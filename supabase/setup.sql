-- Marmoot: the whole database schema, for a new Supabase project.
-- Paste all of this into Supabase > SQL Editor > New query, then Run. Run it once.
-- Generated from supabase/migrations by npm run setup-sql; edit the migrations, not this.

-- ================================================================ 20261109040000_poker_core.sql

-- Marmoot schema v1: groups, people, poker sessions, an append-only ledger, transfers.
--
-- Rules this schema enforces, not the app:
--   * Money is bigint cents. Every amount carries the session's currency.
--   * poker_events and ledger_entries are append-only. Mistakes are fixed with a
--     'void' event, never an UPDATE or DELETE.
--   * Each player's result is computed here, by poker_nets(), with the same
--     largest-remainder rule as @marmoot/core. supabase/tests checks the two agree.
--   * Only security-definer functions write to the ledger. Clients cannot insert
--     ledger rows directly.
--   * Row-level security: you see a group only if you are a member of it.

-- ---------------------------------------------------------------- tables

create table public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  currency    char(3) not null default 'USD',
  created_by  uuid not null default auth.uid() references auth.users (id),
  created_at  timestamptz not null default now()
);

create table public.group_members (
  group_id  uuid not null references public.groups (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  primary key (group_id, user_id)
);

-- Everyone who plays, whether or not they have a Marmoot account.
create table public.people (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references public.groups (id) on delete cascade,
  display_name     text not null check (length(trim(display_name)) > 0),
  user_id          uuid references auth.users (id) on delete set null,
  -- {"venmo": "...", "zelle": "...", "paypal": "...", "cashapp": "..."}
  handles          jsonb not null default '{}'::jsonb check (jsonb_typeof(handles) = 'object'),
  settles_in_cash  boolean not null default false,
  created_at       timestamptz not null default now()
);
create index people_group_idx on public.people (group_id);

create table public.sessions (
  id                     uuid primary key default gen_random_uuid(),
  group_id               uuid not null references public.groups (id) on delete cascade,
  kind                   text not null default 'poker' check (kind in ('poker', 'bill')),
  name                   text not null check (length(trim(name)) > 0),
  currency               char(3) not null default 'USD',
  buy_in_cents           bigint check (buy_in_cents > 0),
  buy_in_mode            text not null default 'settle-later' check (buy_in_mode in ('cash-to-host', 'settle-later')),
  host_person_id         uuid references public.people (id),
  discrepancy_tolerance  numeric(6, 5) not null default 0.01 check (discrepancy_tolerance between 0 and 0.1),
  status                 text not null default 'open' check (status in ('open', 'closed')),
  closed_at              timestamptz,
  created_by             uuid not null default auth.uid() references auth.users (id),
  created_at             timestamptz not null default now()
);
create index sessions_group_idx on public.sessions (group_id);

-- What happened at the table, in order. A cash-out entered twice: the latest one counts.
create table public.poker_events (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null references public.sessions (id),
  kind             text not null check (kind in ('buyin', 'cash', 'cashout', 'void')),
  person_id        uuid references public.people (id),
  to_person_id     uuid references public.people (id),
  amount_cents     bigint check (amount_cents >= 0),
  voids_event_id   uuid references public.poker_events (id),
  idempotency_key  text unique,
  created_by       uuid default auth.uid() references auth.users (id),
  created_at       timestamptz not null default clock_timestamp(),
  check (
       (kind = 'buyin'   and person_id is not null and to_person_id is null and amount_cents > 0  and voids_event_id is null)
    or (kind = 'cash'    and person_id is not null and to_person_id is not null and person_id <> to_person_id and amount_cents > 0 and voids_event_id is null)
    or (kind = 'cashout' and person_id is not null and to_person_id is null and amount_cents >= 0 and voids_event_id is null)
    or (kind = 'void'    and person_id is null and to_person_id is null and amount_cents is null and voids_event_id is not null)
  )
);
create index poker_events_session_idx on public.poker_events (session_id, created_at);

create table public.ledger_entries (
  id            bigint generated always as identity primary key,
  group_id      uuid not null references public.groups (id),
  session_id    uuid references public.sessions (id),
  person_id     uuid not null references public.people (id),
  -- Positive: the group owes this person. Negative: this person owes.
  amount_cents  bigint not null,
  currency      char(3) not null,
  source        text not null check (source in ('poker', 'bill', 'transfer')),
  source_id     uuid not null,
  posted_at     timestamptz not null default now()
);
create index ledger_group_person_idx on public.ledger_entries (group_id, person_id);

create table public.transfers (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references public.groups (id),
  session_id      uuid references public.sessions (id),
  from_person_id  uuid not null references public.people (id),
  to_person_id    uuid not null references public.people (id),
  amount_cents    bigint not null check (amount_cents > 0),
  rail            text check (rail in ('venmo', 'zelle', 'paypal', 'cashapp', 'cash')),
  status          text not null default 'paid' check (status in ('paid', 'confirmed', 'disputed')),
  marked_by       uuid default auth.uid() references auth.users (id),
  created_at      timestamptz not null default now(),
  confirmed_at    timestamptz,
  check (from_person_id <> to_person_id)
);

-- ---------------------------------------------------------------- integrity

create function public.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only; record a correction instead', tg_table_name
    using errcode = 'restrict_violation';
end $$;

create trigger poker_events_append_only before update or delete on public.poker_events
  for each row execute function public.forbid_change();
create trigger ledger_entries_append_only before update or delete on public.ledger_entries
  for each row execute function public.forbid_change();

-- Events must reference people in the session's group, and only open sessions take events.
create function public.check_poker_event() returns trigger
language plpgsql as $$
declare
  s public.sessions%rowtype;
begin
  select * into s from public.sessions where id = new.session_id;
  if s.status <> 'open' then
    raise exception 'session % is closed', new.session_id using errcode = 'check_violation';
  end if;
  if s.kind <> 'poker' then
    raise exception 'session % is not a poker session', new.session_id using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.people p
    where p.id in (new.person_id, new.to_person_id) and p.group_id <> s.group_id
  ) then
    raise exception 'event references someone outside this group' using errcode = 'check_violation';
  end if;
  if new.kind = 'void' and not exists (
    select 1 from public.poker_events e
    where e.id = new.voids_event_id and e.session_id = new.session_id and e.kind <> 'void'
  ) then
    raise exception 'can only void a buy-in, cash or cash-out event in the same session' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger poker_events_check before insert on public.poker_events
  for each row execute function public.check_poker_event();

-- ---------------------------------------------------------------- poker math

-- Per-player totals for one session: buy-ins, latest cash-out, cash handed over and
-- cash held. Voided events are ignored.
create function public.poker_totals(p_session uuid)
returns table (person_id uuid, buyins bigint, cashouts bigint, cash_given bigint, cash_received bigint)
language sql stable
set search_path = public
as $$
  with live as (
    select e.* from poker_events e
    where e.session_id = p_session and e.kind <> 'void'
      and not exists (select 1 from poker_events v where v.kind = 'void' and v.voids_event_id = e.id)
  ),
  latest_cashout as (
    select distinct on (l.person_id) l.person_id, l.amount_cents
    from live l where l.kind = 'cashout'
    order by l.person_id, l.created_at desc, l.id desc
  ),
  players as (
    select l.person_id as pid from live l
    union
    select l.to_person_id from live l where l.kind = 'cash'
  )
  select p.pid,
    coalesce((select sum(l.amount_cents) from live l where l.kind = 'buyin' and l.person_id = p.pid), 0)::bigint,
    coalesce((select c.amount_cents from latest_cashout c where c.person_id = p.pid), 0)::bigint,
    coalesce((select sum(l.amount_cents) from live l where l.kind = 'cash' and l.person_id = p.pid), 0)::bigint,
    coalesce((select sum(l.amount_cents) from live l where l.kind = 'cash' and l.to_person_id = p.pid), 0)::bigint
  from players p;
$$;

-- Each player's result for one session. Mirrors settlePokerNight() in
-- packages/core/src/poker.ts, including the error for a chip count that is off by
-- more than the session's tolerance and the largest-remainder spread of a smaller gap.
create function public.poker_nets(p_session uuid)
returns table (
  person_id      uuid,
  buyins         bigint,
  cashouts       bigint,
  cash_given     bigint,
  cash_received  bigint,
  adjustment     bigint,
  net            bigint
)
language plpgsql stable
set search_path = public
as $$
declare
  v_tol    numeric;
  v_buy    bigint;
  v_out    bigint;
  v_disc   bigint;
  v_limit  bigint;
begin
  select discrepancy_tolerance into v_tol from sessions where id = p_session;
  if v_tol is null then
    raise exception 'session % not found', p_session using errcode = 'no_data_found';
  end if;

  select coalesce(sum(t.buyins), 0), coalesce(sum(t.cashouts), 0) into v_buy, v_out from poker_totals(p_session) t;
  v_disc := v_out - v_buy;
  v_limit := floor(v_buy * v_tol);
  if abs(v_disc) > v_limit then
    raise exception 'chip count is off by % cents, more than the % cent tolerance; recount before settling', v_disc, v_limit
      using errcode = 'check_violation';
  end if;

  -- Spread -v_disc across players by buy-in: floor shares first, then one cent at a
  -- time to the largest remainders, ties to the lowest id (byte order, like JS strings).
  return query
  with shares as (
    select t.*,
      case when v_disc <> 0 and t.buyins > 0 then floor(abs(v_disc)::numeric * t.buyins / v_buy) else 0 end as share,
      case when v_disc <> 0 and t.buyins > 0 then mod(abs(v_disc)::numeric * t.buyins, v_buy) else -1 end as rem
    from poker_totals(p_session) t
  ),
  ranked as (
    select s.*,
      row_number() over (order by s.rem desc, s.person_id::text collate "C") as rk,
      abs(v_disc) - sum(s.share) over () as leftover
    from shares s
  ),
  adj as (
    select r.*, (-sign(v_disc) * (r.share + case when r.buyins > 0 and r.rk <= r.leftover then 1 else 0 end))::bigint as a
    from ranked r
  )
  select adj.person_id, adj.buyins, adj.cashouts, adj.cash_given, adj.cash_received, adj.a,
    (adj.cashouts - adj.buyins + adj.cash_given - adj.cash_received + adj.a)::bigint
  from adj
  order by adj.person_id::text collate "C";
end $$;

-- ---------------------------------------------------------------- access

create function public.is_member(p_group uuid) returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from group_members m where m.group_id = p_group and m.user_id = auth.uid());
$$;

create function public.session_group(p_session uuid) returns uuid
language sql stable security definer
set search_path = public
as $$
  select group_id from sessions where id = p_session;
$$;

-- Whoever creates a group owns it.
create function public.add_group_owner() returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into group_members (group_id, user_id, role) values (new.id, new.created_by, 'owner');
  return new;
end $$;

create trigger groups_add_owner after insert on public.groups
  for each row execute function public.add_group_owner();

-- Close a poker night: every player needs a cash-out, the chips must match the pot
-- within tolerance, and then each net is posted to the ledger in one transaction.
create function public.close_poker_session(p_session uuid) returns setof public.ledger_entries
language plpgsql security definer
set search_path = public
as $$
declare
  s sessions%rowtype;
  v_missing int;
begin
  select * into s from sessions where id = p_session for update;
  if not found or not is_member(s.group_id) then
    raise exception 'session % not found', p_session using errcode = 'no_data_found';
  end if;
  if s.status <> 'open' then
    raise exception 'session % is already closed', p_session using errcode = 'check_violation';
  end if;

  select count(*) into v_missing
  from poker_nets(p_session) n
  where not exists (
    select 1 from poker_events e
    where e.session_id = p_session and e.kind = 'cashout' and e.person_id = n.person_id
      and not exists (select 1 from poker_events v where v.kind = 'void' and v.voids_event_id = e.id)
  );
  if v_missing > 0 then
    raise exception '% player(s) still need a cash-out', v_missing using errcode = 'check_violation';
  end if;

  update sessions set status = 'closed', closed_at = now() where id = p_session;

  return query
  with posted as (
    insert into ledger_entries (group_id, session_id, person_id, amount_cents, currency, source, source_id)
    select s.group_id, s.id, n.person_id, n.net, s.currency, 'poker', s.id
    from poker_nets(p_session) n
    where n.net <> 0
    returning *
  )
  select * from posted;
end $$;

-- A payment someone marked as made moves both balances toward zero.
create function public.post_transfer() returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_currency char(3);
begin
  select currency into v_currency from groups where id = new.group_id;
  if exists (
    select 1 from people p where p.id in (new.from_person_id, new.to_person_id) and p.group_id <> new.group_id
  ) then
    raise exception 'transfer references someone outside this group' using errcode = 'check_violation';
  end if;
  insert into ledger_entries (group_id, session_id, person_id, amount_cents, currency, source, source_id) values
    (new.group_id, new.session_id, new.from_person_id,  new.amount_cents, v_currency, 'transfer', new.id),
    (new.group_id, new.session_id, new.to_person_id,   -new.amount_cents, v_currency, 'transfer', new.id);
  return new;
end $$;

create trigger transfers_post after insert on public.transfers
  for each row execute function public.post_transfer();

-- Balances are always computed, never stored.
create view public.balances with (security_invoker = true) as
  select group_id, person_id, currency, sum(amount_cents)::bigint as balance_cents
  from public.ledger_entries
  group by group_id, person_id, currency;

create view public.session_balances with (security_invoker = true) as
  select session_id, person_id, currency, sum(amount_cents)::bigint as balance_cents
  from public.ledger_entries
  where session_id is not null
  group by session_id, person_id, currency;

alter table public.groups          enable row level security;
alter table public.group_members   enable row level security;
alter table public.people          enable row level security;
alter table public.sessions        enable row level security;
alter table public.poker_events    enable row level security;
alter table public.ledger_entries  enable row level security;
alter table public.transfers       enable row level security;

create policy groups_read   on public.groups for select to authenticated using (is_member(id) or created_by = auth.uid());
create policy groups_create on public.groups for insert to authenticated with check (created_by = auth.uid());
create policy groups_rename on public.groups for update to authenticated using (is_member(id)) with check (is_member(id));

create policy members_read on public.group_members for select to authenticated using (is_member(group_id));

create policy people_read   on public.people for select to authenticated using (is_member(group_id));
create policy people_create on public.people for insert to authenticated with check (is_member(group_id));
create policy people_update on public.people for update to authenticated using (is_member(group_id)) with check (is_member(group_id));

create policy sessions_read   on public.sessions for select to authenticated using (is_member(group_id));
create policy sessions_create on public.sessions for insert to authenticated with check (is_member(group_id) and created_by = auth.uid());
-- Closing goes through close_poker_session(), so updates may not touch status.
create policy sessions_update on public.sessions for update to authenticated using (is_member(group_id) and status = 'open') with check (is_member(group_id) and status = 'open');

create policy events_read   on public.poker_events for select to authenticated using (is_member(session_group(session_id)));
create policy events_create on public.poker_events for insert to authenticated with check (is_member(session_group(session_id)) and created_by = auth.uid());

create policy ledger_read on public.ledger_entries for select to authenticated using (is_member(group_id));
-- No insert policy: only close_poker_session() and post_transfer() write the ledger.

create policy transfers_read   on public.transfers for select to authenticated using (is_member(group_id));
create policy transfers_create on public.transfers for insert to authenticated with check (is_member(group_id) and marked_by = auth.uid());

revoke all on public.ledger_entries from anon, authenticated;
grant select on public.ledger_entries to authenticated;
revoke execute on function public.close_poker_session(uuid) from public, anon;
grant execute on function public.close_poker_session(uuid) to authenticated;

-- ================================================================ 20261109050000_expenses.sql

-- Marmoot schema v2: everyday expenses, repeating bills and WhatsApp numbers.
--
-- Most groups are flats, couples, trips and families splitting groceries, rent and
-- utilities; a poker night is one kind of event among many. This migration adds:
--
--   * expenses + expense_shares. One person paid; the cost is split equally, by exact
--     amounts, by percentage or by shares. split_amount() mirrors splitAmount() in
--     @marmoot/core, including the largest-remainder rounding and the error messages,
--     and supabase/tests checks the two agree.
--   * add_expense(), edit_expense(), void_expense(): the only way to write an
--     expense. Each posts to the append-only ledger in the same transaction. An
--     expense is never changed: an edit voids it and records a corrected one.
--   * recurring_bills + due_bills. A fixed bill (rent) posts itself when due. A bill
--     whose amount changes (power, water) waits as a due bill until someone enters
--     this month's amount or skips it.
--   * people.phone, in international format, for one-tap WhatsApp reminders now and
--     automatic WhatsApp messages later. Automatic messages need the recipient's own
--     opt-in, recorded in whatsapp_opt_in_at.

-- ---------------------------------------------------------------- groups and people

create function public.is_time_zone(p_tz text) returns boolean
language sql stable
as $$
  select exists (select 1 from pg_timezone_names where name = p_tz);
$$;

-- Repeating bills fall due by the group's calendar, not the server's.
alter table public.groups
  add column time_zone text not null default 'UTC' check (public.is_time_zone(time_zone));

alter table public.people
  add column phone text check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  add column whatsapp_opt_in_at timestamptz;

alter table public.ledger_entries drop constraint ledger_entries_source_check;
alter table public.ledger_entries add constraint ledger_entries_source_check
  check (source in ('poker', 'bill', 'transfer', 'expense'));

create domain public.expense_category as text
  check (value in ('groceries', 'utilities', 'rent', 'dining', 'transport', 'travel', 'household', 'fun', 'game', 'other'));

-- ---------------------------------------------------------------- split math

-- '$4.20', as core formats amounts in split errors.
create function public.usd_text(p_cents bigint) returns text
language sql immutable
as $$
  select '$' || (p_cents / 100)::text || '.' || lpad((p_cents % 100)::text, 2, '0');
$$;

-- Split p_total across keys in proportion to whole-number weights, with the
-- largest-remainder rule of allocate() in @marmoot/core: floor shares first, then one
-- cent at a time to the largest remainders, ties to the key that sorts first.
create function public.allocate_cents(p_total bigint, p_keys uuid[], p_weights bigint[])
returns table (key uuid, cents bigint)
language plpgsql immutable
set search_path = public
as $$
declare
  v_w numeric;
begin
  if cardinality(p_keys) is distinct from cardinality(p_weights) then
    raise exception 'keys and weights differ in length';
  end if;
  if exists (select 1 from unnest(p_weights) w where w is null or w < 0) then
    raise exception 'weights must be zero or more';
  end if;
  select coalesce(sum(w), 0) into v_w from unnest(p_weights) w;
  if p_total <> 0 and v_w = 0 then
    raise exception 'cannot allocate a non-zero total with no positive weights';
  end if;

  return query
  with w as (
    select u.k, u.wt::numeric as wt from unnest(p_keys, p_weights) as u(k, wt)
  ),
  s as (
    select w.k, w.wt,
      case when w.wt > 0 and p_total <> 0 then floor(abs(p_total)::numeric * w.wt / v_w) else 0 end as share,
      case when w.wt > 0 and p_total <> 0 then mod(abs(p_total)::numeric * w.wt, v_w) else -1 end as rem
    from w
  ),
  r as (
    select s.*,
      row_number() over (order by s.rem desc, s.k::text collate "C") as rk,
      abs(p_total) - sum(s.share) over () as leftover
    from s
  )
  select r.k, (sign(p_total) * (r.share + case when r.wt > 0 and r.rk <= r.leftover then 1 else 0 end))::bigint
  from r
  order by r.k::text collate "C";
end $$;

-- Who owes what for one expense. p_split is the same object the app builds:
--   {"method": "equal",   "among": [person, ...]}
--   {"method": "exact",   "amounts": {person: cents, ...}}        must add up to the total
--   {"method": "percent", "basisPoints": {person: bp, ...}}        must add up to 10000
--   {"method": "shares",  "shares": {person: n, ...}}              whole numbers
-- Zero entries are dropped, as in core. Errors carry core's wording, so the app can
-- show them as they are.
create function public.split_amount(p_total bigint, p_split jsonb)
returns table (person_id uuid, share_cents bigint)
language plpgsql immutable
set search_path = public
as $$
declare
  v_method text := p_split ->> 'method';
  v_field  text;
  v_keys   uuid[];
  v_vals   numeric[];
  v_sum    numeric;
begin
  if p_total is null or p_total <= 0 then
    raise exception 'Enter an amount above zero.' using errcode = 'check_violation';
  end if;

  if v_method = 'equal' then
    if jsonb_typeof(p_split -> 'among') = 'array' then
      select array_agg(distinct x::uuid) into v_keys from jsonb_array_elements_text(p_split -> 'among') x;
    end if;
    if v_keys is null then
      raise exception 'Choose at least one person to split with.' using errcode = 'check_violation';
    end if;
    return query select a.key, a.cents from allocate_cents(p_total, v_keys, array_fill(1::bigint, array[cardinality(v_keys)])) a;
    return;
  end if;

  v_field := case v_method when 'exact' then 'amounts' when 'percent' then 'basisPoints' when 'shares' then 'shares' end;
  if v_field is null or jsonb_typeof(p_split -> v_field) is distinct from 'object' then
    raise exception 'Unknown split method.' using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from jsonb_each(p_split -> v_field) e
    where jsonb_typeof(e.value) <> 'number'
       or e.value::numeric < 0
       or e.value::numeric <> trunc(e.value::numeric)
       or e.value::numeric > 9007199254740991
  ) then
    raise exception '%', case v_method
        when 'exact' then 'Amounts must be zero or more.'
        when 'percent' then 'Percentages must be zero or more, to two decimals.'
        else 'Shares must be whole numbers.'
      end
      using errcode = 'check_violation';
  end if;

  select array_agg(e.key::uuid order by e.key), array_agg(e.value::numeric order by e.key), coalesce(sum(e.value::numeric), 0)
    into v_keys, v_vals, v_sum
  from jsonb_each(p_split -> v_field) e
  where e.value::numeric <> 0;
  v_sum := coalesce(v_sum, 0);

  if v_method = 'exact' then
    if v_sum <> p_total then
      raise exception '%', case when p_total > v_sum
          then usd_text((p_total - v_sum)::bigint) || ' still to assign.'
          else usd_text((v_sum - p_total)::bigint) || ' over the total.'
        end
        using errcode = 'check_violation';
    end if;
    return query select k, v::bigint from unnest(v_keys, v_vals) as u(k, v);
    return;
  end if;

  if v_method = 'percent' and v_sum <> 10000 then
    raise exception 'Percentages add up to %, not 100%%.',
      case when v_sum % 100 = 0 then (v_sum / 100)::bigint::text else to_char(v_sum / 100, 'FM999999999999990.00') end || '%'
      using errcode = 'check_violation';
  end if;
  if v_method = 'shares' and v_keys is null then
    raise exception 'Give at least one person a share.' using errcode = 'check_violation';
  end if;

  return query select a.key, a.cents from allocate_cents(p_total, v_keys, v_vals::bigint[]) a;
end $$;

-- ---------------------------------------------------------------- tables

create table public.recurring_bills (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.groups (id) on delete cascade,
  description   text not null check (length(trim(description)) between 1 and 120),
  category      public.expense_category not null default 'other',
  -- null: the amount changes each time, so ask for it when it falls due.
  amount_cents  bigint check (amount_cents > 0),
  paid_by       uuid not null references public.people (id),
  split         jsonb not null,
  every         text not null check (every in ('week', 'month')),
  -- Day of the month a monthly bill belongs on, so the 31st survives February.
  anchor_day    smallint not null check (anchor_day between 1 and 31),
  next_due      date not null,
  -- Stopping a bill turns it off; it is never deleted, because posted expenses point at it.
  active        boolean not null default true,
  created_by    uuid not null default auth.uid() references auth.users (id),
  created_at    timestamptz not null default now(),
  check (amount_cents is not null or split ->> 'method' <> 'exact')
);
create index recurring_due_idx on public.recurring_bills (next_due) where active;

create table public.expenses (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.groups (id),
  description   text not null check (length(trim(description)) between 1 and 120),
  category      public.expense_category not null default 'other',
  spent_on      date not null,
  amount_cents  bigint not null check (amount_cents > 0),
  currency      char(3) not null,
  paid_by       uuid not null references public.people (id),
  -- The split as entered; expense_shares holds what it came to.
  split         jsonb not null,
  recurring_id  uuid references public.recurring_bills (id),
  replaces_id   uuid references public.expenses (id),
  voided_at     timestamptz,
  voided_by     uuid references auth.users (id),
  created_by    uuid not null references auth.users (id),
  created_at    timestamptz not null default now()
);
create index expenses_group_idx on public.expenses (group_id, spent_on desc);

create table public.expense_shares (
  expense_id   uuid not null references public.expenses (id),
  group_id     uuid not null references public.groups (id),
  person_id    uuid not null references public.people (id),
  share_cents  bigint not null check (share_cents >= 0),
  primary key (expense_id, person_id)
);
create index expense_shares_person_idx on public.expense_shares (person_id);

create table public.due_bills (
  recurring_id  uuid not null references public.recurring_bills (id),
  due_on        date not null,
  group_id      uuid not null references public.groups (id) on delete cascade,
  status        text not null default 'waiting' check (status in ('waiting', 'entered', 'skipped')),
  expense_id    uuid references public.expenses (id),
  resolved_by   uuid references auth.users (id),
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  primary key (recurring_id, due_on),
  check ((status = 'entered') = (expense_id is not null))
);
create index due_bills_waiting_idx on public.due_bills (group_id) where status = 'waiting';

-- ---------------------------------------------------------------- integrity

-- An expense is never edited or deleted. The one change allowed is voiding it.
create function public.check_expense_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'expenses are append-only; void it instead' using errcode = 'restrict_violation';
  end if;
  if old.voided_at is not null or new.voided_at is null
     or (to_jsonb(new) - 'voided_at' - 'voided_by') <> (to_jsonb(old) - 'voided_at' - 'voided_by') then
    raise exception 'an expense cannot be edited; void it and record a corrected one' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create trigger expenses_append_only before update or delete on public.expenses
  for each row execute function public.check_expense_change();
create trigger expense_shares_append_only before update or delete on public.expense_shares
  for each row execute function public.forbid_change();

-- Next due date: +7 days, or the anchor day of next month (clamped to its last day).
-- Mirrors nextDue() in @marmoot/core.
create function public.next_due_date(p_from date, p_every text, p_anchor smallint) returns date
language sql immutable
as $$
  select case p_every
    when 'week' then p_from + 7
    else (
      select make_date(extract(year from m)::int, extract(month from m)::int,
                       least(p_anchor::int, extract(day from m + interval '1 month - 1 day')::int))
      from (select date_trunc('month', p_from::timestamp) + interval '1 month' as m) x
    )
  end;
$$;

-- A repeating bill must split among people in its group, in a way that adds up.
create function public.check_recurring_bill() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.anchor_day := coalesce(new.anchor_day, extract(day from new.next_due)::smallint);
  if new.amount_cents is null and new.split ->> 'method' = 'exact' then
    raise exception 'A bill whose amount changes cannot be split by exact amounts.' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.group_id <> old.group_id then
    raise exception 'a repeating bill cannot move to another group' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from (select new.paid_by as pid union all select s.person_id from split_amount(coalesce(new.amount_cents, 10000), new.split) s) x
    where not exists (select 1 from people p where p.id = x.pid and p.group_id = new.group_id)
  ) then
    raise exception 'everyone on a repeating bill must be in its group' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger recurring_bills_check before insert or update on public.recurring_bills
  for each row execute function public.check_recurring_bill();

-- ---------------------------------------------------------------- posting

-- Record one expense and post it: the payer is owed the total, everyone in the split
-- owes their share. Internal: clients call add_expense() or edit_expense().
create function public.post_expense(
  p_id           uuid,
  p_group        uuid,
  p_description  text,
  p_category     text,
  p_spent_on     date,
  p_amount       bigint,
  p_paid_by      uuid,
  p_split        jsonb,
  p_recurring    uuid,
  p_replaces     uuid,
  p_created_by   uuid
) returns public.expenses
language plpgsql security definer
set search_path = public
as $$
declare
  g groups%rowtype;
  v expenses%rowtype;
begin
  select * into g from groups where id = p_group;
  if not exists (select 1 from people p where p.id = p_paid_by and p.group_id = p_group) then
    raise exception 'The person who paid is not in this group.' using errcode = 'check_violation';
  end if;

  insert into expenses (id, group_id, description, category, spent_on, amount_cents, currency, paid_by, split, recurring_id, replaces_id, created_by)
  values (coalesce(p_id, gen_random_uuid()), p_group, trim(p_description), coalesce(p_category, 'other'),
          coalesce(p_spent_on, (now() at time zone g.time_zone)::date), p_amount, g.currency, p_paid_by, p_split,
          p_recurring, p_replaces, p_created_by)
  returning * into v;

  insert into expense_shares (expense_id, group_id, person_id, share_cents)
  select v.id, p_group, s.person_id, s.share_cents from split_amount(p_amount, p_split) s;

  if exists (
    select 1 from expense_shares es join people p on p.id = es.person_id
    where es.expense_id = v.id and p.group_id <> p_group
  ) then
    raise exception 'Everyone in the split must be in this group.' using errcode = 'check_violation';
  end if;

  insert into ledger_entries (group_id, person_id, amount_cents, currency, source, source_id)
  select p_group, n.person_id, n.net, g.currency, 'expense', v.id
  from (
    select t.person_id, sum(t.x)::bigint as net
    from (
      select es.person_id, -es.share_cents as x from expense_shares es where es.expense_id = v.id
      union all
      select p_paid_by, p_amount
    ) t
    group by t.person_id
  ) n
  where n.net <> 0;

  return v;
end $$;

-- Add an expense. Pass p_id (a uuid the app made) so a retried request after a
-- dropped connection returns the first one instead of adding it twice.
create function public.add_expense(
  p_group         uuid,
  p_description   text,
  p_amount_cents  bigint,
  p_paid_by       uuid,
  p_split         jsonb,
  p_spent_on      date default null,
  p_category      text default 'other',
  p_id            uuid default null
) returns public.expenses
language plpgsql security definer
set search_path = public
as $$
declare
  v expenses%rowtype;
begin
  if not is_member(p_group) then
    raise exception 'group % not found', p_group using errcode = 'no_data_found';
  end if;
  if p_id is not null then
    select * into v from expenses where id = p_id;
    if found then
      if v.group_id <> p_group then
        raise exception 'expense % belongs to another group', p_id using errcode = 'check_violation';
      end if;
      return v;
    end if;
  end if;
  return post_expense(p_id, p_group, p_description, p_category, p_spent_on, p_amount_cents, p_paid_by, p_split, null, null, auth.uid());
end $$;

-- Take an expense back out of everyone's balance. The row stays, marked void.
create function public.void_expense(p_expense uuid) returns public.expenses
language plpgsql security definer
set search_path = public
as $$
declare
  v expenses%rowtype;
begin
  select * into v from expenses where id = p_expense for update;
  if not found or not is_member(v.group_id) then
    raise exception 'expense % not found', p_expense using errcode = 'no_data_found';
  end if;
  if v.voided_at is not null then
    raise exception 'expense % is already void', p_expense using errcode = 'check_violation';
  end if;

  update expenses set voided_at = now(), voided_by = auth.uid() where id = p_expense returning * into v;

  insert into ledger_entries (group_id, person_id, amount_cents, currency, source, source_id)
  select l.group_id, l.person_id, -sum(l.amount_cents)::bigint, l.currency, 'expense', l.source_id
  from ledger_entries l
  where l.source = 'expense' and l.source_id = p_expense
  group by l.group_id, l.person_id, l.currency, l.source_id
  having sum(l.amount_cents) <> 0;

  return v;
end $$;

-- Change an expense: void it and record the corrected one, in one transaction.
create function public.edit_expense(
  p_expense       uuid,
  p_description   text,
  p_amount_cents  bigint,
  p_paid_by       uuid,
  p_split         jsonb,
  p_spent_on      date,
  p_category      text
) returns public.expenses
language plpgsql security definer
set search_path = public
as $$
declare
  old_e expenses%rowtype;
begin
  old_e := void_expense(p_expense);
  return post_expense(null, old_e.group_id, p_description, p_category, p_spent_on, p_amount_cents, p_paid_by, p_split,
                      old_e.recurring_id, old_e.id, auth.uid());
end $$;

-- ---------------------------------------------------------------- repeating bills

-- Post every fixed bill that has fallen due by p_today, and queue every variable one
-- as a due bill. Safe to run twice: each bill row is locked and moved past p_today.
-- Internal: clients call catch_up_recurring(); a scheduled job calls
-- catch_up_all_recurring().
create function public.run_recurring(p_group uuid, p_today date)
returns table (recurring_id uuid, due_on date, expense_id uuid)
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  r      recurring_bills%rowtype;
  v_next date;
  v_n    int;
  v_exp  expenses%rowtype;
begin
  for r in
    select * from recurring_bills b
    where b.group_id = p_group and b.active and b.next_due <= p_today
    order by b.next_due, b.id
    for update
  loop
    v_next := r.next_due;
    v_n := 0;
    -- A bill left a long time is caught up two years at most.
    while v_next <= p_today and v_n < 24 loop
      if r.amount_cents is not null then
        v_exp := post_expense(null, r.group_id, r.description, r.category, v_next, r.amount_cents, r.paid_by, r.split, r.id, null, r.created_by);
        recurring_id := r.id; due_on := v_next; expense_id := v_exp.id;
        return next;
      else
        insert into due_bills (recurring_id, due_on, group_id) values (r.id, v_next, r.group_id)
        on conflict do nothing;
        if found then
          recurring_id := r.id; due_on := v_next; expense_id := null;
          return next;
        end if;
      end if;
      v_next := next_due_date(v_next, r.every, r.anchor_day);
      v_n := v_n + 1;
    end loop;
    if v_next <= p_today then
      v_next := p_today + 1;
    end if;
    update recurring_bills set next_due = v_next where id = r.id;
  end loop;
end $$;

create function public.catch_up_recurring(p_group uuid)
returns table (recurring_id uuid, due_on date, expense_id uuid)
language plpgsql security definer
set search_path = public
as $$
declare
  v_tz text;
begin
  if not is_member(p_group) then
    raise exception 'group % not found', p_group using errcode = 'no_data_found';
  end if;
  select time_zone into v_tz from groups where id = p_group;
  return query select * from run_recurring(p_group, (now() at time zone v_tz)::date);
end $$;

-- For a scheduled job (pg_cron on Supabase), run hourly so every time zone is covered:
--   select cron.schedule('marmoot-recurring', '17 * * * *', 'select public.catch_up_all_recurring()');
create function public.catch_up_all_recurring() returns int
language plpgsql security definer
set search_path = public
as $$
declare
  g record;
  v_n int := 0;
begin
  for g in
    select distinct gr.id, gr.time_zone
    from groups gr join recurring_bills b on b.group_id = gr.id
    where b.active and b.next_due <= (now() at time zone gr.time_zone)::date
  loop
    v_n := v_n + (select count(*) from run_recurring(g.id, (now() at time zone g.time_zone)::date));
  end loop;
  return v_n;
end $$;

-- Enter this time's amount for a bill that changes each time, or skip it.
create function public.resolve_due_bill(p_recurring uuid, p_due_on date, p_amount_cents bigint default null)
returns public.due_bills
language plpgsql security definer
set search_path = public
as $$
declare
  d due_bills%rowtype;
  r recurring_bills%rowtype;
  v expenses%rowtype;
begin
  select * into d from due_bills where recurring_id = p_recurring and due_on = p_due_on for update;
  if not found or not is_member(d.group_id) then
    raise exception 'no bill is waiting for % on %', p_recurring, p_due_on using errcode = 'no_data_found';
  end if;
  if d.status <> 'waiting' then
    raise exception 'that bill was already %', d.status using errcode = 'check_violation';
  end if;
  select * into r from recurring_bills where id = p_recurring;

  if p_amount_cents is null then
    update due_bills set status = 'skipped', resolved_by = auth.uid(), resolved_at = now()
    where recurring_id = p_recurring and due_on = p_due_on
    returning * into d;
  else
    v := post_expense(null, r.group_id, r.description, r.category, p_due_on, p_amount_cents, r.paid_by, r.split, r.id, null, auth.uid());
    update due_bills set status = 'entered', expense_id = v.id, resolved_by = auth.uid(), resolved_at = now()
    where recurring_id = p_recurring and due_on = p_due_on
    returning * into d;
  end if;
  return d;
end $$;

-- ---------------------------------------------------------------- access

alter table public.expenses         enable row level security;
alter table public.expense_shares   enable row level security;
alter table public.recurring_bills  enable row level security;
alter table public.due_bills        enable row level security;

create policy expenses_read on public.expenses for select to authenticated using (is_member(group_id));
create policy shares_read   on public.expense_shares for select to authenticated using (is_member(group_id));
create policy due_read      on public.due_bills for select to authenticated using (is_member(group_id));

create policy recurring_read   on public.recurring_bills for select to authenticated using (is_member(group_id));
create policy recurring_create on public.recurring_bills for insert to authenticated with check (is_member(group_id) and created_by = auth.uid());
create policy recurring_update on public.recurring_bills for update to authenticated using (is_member(group_id)) with check (is_member(group_id));

-- Expenses, shares and due bills are written only by the functions above.
revoke all on public.expenses, public.expense_shares, public.due_bills from anon, authenticated;
grant select on public.expenses, public.expense_shares, public.due_bills to authenticated;
revoke all on public.recurring_bills from anon, authenticated;
grant select, insert, update on public.recurring_bills to authenticated;

revoke execute on function
  public.post_expense(uuid, uuid, text, text, date, bigint, uuid, jsonb, uuid, uuid, uuid),
  public.run_recurring(uuid, date),
  public.catch_up_all_recurring()
from public, anon, authenticated;

revoke execute on function
  public.add_expense(uuid, text, bigint, uuid, jsonb, date, text, uuid),
  public.void_expense(uuid),
  public.edit_expense(uuid, text, bigint, uuid, jsonb, date, text),
  public.catch_up_recurring(uuid),
  public.resolve_due_bill(uuid, date, bigint)
from public, anon;
grant execute on function
  public.add_expense(uuid, text, bigint, uuid, jsonb, date, text, uuid),
  public.void_expense(uuid),
  public.edit_expense(uuid, text, bigint, uuid, jsonb, date, text),
  public.catch_up_recurring(uuid),
  public.resolve_due_bill(uuid, date, bigint)
to authenticated;

-- ================================================================ 20261109060000_bill_sheets.sql

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
