-- Separate named skid reports. Preserves all existing evidence/comments/status
-- under a stable legacy walkdown. Run once after the previous schema; rerunnable.
begin;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'qa_walkdowns' and column_name = 'status') then
    raise exception 'QC closeout revisions are installed. Use the current schema.sql instead of this older migration.';
  end if;
end; $$;


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
  if not exists (select 1 from public.qa_targets where key = p_record_key) then raise exception 'Unknown device or terminal.'; end if;
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
  if not found then raise exception 'Unknown device or terminal.'; end if;
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
  if not found then raise exception 'Unknown device or terminal.'; end if;
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
commit;
