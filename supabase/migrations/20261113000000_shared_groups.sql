-- Shared groups: everyone in a group sees the same expenses and balances, on any phone.
--
-- A group's contents are an append-only log of the app's own actions: add an expense,
-- record a payment, add a member, close a bill sheet. Every phone replays the log in
-- order with the same code (apps/web/src/model.ts), so every member sees the same
-- balances. Nothing in the log is ever changed; a deleted expense is a later
-- "deleteItem" action.
--
-- People join with the group's invite link, then someone already in the group
-- approves them. The tables are closed to the API; only the functions below reach them.

-- ---------------------------------------------------------------- tables

create table public.group_events (
  group_id    uuid not null references public.groups (id) on delete cascade,
  seq         integer not null check (seq > 0),
  client_id   text not null unique check (length(client_id) between 8 and 80),
  action      jsonb not null check (jsonb_typeof(action) = 'object' and action ? 'type'),
  actor       uuid not null references auth.users (id),
  created_at  timestamptz not null default now(),
  primary key (group_id, seq),
  check (octet_length(action::text) <= 500000)
);

create trigger group_events_append_only before update on public.group_events
  for each row execute function public.forbid_change();

create table public.group_invites (
  group_id    uuid primary key references public.groups (id) on delete cascade,
  token       text not null unique default public.new_token(),
  inviter     text not null default '',
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now()
);

create table public.join_requests (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 60),
  email       text,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at  timestamptz not null default now(),
  decided_by  uuid references auth.users (id),
  decided_at  timestamptz,
  unique (group_id, user_id)
);

alter table public.group_events  enable row level security;
alter table public.group_invites enable row level security;
alter table public.join_requests enable row level security;
revoke all on public.group_events, public.group_invites, public.join_requests from anon, authenticated;

-- ---------------------------------------------------------------- helpers

create function public.require_user() returns uuid
language plpgsql stable
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

create function public.require_member(p_group uuid) returns uuid
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_user uuid := require_user();
begin
  if not is_member(p_group) then
    raise exception 'You''re not in this group.' using errcode = '42501';
  end if;
  return v_user;
end $$;

-- Actions a member may add to a group's log. createGroup only comes from
-- create_shared_group(). A member can be linked only to someone already in the group.
create function public.check_group_action(p_group uuid, p_action jsonb) returns void
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_type text := p_action ->> 'type';
  v_user text := p_action -> 'member' ->> 'userId';
begin
  if v_type is null or v_type not in (
    'renameGroup', 'addMember', 'updateMember', 'removeMember', 'addItem', 'deleteItem',
    'addRecurring', 'deleteRecurring', 'catchUp', 'resolveDue', 'updateGame', 'addSheet', 'closeSheet'
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

-- Appends in order. One writer per group at a time, so seq never skips or repeats,
-- and a reader that has seen seq n has seen everything before it.
create function public.insert_group_events(p_group uuid, p_user uuid, p_events jsonb, p_first boolean default false) returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  e       jsonb;
  v_seq   integer;
begin
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) > 200 then
    raise exception 'Send between 1 and 200 changes at a time.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_group::text, 7));
  select coalesce(max(seq), 0) into v_seq from group_events where group_id = p_group;
  for e in select value from jsonb_array_elements(p_events) loop
    if (e ->> 'client_id') is null or jsonb_typeof(e -> 'action') is distinct from 'object' then
      raise exception 'Each change needs a client_id and an action.' using errcode = '22023';
    end if;
    -- A retry of something already saved: skip it.
    continue when exists (select 1 from group_events where client_id = e ->> 'client_id');
    -- Only the very first entry of a log may be the group itself.
    if not (p_first and v_seq = 0 and e -> 'action' ->> 'type' = 'createGroup') then
      perform check_group_action(p_group, e -> 'action');
    end if;
    v_seq := v_seq + 1;
    insert into group_events (group_id, seq, client_id, action, actor)
    values (p_group, v_seq, e ->> 'client_id', e -> 'action', p_user);
    if e -> 'action' ->> 'type' = 'renameGroup' and length(trim(e -> 'action' ->> 'name')) > 0 then
      update groups set name = trim(e -> 'action' ->> 'name') where id = p_group;
    end if;
  end loop;
  return v_seq;
end $$;

-- ---------------------------------------------------------------- the API

-- Starts a shared group from the app's own copy of it (a new group, or one moving
-- from this phone). Retrying with the same id is harmless.
create function public.create_shared_group(p_id uuid, p_name text, p_client_id text, p_snapshot jsonb) returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  v_user uuid := require_user();
begin
  if exists (select 1 from groups where id = p_id) then
    if is_member(p_id) then
      return (select coalesce(max(seq), 0) from group_events where group_id = p_id);
    end if;
    raise exception 'That group already exists.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_snapshot) is distinct from 'object' or p_snapshot ->> 'id' is distinct from p_id::text then
    raise exception 'The group''s contents don''t match its id.' using errcode = '22023';
  end if;
  insert into groups (id, name, created_by) values (p_id, trim(p_name), v_user);
  return insert_group_events(p_id, v_user, jsonb_build_array(jsonb_build_object(
    'client_id', p_client_id,
    'action', jsonb_build_object('type', 'createGroup', 'group', p_snapshot)
  )), true);
end $$;

create function public.append_group_events(p_group uuid, p_events jsonb) returns integer
language plpgsql security definer
set search_path = public
as $$
begin
  return insert_group_events(p_group, require_member(p_group), p_events);
end $$;

-- The log after a point, oldest first.
create function public.group_events_since(p_group uuid, p_after integer default 0, p_limit integer default 500)
returns table (seq integer, client_id text, action jsonb, actor uuid, created_at timestamptz)
language plpgsql stable security definer
set search_path = public
as $$
begin
  perform require_member(p_group);
  return query
    select e.seq, e.client_id, e.action, e.actor, e.created_at
    from group_events e
    where e.group_id = p_group and e.seq > coalesce(p_after, 0)
    order by e.seq
    limit least(greatest(coalesce(p_limit, 500), 1), 1000);
end $$;

-- The groups you're in, with how far each one's log goes.
create function public.my_groups()
returns table (id uuid, name text, role text, members integer, last_seq integer, pending_requests integer)
language sql stable security definer
set search_path = public
as $$
  select g.id, g.name, m.role,
         (select count(*)::integer from group_members x where x.group_id = g.id),
         (select coalesce(max(e.seq), 0) from group_events e where e.group_id = g.id),
         (select count(*)::integer from join_requests r where r.group_id = g.id and r.status = 'pending')
  from group_members m
  join groups g on g.id = m.group_id
  where m.user_id = auth.uid()
  order by g.created_at;
$$;

create function public.leave_group(p_group uuid) returns void
language plpgsql security definer
set search_path = public
as $$
begin
  delete from group_members where group_id = p_group and user_id = require_user();
end $$;

-- The group's invite link token, made on first use. p_reset makes a new one, so the
-- old link stops working.
create function public.group_invite(p_group uuid, p_inviter text default '', p_reset boolean default false) returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := require_member(p_group);
  v_token text;
begin
  insert into group_invites (group_id, inviter, created_by)
  values (p_group, left(trim(coalesce(p_inviter, '')), 60), v_user)
  on conflict (group_id) do update
    set token      = case when p_reset then new_token() else group_invites.token end,
        inviter    = case when length(trim(coalesce(p_inviter, ''))) > 0 then left(trim(p_inviter), 60) else group_invites.inviter end,
        created_by = case when p_reset then v_user else group_invites.created_by end
  returning token into v_token;
  return v_token;
end $$;

-- What an invite link leads to, for the page it opens. Works before signing in.
create function public.invite_info(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  i        group_invites;
  v_status text;
begin
  select * into i from group_invites where token = p_token;
  if not found then
    raise exception 'This invite link doesn''t work any more. Ask for a new one.' using errcode = 'P0002';
  end if;
  v_status := case
    when auth.uid() is null then 'signed_out'
    when exists (select 1 from group_members where group_id = i.group_id and user_id = auth.uid()) then 'member'
    else coalesce((select status from join_requests where group_id = i.group_id and user_id = auth.uid()), 'none')
  end;
  return jsonb_build_object(
    'group_id', i.group_id,
    'group_name', (select name from groups where id = i.group_id),
    'inviter', i.inviter,
    'members', (select count(*) from group_members where group_id = i.group_id),
    'status', v_status
  );
end $$;

-- Ask to join. Someone already in the group approves or declines.
create function public.request_to_join(p_token text, p_name text) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := require_user();
  v_group uuid;
begin
  select group_id into v_group from group_invites where token = p_token;
  if not found then
    raise exception 'This invite link doesn''t work any more. Ask for a new one.' using errcode = 'P0002';
  end if;
  if exists (select 1 from group_members where group_id = v_group and user_id = v_user) then
    return jsonb_build_object('group_id', v_group, 'status', 'member');
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 then
    raise exception 'Add your name, so they know who''s asking.' using errcode = '22023';
  end if;
  insert into join_requests (group_id, user_id, name, email)
  values (v_group, v_user, left(trim(p_name), 60), auth.jwt() ->> 'email')
  on conflict (group_id, user_id) do update
    set name       = excluded.name,
        email      = excluded.email,
        status     = 'pending',
        created_at = case when join_requests.status = 'pending' then join_requests.created_at else now() end,
        decided_by = null,
        decided_at = null;
  return jsonb_build_object('group_id', v_group, 'status', 'pending');
end $$;

create function public.group_join_requests(p_group uuid)
returns table (id uuid, user_id uuid, name text, email text, created_at timestamptz)
language plpgsql stable security definer
set search_path = public
as $$
begin
  perform require_member(p_group);
  return query
    select r.id, r.user_id, r.name, r.email, r.created_at
    from join_requests r
    where r.group_id = p_group and r.status = 'pending'
    order by r.created_at;
end $$;

-- Approve or decline. Approving adds them to the group and, in the same step, records
-- p_action: linking them to a member already listed (updateMember) or adding them
-- (addMember).
create function public.decide_join_request(p_request uuid, p_approve boolean, p_client_id text default null, p_action jsonb default null) returns text
language plpgsql security definer
set search_path = public
as $$
declare
  r      join_requests;
  v_user uuid;
begin
  select * into r from join_requests where id = p_request for update;
  if not found then
    raise exception 'That request is gone.' using errcode = 'P0002';
  end if;
  v_user := require_member(r.group_id);
  if r.status <> 'pending' then
    return r.status;
  end if;
  if not p_approve then
    update join_requests set status = 'declined', decided_by = v_user, decided_at = now() where id = r.id;
    return 'declined';
  end if;
  if p_action is not null and (
       coalesce(p_action ->> 'type', '') not in ('addMember', 'updateMember')
    or p_action -> 'member' ->> 'userId' is distinct from r.user_id::text
  ) then
    raise exception 'Approving can only add or link the person who asked.' using errcode = '22023';
  end if;
  insert into group_members (group_id, user_id, role) values (r.group_id, r.user_id, 'member')
    on conflict do nothing;
  update join_requests set status = 'approved', decided_by = v_user, decided_at = now() where id = r.id;
  if p_action is not null then
    perform insert_group_events(r.group_id, v_user, jsonb_build_array(jsonb_build_object('client_id', p_client_id, 'action', p_action)));
  end if;
  return 'approved';
end $$;

-- ---------------------------------------------------------------- who may call what

revoke execute on function
  public.require_member(uuid), public.check_group_action(uuid, jsonb), public.insert_group_events(uuid, uuid, jsonb, boolean)
from public, anon, authenticated;

revoke execute on function
  public.create_shared_group(uuid, text, text, jsonb), public.append_group_events(uuid, jsonb),
  public.group_events_since(uuid, integer, integer), public.my_groups(), public.leave_group(uuid),
  public.group_invite(uuid, text, boolean), public.request_to_join(text, text),
  public.group_join_requests(uuid), public.decide_join_request(uuid, boolean, text, jsonb)
from public, anon;

grant execute on function
  public.create_shared_group(uuid, text, text, jsonb), public.append_group_events(uuid, jsonb),
  public.group_events_since(uuid, integer, integer), public.my_groups(), public.leave_group(uuid),
  public.group_invite(uuid, text, boolean), public.request_to_join(text, text),
  public.group_join_requests(uuid), public.decide_join_request(uuid, boolean, text, jsonb)
to authenticated;

-- The invite page works before signing in.
grant execute on function public.invite_info(text) to anon, authenticated;
