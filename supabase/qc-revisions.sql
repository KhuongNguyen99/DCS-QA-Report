-- QC closeout revisions. Existing report numbers and evidence are preserved.
-- Run on a named-skid deployment; new installations use schema.sql instead.
begin;
do $$ begin
  if to_regclass('public.qa_walkdowns') is null then
    raise exception 'Install the current schema.sql before enabling QC revisions.';
  end if;
end; $$;

alter table public.qa_walkdowns drop constraint if exists qa_walkdowns_revision_check;
alter table public.qa_walkdowns add constraint qa_walkdowns_revision_check check (revision >= 1);
alter table public.qa_walkdowns alter column revision set default 1;
alter table public.qa_walkdowns add column if not exists status text not null default 'draft' check (status in ('draft', 'closed'));
alter table public.qa_walkdowns add column if not exists content_version bigint not null default 1 check (content_version >= 1);
alter table public.qa_walkdowns add column if not exists closed_at timestamptz;
alter table public.qa_walkdowns add column if not exists closed_by uuid references auth.users(id);
alter table public.qa_walkdowns add column if not exists closed_by_name text;
alter table public.qa_comments add column if not exists deleted_at timestamptz;
alter table public.qa_comments add column if not exists deleted_by uuid references auth.users(id);
alter table public.qa_photos add column if not exists reserved_revision bigint;
alter table public.qa_photos disable trigger qa_photos_update_report_revision;
update public.qa_photos p set reserved_revision = w.revision
from public.qa_walkdowns w where w.id = p.walkdown_id and p.reserved_revision is null;
alter table public.qa_photos enable trigger qa_photos_update_report_revision;
alter table public.qa_photos alter column reserved_revision set not null;

create table if not exists public.qa_report_revisions (
  walkdown_id uuid not null references public.qa_walkdowns(id),
  revision bigint not null check (revision >= 1),
  skid_name text not null,
  closed_at timestamptz not null,
  closed_by uuid not null references auth.users(id),
  closed_by_name text not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  primary key (walkdown_id, revision)
);
create table if not exists public.qa_revision_photos (
  walkdown_id uuid not null,
  revision bigint not null,
  photo_id uuid not null references public.qa_photos(id),
  path text not null,
  primary key (walkdown_id, revision, photo_id),
  foreign key (walkdown_id, revision) references public.qa_report_revisions(walkdown_id, revision)
);
create index if not exists qa_revision_photos_path on public.qa_revision_photos(path);
alter table public.qa_report_revisions enable row level security;
alter table public.qa_revision_photos enable row level security;
revoke all on public.qa_report_revisions, public.qa_revision_photos from public, anon, authenticated;
grant select on public.qa_report_revisions, public.qa_revision_photos to authenticated;
drop policy if exists qa_report_revisions_read on public.qa_report_revisions;
create policy qa_report_revisions_read on public.qa_report_revisions for select to authenticated using ((select qa_private.is_inspector()));
drop policy if exists qa_revision_photos_read on public.qa_revision_photos;
create policy qa_revision_photos_read on public.qa_revision_photos for select to authenticated using ((select qa_private.is_inspector()));
drop policy if exists qa_comments_read on public.qa_comments;
create policy qa_comments_read on public.qa_comments for select to authenticated using ((select qa_private.is_inspector()) and deleted_at is null);

create or replace function qa_private.require_walkdown(p_walkdown_id uuid, p_write boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare report public.qa_walkdowns%rowtype;
begin
  perform qa_private.require_inspector();
  if p_write then perform pg_catalog.pg_advisory_xact_lock(450007, pg_catalog.hashtext(p_walkdown_id::text)); end if;
  select * into report from public.qa_walkdowns where id = p_walkdown_id;
  if not found then raise exception 'Choose an existing skid walkdown.'; end if;
  if p_write and report.name_required then raise exception 'Name this skid before saving inspection changes.'; end if;
  if p_write and report.status <> 'draft' then raise exception 'This revision is approved and closed. Start a new revision to make changes.'; end if;
end;
$$;

create or replace function qa_private.require_draft_revision(p_walkdown_id uuid, p_expected_revision bigint, p_allow_unnamed boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare report public.qa_walkdowns%rowtype;
begin
  perform qa_private.require_walkdown(p_walkdown_id, false);
  perform pg_catalog.pg_advisory_xact_lock(450007, pg_catalog.hashtext(p_walkdown_id::text));
  select * into report from public.qa_walkdowns where id = p_walkdown_id;
  if p_expected_revision is null or report.revision <> p_expected_revision then
    raise exception 'This report has a different revision. Refresh before saving changes.';
  end if;
  if report.status <> 'draft' then raise exception 'This revision is approved and closed. Start a new revision to make changes.'; end if;
  if report.name_required and not p_allow_unnamed then raise exception 'Name this skid before saving inspection changes.'; end if;
end;
$$;

-- Existing content hooks now update only the optimistic review token. A report
-- number advances solely through qa_new_revision, once per explicit closeout.
create or replace function qa_private.mark_walkdown_changed(p_walkdown_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.qa_walkdowns set content_version = content_version + 1,
    updated_at = clock_timestamp(), last_change_txid = pg_catalog.txid_current()
  where id = p_walkdown_id and last_change_txid is distinct from pg_catalog.txid_current();
end;
$$;
create or replace trigger qa_comments_update_report_revision after update on public.qa_comments for each row
when (old.* is distinct from new.*) execute function qa_private.bump_report_revision();

-- Defense in depth: even accidental maintenance writes cannot alter a closed
-- report. Pending upload cancellation is cleanup, never part of its snapshot.
create or replace function qa_private.guard_report_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare report_id uuid; report_status text;
begin
  if tg_op = 'DELETE' then report_id := old.walkdown_id; else report_id := new.walkdown_id; end if;
  perform pg_catalog.pg_advisory_xact_lock(450007, pg_catalog.hashtext(report_id::text));
  select status into report_status from public.qa_walkdowns where id = report_id;
  if report_status <> 'draft' then
    if tg_table_name = 'qa_photos' and tg_op = 'UPDATE' then
      if old.upload_state = 'pending' and new.deleted_at is not null
        and (to_jsonb(old) - 'deleted_at' - 'deleted_by') = (to_jsonb(new) - 'deleted_at' - 'deleted_by') then return new; end if;
    end if;
    raise exception 'This revision is approved and closed. Start a new revision to make changes.';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
create or replace trigger qa_records_draft_only before insert or update or delete on public.qa_records
for each row execute function qa_private.guard_report_row();
create or replace trigger qa_comments_draft_only before insert or update or delete on public.qa_comments
for each row execute function qa_private.guard_report_row();
create or replace trigger qa_photos_draft_only before insert or update or delete on public.qa_photos
for each row execute function qa_private.guard_report_row();

create or replace function qa_private.keep_closed_revision()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'Approved QC revisions and their evidence references are immutable.'; end;
$$;
create or replace trigger qa_report_revisions_immutable before update or delete on public.qa_report_revisions
for each row execute function qa_private.keep_closed_revision();
create or replace trigger qa_revision_photos_immutable before update or delete on public.qa_revision_photos
for each row execute function qa_private.keep_closed_revision();

create or replace function qa_private.walkdown_info(p_walkdown_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', id, 'skidName', skid_name, 'nameRequired', name_required,
    'revision', revision, 'updatedAt', updated_at, 'createdAt', created_at,
    'status', status, 'contentVersion', content_version, 'closedAt', closed_at,
    'closedBy', closed_by, 'closedByName', closed_by_name)
  from public.qa_walkdowns where id = p_walkdown_id;
$$;

create or replace function qa_private.current_inspector()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', u.id, 'email', u.email, 'name', i.display_name, 'isAdmin', i.is_admin)
  from auth.users u join public.qa_inspectors i on i.email = lower(u.email) where u.id = auth.uid();
$$;

-- Functional-test storage is an optional extension. Keep its state hook when
-- rerunning this migration so existing imported runs remain in future snapshots.
do $install_test_runs_hook$
begin
  if to_regprocedure('qa_private.test_runs_state(uuid)') is null then
    execute $hook$create function qa_private.test_runs_state(p_walkdown_id uuid)
      returns jsonb language sql stable security definer set search_path = '' as
      'select ''[]''::jsonb';$hook$;
  end if;
end;
$install_test_runs_hook$;

create or replace function qa_private.live_report_state(p_walkdown_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'project', jsonb_build_object('title', '450k Skid x7 - DCS', 'revision', w.revision, 'scheduleRevision', 3,
      'updatedAt', w.updated_at, 'walkdownId', w.id, 'skidName', w.skid_name, 'nameRequired', w.name_required,
      'status', w.status, 'contentVersion', w.content_version, 'closedAt', w.closed_at,
      'closedBy', w.closed_by, 'closedByName', w.closed_by_name),
    'inspector', qa_private.current_inspector(),
    'testRuns', qa_private.test_runs_state(p_walkdown_id),
    'catalog', coalesce((select jsonb_agg(jsonb_build_object('key', t.key, 'kind', t.kind, 'terminal', t.terminal, 'label', case when t.kind = 'terminal' then 'Terminal ' || t.label else t.label end)
      order by case when t.kind = 'equipment' then 0 else 1 end,
      case when t.kind = 'equipment' then t.key else t.terminal end,
      case when t.kind = 'terminal' then 0 else 1 end, t.key) from public.qa_targets t), '[]'::jsonb),
    'records', coalesce((select jsonb_agg(jsonb_build_object('key', r.key, 'complete', r.complete,
      'completedAt', r.completed_at, 'completedBy', r.completed_by, 'updatedAt', r.updated_at,
      'quality', r.quality, 'qualityBy', r.quality_by, 'qualityAt', r.quality_at) order by r.key)
      from public.qa_records r where r.walkdown_id = p_walkdown_id), '[]'::jsonb),
    'photos', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'walkdownId', p.walkdown_id, 'recordKey', p.record_key,
      'path', p.path, 'name', p.name, 'width', p.width, 'height', p.height, 'createdAt', p.created_at, 'createdBy', p.created_by) order by p.created_at, p.id)
      from public.qa_photos p where p.walkdown_id = p_walkdown_id and p.deleted_at is null and p.upload_state = 'ready'), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'walkdownId', c.walkdown_id,
      'recordKey', coalesce(c.record_key, 'walkdown:general'), 'text', c.text, 'createdAt', c.created_at,
      'createdBy', c.created_by, 'authorName', c.author_name) order by c.created_at, c.id)
      from public.qa_comments c where c.walkdown_id = p_walkdown_id and c.deleted_at is null), '[]'::jsonb)
  ) from public.qa_walkdowns w where w.id = p_walkdown_id;
$$;

create or replace function public.qa_load_state(p_walkdown_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform qa_private.require_walkdown(p_walkdown_id, false);
  -- Serialize this read with close/new so project metadata and evidence agree.
  perform pg_catalog.pg_advisory_xact_lock_shared(450007, pg_catalog.hashtext(p_walkdown_id::text));
  select r.snapshot into result from public.qa_report_revisions r join public.qa_walkdowns w
    on w.id = r.walkdown_id and w.revision = r.revision
    where w.id = p_walkdown_id and w.status = 'closed';
  if found then return result || jsonb_build_object('inspector', qa_private.current_inspector(), 'revisions', public.qa_list_revisions(p_walkdown_id)); end if;
  return qa_private.live_report_state(p_walkdown_id) || jsonb_build_object('revisions', public.qa_list_revisions(p_walkdown_id));
end;
$$;

create or replace function public.qa_list_revisions(p_walkdown_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_walkdown(p_walkdown_id, false);
  return coalesce((select jsonb_agg(jsonb_build_object('revision', revision, 'skidName', skid_name,
    'closedAt', closed_at, 'closedBy', closed_by, 'closedByName', closed_by_name,
    'testRunCount', case when jsonb_typeof(snapshot->'testRuns') = 'array' then jsonb_array_length(snapshot->'testRuns') else 0 end) order by revision desc)
    from public.qa_report_revisions where walkdown_id = p_walkdown_id), '[]'::jsonb);
end;
$$;

create or replace function public.qa_load_revision(p_walkdown_id uuid, p_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform qa_private.require_walkdown(p_walkdown_id, false);
  select snapshot into result from public.qa_report_revisions where walkdown_id = p_walkdown_id and revision = p_revision;
  if not found then raise exception 'Choose an approved and closed revision to export.'; end if;
  return result || jsonb_build_object('inspector', qa_private.current_inspector());
end;
$$;

create or replace function public.qa_approve_revision(p_walkdown_id uuid, p_expected_revision bigint, p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare report public.qa_walkdowns%rowtype; result jsonb; approver text;
begin
  perform qa_private.require_walkdown(p_walkdown_id, false);
  perform pg_catalog.pg_advisory_xact_lock(450007, pg_catalog.hashtext(p_walkdown_id::text));
  select * into report from public.qa_walkdowns where id = p_walkdown_id;
  if p_expected_revision is null or report.revision <> p_expected_revision then raise exception 'This report has a different revision. Refresh before approving.'; end if;
  if p_expected_version is null or report.content_version <> p_expected_version then
    raise exception 'The report changed since you reviewed it. Refresh and review the latest changes before approving.';
  end if;
  if report.status = 'closed' then return public.qa_load_state(p_walkdown_id); end if;
  if report.name_required then raise exception 'Name this skid before approving its QC report.'; end if;
  if exists (select 1 from public.qa_photos p where p.walkdown_id = p_walkdown_id and p.deleted_at is null and p.upload_state = 'ready'
    and not exists (select 1 from storage.objects o where o.bucket_id = 'qa-evidence' and o.name = p.path)) then
    raise exception 'An evidence image is missing from storage. Restore or remove it before approving.';
  end if;
  select display_name into approver from public.qa_inspectors i join auth.users u on i.email = lower(u.email) where u.id = auth.uid();
  -- In-flight reservations are not approved evidence. Cancel them atomically so
  -- a late upload/finalization cannot enter a subsequent revision unnoticed.
  update public.qa_photos set deleted_at = clock_timestamp(), deleted_by = auth.uid()
  where walkdown_id = p_walkdown_id and upload_state = 'pending' and deleted_at is null;
  update public.qa_walkdowns set status = 'closed', closed_at = clock_timestamp(), closed_by = auth.uid(),
    closed_by_name = approver, updated_at = clock_timestamp() where id = p_walkdown_id;
  result := qa_private.live_report_state(p_walkdown_id);
  insert into public.qa_report_revisions(walkdown_id, revision, skid_name, closed_at, closed_by, closed_by_name, snapshot)
  select id, revision, skid_name, closed_at, closed_by, closed_by_name, result - 'inspector'
  from public.qa_walkdowns where id = p_walkdown_id;
  insert into public.qa_revision_photos(walkdown_id, revision, photo_id, path)
  select p_walkdown_id, p_expected_revision, p.id, p.path from public.qa_photos p
  where p.walkdown_id = p_walkdown_id and p.upload_state = 'ready' and p.deleted_at is null;
  return result || jsonb_build_object('revisions', public.qa_list_revisions(p_walkdown_id));
end;
$$;

create or replace function public.qa_new_revision(p_walkdown_id uuid, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare report public.qa_walkdowns%rowtype;
begin
  perform qa_private.require_walkdown(p_walkdown_id, false);
  perform pg_catalog.pg_advisory_xact_lock(450007, pg_catalog.hashtext(p_walkdown_id::text));
  select * into report from public.qa_walkdowns where id = p_walkdown_id;
  if p_expected_revision is null or report.revision <> p_expected_revision then
    raise exception 'This report has a different revision. Refresh before starting another revision.';
  end if;
  if report.status <> 'closed' then raise exception 'Approve and close the current revision before starting a new revision.'; end if;
  if not exists (select 1 from public.qa_report_revisions where walkdown_id = p_walkdown_id and revision = p_expected_revision) then
    raise exception 'The approved revision snapshot is missing. Contact the project administrator.';
  end if;
  update public.qa_walkdowns set revision = revision + 1, status = 'draft', content_version = content_version + 1,
    closed_at = null, closed_by = null, closed_by_name = null, updated_at = clock_timestamp(),
    last_change_txid = pg_catalog.txid_current() where id = p_walkdown_id;
  return qa_private.live_report_state(p_walkdown_id) || jsonb_build_object('revisions', public.qa_list_revisions(p_walkdown_id));
end;
$$;

-- Original mutation signatures remain private implementation details. New
-- browser overloads pin every save to the draft the inspector actually opened.
create or replace function public.qa_rename_walkdown(p_walkdown_id uuid, p_skid_name text, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision, true);
  return public.qa_rename_walkdown(p_walkdown_id, p_skid_name);
end;
$$;
create or replace function public.qa_prepare_photo(p_walkdown_id uuid, p_id uuid, p_record_key text, p_path text, p_name text, p_width integer, p_height integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_walkdown(p_walkdown_id, true);
  if not exists (select 1 from public.qa_targets where key = p_record_key) then raise exception 'Unknown inspection target.'; end if;
  if p_path is null or p_path not in (auth.uid()::text || '/' || p_id::text || '.jpg', auth.uid()::text || '/' || p_id::text || '.png', auth.uid()::text || '/' || p_id::text || '.webp') then
    raise exception 'Invalid photo storage path.';
  end if;
  insert into public.qa_photos(id, walkdown_id, record_key, path, name, width, height, created_by, reserved_revision)
  select p_id, p_walkdown_id, p_record_key, p_path, trim(p_name), p_width, p_height, auth.uid(), revision
  from public.qa_walkdowns where id = p_walkdown_id;
end;
$$;
create or replace function public.qa_prepare_photo(p_walkdown_id uuid, p_id uuid, p_record_key text, p_path text, p_name text, p_width integer, p_height integer, p_expected_revision bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  perform public.qa_prepare_photo(p_walkdown_id, p_id, p_record_key, p_path, p_name, p_width, p_height);
end;
$$;
create or replace function public.qa_add_photo(p_walkdown_id uuid, p_id uuid, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  if not exists (select 1 from public.qa_photos where walkdown_id = p_walkdown_id and id = p_id
    and reserved_revision = p_expected_revision and deleted_at is null) then
    raise exception 'The photo reservation was not found in this skid revision. Choose the photo again.';
  end if;
  return public.qa_add_photo(p_walkdown_id, p_id);
end;
$$;
create or replace function public.qa_cancel_photo(p_walkdown_id uuid, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare photo public.qa_photos%rowtype;
begin
  perform qa_private.require_walkdown(p_walkdown_id, false);
  perform pg_catalog.pg_advisory_xact_lock(450007, pg_catalog.hashtext(p_walkdown_id::text));
  select * into photo from public.qa_photos where id = p_id and walkdown_id = p_walkdown_id and created_by = auth.uid();
  if not found then raise exception 'The photo reservation was not found in this skid walkdown.'; end if;
  if photo.upload_state = 'ready' then raise exception 'This photo is already saved. Refresh the inspection to view it.'; end if;
  update public.qa_photos set deleted_at = coalesce(deleted_at, clock_timestamp()), deleted_by = coalesce(deleted_by, auth.uid()) where id = p_id;
end;
$$;
create or replace function public.qa_add_comment(p_walkdown_id uuid, p_record_key text, p_text text, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  return public.qa_add_comment(p_walkdown_id, p_record_key, p_text);
end;
$$;
create or replace function public.qa_delete_comment(p_walkdown_id uuid, p_id uuid, p_expected_revision bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare note public.qa_comments%rowtype;
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  select * into note from public.qa_comments where walkdown_id = p_walkdown_id and id = p_id;
  if not found then raise exception 'Comment not found in this skid walkdown.'; end if;
  if note.created_by <> auth.uid() and not qa_private.is_admin() then
    raise exception 'Only the author or a project administrator can remove this comment.' using errcode = '42501';
  end if;
  if note.deleted_at is null then
    update public.qa_comments set deleted_at = clock_timestamp(), deleted_by = auth.uid() where id = p_id;
    if note.record_key is not null then perform qa_private.touch_record(p_walkdown_id, note.record_key, false); end if;
  end if;
end;
$$;
create or replace function public.qa_set_complete(p_walkdown_id uuid, p_record_key text, p_complete boolean, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  return public.qa_set_complete(p_walkdown_id, p_record_key, p_complete);
end;
$$;
create or replace function public.qa_set_quality(p_walkdown_id uuid, p_record_key text, p_quality text, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  if p_quality is not null and p_quality not in ('good', 'bad') then raise exception 'Quality must be Passed, Failed, or unrated.'; end if;
  return public.qa_set_quality(p_walkdown_id, p_record_key, p_quality);
end;
$$;
create or replace function public.qa_delete_photo(p_walkdown_id uuid, p_id uuid, p_expected_revision bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare photo_path text;
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  photo_path := public.qa_delete_photo(p_walkdown_id, p_id);
  if exists (select 1 from public.qa_revision_photos where path = photo_path) then return null; end if;
  return photo_path;
end;
$$;

-- Photo objects referenced by ANY closed revision remain private and readable,
-- even after removal from the current draft. No client can delete or overwrite.
create or replace function qa_private.can_upload_photo(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select qa_private.is_inspector() and exists (select 1 from public.qa_photos p join public.qa_walkdowns w on w.id = p.walkdown_id
    where p.path = p_path and p.created_by = auth.uid() and p.upload_state = 'pending' and p.deleted_at is null
      and w.status = 'draft' and w.revision = p.reserved_revision);
$$;
create or replace function qa_private.can_read_photo(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select qa_private.is_inspector() and (exists (select 1 from public.qa_photos
    where path = p_path and ((upload_state = 'ready' and deleted_at is null) or created_by = auth.uid() or qa_private.is_admin()))
    or exists (select 1 from public.qa_revision_photos where path = p_path));
$$;
create or replace function qa_private.can_delete_photo(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select qa_private.is_inspector() and exists (select 1 from public.qa_photos
    where path = p_path and deleted_at is not null and (created_by = auth.uid() or qa_private.is_admin()))
    and not exists (select 1 from public.qa_revision_photos where path = p_path);
$$;

revoke all on function public.qa_rename_walkdown(uuid,text), public.qa_prepare_photo(uuid,uuid,text,text,text,integer,integer),
  public.qa_add_photo(uuid,uuid), public.qa_add_comment(uuid,text,text), public.qa_set_complete(uuid,text,boolean),
  public.qa_set_quality(uuid,text,text), public.qa_delete_photo(uuid,uuid) from public, anon, authenticated;
revoke all on function public.qa_rename_walkdown(uuid,text,bigint), public.qa_prepare_photo(uuid,uuid,text,text,text,integer,integer,bigint),
  public.qa_add_photo(uuid,uuid,bigint), public.qa_add_comment(uuid,text,text,bigint), public.qa_delete_comment(uuid,uuid,bigint),
  public.qa_set_complete(uuid,text,boolean,bigint), public.qa_set_quality(uuid,text,text,bigint), public.qa_delete_photo(uuid,uuid,bigint),
  public.qa_list_revisions(uuid), public.qa_load_revision(uuid,bigint), public.qa_approve_revision(uuid,bigint,bigint),
  public.qa_new_revision(uuid,bigint) from public, anon, authenticated;
grant execute on function public.qa_rename_walkdown(uuid,text,bigint), public.qa_prepare_photo(uuid,uuid,text,text,text,integer,integer,bigint),
  public.qa_add_photo(uuid,uuid,bigint), public.qa_add_comment(uuid,text,text,bigint), public.qa_delete_comment(uuid,uuid,bigint),
  public.qa_set_complete(uuid,text,boolean,bigint), public.qa_set_quality(uuid,text,text,bigint), public.qa_delete_photo(uuid,uuid,bigint),
  public.qa_list_revisions(uuid), public.qa_load_revision(uuid,bigint), public.qa_approve_revision(uuid,bigint,bigint),
  public.qa_new_revision(uuid,bigint) to authenticated;
revoke all on all functions in schema qa_private from public, anon, authenticated;
grant execute on function qa_private.is_inspector(), qa_private.is_admin(), qa_private.can_upload_photo(text),
  qa_private.can_read_photo(text), qa_private.can_delete_photo(text) to authenticated;
notify pgrst, 'reload schema';
commit;
