-- Test setup photos reuse private evidence objects and approved path references.
-- Install after qc-revisions.sql and proneta-test-reports.sql on every upgrade.
begin;
do $$ begin
  if to_regclass('public.qa_test_runs') is null or to_regclass('public.qa_revision_photos') is null then
    raise exception 'Install QC revisions and test reports before setup photos.';
  end if;
end; $$;

alter table public.qa_photos add column if not exists test_run_id uuid;
alter table public.qa_photos add column if not exists caption text not null default '';
alter table public.qa_photos alter column record_key drop not null;
create unique index if not exists qa_test_runs_id_walkdown on public.qa_test_runs(id, walkdown_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'qa_photos_test_run' and conrelid = 'public.qa_photos'::regclass) then
    alter table public.qa_photos add constraint qa_photos_test_run foreign key (test_run_id, walkdown_id)
      references public.qa_test_runs(id, walkdown_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'qa_photos_single_target' and conrelid = 'public.qa_photos'::regclass) then
    alter table public.qa_photos add constraint qa_photos_single_target check ((record_key is null) <> (test_run_id is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'qa_photos_caption' and conrelid = 'public.qa_photos'::regclass) then
    alter table public.qa_photos add constraint qa_photos_caption check (length(caption) <= 1000);
  end if;
end; $$;
create index if not exists qa_photos_test_run_ready on public.qa_photos(test_run_id, created_at, id)
  where deleted_at is null and upload_state = 'ready';

-- Backfill private ordering metadata without changing approved snapshots or
-- report review tokens. ALTER TABLE holds the table lock through this migration.
alter table public.qa_photos add column if not exists photo_position integer check (photo_position > 0);
alter table public.qa_photos disable trigger qa_photos_draft_only;
alter table public.qa_photos disable trigger qa_photos_update_report_revision;
with missing as (
  select p.id, coalesce((select max(prior.photo_position) from public.qa_photos prior
      where prior.test_run_id = p.test_run_id), 0)
    + row_number() over (partition by p.test_run_id order by p.created_at, p.id) as position
  from public.qa_photos p where p.test_run_id is not null and p.upload_state = 'ready' and p.photo_position is null
)
update public.qa_photos p set photo_position = missing.position from missing where p.id = missing.id;
alter table public.qa_photos enable trigger qa_photos_update_report_revision;
alter table public.qa_photos enable trigger qa_photos_draft_only;

create or replace function qa_private.test_setup_photo_info(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', id, 'walkdownId', walkdown_id, 'testRunId', test_run_id,
    'path', path, 'name', name, 'width', width, 'height', height, 'caption', caption,
    'createdAt', created_at, 'createdBy', created_by)
  from public.qa_photos where id = p_id and test_run_id is not null;
$$;

create or replace function qa_private.test_run_info(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select data || jsonb_build_object('id', id, 'walkdownId', walkdown_id, 'runVersion', run_version,
    'createdAt', created_at, 'createdBy', created_by, 'updatedAt', updated_at, 'updatedBy', updated_by)
    || coalesce((select jsonb_build_object('setupPhotos', jsonb_agg(qa_private.test_setup_photo_info(p.id) order by p.photo_position, p.created_at, p.id))
      from public.qa_photos p where p.test_run_id = r.id and p.walkdown_id = r.walkdown_id
        and p.upload_state = 'ready' and p.deleted_at is null having count(*) > 0), '{}'::jsonb)
  from public.qa_test_runs r where id = p_id;
$$;

-- Keep setup images in their run, separate from ordinary QC inspection photos.
create or replace function qa_private.live_report_state(p_walkdown_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'project', jsonb_build_object('title', '450k Skid x7 - DCS', 'revision', w.revision, 'revisionNumberBase', w.revision_number_base, 'scheduleRevision', 3,
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
      'path', p.path, 'name', p.name, 'width', p.width, 'height', p.height, 'createdAt', p.created_at, 'createdBy', p.created_by) order by p.record_key, p.photo_position, p.created_at, p.id)
      from public.qa_photos p where p.walkdown_id = p_walkdown_id and p.deleted_at is null and p.upload_state = 'ready' and p.record_key is not null), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'walkdownId', c.walkdown_id,
      'recordKey', coalesce(c.record_key, 'walkdown:general'), 'text', c.text, 'createdAt', c.created_at,
      'createdBy', c.created_by, 'authorName', c.author_name) order by c.created_at, c.id)
      from public.qa_comments c where c.walkdown_id = p_walkdown_id and c.deleted_at is null), '[]'::jsonb)
  ) from public.qa_walkdowns w where w.id = p_walkdown_id;
$$;

-- Setup images are server-owned evidence, not client-supplied source JSON.
create or replace function qa_private.guard_test_setup_data()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.data ? 'setupPhotos' then raise exception 'Setup photos are managed separately by the server.'; end if;
  return new;
end;
$$;
create or replace trigger qa_test_runs_setup_data before insert or update on public.qa_test_runs
for each row execute function qa_private.guard_test_setup_data();

create or replace function qa_private.require_test_setup_run(p_walkdown_id uuid, p_run_id uuid, p_expected_revision bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare run public.qa_test_runs%rowtype;
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  select * into run from public.qa_test_runs where id = p_run_id and walkdown_id = p_walkdown_id and deleted_at is null;
  if not found then raise exception 'Save an active test run in this skid before adding or editing its setup photos.'; end if;
  if run.created_by <> auth.uid() and not qa_private.is_admin() then
    raise exception 'Only the importing inspector or a project administrator can change this test setup.' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.qa_prepare_test_setup_photo(p_walkdown_id uuid, p_run_id uuid, p_id uuid,
  p_path text, p_name text, p_width integer, p_height integer, p_expected_revision bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_test_setup_run(p_walkdown_id, p_run_id, p_expected_revision);
  if p_id is null or p_path is null or p_path not in (auth.uid()::text || '/' || p_id::text || '.jpg',
    auth.uid()::text || '/' || p_id::text || '.png', auth.uid()::text || '/' || p_id::text || '.webp') then
    raise exception 'Invalid setup photo storage path.';
  end if;
  if (select count(*) from public.qa_photos where test_run_id = p_run_id and deleted_at is null) >= 30 then
    raise exception 'A test run can contain at most 30 setup photos. Remove an unused photo first.';
  end if;
  insert into public.qa_photos(id, walkdown_id, test_run_id, path, name, width, height, created_by, reserved_revision)
  values(p_id, p_walkdown_id, p_run_id, p_path, trim(p_name), p_width, p_height, auth.uid(), p_expected_revision);
end;
$$;

create or replace function public.qa_add_test_setup_photo(p_walkdown_id uuid, p_run_id uuid, p_id uuid, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare photo public.qa_photos%rowtype;
begin
  perform qa_private.require_test_setup_run(p_walkdown_id, p_run_id, p_expected_revision);
  select * into photo from public.qa_photos where id = p_id and walkdown_id = p_walkdown_id and test_run_id = p_run_id
    and created_by = auth.uid() and reserved_revision = p_expected_revision and deleted_at is null;
  if not found then raise exception 'The setup photo reservation was not found in this test run and revision. Choose the photo again.'; end if;
  if photo.upload_state = 'ready' then return qa_private.test_setup_photo_info(p_id); end if;
  if not exists (select 1 from storage.objects where bucket_id = 'qa-evidence' and name = photo.path) then
    raise exception 'Upload the image before adding it to the test setup.';
  end if;
  update public.qa_photos set upload_state = 'ready', created_at = clock_timestamp(),
    photo_position = (select coalesce(max(p.photo_position), 0) + 1 from public.qa_photos p
      where p.test_run_id = p_run_id and p.upload_state = 'ready' and p.deleted_at is null)
  where id = p_id;
  return qa_private.test_setup_photo_info(p_id);
end;
$$;

create or replace function public.qa_update_test_setup_photo(p_walkdown_id uuid, p_run_id uuid, p_id uuid,
  p_caption text, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_test_setup_run(p_walkdown_id, p_run_id, p_expected_revision);
  if p_caption is null or length(p_caption) > 1000 then raise exception 'A setup photo caption can contain at most 1,000 characters.'; end if;
  if not exists (select 1 from public.qa_photos where id = p_id and walkdown_id = p_walkdown_id and test_run_id = p_run_id
    and upload_state = 'ready' and deleted_at is null) then raise exception 'Setup photo not found in this test run.'; end if;
  update public.qa_photos set caption = p_caption where id = p_id and caption is distinct from p_caption;
  return qa_private.test_setup_photo_info(p_id);
end;
$$;

create or replace function public.qa_delete_test_setup_photo(p_walkdown_id uuid, p_run_id uuid, p_id uuid, p_expected_revision bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare photo public.qa_photos%rowtype;
begin
  perform qa_private.require_test_setup_run(p_walkdown_id, p_run_id, p_expected_revision);
  select * into photo from public.qa_photos where id = p_id and walkdown_id = p_walkdown_id and test_run_id = p_run_id;
  if not found then raise exception 'Setup photo not found in this test run.'; end if;
  if photo.deleted_at is null then
    update public.qa_photos set deleted_at = clock_timestamp(), deleted_by = auth.uid() where id = p_id;
  end if;
  if exists (select 1 from public.qa_revision_photos where path = photo.path) then return null; end if;
  return photo.path;
end;
$$;

create or replace function public.qa_reorder_test_setup_photos(p_walkdown_id uuid, p_run_id uuid,
  p_ordered_photo_ids uuid[], p_expected_photo_ids uuid[], p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare current_ids uuid[];
begin
  -- This acquires the same transaction lock as uploads, removals, and closeout.
  perform qa_private.require_test_setup_run(p_walkdown_id, p_run_id, p_expected_revision);
  if p_ordered_photo_ids is null or p_expected_photo_ids is null
    or coalesce(array_ndims(p_ordered_photo_ids), 1) <> 1 or coalesce(array_ndims(p_expected_photo_ids), 1) <> 1
    or cardinality(p_ordered_photo_ids) > 30 or cardinality(p_expected_photo_ids) > 30
    or cardinality(p_ordered_photo_ids) <> (select count(distinct id) from unnest(p_ordered_photo_ids) id)
    or cardinality(p_expected_photo_ids) <> (select count(distinct id) from unnest(p_expected_photo_ids) id) then
    raise exception 'Include each setup photo exactly once in a complete order of at most 30 photos.';
  end if;
  select coalesce(array_agg(id order by photo_position, created_at, id), '{}'::uuid[]) into current_ids
  from public.qa_photos where walkdown_id = p_walkdown_id and test_run_id = p_run_id
    and upload_state = 'ready' and deleted_at is null;
  if p_expected_photo_ids is distinct from current_ids then
    raise exception 'Setup photos changed since you opened them. Refresh before changing their order.' using errcode = '40001';
  end if;
  if cardinality(p_ordered_photo_ids) <> cardinality(current_ids) or not p_ordered_photo_ids @> current_ids then
    raise exception 'Include every current setup photo exactly once in the order.';
  end if;
  if p_ordered_photo_ids is distinct from current_ids then
    update public.qa_photos p set photo_position = requested.position
    from unnest(p_ordered_photo_ids) with ordinality as requested(id, position)
    where p.id = requested.id and p.walkdown_id = p_walkdown_id and p.test_run_id = p_run_id
      and p.photo_position is distinct from requested.position;
  end if;
  return coalesce(qa_private.test_run_info(p_run_id)->'setupPhotos', '[]'::jsonb);
end;
$$;

-- The normal inspection RPCs cannot register or remove setup images by ID.
create or replace function public.qa_add_photo(p_walkdown_id uuid, p_id uuid, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  if not exists (select 1 from public.qa_photos where walkdown_id = p_walkdown_id and id = p_id and test_run_id is null
    and reserved_revision = p_expected_revision and deleted_at is null) then
    raise exception 'The inspection photo reservation was not found in this skid revision. Choose the photo again.';
  end if;
  return public.qa_add_photo(p_walkdown_id, p_id);
end;
$$;
create or replace function public.qa_delete_photo(p_walkdown_id uuid, p_id uuid, p_expected_revision bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare photo_path text;
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  if not exists (select 1 from public.qa_photos where walkdown_id = p_walkdown_id and id = p_id and test_run_id is null) then
    raise exception 'Inspection photo not found in this skid walkdown.';
  end if;
  photo_path := public.qa_delete_photo(p_walkdown_id, p_id);
  if exists (select 1 from public.qa_revision_photos where path = photo_path) then return null; end if;
  return photo_path;
end;
$$;

-- A run owner may remove setup evidence uploaded to their run by an admin.
create or replace function qa_private.can_read_photo(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select qa_private.is_inspector() and (exists (select 1 from public.qa_photos p
    where p.path = p_path and ((p.upload_state = 'ready' and p.deleted_at is null) or p.created_by = auth.uid() or qa_private.is_admin()
      or exists (select 1 from public.qa_test_runs r where r.id = p.test_run_id and r.walkdown_id = p.walkdown_id and r.created_by = auth.uid())))
    or exists (select 1 from public.qa_revision_photos where path = p_path));
$$;
create or replace function qa_private.can_delete_photo(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select qa_private.is_inspector() and exists (select 1 from public.qa_photos p
    where p.path = p_path and p.deleted_at is not null and (p.created_by = auth.uid() or qa_private.is_admin()
      or exists (select 1 from public.qa_test_runs r where r.id = p.test_run_id and r.walkdown_id = p.walkdown_id and r.created_by = auth.uid())))
    and not exists (select 1 from public.qa_revision_photos where path = p_path);
$$;

-- Removing a run also retires its setup reservations and current photo links.
-- Existing archived paths remain protected by qa_revision_photos/storage RLS.
create or replace function qa_private.retire_test_setup_photos()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.qa_photos set deleted_at = new.deleted_at, deleted_by = new.deleted_by
    where test_run_id = new.id and deleted_at is null;
  end if;
  return new;
end;
$$;
create or replace trigger qa_test_runs_retire_setup after update on public.qa_test_runs
for each row execute function qa_private.retire_test_setup_photos();

revoke all on function public.qa_prepare_test_setup_photo(uuid,uuid,uuid,text,text,integer,integer,bigint),
  public.qa_add_test_setup_photo(uuid,uuid,uuid,bigint), public.qa_update_test_setup_photo(uuid,uuid,uuid,text,bigint),
  public.qa_delete_test_setup_photo(uuid,uuid,uuid,bigint),
  public.qa_reorder_test_setup_photos(uuid,uuid,uuid[],uuid[],bigint) from public, anon, authenticated;
grant execute on function public.qa_prepare_test_setup_photo(uuid,uuid,uuid,text,text,integer,integer,bigint),
  public.qa_add_test_setup_photo(uuid,uuid,uuid,bigint), public.qa_update_test_setup_photo(uuid,uuid,uuid,text,bigint),
  public.qa_delete_test_setup_photo(uuid,uuid,uuid,bigint),
  public.qa_reorder_test_setup_photos(uuid,uuid,uuid[],uuid[],bigint) to authenticated;
revoke all on function qa_private.test_setup_photo_info(uuid), qa_private.guard_test_setup_data(),
  qa_private.require_test_setup_run(uuid,uuid,bigint), qa_private.retire_test_setup_photos() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
