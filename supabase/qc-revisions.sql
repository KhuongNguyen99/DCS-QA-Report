-- QC closeout revisions. Existing report numbers and evidence are preserved.
-- Run on a named-skid deployment; new installations use schema.sql instead.
begin;
do $$ begin
  if to_regclass('public.qa_walkdowns') is null then
    raise exception 'Install the current schema.sql before enabling QC revisions.';
  end if;
end; $$;

alter table public.qa_inspectors add column if not exists job_title text
  check (length(trim(job_title)) between 1 and 100);
update public.qa_inspectors set job_title = 'Project Manager'
where email = 'khuong@jeevyfabrication.com' and job_title is null;

alter table public.qa_walkdowns drop constraint if exists qa_walkdowns_revision_check;
alter table public.qa_walkdowns add constraint qa_walkdowns_revision_check check (revision >= 1);
alter table public.qa_walkdowns alter column revision set default 1;
alter table public.qa_walkdowns add column if not exists revision_number_base bigint not null default 1
  check (revision_number_base between 1 and revision);
alter table public.qa_walkdowns add column if not exists status text not null default 'draft' check (status in ('draft', 'closed'));
alter table public.qa_walkdowns add column if not exists content_version bigint not null default 1 check (content_version >= 1);
alter table public.qa_walkdowns add column if not exists closed_at timestamptz;
alter table public.qa_walkdowns add column if not exists closed_by uuid references auth.users(id);
alter table public.qa_walkdowns add column if not exists closed_by_name text;
-- Manual checker attribution belongs to this draft, not the account that
-- creates it. Existing reports and approved snapshots are never backfilled.
alter table public.qa_walkdowns add column if not exists checked_by_name text
  check (checked_by_name = trim(checked_by_name) and length(checked_by_name) between 1 and 120
    and checked_by_name ~ '[^[:space:]]' and checked_by_name !~ '[[:cntrl:]]');
alter table public.qa_walkdowns add column if not exists checked_by_recorded_at timestamptz;
alter table public.qa_walkdowns add column if not exists checked_by_recorded_by uuid references auth.users(id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'qa_walkdowns_checked_by_audit'
    and conrelid = 'public.qa_walkdowns'::regclass) then
    alter table public.qa_walkdowns add constraint qa_walkdowns_checked_by_audit check (
      (checked_by_name is null and checked_by_recorded_at is null and checked_by_recorded_by is null)
      or (checked_by_name is not null and checked_by_recorded_at is not null and checked_by_recorded_by is not null));
  end if;
end; $$;
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
  if p_write and report.checked_by_name is null then raise exception 'Enter Checked by before saving inspection data, photos, or comments.'; end if;
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
  -- Only the naming and checker-setup RPCs pass this private metadata exemption.
  -- They still require the selected draft revision and an approved inspector.
  if not p_allow_unnamed and report.checked_by_name is null then
    raise exception 'Enter Checked by before saving inspection data, photos, or comments.';
  end if;
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
declare report_id uuid; report public.qa_walkdowns%rowtype;
begin
  if tg_op = 'DELETE' then report_id := old.walkdown_id; else report_id := new.walkdown_id; end if;
  perform pg_catalog.pg_advisory_xact_lock(450007, pg_catalog.hashtext(report_id::text));
  select * into report from public.qa_walkdowns where id = report_id;
  -- Abandoning an unfinished reservation remains safe before checker setup or
  -- after closeout; it cannot add or alter approved evidence.
  if tg_table_name = 'qa_photos' and tg_op = 'UPDATE' then
    if old.upload_state = 'pending' and new.deleted_at is not null
      and (to_jsonb(old) - 'deleted_at' - 'deleted_by') = (to_jsonb(new) - 'deleted_at' - 'deleted_by') then return new; end if;
  end if;
  if report.status <> 'draft' then
    raise exception 'This revision is approved and closed. Start a new revision to make changes.';
  end if;
  if report.checked_by_name is null then
    if tg_table_name = 'qa_records' and tg_op = 'INSERT' then
      if not new.complete and new.completed_at is null and new.completed_by is null
        and new.quality is null and new.quality_at is null and new.quality_by is null then return new; end if;
    end if;
    raise exception 'Enter Checked by before saving inspection data, photos, or comments.';
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

-- Backfill private ordering metadata without changing approved snapshots or
-- report review tokens. ALTER TABLE holds the table lock through this migration.
alter table public.qa_photos add column if not exists photo_position integer check (photo_position > 0);
alter table public.qa_photos disable trigger qa_photos_draft_only;
alter table public.qa_photos disable trigger qa_photos_update_report_revision;
with missing as (
  select p.id, coalesce((select max(prior.photo_position) from public.qa_photos prior
      where prior.walkdown_id = p.walkdown_id and prior.record_key = p.record_key), 0)
    + row_number() over (partition by p.walkdown_id, p.record_key order by p.created_at, p.id) as position
  from public.qa_photos p where p.record_key is not null and p.upload_state = 'ready' and p.photo_position is null
)
update public.qa_photos p set photo_position = missing.position from missing where p.id = missing.id;
alter table public.qa_photos enable trigger qa_photos_update_report_revision;
alter table public.qa_photos enable trigger qa_photos_draft_only;

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
    'revision', revision, 'revisionNumberBase', revision_number_base, 'updatedAt', updated_at, 'createdAt', created_at,
    'status', status, 'contentVersion', content_version, 'closedAt', closed_at,
    'closedBy', closed_by, 'closedByName', closed_by_name,
    'checkedByName', checked_by_name, 'checkedByRecordedAt', checked_by_recorded_at, 'checkedByRecordedBy', checked_by_recorded_by)
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
    'project', jsonb_build_object('title', '450k Skid x7 - DCS', 'revision', w.revision, 'revisionNumberBase', w.revision_number_base, 'scheduleRevision', 3,
      'updatedAt', w.updated_at, 'walkdownId', w.id, 'skidName', w.skid_name, 'nameRequired', w.name_required,
      'status', w.status, 'contentVersion', w.content_version, 'closedAt', w.closed_at,
      'closedBy', w.closed_by, 'closedByName', w.closed_by_name,
      'checkedByName', w.checked_by_name, 'checkedByRecordedAt', w.checked_by_recorded_at, 'checkedByRecordedBy', w.checked_by_recorded_by),
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
      'path', p.path, 'name', p.name, 'width', p.width, 'height', p.height, 'createdAt', p.created_at, 'createdBy', p.created_by) order by p.record_key, p.photo_position, p.created_at, p.id)
      from public.qa_photos p where p.walkdown_id = p_walkdown_id and p.deleted_at is null and p.upload_state = 'ready' and p.record_key is not null), '[]'::jsonb),
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
  select jsonb_set(r.snapshot, '{project,revisionNumberBase}', to_jsonb(w.revision_number_base))
    into result from public.qa_report_revisions r join public.qa_walkdowns w
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
    'closedByTitle', snapshot->'project'->'closedByTitle',
    'checkedByName', snapshot->'project'->'checkedByName',
    'checkedByRecordedAt', snapshot->'project'->'checkedByRecordedAt',
    'checkedByRecordedBy', snapshot->'project'->'checkedByRecordedBy',
    'testRunCount', case when jsonb_typeof(snapshot->'testRuns') = 'array' then jsonb_array_length(snapshot->'testRuns') else 0 end) order by revision desc)
    from public.qa_report_revisions where walkdown_id = p_walkdown_id), '[]'::jsonb);
end;
$$;

create or replace function public.qa_load_revision(p_walkdown_id uuid, p_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform qa_private.require_walkdown(p_walkdown_id, false);
  select jsonb_set(r.snapshot, '{project}', (r.snapshot->'project')
    || jsonb_build_object('revisionNumberBase', w.revision_number_base)
    || case when (r.snapshot->'project') ? 'closedByTitle' or i.job_title is null then '{}'::jsonb
         else jsonb_build_object('closedByTitle', i.job_title) end)
    into result from public.qa_report_revisions r join public.qa_walkdowns w on w.id = r.walkdown_id
    left join auth.users u on u.id = r.closed_by
    left join public.qa_inspectors i on i.email = lower(u.email)
    where r.walkdown_id = p_walkdown_id and r.revision = p_revision;
  if not found then raise exception 'Choose an approved and closed revision to export.'; end if;
  return result || jsonb_build_object('inspector', qa_private.current_inspector());
end;
$$;

create or replace function public.qa_approve_revision(p_walkdown_id uuid, p_expected_revision bigint, p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare report public.qa_walkdowns%rowtype; result jsonb; approver text; approver_title text;
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
  if report.checked_by_name is null then raise exception 'Enter Checked by before approving this report.'; end if;
  if exists (select 1 from public.qa_photos p where p.walkdown_id = p_walkdown_id and p.deleted_at is null and p.upload_state = 'ready'
    and not exists (select 1 from storage.objects o where o.bucket_id = 'qa-evidence' and o.name = p.path)) then
    raise exception 'An evidence image is missing from storage. Restore or remove it before approving.';
  end if;
  select i.display_name, i.job_title into approver, approver_title
    from public.qa_inspectors i join auth.users u on i.email = lower(u.email) where u.id = auth.uid();
  -- In-flight reservations are not approved evidence. Cancel them atomically so
  -- a late upload/finalization cannot enter a subsequent revision unnoticed.
  update public.qa_photos set deleted_at = clock_timestamp(), deleted_by = auth.uid()
  where walkdown_id = p_walkdown_id and upload_state = 'pending' and deleted_at is null;
  update public.qa_walkdowns set status = 'closed', closed_at = clock_timestamp(), closed_by = auth.uid(),
    closed_by_name = approver, updated_at = clock_timestamp() where id = p_walkdown_id;
  result := jsonb_set(qa_private.live_report_state(p_walkdown_id), '{project,closedByTitle}',
    coalesce(to_jsonb(approver_title), 'null'::jsonb));
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
    checked_by_name = null, checked_by_recorded_at = null, checked_by_recorded_by = null,
    last_change_txid = pg_catalog.txid_current() where id = p_walkdown_id;
  return qa_private.live_report_state(p_walkdown_id) || jsonb_build_object('revisions', public.qa_list_revisions(p_walkdown_id));
end;
$$;

-- Original mutation signatures remain private implementation details. New
-- browser overloads pin every save to the draft the inspector actually opened.
create or replace function public.qa_set_checked_by(p_walkdown_id uuid, p_name text,
  p_expected_revision bigint, p_expected_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare name text := regexp_replace(p_name, '^[[:space:]]+|[[:space:]]+$', '', 'g'); current_name text;
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision, true);
  if name is null or length(name) not between 1 and 120 or name !~ '[^[:space:]]' or name ~ '[[:cntrl:]]' then
    raise exception 'Enter a Checked by name between 1 and 120 characters, without control characters.';
  end if;
  select checked_by_name into current_name from public.qa_walkdowns where id = p_walkdown_id;
  -- A lost successful response can retry without replacing audit attribution or
  -- invalidating another inspector's review token when the name already agrees.
  if current_name is distinct from name then
    if current_name is distinct from p_expected_name then
      raise exception 'Checked by changed since you opened this report. Refresh before changing the name.' using errcode = '40001';
    end if;
    update public.qa_walkdowns set checked_by_name = name,
      checked_by_recorded_at = clock_timestamp(), checked_by_recorded_by = auth.uid()
      where id = p_walkdown_id;
    perform qa_private.mark_walkdown_changed(p_walkdown_id);
  end if;
  return qa_private.live_report_state(p_walkdown_id) || jsonb_build_object('revisions', public.qa_list_revisions(p_walkdown_id));
end;
$$;

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
-- The revoked legacy overload is retained as the checked wrapper's internal
-- finalizer. Assign position when upload completes so new images append.
create or replace function public.qa_add_photo(p_walkdown_id uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare photo public.qa_photos%rowtype;
begin
  perform qa_private.require_walkdown(p_walkdown_id, true);
  select * into photo from public.qa_photos where id = p_id and walkdown_id = p_walkdown_id
    and record_key is not null and created_by = auth.uid() and deleted_at is null;
  if not found then raise exception 'The photo reservation was not found in this skid walkdown.'; end if;
  if photo.upload_state = 'ready' then return to_jsonb(photo); end if;
  if not exists (select 1 from storage.objects where bucket_id = 'qa-evidence' and name = photo.path) then raise exception 'Upload the image before adding it to the inspection.'; end if;
  update public.qa_photos set upload_state = 'ready', created_at = clock_timestamp(),
    photo_position = (select coalesce(max(p.photo_position), 0) + 1 from public.qa_photos p
      where p.walkdown_id = p_walkdown_id and p.record_key = photo.record_key and p.upload_state = 'ready' and p.deleted_at is null)
  where id = p_id returning * into photo;
  perform qa_private.touch_record(p_walkdown_id, photo.record_key, false);
  return to_jsonb(photo);
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
create or replace function public.qa_reorder_photos(p_walkdown_id uuid, p_record_key text,
  p_ordered_photo_ids uuid[], p_expected_photo_ids uuid[], p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare current_ids uuid[];
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  if not exists (select 1 from public.qa_targets where key = p_record_key) then raise exception 'Unknown inspection target.'; end if;
  if p_ordered_photo_ids is null or p_expected_photo_ids is null
    or coalesce(array_ndims(p_ordered_photo_ids), 1) <> 1 or coalesce(array_ndims(p_expected_photo_ids), 1) <> 1
    or cardinality(p_ordered_photo_ids) > 1000 or cardinality(p_expected_photo_ids) > 1000
    or cardinality(p_ordered_photo_ids) <> (select count(distinct id) from unnest(p_ordered_photo_ids) id)
    or cardinality(p_expected_photo_ids) <> (select count(distinct id) from unnest(p_expected_photo_ids) id) then
    raise exception 'Include each inspection photo exactly once in a complete order of at most 1000 photos.';
  end if;
  select coalesce(array_agg(id order by photo_position, created_at, id), '{}'::uuid[]) into current_ids
  from public.qa_photos where walkdown_id = p_walkdown_id and record_key = p_record_key
    and upload_state = 'ready' and deleted_at is null;
  if p_expected_photo_ids is distinct from current_ids then
    raise exception 'Inspection photos changed since you opened them. Refresh before changing their order.' using errcode = '40001';
  end if;
  if cardinality(p_ordered_photo_ids) <> cardinality(current_ids) or not p_ordered_photo_ids @> current_ids then
    raise exception 'Include every current inspection photo exactly once in the order.';
  end if;
  if p_ordered_photo_ids is distinct from current_ids then
    update public.qa_photos p set photo_position = requested.position
    from unnest(p_ordered_photo_ids) with ordinality as requested(id, position)
    where p.id = requested.id and p.walkdown_id = p_walkdown_id and p.record_key = p_record_key
      and p.photo_position is distinct from requested.position;
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'walkdownId', p.walkdown_id, 'recordKey', p.record_key,
    'path', p.path, 'name', p.name, 'width', p.width, 'height', p.height, 'createdAt', p.created_at, 'createdBy', p.created_by)
    order by p.photo_position, p.created_at, p.id), '[]'::jsonb)
    from public.qa_photos p where p.walkdown_id = p_walkdown_id and p.record_key = p_record_key
      and p.upload_state = 'ready' and p.deleted_at is null);
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
      and w.status = 'draft' and w.checked_by_name is not null and w.revision = p.reserved_revision);
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
  public.qa_new_revision(uuid,bigint), public.qa_reorder_photos(uuid,text,uuid[],uuid[],bigint),
  public.qa_set_checked_by(uuid,text,bigint,text) from public, anon, authenticated;
grant execute on function public.qa_rename_walkdown(uuid,text,bigint), public.qa_prepare_photo(uuid,uuid,text,text,text,integer,integer,bigint),
  public.qa_add_photo(uuid,uuid,bigint), public.qa_add_comment(uuid,text,text,bigint), public.qa_delete_comment(uuid,uuid,bigint),
  public.qa_set_complete(uuid,text,boolean,bigint), public.qa_set_quality(uuid,text,text,bigint), public.qa_delete_photo(uuid,uuid,bigint),
  public.qa_list_revisions(uuid), public.qa_load_revision(uuid,bigint), public.qa_approve_revision(uuid,bigint,bigint),
  public.qa_new_revision(uuid,bigint), public.qa_reorder_photos(uuid,text,uuid[],uuid[],bigint),
  public.qa_set_checked_by(uuid,text,bigint,text) to authenticated;
revoke all on all functions in schema qa_private from public, anon, authenticated;
grant execute on function qa_private.is_inspector(), qa_private.is_admin(), qa_private.can_upload_photo(text),
  qa_private.can_read_photo(text), qa_private.can_delete_photo(text) to authenticated;
notify pgrst, 'reload schema';
commit;
