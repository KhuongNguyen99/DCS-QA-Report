-- Add a shared QA report revision to an existing project. Existing report data
-- is baseline revision 3. Re-running preserves the current revision and notes.
begin;
do $$ begin
  if to_regclass('public.qa_walkdowns') is not null then raise exception 'This migration predates named skids. Use named-walkdowns.sql instead.'; end if;
end; $$;

create table if not exists public.qa_project (
  id integer primary key default 1 check (id = 1),
  revision bigint not null default 3 check (revision >= 3),
  updated_at timestamptz not null default now(),
  last_change_txid bigint
);
insert into public.qa_project (id) values (1) on conflict (id) do nothing;
alter table public.qa_project enable row level security;
revoke all on public.qa_project from public, anon, authenticated;
grant select on public.qa_project to authenticated;
drop policy if exists qa_project_read on public.qa_project;
create policy qa_project_read on public.qa_project for select to authenticated using ((select qa_private.is_inspector()));

create or replace function qa_private.bump_report_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- The row lock serializes simultaneous saves. All affected rows in one RPC
  -- share a transaction ID, so a photo + device + terminal change advances once.
  update public.qa_project
  set revision = revision + 1, updated_at = clock_timestamp(), last_change_txid = pg_catalog.txid_current()
  where id = 1 and last_change_txid is distinct from pg_catalog.txid_current();
  return null;
end;
$$;
revoke all on function qa_private.bump_report_revision() from public, anon, authenticated;

create or replace trigger qa_records_report_revision
after update on public.qa_records for each row
when (old.* is distinct from new.*)
execute function qa_private.bump_report_revision();

create or replace trigger qa_comments_report_revision
after insert on public.qa_comments for each row
execute function qa_private.bump_report_revision();

-- Pending reservations/cancellations are not report evidence. Only visible,
-- finalized evidence entering, changing, or leaving the report advances it.
create or replace trigger qa_photos_insert_report_revision
after insert on public.qa_photos for each row
when (new.upload_state = 'ready' and new.deleted_at is null)
execute function qa_private.bump_report_revision();

create or replace trigger qa_photos_update_report_revision
after update on public.qa_photos for each row
when (old.* is distinct from new.* and (
  (old.upload_state = 'ready' and old.deleted_at is null)
  or (new.upload_state = 'ready' and new.deleted_at is null)
))
execute function qa_private.bump_report_revision();

create or replace trigger qa_photos_delete_report_revision
after delete on public.qa_photos for each row
when (old.upload_state = 'ready' and old.deleted_at is null)
execute function qa_private.bump_report_revision();

create or replace function public.qa_load_state()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform qa_private.require_inspector();
  select jsonb_build_object(
    'project', (select jsonb_build_object('title', '450k Skid x7 - DCS', 'revision', p.revision,
      'scheduleRevision', 3, 'updatedAt', p.updated_at) from public.qa_project p where p.id = 1),
    'inspector', (select jsonb_build_object('id', u.id, 'email', u.email, 'name', i.display_name, 'isAdmin', i.is_admin)
      from auth.users u join public.qa_inspectors i on i.email = lower(u.email) where u.id = auth.uid()),
    'records', coalesce((select jsonb_agg(jsonb_build_object(
      'key', r.key, 'complete', r.complete, 'completedAt', r.completed_at, 'completedBy', r.completed_by, 'updatedAt', r.updated_at,
      'quality', r.quality, 'qualityBy', r.quality_by, 'qualityAt', r.quality_at
    ) order by r.key) from public.qa_records r), '[]'::jsonb),
    'photos', coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'recordKey', p.record_key, 'path', p.path, 'name', p.name, 'width', p.width, 'height', p.height,
      'createdAt', p.created_at, 'createdBy', p.created_by
    ) order by p.created_at, p.id) from public.qa_photos p where p.deleted_at is null and p.upload_state = 'ready'), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'recordKey', coalesce(c.record_key, 'walkdown:general'), 'text', c.text, 'createdAt', c.created_at, 'createdBy', c.created_by, 'authorName', c.author_name
    ) order by c.created_at, c.id) from public.qa_comments c), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.qa_load_state() from public, anon, authenticated;
grant execute on function public.qa_load_state() to authenticated;
commit;
