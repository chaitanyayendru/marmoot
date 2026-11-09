-- Marmoot schema v3: bill sheets, shared item by item.
--
-- The person who paid lists the items. Everyone on the bill gets a personal link and
-- says which items they were part of: Hima keeps tomatoes and drops onions. Rows are
-- items, columns are people, each cell is in or out. Cells start at the sheet's
-- default (usually in), so people only change what they weren't part of.
--
-- Access is by link, not by account. Every person on a sheet has a secret token:
--   * a person's token lets them read the sheet and change their own column;
--   * the owner's token also lets them edit items, anyone's cells, and close it.
-- Tables are closed to clients; everything goes through the functions below, which
-- check the token first. Accounts come later and will claim sheets by token.
--
-- Messages go out from Marmoot's WhatsApp number through an Edge Function, using the
-- service role: queue_bill_alerts() picks who to message, record_alert() and
-- record_whatsapp_status() track sent, delivered, read and failed.
--
-- Totals are computed in @marmoot/core (sheetShares), the same code on every phone.

-- ---------------------------------------------------------------- tokens

-- 128 random bits from a v4 UUID (122 of them random), URL-safe, 22 characters.
create function public.new_token() returns text
language sql volatile
as $$
  select rtrim(translate(encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/', '-_'), '=');
$$;

-- ---------------------------------------------------------------- tables

create table public.bill_sheets (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(trim(title)) between 1 and 80),
  note        text check (length(note) <= 280),
  currency    char(3) not null default 'USD',
  tax_cents   bigint not null default 0 check (tax_cents >= 0),
  tip_cents   bigint not null default 0 check (tip_cents >= 0),
  -- Where a cell starts before anyone touches it: true = everyone is in until they opt out.
  default_in  boolean not null default true,
  status      text not null default 'open' check (status in ('open', 'closed')),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);

create table public.bill_people (
  id                uuid primary key default gen_random_uuid(),
  sheet_id          uuid not null references public.bill_sheets (id) on delete cascade,
  position          smallint not null default 0,
  name              text not null check (length(trim(name)) between 1 and 60),
  phone             text check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  is_owner          boolean not null default false,
  token             text not null unique default public.new_token(),
  viewed_at         timestamptz,
  responded_at      timestamptz,
  out_of_bill       boolean not null default false,
  alert_status      text not null default 'not_sent'
                    check (alert_status in ('not_sent', 'no_phone', 'queued', 'sent', 'delivered', 'read', 'failed')),
  alert_error       text,
  alert_updated_at  timestamptz
);
create unique index bill_people_one_owner on public.bill_people (sheet_id) where is_owner;
create index bill_people_sheet_idx on public.bill_people (sheet_id, position);

create table public.bill_items (
  id           uuid primary key default gen_random_uuid(),
  sheet_id     uuid not null references public.bill_sheets (id) on delete cascade,
  position     int not null default 0,
  name         text not null check (length(trim(name)) between 1 and 80),
  price_cents  bigint not null check (price_cents >= 0),
  removed      boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index bill_items_sheet_idx on public.bill_items (sheet_id, position);

create table public.bill_choices (
  item_id     uuid not null references public.bill_items (id) on delete cascade,
  person_id   uuid not null references public.bill_people (id) on delete cascade,
  sheet_id    uuid not null references public.bill_sheets (id) on delete cascade,
  is_in       boolean not null,
  -- Who set it: the person themselves, or the owner on their behalf.
  set_by      uuid not null references public.bill_people (id) on delete cascade,
  updated_at  timestamptz not null default now(),
  primary key (item_id, person_id)
);
create index bill_choices_sheet_idx on public.bill_choices (sheet_id);

-- Every change, for the owner's activity list: "Hima: out of Onions, 12:03".
create table public.bill_events (
  id         bigint generated always as identity primary key,
  sheet_id   uuid not null references public.bill_sheets (id) on delete cascade,
  person_id  uuid references public.bill_people (id) on delete cascade,
  actor_id   uuid references public.bill_people (id) on delete cascade,
  item_id    uuid references public.bill_items (id) on delete cascade,
  kind       text not null check (kind in (
               'created', 'viewed', 'in', 'out', 'all_out', 'back_in', 'done',
               'item_added', 'item_changed', 'item_removed', 'person_added', 'sheet_changed',
               'alert_queued', 'alert_sent', 'alert_delivered', 'alert_read', 'alert_failed',
               'closed', 'reopened')),
  detail     text,
  at         timestamptz not null default now()
);
create index bill_events_sheet_idx on public.bill_events (sheet_id, id desc);

-- One row per WhatsApp message Marmoot sends, written before the send and updated by
-- the send result and then by Meta's delivery webhooks.
create table public.whatsapp_outbox (
  id             uuid primary key default gen_random_uuid(),
  sheet_id       uuid not null references public.bill_sheets (id) on delete cascade,
  person_id      uuid not null references public.bill_people (id) on delete cascade,
  to_phone       text not null,
  template       text not null,
  status         text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'read', 'failed')),
  wa_message_id  text unique,
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index whatsapp_outbox_sheet_idx on public.whatsapp_outbox (sheet_id);

alter table public.bill_sheets      enable row level security;
alter table public.bill_people      enable row level security;
alter table public.bill_items       enable row level security;
alter table public.bill_choices     enable row level security;
alter table public.bill_events      enable row level security;
alter table public.whatsapp_outbox  enable row level security;
revoke all on public.bill_sheets, public.bill_people, public.bill_items, public.bill_choices,
              public.bill_events, public.whatsapp_outbox from anon, authenticated;

-- ---------------------------------------------------------------- token checks

-- The person a token belongs to, or an error that reveals nothing about other sheets.
create function public.person_for_token(p_token text) returns public.bill_people
language plpgsql stable security definer
set search_path = public
as $$
declare
  v bill_people%rowtype;
begin
  select * into v from bill_people where token = p_token;
  if not found then
    raise exception 'This link is not valid. Ask for a new one.' using errcode = 'no_data_found';
  end if;
  return v;
end $$;

create function public.owner_for_token(p_token text) returns public.bill_people
language plpgsql stable security definer
set search_path = public
as $$
declare
  v bill_people%rowtype := person_for_token(p_token);
begin
  if not v.is_owner then
    raise exception 'Only the person who shared this bill can do that.' using errcode = 'insufficient_privilege';
  end if;
  return v;
end $$;

create function public.require_open(p_sheet uuid) returns void
language plpgsql stable
set search_path = public
as $$
begin
  if (select status from bill_sheets where id = p_sheet) <> 'open' then
    raise exception 'This bill is closed, so it can''t change.' using errcode = 'check_violation';
  end if;
end $$;

-- ---------------------------------------------------------------- create and read

-- p_people: [{"name": "Chai", "phone": "+14045550101", "owner": true}, {"name": "Hima"}, ...]
-- p_items:  [{"name": "Tomatoes", "price": 600}, ...]
-- Returns the sheet id, the owner's token, and each person's id and token.
create function public.create_bill_sheet(
  p_title       text,
  p_people      jsonb,
  p_items       jsonb default '[]',
  p_tax_cents   bigint default 0,
  p_tip_cents   bigint default 0,
  p_note        text default null,
  p_currency    text default 'USD',
  p_default_in  boolean default true
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_sheet  bill_sheets%rowtype;
  v_owner  uuid;
  v_n      int;
begin
  if jsonb_typeof(p_people) <> 'array' or jsonb_array_length(p_people) not between 1 and 30 then
    raise exception 'Add between 1 and 30 people.' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200 then
    raise exception 'A bill can have up to 200 items.' using errcode = 'check_violation';
  end if;
  select count(*) into v_n from jsonb_array_elements(p_people) e where (e ->> 'owner')::boolean is true;
  if v_n <> 1 then
    raise exception 'Exactly one person must be the one who paid.' using errcode = 'check_violation';
  end if;

  insert into bill_sheets (title, note, currency, tax_cents, tip_cents, default_in)
  values (trim(p_title), nullif(trim(p_note), ''), upper(p_currency), p_tax_cents, p_tip_cents, p_default_in)
  returning * into v_sheet;

  insert into bill_people (sheet_id, position, name, phone, is_owner)
  select v_sheet.id, (e.ord - 1)::smallint, trim(e.val ->> 'name'), nullif(e.val ->> 'phone', ''), coalesce((e.val ->> 'owner')::boolean, false)
  from jsonb_array_elements(p_people) with ordinality as e(val, ord);

  insert into bill_items (sheet_id, position, name, price_cents)
  select v_sheet.id, (e.ord - 1)::int, trim(e.val ->> 'name'), (e.val ->> 'price')::bigint
  from jsonb_array_elements(p_items) with ordinality as e(val, ord);

  select id into v_owner from bill_people where sheet_id = v_sheet.id and is_owner;
  insert into bill_events (sheet_id, person_id, actor_id, kind) values (v_sheet.id, v_owner, v_owner, 'created');

  return jsonb_build_object(
    'sheet_id', v_sheet.id,
    'owner_token', (select token from bill_people where id = v_owner),
    'people', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'token', token) order by position)
               from bill_people where sheet_id = v_sheet.id)
  );
end $$;

-- Everything a link holder sees. Everyone sees every cell, so the sheet is open
-- for the whole group. Only the owner sees phone numbers, links and the activity.
create function public.bill_sheet(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  me  bill_people%rowtype := person_for_token(p_token);
  own boolean := me.is_owner;
  s   bill_sheets%rowtype;
begin
  select * into s from bill_sheets where id = me.sheet_id;
  return jsonb_build_object(
    'sheet', jsonb_build_object(
      'id', s.id, 'title', s.title, 'note', s.note, 'currency', s.currency,
      'tax_cents', s.tax_cents, 'tip_cents', s.tip_cents, 'default_in', s.default_in,
      'status', s.status, 'created_at', s.created_at, 'closed_at', s.closed_at),
    'me', jsonb_build_object('id', me.id, 'is_owner', me.is_owner),
    'people', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'id', p.id, 'name', p.name, 'is_owner', p.is_owner, 'out_of_bill', p.out_of_bill,
          'viewed_at', p.viewed_at, 'responded_at', p.responded_at,
          'has_phone', p.phone is not null,
          'phone', case when own then p.phone end,
          'token', case when own then p.token end,
          'alert_status', case when own then p.alert_status end,
          'alert_error', case when own then p.alert_error end,
          'alert_updated_at', case when own then p.alert_updated_at end)
        order by p.position), '[]')
      from bill_people p where p.sheet_id = s.id),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'price_cents', i.price_cents) order by i.position, i.created_at), '[]')
      from bill_items i where i.sheet_id = s.id and not i.removed),
    'choices', (
      select coalesce(jsonb_agg(jsonb_build_object('item_id', c.item_id, 'person_id', c.person_id, 'is_in', c.is_in)), '[]')
      from bill_choices c join bill_items i on i.id = c.item_id
      where c.sheet_id = s.id and not i.removed),
    'events', case when own then (
      select coalesce(jsonb_agg(jsonb_build_object(
          'id', e.id, 'kind', e.kind, 'person_id', e.person_id, 'actor_id', e.actor_id,
          'item_id', e.item_id, 'detail', e.detail, 'at', e.at) order by e.id desc), '[]')
      from (select * from bill_events where sheet_id = s.id order by id desc limit 200) e)
    else '[]'::jsonb end
  );
end $$;

-- The first time someone opens their link.
create function public.mark_bill_viewed(p_token text) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  me bill_people%rowtype := person_for_token(p_token);
begin
  if me.viewed_at is null and not me.is_owner then
    update bill_people set viewed_at = now() where id = me.id;
    insert into bill_events (sheet_id, person_id, actor_id, kind) values (me.sheet_id, me.id, me.id, 'viewed');
  end if;
end $$;

-- ---------------------------------------------------------------- choices

-- Set one cell. People change their own column; the owner can change anyone's.
create function public.set_bill_choice(p_token text, p_item uuid, p_in boolean, p_person uuid default null)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  me      bill_people%rowtype := person_for_token(p_token);
  v_who   uuid := coalesce(p_person, me.id);
  v_prev  boolean;
begin
  perform require_open(me.sheet_id);
  if v_who <> me.id and not me.is_owner then
    raise exception 'You can only change your own choices.' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from bill_people where id = v_who and sheet_id = me.sheet_id)
     or not exists (select 1 from bill_items where id = p_item and sheet_id = me.sheet_id and not removed) then
    raise exception 'That item or person is not on this bill.' using errcode = 'no_data_found';
  end if;

  select is_in into v_prev from bill_choices where item_id = p_item and person_id = v_who;
  insert into bill_choices (item_id, person_id, sheet_id, is_in, set_by)
  values (p_item, v_who, me.sheet_id, p_in, me.id)
  on conflict (item_id, person_id) do update set is_in = excluded.is_in, set_by = excluded.set_by, updated_at = now();

  if p_in and (select out_of_bill from bill_people where id = v_who) then
    update bill_people set out_of_bill = false where id = v_who;
    insert into bill_events (sheet_id, person_id, actor_id, kind) values (me.sheet_id, v_who, me.id, 'back_in');
  end if;
  if v_prev is distinct from p_in then
    insert into bill_events (sheet_id, person_id, actor_id, item_id, kind, detail)
    values (me.sheet_id, v_who, me.id, p_item, case when p_in then 'in' else 'out' end, (select name from bill_items where id = p_item));
  end if;
end $$;

-- "I wasn't part of this bill" (or back in). Cells keep their values underneath.
create function public.set_out_of_bill(p_token text, p_out boolean, p_person uuid default null)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  me     bill_people%rowtype := person_for_token(p_token);
  v_who  uuid := coalesce(p_person, me.id);
begin
  perform require_open(me.sheet_id);
  if v_who <> me.id and not me.is_owner then
    raise exception 'You can only change your own choices.' using errcode = 'insufficient_privilege';
  end if;
  update bill_people set out_of_bill = p_out, responded_at = case when p_out then now() else responded_at end
  where id = v_who and sheet_id = me.sheet_id and out_of_bill is distinct from p_out;
  if found then
    insert into bill_events (sheet_id, person_id, actor_id, kind)
    values (me.sheet_id, v_who, me.id, case when p_out then 'all_out' else 'back_in' end);
  end if;
end $$;

-- "Done": this person has gone through the list.
create function public.mark_bill_done(p_token text) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  me bill_people%rowtype := person_for_token(p_token);
begin
  perform require_open(me.sheet_id);
  update bill_people set responded_at = now() where id = me.id;
  insert into bill_events (sheet_id, person_id, actor_id, kind) values (me.sheet_id, me.id, me.id, 'done');
end $$;

-- ---------------------------------------------------------------- owner edits

create function public.add_bill_item(p_owner_token text, p_name text, p_price_cents bigint) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  me  bill_people%rowtype := owner_for_token(p_owner_token);
  v   uuid;
begin
  perform require_open(me.sheet_id);
  insert into bill_items (sheet_id, position, name, price_cents)
  values (me.sheet_id, coalesce((select max(position) + 1 from bill_items where sheet_id = me.sheet_id), 0), trim(p_name), p_price_cents)
  returning id into v;
  insert into bill_events (sheet_id, actor_id, item_id, kind, detail) values (me.sheet_id, me.id, v, 'item_added', trim(p_name));
  return v;
end $$;

create function public.update_bill_item(p_owner_token text, p_item uuid, p_name text, p_price_cents bigint) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  me bill_people%rowtype := owner_for_token(p_owner_token);
begin
  perform require_open(me.sheet_id);
  update bill_items set name = trim(p_name), price_cents = p_price_cents, updated_at = now()
  where id = p_item and sheet_id = me.sheet_id and not removed;
  if not found then raise exception 'That item is not on this bill.' using errcode = 'no_data_found'; end if;
  insert into bill_events (sheet_id, actor_id, item_id, kind, detail) values (me.sheet_id, me.id, p_item, 'item_changed', trim(p_name));
end $$;

create function public.remove_bill_item(p_owner_token text, p_item uuid) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  me bill_people%rowtype := owner_for_token(p_owner_token);
begin
  perform require_open(me.sheet_id);
  update bill_items set removed = true, updated_at = now() where id = p_item and sheet_id = me.sheet_id and not removed;
  if found then
    insert into bill_events (sheet_id, actor_id, item_id, kind, detail)
    values (me.sheet_id, me.id, p_item, 'item_removed', (select name from bill_items where id = p_item));
  end if;
end $$;

create function public.update_bill_sheet(p_owner_token text, p_title text, p_note text, p_tax_cents bigint, p_tip_cents bigint)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  me bill_people%rowtype := owner_for_token(p_owner_token);
begin
  perform require_open(me.sheet_id);
  update bill_sheets set title = trim(p_title), note = nullif(trim(p_note), ''), tax_cents = p_tax_cents, tip_cents = p_tip_cents
  where id = me.sheet_id;
  insert into bill_events (sheet_id, actor_id, kind) values (me.sheet_id, me.id, 'sheet_changed');
end $$;

create function public.add_bill_person(p_owner_token text, p_name text, p_phone text default null) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  me  bill_people%rowtype := owner_for_token(p_owner_token);
  v   bill_people%rowtype;
begin
  perform require_open(me.sheet_id);
  if (select count(*) from bill_people where sheet_id = me.sheet_id) >= 30 then
    raise exception 'A bill can have up to 30 people.' using errcode = 'check_violation';
  end if;
  insert into bill_people (sheet_id, position, name, phone)
  values (me.sheet_id, (select max(position) + 1 from bill_people where sheet_id = me.sheet_id), trim(p_name), nullif(p_phone, ''))
  returning * into v;
  insert into bill_events (sheet_id, person_id, actor_id, kind, detail) values (me.sheet_id, v.id, me.id, 'person_added', v.name);
  return jsonb_build_object('id', v.id, 'name', v.name, 'token', v.token);
end $$;

create function public.set_bill_person_phone(p_owner_token text, p_person uuid, p_phone text) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  me bill_people%rowtype := owner_for_token(p_owner_token);
begin
  update bill_people set phone = nullif(p_phone, ''),
    alert_status = case when alert_status = 'no_phone' then 'not_sent' else alert_status end
  where id = p_person and sheet_id = me.sheet_id;
end $$;

create function public.close_bill_sheet(p_owner_token text, p_close boolean default true) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  me bill_people%rowtype := owner_for_token(p_owner_token);
begin
  update bill_sheets set status = case when p_close then 'closed' else 'open' end,
                         closed_at = case when p_close then now() end
  where id = me.sheet_id and status <> case when p_close then 'closed' else 'open' end;
  if found then
    insert into bill_events (sheet_id, actor_id, kind) values (me.sheet_id, me.id, case when p_close then 'closed' else 'reopened' end);
  end if;
end $$;

-- ---------------------------------------------------------------- WhatsApp (service role only)

-- Who to message for a sheet: everyone but the owner, with a phone, not already
-- messaged (unless p_resend). Writes a queued outbox row for each and returns what
-- the sender needs. People without a phone are marked so the owner can see why.
create function public.queue_bill_alerts(p_owner_token text, p_people uuid[] default null, p_resend boolean default false)
returns table (outbox_id uuid, person_id uuid, to_phone text, person_name text, person_token text,
               owner_name text, sheet_title text, sheet_total_cents bigint, currency text, note text)
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  me  bill_people%rowtype := owner_for_token(p_owner_token);
  s   bill_sheets%rowtype;
  p   bill_people%rowtype;
  v   uuid;
  tot bigint;
begin
  select * into s from bill_sheets where id = me.sheet_id;
  perform require_open(s.id);
  select coalesce(sum(price_cents), 0) + s.tax_cents + s.tip_cents into tot from bill_items where sheet_id = s.id and not removed;

  for p in
    select * from bill_people b
    where b.sheet_id = s.id and not b.is_owner
      and (p_people is null or b.id = any (p_people))
    order by b.position
    for update
  loop
    if p.phone is null then
      update bill_people set alert_status = 'no_phone', alert_updated_at = now() where id = p.id;
      continue;
    end if;
    if not p_resend and p.alert_status in ('queued', 'sent', 'delivered', 'read') then
      continue;
    end if;
    insert into whatsapp_outbox (sheet_id, person_id, to_phone, template) values (s.id, p.id, p.phone, 'bill_ready')
    returning id into v;
    update bill_people set alert_status = 'queued', alert_error = null, alert_updated_at = now() where id = p.id;
    insert into bill_events (sheet_id, person_id, actor_id, kind) values (s.id, p.id, me.id, 'alert_queued');
    outbox_id := v; person_id := p.id; to_phone := p.phone; person_name := p.name; person_token := p.token;
    owner_name := me.name; sheet_title := s.title; sheet_total_cents := tot; currency := s.currency; note := s.note;
    return next;
  end loop;
end $$;

-- How a send went: 'sent' with Meta's message id, or 'failed' with the reason.
create function public.record_alert(p_outbox uuid, p_status text, p_wa_message_id text default null, p_error text default null)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  o whatsapp_outbox%rowtype;
begin
  update whatsapp_outbox set status = p_status, wa_message_id = coalesce(p_wa_message_id, wa_message_id), error = p_error, updated_at = now()
  where id = p_outbox returning * into o;
  if not found then return; end if;
  update bill_people set alert_status = p_status, alert_error = p_error, alert_updated_at = now() where id = o.person_id;
  insert into bill_events (sheet_id, person_id, kind, detail) values (o.sheet_id, o.person_id, 'alert_' || p_status, p_error);
end $$;

-- A status from Meta's webhook. Statuses only move forward (sent, delivered, read),
-- because webhooks can arrive out of order; a failure is always recorded.
create function public.record_whatsapp_status(p_wa_message_id text, p_status text, p_error text default null)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  o     whatsapp_outbox%rowtype;
  rank  constant jsonb := '{"queued": 0, "sent": 1, "delivered": 2, "read": 3}';
begin
  if p_status not in ('sent', 'delivered', 'read', 'failed') then return; end if;
  select * into o from whatsapp_outbox where wa_message_id = p_wa_message_id for update;
  if not found then return; end if;
  if p_status <> 'failed' and (o.status = 'failed' or (rank ->> p_status)::int <= (rank ->> o.status)::int) then
    return;
  end if;
  perform record_alert(o.id, p_status, null, p_error);
end $$;

-- ---------------------------------------------------------------- access

revoke execute on function
  public.person_for_token(text), public.owner_for_token(text), public.require_open(uuid),
  public.queue_bill_alerts(text, uuid[], boolean), public.record_alert(uuid, text, text, text),
  public.record_whatsapp_status(text, text, text)
from public, anon, authenticated;
grant execute on function
  public.queue_bill_alerts(text, uuid[], boolean), public.record_alert(uuid, text, text, text),
  public.record_whatsapp_status(text, text, text)
to service_role;

grant execute on function
  public.create_bill_sheet(text, jsonb, jsonb, bigint, bigint, text, text, boolean),
  public.bill_sheet(text), public.mark_bill_viewed(text),
  public.set_bill_choice(text, uuid, boolean, uuid), public.set_out_of_bill(text, boolean, uuid), public.mark_bill_done(text),
  public.add_bill_item(text, text, bigint), public.update_bill_item(text, uuid, text, bigint), public.remove_bill_item(text, uuid),
  public.update_bill_sheet(text, text, text, bigint, bigint), public.add_bill_person(text, text, text),
  public.set_bill_person_phone(text, uuid, text), public.close_bill_sheet(text, boolean)
to anon, authenticated;
