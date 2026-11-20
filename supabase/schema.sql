-- DCS shared inspection workspace; named skid reports, source schedule revision 3.
-- Run as the project owner in a new Supabase project's SQL Editor.
-- Re-running this file preserves inspection records, evidence, and comments.
begin;

create schema if not exists qa_private;
revoke all on schema qa_private from public, anon, authenticated;
grant usage on schema qa_private to authenticated;

create table if not exists public.qa_inspectors (
  email text primary key check (email = lower(trim(email))),
  display_name text not null check (length(trim(display_name)) between 1 and 100),
  is_admin boolean not null default false,
  active boolean not null default true
);
insert into public.qa_inspectors (email, display_name, is_admin)
values ('khuong@jeevyfabrication.com', 'Khuong', true)
on conflict (email) do nothing;

create table if not exists public.qa_targets (
  key text primary key,
  kind text not null check (kind in ('device', 'terminal', 'equipment')),
  terminal text check ((kind = 'equipment' and terminal is null)
    or (kind in ('device', 'terminal') and terminal is not null and terminal ~ '^[A-H]$')),
  label text not null,
  check ((kind = 'terminal' and key = 'terminal:' || terminal)
    or (kind = 'device' and key = 'device:' || label)
    or (kind = 'equipment' and ((key = 'equipment:control-box' and label = 'Control Box')
      or (key = 'equipment:solenoid-box' and label = 'Solenoid Box')
      or (key = 'equipment:transducer-panel' and label = 'Transducer Panel'))))
);
-- Existing projects still have the original device/terminal-only checks.
alter table public.qa_targets drop constraint if exists qa_targets_kind_check;
alter table public.qa_targets drop constraint if exists qa_targets_terminal_check;
alter table public.qa_targets drop constraint if exists qa_targets_check;
alter table public.qa_targets alter column terminal drop not null;
alter table public.qa_targets add constraint qa_targets_kind_check check (kind in ('device', 'terminal', 'equipment'));
alter table public.qa_targets add constraint qa_targets_terminal_check check ((kind = 'equipment' and terminal is null)
  or (kind in ('device', 'terminal') and terminal is not null and terminal ~ '^[A-H]$'));
alter table public.qa_targets add constraint qa_targets_check check ((kind = 'terminal' and key = 'terminal:' || terminal)
  or (kind = 'device' and key = 'device:' || label)
  or (kind = 'equipment' and ((key = 'equipment:control-box' and label = 'Control Box')
    or (key = 'equipment:solenoid-box' and label = 'Solenoid Box')
    or (key = 'equipment:transducer-panel' and label = 'Transducer Panel'))));
insert into public.qa_targets (key, kind, terminal, label)
select 'terminal:' || letter, 'terminal', letter, letter
from unnest(array['A','B','C','D','E','F','G','H']) as letter
on conflict (key) do nothing;

insert into public.qa_targets (key, kind, terminal, label) values
  ('equipment:control-box', 'equipment', null, 'Control Box'),
  ('equipment:solenoid-box', 'equipment', null, 'Solenoid Box'),
  ('equipment:transducer-panel', 'equipment', null, 'Transducer Panel')
on conflict (key) do nothing;
-- These 28 IDs/group assignments are from 450k skid x7 - DCS, revision 3.
insert into public.qa_targets (key, kind, terminal, label)
select 'device:' || id, 'device', terminal, id from (values
  ('V-3571#1','A'), ('V-3571#2','A'), ('V-3571-Y','A'),
  ('TH-3541','B'), ('V-3541-Y','B'), ('TH-3511','B'), ('V-3541','B'), ('PD-3511','B'),
  ('V-3511','C'), ('V-3511-Y','C'), ('TH-3510','C'),
  ('TH-3531','D'), ('V-3501-Y','D'),
  ('V-3531','E'), ('TH-3530','E'), ('V-3501','E'),
  ('V-3551','F'), ('TH-3550','F'), ('V-3521','F'), ('TH-3520','F'),
  ('DP-3500#1','G'), ('PD-3500#1','G'), ('DP-3500#2','G'), ('PD-3500#2','G'), ('DP-3500#3','G'), ('PD-3500#3','G'),
  ('V-3561','H'), ('TH-3560','H')
) as catalog(id, terminal)
on conflict (key) do nothing;

create table if not exists public.qa_records (
  key text primary key references public.qa_targets(key),
  complete boolean not null default false,
  completed_at timestamptz,
  completed_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  check ((complete and completed_at is not null and completed_by is not null)
    or (not complete and completed_at is null and completed_by is null))
);
-- Additive migration for projects that installed the initial inspection schema.
alter table public.qa_records add column if not exists quality text check (quality in ('good', 'bad'));
alter table public.qa_records add column if not exists quality_by uuid references auth.users(id);
alter table public.qa_records add column if not exists quality_at timestamptz;

create table if not exists public.qa_photos (
  id uuid primary key,
  record_key text not null references public.qa_targets(key),
  path text not null unique,
  name text not null check (length(trim(name)) between 1 and 180),
  width integer not null check (width between 1 and 24000),
  height integer not null check (height between 1 and 24000),
  upload_state text not null default 'pending' check (upload_state in ('pending', 'ready')),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id)
);
create index if not exists qa_photos_record on public.qa_photos(record_key) where deleted_at is null and upload_state = 'ready';

create table if not exists public.qa_comments (
  id uuid primary key default gen_random_uuid(),
  record_key text references public.qa_targets(key),
  text text not null check (length(trim(text)) between 1 and 4000),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  author_name text not null
);
-- NULL is the whole-walkdown comment scope, without adding an inspection target.
alter table public.qa_comments alter column record_key drop not null;
create index if not exists qa_comments_record on public.qa_comments(record_key, created_at);

-- Membership is checked against the current verified Auth email, never editable
-- user metadata or a browser-supplied email. A revoked inspector loses DB access
-- on their next request, including with an existing access token.
create or replace function qa_private.is_inspector()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.qa_inspectors i join auth.users u on lower(u.email) = i.email
    where u.id = auth.uid() and u.email_confirmed_at is not null and i.active
  );
$$;
create or replace function qa_private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.qa_inspectors i join auth.users u on lower(u.email) = i.email
    where u.id = auth.uid() and u.email_confirmed_at is not null and i.active and i.is_admin
  );
$$;
create or replace function qa_private.require_inspector()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not qa_private.is_inspector() then
    raise exception 'This verified email is not an approved project inspector. Ask the project administrator to add it.' using errcode = '42501';
  end if;
end;
$$;

alter table public.qa_inspectors enable row level security;
alter table public.qa_targets enable row level security;
alter table public.qa_records enable row level security;
alter table public.qa_photos enable row level security;
alter table public.qa_comments enable row level security;

-- No browser can write these tables directly, including admins. All mutations
-- use checked functions; allowlist administration happens in the SQL Editor.
revoke all on public.qa_inspectors, public.qa_targets, public.qa_records, public.qa_photos, public.qa_comments from public, anon, authenticated;
grant select on public.qa_targets, public.qa_records, public.qa_photos, public.qa_comments to authenticated;
drop policy if exists qa_targets_read on public.qa_targets;
create policy qa_targets_read on public.qa_targets for select to authenticated using ((select qa_private.is_inspector()));
drop policy if exists qa_records_read on public.qa_records;
create policy qa_records_read on public.qa_records for select to authenticated using ((select qa_private.is_inspector()));
drop policy if exists qa_photos_read on public.qa_photos;
create policy qa_photos_read on public.qa_photos for select to authenticated
  using ((select qa_private.is_inspector()) and deleted_at is null and upload_state = 'ready');
drop policy if exists qa_comments_read on public.qa_comments;
create policy qa_comments_read on public.qa_comments for select to authenticated using ((select qa_private.is_inspector()));

-- RLS checks run as a helper owner so pending/tombstoned reservations can remain
-- hidden from normal table reads. These helpers are not exposed through the API.
create or replace function qa_private.can_upload_photo(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select qa_private.is_inspector() and exists (select 1 from public.qa_photos
    where path = p_path and created_by = auth.uid() and upload_state = 'pending' and deleted_at is null);
$$;
create or replace function qa_private.can_read_photo(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select qa_private.is_inspector() and exists (select 1 from public.qa_photos
    where path = p_path and ((upload_state = 'ready' and deleted_at is null) or created_by = auth.uid() or qa_private.is_admin()));
$$;
create or replace function qa_private.can_delete_photo(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select qa_private.is_inspector() and exists (select 1 from public.qa_photos
    where path = p_path and deleted_at is not null and (created_by = auth.uid() or qa_private.is_admin()));
$$;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('qa-evidence', 'qa-evidence', false, 12582912, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists qa_evidence_insert on storage.objects;
create policy qa_evidence_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'qa-evidence' and qa_private.can_upload_photo(name));
drop policy if exists qa_evidence_select on storage.objects;
create policy qa_evidence_select on storage.objects for select to authenticated
  using (bucket_id = 'qa-evidence' and qa_private.can_read_photo(name));
drop policy if exists qa_evidence_delete on storage.objects;
create policy qa_evidence_delete on storage.objects for delete to authenticated
  using (bucket_id = 'qa-evidence' and qa_private.can_delete_photo(name));
-- Deliberately no storage UPDATE policy: evidence cannot be silently replaced.

revoke all on all functions in schema qa_private from public, anon, authenticated;
grant execute on function qa_private.is_inspector(), qa_private.is_admin(), qa_private.can_upload_photo(text), qa_private.can_read_photo(text), qa_private.can_delete_photo(text) to authenticated;

-- Realtime updates are an acceleration; clients also refresh periodically.
do $$
declare table_name text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach table_name in array array['qa_records','qa_photos','qa_comments'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = table_name) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end;
$$;

-- Named walkdowns: shared catalog, independent evidence/status/revisions.

create table if not exists public.qa_walkdowns (
  id uuid primary key default gen_random_uuid(),
  skid_name text not null check (skid_name = trim(skid_name) and length(skid_name) between 1 and 120 and skid_name !~ '[[:cntrl:]]'),
  name_required boolean not null default false,
  revision bigint not null default 3 check (revision >= 3),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  last_change_txid bigint
);
create unique index if not exists qa_walkdowns_unique_name on public.qa_walkdowns(lower(skid_name));
create table if not exists qa_private.voice_attempts (
  inspector_id uuid not null references auth.users(id),
  attempted_at timestamptz not null default now()
);
create index if not exists voice_attempts_inspector_time on qa_private.voice_attempts(inspector_id, attempted_at);
alter table qa_private.voice_attempts enable row level security;

-- Turn off the old global revision hooks while backfilling ownership. This DDL
-- and all data changes commit atomically; the new scoped hooks are installed below.
drop trigger if exists qa_records_report_revision on public.qa_records;
drop trigger if exists qa_comments_report_revision on public.qa_comments;
drop trigger if exists qa_photos_insert_report_revision on public.qa_photos;
drop trigger if exists qa_photos_update_report_revision on public.qa_photos;
drop trigger if exists qa_photos_delete_report_revision on public.qa_photos;

alter table public.qa_records add column if not exists walkdown_id uuid;
alter table public.qa_photos add column if not exists walkdown_id uuid;
alter table public.qa_comments add column if not exists walkdown_id uuid;
alter table qa_private.voice_attempts add column if not exists walkdown_id uuid;

do $$
declare legacy_revision bigint := 3; legacy_updated timestamptz := now();
begin
  if exists (select 1 from public.qa_records where walkdown_id is null)
    or exists (select 1 from public.qa_photos where walkdown_id is null)
    or exists (select 1 from public.qa_comments where walkdown_id is null)
    or exists (select 1 from qa_private.voice_attempts where walkdown_id is null) then
    if to_regclass('public.qa_project') is not null then
      execute 'select revision, updated_at from public.qa_project where id = 1' into legacy_revision, legacy_updated;
    end if;
    insert into public.qa_walkdowns(id, skid_name, name_required, revision, updated_at)
    values ('00000000-0000-4000-8000-000000000001', 'Unassigned skid', true, coalesce(legacy_revision, 3), coalesce(legacy_updated, now()))
    on conflict (id) do nothing;
    update public.qa_records set walkdown_id = '00000000-0000-4000-8000-000000000001' where walkdown_id is null;
    update public.qa_photos set walkdown_id = '00000000-0000-4000-8000-000000000001' where walkdown_id is null;
    update public.qa_comments set walkdown_id = '00000000-0000-4000-8000-000000000001' where walkdown_id is null;
    update qa_private.voice_attempts set walkdown_id = '00000000-0000-4000-8000-000000000001' where walkdown_id is null;
  end if;
end;
$$;

alter table public.qa_records alter column walkdown_id set not null;
alter table public.qa_photos alter column walkdown_id set not null;
alter table public.qa_comments alter column walkdown_id set not null;
alter table qa_private.voice_attempts alter column walkdown_id set not null;
alter table public.qa_records drop constraint if exists qa_records_pkey;
alter table public.qa_records add constraint qa_records_pkey primary key(walkdown_id, key);
do $$
declare relation text;
begin
  foreach relation in array array['qa_records','qa_photos','qa_comments'] loop
    if not exists (select 1 from pg_constraint where conname = relation || '_walkdown_fkey' and conrelid = ('public.' || relation)::regclass) then
      execute format('alter table public.%I add constraint %I foreign key(walkdown_id) references public.qa_walkdowns(id)', relation, relation || '_walkdown_fkey');
    end if;
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'voice_attempts_walkdown_fkey' and conrelid = 'qa_private.voice_attempts'::regclass) then
    alter table qa_private.voice_attempts add constraint voice_attempts_walkdown_fkey foreign key(walkdown_id) references public.qa_walkdowns(id);
  end if;
end;
$$;
create index if not exists qa_photos_walkdown_record on public.qa_photos(walkdown_id, record_key) where deleted_at is null and upload_state = 'ready';
create index if not exists qa_comments_walkdown_record on public.qa_comments(walkdown_id, record_key, created_at);
alter table public.qa_walkdowns enable row level security;
revoke all on public.qa_walkdowns from public, anon, authenticated;
grant select on public.qa_walkdowns to authenticated;
drop policy if exists qa_walkdowns_read on public.qa_walkdowns;
create policy qa_walkdowns_read on public.qa_walkdowns for select to authenticated using ((select qa_private.is_inspector()));
revoke all on qa_private.voice_attempts from public, anon, authenticated;
do $$
begin
  if to_regclass('public.qa_project') is not null then
    revoke all on public.qa_project from public, anon, authenticated;
    drop policy if exists qa_project_read on public.qa_project;
  end if;
end;
$$;

create or replace function qa_private.require_walkdown(p_walkdown_id uuid, p_write boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare needs_name boolean;
begin
  perform qa_private.require_inspector();
  if p_write then perform pg_catalog.pg_advisory_xact_lock(450007, pg_catalog.hashtext(p_walkdown_id::text)); end if;
  select name_required into needs_name from public.qa_walkdowns where id = p_walkdown_id;
  if not found then raise exception 'Choose an existing skid walkdown.'; end if;
  if p_write and needs_name then raise exception 'Name this skid before saving inspection changes.'; end if;
end;
$$;

create or replace function qa_private.walkdown_info(p_walkdown_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', id, 'skidName', skid_name, 'nameRequired', name_required,
    'revision', revision, 'updatedAt', updated_at, 'createdAt', created_at)
  from public.qa_walkdowns where id = p_walkdown_id;
$$;

create or replace function qa_private.mark_walkdown_changed(p_walkdown_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.qa_walkdowns set revision = revision + 1, updated_at = clock_timestamp(), last_change_txid = pg_catalog.txid_current()
  where id = p_walkdown_id and last_change_txid is distinct from pg_catalog.txid_current();
end;
$$;

-- Existing reports gain one empty record per equipment target. INSERT does not
-- fire the record revision trigger, so advance only reports receiving new rows.
with added as (
  insert into public.qa_records(walkdown_id, key)
  select w.id, t.key from public.qa_walkdowns w cross join public.qa_targets t
  where t.kind = 'equipment' and not exists (
    select 1 from public.qa_records r where r.walkdown_id = w.id and r.key = t.key
  )
  on conflict (walkdown_id, key) do nothing
  returning walkdown_id
)
update public.qa_walkdowns w set revision = revision + 1,
  updated_at = clock_timestamp(), last_change_txid = pg_catalog.txid_current()
where w.id in (select distinct walkdown_id from added);

create or replace function qa_private.bump_report_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then perform qa_private.mark_walkdown_changed(old.walkdown_id);
  else perform qa_private.mark_walkdown_changed(new.walkdown_id); end if;
  return null;
end;
$$;

create or replace trigger qa_records_report_revision after update on public.qa_records for each row
when (old.* is distinct from new.*) execute function qa_private.bump_report_revision();
create or replace trigger qa_comments_report_revision after insert on public.qa_comments for each row
execute function qa_private.bump_report_revision();
create or replace trigger qa_photos_insert_report_revision after insert on public.qa_photos for each row
when (new.upload_state = 'ready' and new.deleted_at is null) execute function qa_private.bump_report_revision();
create or replace trigger qa_photos_update_report_revision after update on public.qa_photos for each row
when (old.* is distinct from new.* and ((old.upload_state = 'ready' and old.deleted_at is null) or (new.upload_state = 'ready' and new.deleted_at is null)))
execute function qa_private.bump_report_revision();
create or replace trigger qa_photos_delete_report_revision after delete on public.qa_photos for each row
when (old.upload_state = 'ready' and old.deleted_at is null) execute function qa_private.bump_report_revision();

create or replace function qa_private.touch_record(p_walkdown_id uuid, p_key text, p_reopen boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.qa_records set complete = case when p_reopen then false else complete end,
    completed_at = case when p_reopen then null else completed_at end,
    completed_by = case when p_reopen then null else completed_by end, updated_at = clock_timestamp()
  where walkdown_id = p_walkdown_id and key = p_key;
  if p_reopen then
    update public.qa_records set complete = false, completed_at = null, completed_by = null, updated_at = clock_timestamp()
    where walkdown_id = p_walkdown_id and key = (select 'terminal:' || terminal from public.qa_targets where key = p_key and kind = 'device');
  end if;
end;
$$;

create or replace function public.qa_list_walkdowns()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_inspector();
  return jsonb_build_object(
    'inspector', (select jsonb_build_object('id', u.id, 'email', u.email, 'name', i.display_name, 'isAdmin', i.is_admin)
      from auth.users u join public.qa_inspectors i on i.email = lower(u.email) where u.id = auth.uid()),
    'walkdowns', coalesce((select jsonb_agg(qa_private.walkdown_info(w.id) order by w.updated_at desc, w.skid_name, w.id) from public.qa_walkdowns w), '[]'::jsonb)
  );
end;
$$;

create or replace function public.qa_create_walkdown(p_skid_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare new_id uuid; name text := trim(p_skid_name);
begin
  perform qa_private.require_inspector();
  if name is null or length(name) not between 1 and 120 or name ~ '[[:cntrl:]]' or lower(name) = 'unassigned skid' then
    raise exception 'Enter a unique skid name between 1 and 120 characters. Unassigned skid is reserved.';
  end if;
  insert into public.qa_walkdowns(skid_name, created_by) values(name, auth.uid()) returning id into new_id;
  insert into public.qa_records(walkdown_id, key) select new_id, key from public.qa_targets;
  return qa_private.walkdown_info(new_id);
exception when unique_violation then raise exception 'A walkdown with this skid name already exists. Select it or choose a different name.';
end;
$$;

create or replace function public.qa_rename_walkdown(p_walkdown_id uuid, p_skid_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare name text := trim(p_skid_name);
begin
  perform qa_private.require_walkdown(p_walkdown_id, false);
  perform pg_catalog.pg_advisory_xact_lock(450007, pg_catalog.hashtext(p_walkdown_id::text));
  if name is null or length(name) not between 1 and 120 or name ~ '[[:cntrl:]]' or lower(name) = 'unassigned skid' then
    raise exception 'Enter a unique skid name between 1 and 120 characters. Unassigned skid is reserved.';
  end if;
  update public.qa_walkdowns set skid_name = name, name_required = false
  where id = p_walkdown_id and (skid_name is distinct from name or name_required);
  if found then perform qa_private.mark_walkdown_changed(p_walkdown_id); end if;
  return qa_private.walkdown_info(p_walkdown_id);
exception when unique_violation then raise exception 'A walkdown with this skid name already exists. Choose a different name.';
end;
$$;

create or replace function public.qa_load_state(p_walkdown_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform qa_private.require_walkdown(p_walkdown_id, false);
  select jsonb_build_object(
    'project', (select jsonb_build_object('title', '450k Skid x7 - DCS', 'revision', w.revision, 'scheduleRevision', 3,
      'updatedAt', w.updated_at, 'walkdownId', w.id, 'skidName', w.skid_name, 'nameRequired', w.name_required)
      from public.qa_walkdowns w where w.id = p_walkdown_id),
    'inspector', (select jsonb_build_object('id', u.id, 'email', u.email, 'name', i.display_name, 'isAdmin', i.is_admin)
      from auth.users u join public.qa_inspectors i on i.email = lower(u.email) where u.id = auth.uid()),
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
      from public.qa_comments c where c.walkdown_id = p_walkdown_id), '[]'::jsonb)
  ) into result;
  return result;
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
  insert into public.qa_photos(id, walkdown_id, record_key, path, name, width, height, created_by)
  values(p_id, p_walkdown_id, p_record_key, p_path, trim(p_name), p_width, p_height, auth.uid());
end;
$$;

create or replace function public.qa_add_photo(p_walkdown_id uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare photo public.qa_photos%rowtype;
begin
  perform qa_private.require_walkdown(p_walkdown_id, true);
  select * into photo from public.qa_photos where id = p_id and walkdown_id = p_walkdown_id and created_by = auth.uid() and deleted_at is null;
  if not found then raise exception 'The photo reservation was not found in this skid walkdown.'; end if;
  if photo.upload_state = 'ready' then return to_jsonb(photo); end if;
  if not exists (select 1 from storage.objects where bucket_id = 'qa-evidence' and name = photo.path) then raise exception 'Upload the image before adding it to the inspection.'; end if;
  update public.qa_photos set upload_state = 'ready', created_at = clock_timestamp() where id = p_id returning * into photo;
  perform qa_private.touch_record(p_walkdown_id, photo.record_key, false);
  return to_jsonb(photo);
end;
$$;

create or replace function public.qa_cancel_photo(p_walkdown_id uuid, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare photo public.qa_photos%rowtype;
begin
  perform qa_private.require_walkdown(p_walkdown_id, true);
  select * into photo from public.qa_photos where id = p_id and walkdown_id = p_walkdown_id and created_by = auth.uid();
  if not found then raise exception 'The photo reservation was not found in this skid walkdown.'; end if;
  if photo.upload_state = 'ready' then raise exception 'This photo is already saved. Refresh the inspection to view it.'; end if;
  update public.qa_photos set deleted_at = coalesce(deleted_at, clock_timestamp()), deleted_by = auth.uid() where id = p_id;
end;
$$;

create or replace function public.qa_add_comment(p_walkdown_id uuid, p_record_key text, p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare author text; added public.qa_comments%rowtype;
begin
  perform qa_private.require_walkdown(p_walkdown_id, true);
  if p_record_key is distinct from 'walkdown:general' and not exists (select 1 from public.qa_targets where key = p_record_key) then raise exception 'Unknown comment scope.'; end if;
  select i.display_name into author from public.qa_inspectors i join auth.users u on lower(u.email) = i.email where u.id = auth.uid();
  insert into public.qa_comments(walkdown_id, record_key, text, created_by, author_name)
  values(p_walkdown_id, nullif(p_record_key, 'walkdown:general'), trim(p_text), auth.uid(), author) returning * into added;
  if p_record_key <> 'walkdown:general' then perform qa_private.touch_record(p_walkdown_id, p_record_key, false); end if;
  return to_jsonb(added);
end;
$$;

create or replace function public.qa_set_complete(p_walkdown_id uuid, p_record_key text, p_complete boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.qa_targets%rowtype; updated public.qa_records%rowtype;
begin
  perform qa_private.require_walkdown(p_walkdown_id, true);
  select * into target from public.qa_targets where key = p_record_key;
  if not found then raise exception 'Unknown inspection target.'; end if;
  if p_complete is null then raise exception 'Completion must be true or false.'; end if;
  if p_complete then
    if not exists (select 1 from public.qa_photos p join storage.objects o on o.bucket_id = 'qa-evidence' and o.name = p.path
      where p.walkdown_id = p_walkdown_id and p.record_key = p_record_key and p.upload_state = 'ready' and p.deleted_at is null) then
      raise exception 'Add at least one inspection photo before marking this item complete.';
    end if;
    if target.kind = 'terminal' and exists (select 1 from public.qa_targets t join public.qa_records r on r.key = t.key
      where r.walkdown_id = p_walkdown_id and t.kind = 'device' and t.terminal = target.terminal and not r.complete) then
      raise exception 'Complete every device in this terminal group first.';
    end if;
    update public.qa_records set complete = true, completed_at = clock_timestamp(), completed_by = auth.uid(), updated_at = clock_timestamp()
    where walkdown_id = p_walkdown_id and key = p_record_key;
  else perform qa_private.touch_record(p_walkdown_id, p_record_key, true); end if;
  select * into updated from public.qa_records where walkdown_id = p_walkdown_id and key = p_record_key;
  return to_jsonb(updated);
end;
$$;

create or replace function public.qa_set_quality(p_walkdown_id uuid, p_record_key text, p_quality text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare updated public.qa_records%rowtype;
begin
  perform qa_private.require_walkdown(p_walkdown_id, true);
  if p_quality is not null and p_quality not in ('good','bad') then raise exception 'Quality must be Good, Bad, or unrated.'; end if;
  update public.qa_records set quality = p_quality, quality_by = auth.uid(), quality_at = clock_timestamp(), updated_at = clock_timestamp()
  where walkdown_id = p_walkdown_id and key = p_record_key returning * into updated;
  if not found then raise exception 'Unknown inspection target.'; end if;
  return to_jsonb(updated);
end;
$$;

create or replace function public.qa_delete_photo(p_walkdown_id uuid, p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare photo public.qa_photos%rowtype;
begin
  perform qa_private.require_walkdown(p_walkdown_id, true);
  select * into photo from public.qa_photos where id = p_id and walkdown_id = p_walkdown_id;
  if not found then raise exception 'Photo not found in this skid walkdown.'; end if;
  if photo.created_by <> auth.uid() and not qa_private.is_admin() then raise exception 'Only the photographer or a project administrator can remove this photo.' using errcode = '42501'; end if;
  if photo.deleted_at is null then
    update public.qa_photos set deleted_at = clock_timestamp(), deleted_by = auth.uid() where id = p_id;
    if photo.upload_state = 'ready' then perform qa_private.touch_record(p_walkdown_id, photo.record_key, true); end if;
  end if;
  return photo.path;
end;
$$;

create or replace function public.qa_authorize_voice(p_walkdown_id uuid, p_record_key text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_walkdown(p_walkdown_id, true);
  if p_record_key is distinct from 'walkdown:general' and not exists (select 1 from public.qa_targets where key = p_record_key) then raise exception 'Unknown comment scope.'; end if;
  -- Global per-inspector spending limit still applies across all named skids.
  perform pg_catalog.pg_advisory_xact_lock(450008, pg_catalog.hashtext(auth.uid()::text));
  delete from qa_private.voice_attempts where attempted_at < now() - interval '1 day';
  if (select count(*) from qa_private.voice_attempts where inspector_id = auth.uid() and attempted_at > now() - interval '5 minutes') >= 10
    or (select count(*) from qa_private.voice_attempts where inspector_id = auth.uid()) >= 120 then return false; end if;
  insert into qa_private.voice_attempts(inspector_id, walkdown_id) values(auth.uid(), p_walkdown_id);
  return true;
end;
$$;

-- Remove browser access to every old unscoped overload, including stale clients.
do $$
declare signature text;
begin
  foreach signature in array array['public.qa_load_state()', 'public.qa_prepare_photo(uuid,text,text,text,integer,integer)',
    'public.qa_add_photo(uuid)', 'public.qa_cancel_photo(uuid)', 'public.qa_add_comment(text,text)',
    'public.qa_set_complete(text,boolean)', 'public.qa_set_quality(text,text)', 'public.qa_delete_photo(uuid)', 'public.qa_authorize_voice(text)'] loop
    if to_regprocedure(signature) is not null then execute 'revoke all on function ' || signature || ' from public, anon, authenticated'; end if;
  end loop;
end;
$$;
revoke all on function public.qa_list_walkdowns(), public.qa_create_walkdown(text), public.qa_rename_walkdown(uuid,text),
  public.qa_load_state(uuid), public.qa_prepare_photo(uuid,uuid,text,text,text,integer,integer), public.qa_add_photo(uuid,uuid),
  public.qa_cancel_photo(uuid,uuid), public.qa_add_comment(uuid,text,text), public.qa_set_complete(uuid,text,boolean),
  public.qa_set_quality(uuid,text,text), public.qa_delete_photo(uuid,uuid), public.qa_authorize_voice(uuid,text) from public, anon, authenticated;
grant execute on function public.qa_list_walkdowns(), public.qa_create_walkdown(text), public.qa_rename_walkdown(uuid,text),
  public.qa_load_state(uuid), public.qa_prepare_photo(uuid,uuid,text,text,text,integer,integer), public.qa_add_photo(uuid,uuid),
  public.qa_cancel_photo(uuid,uuid), public.qa_add_comment(uuid,text,text), public.qa_set_complete(uuid,text,boolean),
  public.qa_set_quality(uuid,text,text), public.qa_delete_photo(uuid,uuid), public.qa_authorize_voice(uuid,text) to authenticated;
revoke all on all functions in schema qa_private from public, anon, authenticated;
grant execute on function qa_private.is_inspector(), qa_private.is_admin(), qa_private.can_upload_photo(text), qa_private.can_read_photo(text), qa_private.can_delete_photo(text) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'qa_walkdowns') then
    alter publication supabase_realtime add table public.qa_walkdowns;
  end if;
end;
$$;

-- QC revision closeout layer; keep synchronized with qc-revisions.sql.
-- QC closeout revisions. Existing report numbers and evidence are preserved.
-- Run on a named-skid deployment; new installations use schema.sql instead.
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
  public.qa_new_revision(uuid,bigint), public.qa_reorder_photos(uuid,text,uuid[],uuid[],bigint) from public, anon, authenticated;
grant execute on function public.qa_rename_walkdown(uuid,text,bigint), public.qa_prepare_photo(uuid,uuid,text,text,text,integer,integer,bigint),
  public.qa_add_photo(uuid,uuid,bigint), public.qa_add_comment(uuid,text,text,bigint), public.qa_delete_comment(uuid,uuid,bigint),
  public.qa_set_complete(uuid,text,boolean,bigint), public.qa_set_quality(uuid,text,text,bigint), public.qa_delete_photo(uuid,uuid,bigint),
  public.qa_list_revisions(uuid), public.qa_load_revision(uuid,bigint), public.qa_approve_revision(uuid,bigint,bigint),
  public.qa_new_revision(uuid,bigint), public.qa_reorder_photos(uuid,text,uuid[],uuid[],bigint) to authenticated;
revoke all on all functions in schema qa_private from public, anon, authenticated;
grant execute on function qa_private.is_inspector(), qa_private.is_admin(), qa_private.can_upload_photo(text),
  qa_private.can_read_photo(text), qa_private.can_delete_photo(text) to authenticated;
notify pgrst, 'reload schema';

-- PRONETA test report layer; keep aligned with proneta-test-reports.sql.
create table if not exists public.qa_test_runs (
  id uuid primary key,
  walkdown_id uuid not null references public.qa_walkdowns(id),
  data jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 4194304),
  run_version bigint not null default 1 check (run_version >= 1),
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid not null references auth.users(id),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid not null references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id)
);
create index if not exists qa_test_runs_walkdown on public.qa_test_runs(walkdown_id, created_at, id) where deleted_at is null;
alter table public.qa_test_runs enable row level security;
revoke all on public.qa_test_runs from public, anon, authenticated;
grant select on public.qa_test_runs to authenticated;
drop policy if exists qa_test_runs_read on public.qa_test_runs;
create policy qa_test_runs_read on public.qa_test_runs for select to authenticated
using ((select qa_private.is_inspector()) and deleted_at is null);
create or replace trigger qa_test_runs_draft_only before insert or update or delete on public.qa_test_runs
for each row execute function qa_private.guard_report_row();
create or replace trigger qa_test_runs_report_revision after insert or update or delete on public.qa_test_runs
for each row execute function qa_private.bump_report_revision();

create or replace function qa_private.test_run_info(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select data || jsonb_build_object('id', id, 'walkdownId', walkdown_id, 'runVersion', run_version,
    'createdAt', created_at, 'createdBy', created_by, 'updatedAt', updated_at, 'updatedBy', updated_by)
  from public.qa_test_runs where id = p_id;
$$;

create or replace function qa_private.test_runs_state(p_walkdown_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(qa_private.test_run_info(id) order by created_at, id), '[]'::jsonb)
  from public.qa_test_runs where walkdown_id = p_walkdown_id and deleted_at is null;
$$;

create or replace function qa_private.validate_test_run(p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare item jsonb; station jsonb; module jsonb; device jsonb; channel jsonb; series jsonb; point jsonb;
  channel_count integer := 0; module_count integer := 0; point_count integer := 0;
  lower_time numeric; upper_time numeric; previous_time numeric; point_time numeric;
begin
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 4194304 then
    raise exception 'The normalized test run must be an object no larger than 4 MB.';
  end if;
  if p_data ?| array['id','walkdownId','runVersion','createdAt','createdBy','updatedAt','updatedBy','deletedAt','deletedBy'] then
    raise exception 'Test run identity and audit metadata are managed by the server.';
  end if;
  if p_data->'schemaVersion' is distinct from '1'::jsonb then raise exception 'Unsupported test run format. Import the files again.'; end if;
  if jsonb_typeof(p_data->'name') is distinct from 'string' or length(trim(p_data->>'name')) not between 1 and 160
    or (p_data->>'name') ~ '[[:cntrl:]]' then raise exception 'Enter a test run name between 1 and 160 characters.'; end if;
  if p_data ? 'comment' and (jsonb_typeof(p_data->'comment') is distinct from 'string' or length(p_data->>'comment') > 4000) then
    raise exception 'Keep test run and device comments to text of at most 4,000 characters.';
  end if;
  if jsonb_typeof(p_data->'software') is distinct from 'object'
    or jsonb_typeof(p_data->'software'->'name') is distinct from 'string'
    or length(trim(p_data->'software'->>'name')) not between 1 and 120
    or (p_data->'software'->>'name') ~ '[[:cntrl:]]'
    or jsonb_typeof(p_data->'software'->'version') is distinct from 'string'
    or length(trim(p_data->'software'->>'version')) not between 1 and 80
    or (p_data->'software'->>'version') ~ '[[:cntrl:]]' then
    raise exception 'Enter the test software name and version before saving the test run.';
  end if;
  if jsonb_typeof(p_data->'clock') is distinct from 'object'
    or coalesce(p_data->'clock'->>'basis','') not in ('source-local','absolute')
    or jsonb_typeof(p_data->'clock'->'timeZone') is distinct from 'string'
    or length(trim(p_data->'clock'->>'timeZone')) not between 1 and 120 then
    raise exception 'The test run clock basis and time zone are required.';
  end if;
  if coalesce(p_data->'clock'->'startMs', 'null'::jsonb) = 'null'::jsonb
    and coalesce(p_data->'clock'->'endMs', 'null'::jsonb) = 'null'::jsonb then
    if coalesce(p_data->'clock'->'start', 'null'::jsonb) <> 'null'::jsonb
      or coalesce(p_data->'clock'->'end', 'null'::jsonb) <> 'null'::jsonb then
      raise exception 'The test run has inconsistent time limits.';
    end if;
  else
    if jsonb_typeof(p_data->'clock'->'startMs') is distinct from 'number'
      or jsonb_typeof(p_data->'clock'->'endMs') is distinct from 'number'
      or jsonb_typeof(p_data->'clock'->'start') is distinct from 'string'
      or jsonb_typeof(p_data->'clock'->'end') is distinct from 'string' then
      raise exception 'The test run has inconsistent time limits.';
    end if;
    lower_time := (p_data->'clock'->>'startMs')::numeric;
    upper_time := (p_data->'clock'->>'endMs')::numeric;
    if lower_time < -8640000000000000 or upper_time > 8640000000000000 or lower_time > upper_time
      or lower_time <> trunc(lower_time) or upper_time <> trunc(upper_time) then
      raise exception 'The test run time limits are invalid.';
    end if;
  end if;
  if jsonb_typeof(p_data->'sources') is distinct from 'array' or jsonb_array_length(p_data->'sources') not between 1 and 20 then
    raise exception 'Import between 1 and 20 source files for a test run.';
  end if;
  for item in select value from jsonb_array_elements(p_data->'sources') loop
    if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'id') is distinct from 'string'
      or length(item->>'id') not between 1 and 160 or jsonb_typeof(item->'name') is distinct from 'string'
      or length(item->>'name') not between 1 and 260 or jsonb_typeof(item->'kind') is distinct from 'string'
      or length(item->>'kind') not between 1 and 40 or jsonb_typeof(item->'sha256') is distinct from 'string'
      or (item->>'sha256') !~ '^[0-9a-fA-F]{64}$' or jsonb_typeof(item->'size') is distinct from 'number'
      or (item->>'size')::numeric not between 1 and 10485760 then
      raise exception 'Every test source needs its filename, type, byte size, and SHA-256 hash.';
    end if;
  end loop;
  if (select count(*) <> count(distinct value->>'id') from jsonb_array_elements(p_data->'sources')) then
    raise exception 'Test source identifiers must be unique.';
  end if;
  if jsonb_typeof(p_data->'stations') is distinct from 'array' or jsonb_array_length(p_data->'stations') > 64 then
    raise exception 'The test run station list is invalid or too large.';
  end if;
  for station in select value from jsonb_array_elements(p_data->'stations') loop
    if jsonb_typeof(station) is distinct from 'object' or jsonb_typeof(station->'id') is distinct from 'string'
      or length(station->>'id') not between 1 and 160 or jsonb_typeof(station->'modules') is distinct from 'array' then
      raise exception 'The test run station or module metadata is invalid.';
    end if;
    module_count := module_count + jsonb_array_length(station->'modules');
    for module in select value from jsonb_array_elements(station->'modules') loop
      if jsonb_typeof(module) is distinct from 'object' or jsonb_typeof(module->'parameters') is distinct from 'array'
        or jsonb_array_length(module->'parameters') > 1000 then raise exception 'The module parameters are invalid or too large.'; end if;
    end loop;
  end loop;
  if module_count > 256 then raise exception 'A test run can contain at most 256 modules.'; end if;
  if jsonb_typeof(p_data->'devices') is distinct from 'array' or jsonb_array_length(p_data->'devices') > 250
    or jsonb_typeof(p_data->'unassignedChannels') is distinct from 'array'
    or jsonb_array_length(p_data->'unassignedChannels') > 500 then raise exception 'The test run device/channel list is invalid or too large.'; end if;
  for device in select value from jsonb_array_elements(p_data->'devices') loop
    if jsonb_typeof(device) is distinct from 'object' or jsonb_typeof(device->'id') is distinct from 'string'
      or length(device->>'id') not between 1 and 160 or jsonb_typeof(device->'name') is distinct from 'string'
      or length(device->>'name') not between 1 and 160 or coalesce(device->>'status','') not in ('Passed','Failed','Not tested')
      or jsonb_typeof(device->'channels') is distinct from 'array' then raise exception 'The device test result is invalid.'; end if;
    if device ? 'comment' and (jsonb_typeof(device->'comment') is distinct from 'string' or length(device->>'comment') > 4000) then
      raise exception 'Keep test run and device comments to text of at most 4,000 characters.';
    end if;
  end loop;
  if (select count(*) <> count(distinct value->>'id') from jsonb_array_elements(p_data->'devices')) then
    raise exception 'Test device identifiers must be unique.';
  end if;
  for channel in
    select c.value from jsonb_array_elements(p_data->'devices') d cross join lateral jsonb_array_elements(d.value->'channels') c
    union all select value from jsonb_array_elements(p_data->'unassignedChannels')
  loop
    channel_count := channel_count + 1;
    if jsonb_typeof(channel) is distinct from 'object' or jsonb_typeof(channel->'id') is distinct from 'string'
      or length(channel->>'id') not between 1 and 220 or coalesce(channel->>'status','') not in ('Passed','Failed','Not tested','Not applicable')
      or jsonb_typeof(channel->'parameters') is distinct from 'array' or jsonb_array_length(channel->'parameters') > 1000
      or jsonb_typeof(channel->'series') is distinct from 'array' or jsonb_array_length(channel->'series') > 32 then
      raise exception 'A test channel has invalid results, parameters, or measurement series.';
    end if;
    for series in select value from jsonb_array_elements(channel->'series') loop
      if jsonb_typeof(series) is distinct from 'object' or coalesce(series->>'kind','') not in ('analog','digital')
        or jsonb_typeof(series->'points') is distinct from 'array' then raise exception 'A measurement series is invalid.'; end if;
      point_count := point_count + jsonb_array_length(series->'points');
      previous_time := null;
      for point in select value from jsonb_array_elements(series->'points') loop
        if point ? 'excluded' and jsonb_typeof(point->'excluded') is distinct from 'boolean' then
          raise exception 'A recorded event''s excluded flag must be true or false.';
        end if;
        if jsonb_typeof(point) is distinct from 'object' or jsonb_typeof(point->'timeMs') is distinct from 'number'
          or jsonb_typeof(point->'valid') is distinct from 'boolean' or lower_time is null then
          raise exception 'Every measurement needs a valid timestamp within the shared run time span.';
        end if;
        point_time := (point->>'timeMs')::numeric;
        if point_time < lower_time or point_time > upper_time or point_time <> trunc(point_time)
          or (previous_time is not null and point_time < previous_time) then
          raise exception 'Measurements must be ordered and inside the shared run time span.';
        end if;
        previous_time := point_time;
        if (point->>'valid')::boolean and (jsonb_typeof(point->'value') is distinct from 'number') then
          raise exception 'Valid measurements need a numeric value.';
        end if;
        if coalesce(jsonb_typeof(point->'value'),'null') not in ('number','null')
          or coalesce(jsonb_typeof(point->'previousValue'),'null') not in ('number','null') then
          raise exception 'Measurement values must be finite numbers or explicitly missing.';
        end if;
        if (jsonb_typeof(point->'value') = 'number' and abs((point->>'value')::numeric) > 1e100)
          or (jsonb_typeof(point->'previousValue') = 'number' and abs((point->>'previousValue')::numeric) > 1e100) then
          raise exception 'A measurement value exceeds the supported numeric range.';
        end if;
        if not exists (select 1 from jsonb_array_elements(p_data->'sources') s where s.value->>'id' = point->>'sourceId') then
          raise exception 'Every measurement must reference an imported source file.';
        end if;
      end loop;
    end loop;
  end loop;
  if channel_count > 500 or point_count > 10000 then raise exception 'A test run supports at most 500 channels and 10,000 measurement events.'; end if;
  if jsonb_typeof(p_data->'warnings') is distinct from 'array' or jsonb_array_length(p_data->'warnings') > 101 then
    raise exception 'The test import warnings are invalid or too large.';
  end if;
  for item in select value from jsonb_array_elements(p_data->'warnings') loop
    if jsonb_typeof(item) is distinct from 'string' or length(item #>> '{}') > 4000 then
      raise exception 'Import warnings must be readable text no longer than 4,000 characters.';
    end if;
  end loop;
  if p_data ? 'unparsedEvents' and (jsonb_typeof(p_data->'unparsedEvents') is distinct from 'array'
    or jsonb_array_length(p_data->'unparsedEvents') > 10000) then raise exception 'The unmatched event list is invalid or too large.'; end if;
end;
$$;

create or replace function public.qa_save_test_run(p_walkdown_id uuid, p_id uuid, p_data jsonb,
  p_expected_revision bigint, p_expected_run_version bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare existing public.qa_test_runs%rowtype;
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  if p_id is null then raise exception 'Choose a valid test run identifier.'; end if;
  perform qa_private.validate_test_run(p_data);
  select * into existing from public.qa_test_runs where id = p_id;
  if found then
    if existing.walkdown_id <> p_walkdown_id then raise exception 'This test run belongs to another skid.'; end if;
    if existing.created_by <> auth.uid() and not qa_private.is_admin() then
      raise exception 'Only the importing inspector or a project administrator can change this test run.' using errcode = '42501';
    end if;
    if existing.deleted_at is not null then raise exception 'This test run was removed. Import it again as a new run.'; end if;
    if existing.data = p_data then return qa_private.test_run_info(p_id); end if;
    if p_expected_run_version is null or existing.run_version <> p_expected_run_version then
      raise exception 'This test run changed since you opened it. Refresh before saving.';
    end if;
    update public.qa_test_runs set data = p_data, run_version = run_version + 1,
      updated_at = clock_timestamp(), updated_by = auth.uid() where id = p_id;
  else
    if p_expected_run_version is not null then raise exception 'This test run no longer exists. Refresh before saving.'; end if;
    if (select count(*) from public.qa_test_runs where walkdown_id = p_walkdown_id and deleted_at is null) >= 20 then
      raise exception 'A skid can contain at most 20 active test runs. Remove an unused draft run first.';
    end if;
    insert into public.qa_test_runs(id, walkdown_id, data, created_by, updated_by)
    values(p_id, p_walkdown_id, p_data, auth.uid(), auth.uid());
  end if;
  return qa_private.test_run_info(p_id);
end;
$$;

create or replace function public.qa_delete_test_run(p_walkdown_id uuid, p_id uuid,
  p_expected_revision bigint, p_expected_run_version bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare existing public.qa_test_runs%rowtype;
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  select * into existing from public.qa_test_runs where id = p_id and walkdown_id = p_walkdown_id;
  if not found then raise exception 'Test run not found in this skid.'; end if;
  if existing.created_by <> auth.uid() and not qa_private.is_admin() then
    raise exception 'Only the importing inspector or a project administrator can remove this test run.' using errcode = '42501';
  end if;
  if existing.deleted_at is not null then return; end if;
  if p_expected_run_version is null or existing.run_version <> p_expected_run_version then
    raise exception 'This test run changed since you opened it. Refresh before removing it.';
  end if;
  update public.qa_test_runs set deleted_at = clock_timestamp(), deleted_by = auth.uid(),
    updated_at = clock_timestamp(), updated_by = auth.uid(), run_version = run_version + 1 where id = p_id;
end;
$$;

revoke all on function public.qa_save_test_run(uuid,uuid,jsonb,bigint,bigint),
  public.qa_delete_test_run(uuid,uuid,bigint,bigint) from public, anon, authenticated;
grant execute on function public.qa_save_test_run(uuid,uuid,jsonb,bigint,bigint),
  public.qa_delete_test_run(uuid,uuid,bigint,bigint) to authenticated;
revoke all on function qa_private.test_run_info(uuid), qa_private.test_runs_state(uuid),
  qa_private.validate_test_run(jsonb) from public, anon, authenticated;
notify pgrst, 'reload schema';

-- Test setup photo layer; keep synchronized with test-setup-photos.sql.
-- Test setup photos reuse private evidence objects and approved path references.
-- Install after qc-revisions.sql and proneta-test-reports.sql on every upgrade.
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
