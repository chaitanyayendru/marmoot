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
