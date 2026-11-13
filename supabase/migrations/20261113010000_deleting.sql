-- Deleting things: a bill sheet by whoever holds its owner link, and a shared group,
-- for everyone, by the person who created it. Leaving a group stays as it was.

-- Members may now share removeSheet (a deleted bill sheet comes off the group's list).
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
    'addRecurring', 'deleteRecurring', 'catchUp', 'resolveDue', 'updateGame', 'addSheet', 'closeSheet', 'removeSheet'
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

-- A bill sheet, gone for everyone: every person's link stops working.
create function public.delete_bill_sheet(p_owner_token text) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  me bill_people%rowtype := owner_for_token(p_owner_token);
begin
  delete from bill_sheets where id = me.sheet_id;
end $$;

-- A shared group, gone for everyone in it. Only the person who created it may.
create function public.delete_shared_group(p_group uuid) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_user uuid := require_member(p_group);
begin
  if not exists (select 1 from group_members where group_id = p_group and user_id = v_user and role = 'owner') then
    raise exception 'Only the person who created this group can delete it for everyone. You can leave it instead.' using errcode = '42501';
  end if;
  delete from groups where id = p_group;
end $$;

revoke execute on function public.delete_bill_sheet(text), public.delete_shared_group(uuid) from public;
grant execute on function public.delete_bill_sheet(text) to anon, authenticated;
revoke execute on function public.delete_shared_group(uuid) from anon;
grant execute on function public.delete_shared_group(uuid) to authenticated;
