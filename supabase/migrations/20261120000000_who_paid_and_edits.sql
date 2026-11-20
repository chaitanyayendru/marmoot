-- Who paid a bill isn't always who shares it, and expenses can be edited.
--
-- A bill sheet now records who paid (bill_people.paid). Shared by Chai but paid by
-- Asha: items nobody keeps fall to Asha, everyone pays Asha, and the expense it
-- becomes says Asha paid. Sheets made before this have no one marked, and their
-- owner is taken to have paid, as before.

alter table public.bill_people add column paid boolean not null default false;
create unique index bill_people_one_payer on public.bill_people (sheet_id) where paid;

-- People may carry "paid": true (at most one); with none, the owner paid.
create or replace function public.create_bill_sheet(
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
    raise exception 'Exactly one person must be the one sharing the bill.' using errcode = 'check_violation';
  end if;
  select count(*) into v_n from jsonb_array_elements(p_people) e where (e ->> 'paid')::boolean is true;
  if v_n > 1 then
    raise exception 'Only one person can have paid.' using errcode = 'check_violation';
  end if;

  insert into bill_sheets (title, note, currency, tax_cents, tip_cents, default_in)
  values (trim(p_title), nullif(trim(p_note), ''), upper(p_currency), p_tax_cents, p_tip_cents, p_default_in)
  returning * into v_sheet;

  insert into bill_people (sheet_id, position, name, phone, is_owner, paid)
  select v_sheet.id, (e.ord - 1)::smallint, trim(e.val ->> 'name'), nullif(e.val ->> 'phone', ''),
         coalesce((e.val ->> 'owner')::boolean, false), coalesce((e.val ->> 'paid')::boolean, false)
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

-- Each person now says whether they paid; exactly one does.
create or replace function public.bill_sheet(p_token text) returns jsonb
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
          'paid', p.paid or (p.is_owner and not exists (select 1 from bill_people x where x.sheet_id = s.id and x.paid)),
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

-- Change who paid while the bill is open.
create function public.set_bill_payer(p_owner_token text, p_person uuid) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  me bill_people%rowtype := owner_for_token(p_owner_token);
  v_name text;
begin
  perform require_open(me.sheet_id);
  select name into v_name from bill_people where id = p_person and sheet_id = me.sheet_id;
  if not found then
    raise exception 'That person isn''t on this bill.' using errcode = 'P0002';
  end if;
  update bill_people set paid = false where sheet_id = me.sheet_id and paid and id <> p_person;
  update bill_people set paid = true where id = p_person and not paid;
  insert into bill_events (sheet_id, actor_id, kind, detail) values (me.sheet_id, me.id, 'sheet_changed', 'paid by ' || v_name);
end $$;

revoke execute on function public.set_bill_payer(text, uuid) from public;
grant execute on function public.set_bill_payer(text, uuid) to anon, authenticated;

-- Members may now share updateItem (an edited expense or payment keeps its id).
create or replace function public.check_group_action(p_group uuid, p_action jsonb) returns void
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_type text := p_action ->> 'type';
  v_user text := p_action -> 'member' ->> 'userId';
begin
  if v_type is null or v_type not in (
    'renameGroup', 'addMember', 'updateMember', 'removeMember', 'addItem', 'deleteItem',
    'addRecurring', 'deleteRecurring', 'catchUp', 'resolveDue', 'updateGame', 'addSheet', 'closeSheet', 'removeSheet', 'updateItem'
  ) then
    raise exception 'That change can''t be shared (%).', coalesce(v_type, 'no type') using errcode = '22023';
  end if;
  if p_action ->> 'group' is distinct from p_group::text then
    raise exception 'That change belongs to another group.' using errcode = '22023';
  end if;
  if v_user is not null and not exists (
    select 1 from group_members m where m.group_id = p_group and m.user_id::text = v_user
  ) then
    raise exception 'Only people who have joined the group can be linked to a member.' using errcode = '22023';
  end if;
end $$;
