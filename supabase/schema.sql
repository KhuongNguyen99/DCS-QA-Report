-- DCS shared inspection workspace, revision 3.
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
  kind text not null check (kind in ('device', 'terminal')),
  terminal text not null check (terminal ~ '^[A-H]$'),
  label text not null,
  check ((kind = 'terminal' and key = 'terminal:' || terminal) or (kind = 'device' and key = 'device:' || label))
);
insert into public.qa_targets (key, kind, terminal, label)
select 'terminal:' || letter, 'terminal', letter, letter
from unnest(array['A','B','C','D','E','F','G','H']) as letter
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
insert into public.qa_records (key) select key from public.qa_targets on conflict (key) do nothing;

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

-- All mutating RPCs hold the same transaction lock. This small single-project
-- workspace favors reliable completion invariants over concurrent write volume.
create or replace function qa_private.touch_record(p_key text, p_reopen boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.qa_records set
    complete = case when p_reopen then false else complete end,
    completed_at = case when p_reopen then null else completed_at end,
    completed_by = case when p_reopen then null else completed_by end,
    updated_at = clock_timestamp()
  where key = p_key;
  if p_reopen then
    update public.qa_records set complete = false, completed_at = null, completed_by = null, updated_at = clock_timestamp()
    where key = (select 'terminal:' || terminal from public.qa_targets where key = p_key and kind = 'device');
  end if;
end;
$$;

create or replace function public.qa_load_state()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform qa_private.require_inspector();
  select jsonb_build_object(
    'project', jsonb_build_object('title', '450k skid x7 - DCS', 'revision', 3),
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

create or replace function public.qa_prepare_photo(p_id uuid, p_record_key text, p_path text, p_name text, p_width integer, p_height integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_inspector();
  perform pg_catalog.pg_advisory_xact_lock(450007, 3);
  if not exists (select 1 from public.qa_targets where key = p_record_key) then
    raise exception 'Unknown device or terminal.';
  end if;
  if p_path is null or p_path not in (
    auth.uid()::text || '/' || p_id::text || '.jpg',
    auth.uid()::text || '/' || p_id::text || '.png',
    auth.uid()::text || '/' || p_id::text || '.webp'
  ) then raise exception 'Invalid photo storage path.'; end if;
  insert into public.qa_photos (id, record_key, path, name, width, height, created_by)
  values (p_id, p_record_key, p_path, trim(p_name), p_width, p_height, auth.uid());
end;
$$;

create or replace function public.qa_add_photo(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare photo public.qa_photos%rowtype;
begin
  perform qa_private.require_inspector();
  perform pg_catalog.pg_advisory_xact_lock(450007, 3);
  select * into photo from public.qa_photos where id = p_id and created_by = auth.uid() and deleted_at is null;
  if not found then raise exception 'The photo upload reservation was not found.'; end if;
  if photo.upload_state = 'ready' then return to_jsonb(photo); end if;
  if not exists (select 1 from storage.objects where bucket_id = 'qa-evidence' and name = photo.path) then
    raise exception 'Upload the image before adding it to the inspection.';
  end if;
  update public.qa_photos set upload_state = 'ready', created_at = clock_timestamp() where id = p_id returning * into photo;
  perform qa_private.touch_record(photo.record_key, false);
  return to_jsonb(photo);
end;
$$;

create or replace function public.qa_cancel_photo(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare photo public.qa_photos%rowtype;
begin
  perform qa_private.require_inspector();
  perform pg_catalog.pg_advisory_xact_lock(450007, 3);
  select * into photo from public.qa_photos where id = p_id and created_by = auth.uid();
  if not found then raise exception 'The photo upload reservation was not found.'; end if;
  if photo.upload_state = 'ready' then raise exception 'This photo is already saved. Refresh the inspection to view it.'; end if;
  update public.qa_photos set deleted_at = coalesce(deleted_at, clock_timestamp()), deleted_by = auth.uid() where id = p_id;
end;
$$;

create or replace function public.qa_add_comment(p_record_key text, p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare author text; added public.qa_comments%rowtype;
begin
  perform qa_private.require_inspector();
  perform pg_catalog.pg_advisory_xact_lock(450007, 3);
  if p_record_key is distinct from 'walkdown:general' and not exists (select 1 from public.qa_targets where key = p_record_key) then
    raise exception 'Unknown comment scope.';
  end if;
  select i.display_name into author from public.qa_inspectors i join auth.users u on lower(u.email) = i.email where u.id = auth.uid();
  insert into public.qa_comments(record_key, text, created_by, author_name)
  values (nullif(p_record_key, 'walkdown:general'), trim(p_text), auth.uid(), author) returning * into added;
  if p_record_key <> 'walkdown:general' then perform qa_private.touch_record(p_record_key, false); end if;
  return to_jsonb(added);
end;
$$;

create or replace function public.qa_set_complete(p_record_key text, p_complete boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.qa_targets%rowtype; updated public.qa_records%rowtype;
begin
  perform qa_private.require_inspector();
  perform pg_catalog.pg_advisory_xact_lock(450007, 3);
  select * into target from public.qa_targets where key = p_record_key;
  if not found then raise exception 'Unknown device or terminal.'; end if;
  if p_complete is null then raise exception 'Completion must be true or false.'; end if;
  if p_complete then
    if not exists (select 1 from public.qa_photos p join storage.objects o on o.bucket_id = 'qa-evidence' and o.name = p.path
      where p.record_key = p_record_key and p.upload_state = 'ready' and p.deleted_at is null) then
      raise exception 'Add at least one inspection photo before marking this item complete.';
    end if;
    if target.kind = 'terminal' and exists (
      select 1 from public.qa_targets t join public.qa_records r on r.key = t.key
      where t.kind = 'device' and t.terminal = target.terminal and not r.complete
    ) then raise exception 'Complete every device in this terminal group first.'; end if;
    update public.qa_records set complete = true, completed_at = clock_timestamp(), completed_by = auth.uid(), updated_at = clock_timestamp()
    where key = p_record_key;
  else
    perform qa_private.touch_record(p_record_key, true);
  end if;
  select * into updated from public.qa_records where key = p_record_key;
  return to_jsonb(updated);
end;
$$;

-- A single nullable value makes Good/Bad mutually exclusive across clients.
-- Quality is independent of evidence completion; clearing it is audited too.
create or replace function public.qa_set_quality(p_record_key text, p_quality text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare updated public.qa_records%rowtype;
begin
  perform qa_private.require_inspector();
  perform pg_catalog.pg_advisory_xact_lock(450007, 3);
  if p_quality is not null and p_quality not in ('good', 'bad') then
    raise exception 'Quality must be Good, Bad, or unrated.';
  end if;
  update public.qa_records set quality = p_quality, quality_by = auth.uid(), quality_at = clock_timestamp(), updated_at = clock_timestamp()
  where key = p_record_key returning * into updated;
  if not found then raise exception 'Unknown device or terminal.'; end if;
  return to_jsonb(updated);
end;
$$;

create or replace function public.qa_delete_photo(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare photo public.qa_photos%rowtype;
begin
  perform qa_private.require_inspector();
  perform pg_catalog.pg_advisory_xact_lock(450007, 3);
  select * into photo from public.qa_photos where id = p_id;
  if not found then raise exception 'Photo not found.'; end if;
  if photo.created_by <> auth.uid() and not qa_private.is_admin() then
    raise exception 'Only the photographer or a project administrator can remove this photo.' using errcode = '42501';
  end if;
  -- Idempotent retry after storage failure must not reopen a newly reinspected item.
  if photo.deleted_at is null then
    update public.qa_photos set deleted_at = clock_timestamp(), deleted_by = auth.uid() where id = p_id;
    if photo.upload_state = 'ready' then perform qa_private.touch_record(photo.record_key, true); end if;
  end if;
  return photo.path;
end;
$$;

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

revoke all on function public.qa_load_state(), public.qa_prepare_photo(uuid,text,text,text,integer,integer), public.qa_add_photo(uuid), public.qa_cancel_photo(uuid), public.qa_add_comment(text,text), public.qa_set_complete(text,boolean), public.qa_set_quality(text,text), public.qa_delete_photo(uuid) from public, anon, authenticated;
grant execute on function public.qa_load_state(), public.qa_prepare_photo(uuid,text,text,text,integer,integer), public.qa_add_photo(uuid), public.qa_cancel_photo(uuid), public.qa_add_comment(text,text), public.qa_set_complete(text,boolean), public.qa_set_quality(text,text), public.qa_delete_photo(uuid) to authenticated;

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

commit;
