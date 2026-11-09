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
