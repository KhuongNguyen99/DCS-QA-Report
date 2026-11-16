-- Run after schema.sql in Supabase SQL Editor as the project owner.
-- Read-only: examines policies/catalog and checks access without creating users,
-- signing in, sending mail, or adding inspection data.

select
  (select count(*) from public.qa_targets where kind = 'device') as devices_expected_28,
  (select count(*) from public.qa_targets where kind = 'terminal') as terminals_expected_8,
  (select count(*) from public.qa_records) as records_expected_36,
  (select not public from storage.buckets where id = 'qa-evidence') as private_bucket_expected_true,
  (select active and is_admin from public.qa_inspectors where email = 'khuong@jeevyfabrication.com') as admin_enabled_expected_true;

select c.relname, c.relrowsecurity as rls_expected_true,
  has_table_privilege('anon', c.oid, 'SELECT') as anonymous_read_expected_false,
  has_table_privilege('authenticated', c.oid, 'INSERT') as browser_insert_expected_false,
  has_table_privilege('authenticated', c.oid, 'UPDATE') as browser_update_expected_false,
  has_table_privilege('authenticated', c.oid, 'DELETE') as browser_delete_expected_false
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('qa_inspectors','qa_targets','qa_records','qa_photos','qa_comments')
order by c.relname;

select p.proname, p.prosecdef as security_definer_expected_true, p.proconfig,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anonymous_execute_expected_false,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as inspector_execute_expected_true
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in
  ('qa_load_state','qa_prepare_photo','qa_add_photo','qa_cancel_photo','qa_add_comment','qa_set_complete','qa_set_quality','qa_delete_photo')
order by p.proname;

-- Expected: zero invalid quality values; initially all 36 rows are unrated.
select key as invalid_quality from public.qa_records where quality not in ('good','bad');
select coalesce(quality, 'unrated') as quality, count(*) as records
from public.qa_records group by quality order by quality;

-- Inspect all storage policies. In a dedicated project the three qa_evidence_*
-- policies are sufficient. An older broad permissive policy could widen access;
-- review any additional policy before using an existing shared project.
select policyname, roles, cmd, qual, with_check
from pg_policies where schemaname = 'storage' and tablename = 'objects'
order by policyname;

-- Expected: three rows, one for each realtime table.
select tablename from pg_publication_tables
where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('qa_records','qa_photos','qa_comments')
order by tablename;

-- Expected: zero invalid completed records.
select r.key as invalid_complete_without_evidence
from public.qa_records r where r.complete and not exists (
  select 1 from public.qa_photos p join storage.objects o on o.bucket_id = 'qa-evidence' and o.name = p.path
  where p.record_key = r.key and p.deleted_at is null and p.upload_state = 'ready'
);
select terminal.key as invalid_complete_with_unfinished_device
from public.qa_records terminal join public.qa_targets t on t.key = terminal.key
where t.kind = 'terminal' and terminal.complete and exists (
  select 1 from public.qa_targets d join public.qa_records r on r.key = d.key
  where d.kind = 'device' and d.terminal = t.terminal and not r.complete
);

begin read only;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '{}';
set local role anon;
do $$
begin
  begin
    perform public.qa_load_state();
    raise exception 'FAIL: anonymous caller executed qa_load_state';
  exception when insufficient_privilege then
    raise notice 'PASS: anonymous RPC access denied';
  end;
  begin
    perform 1 from public.qa_comments;
    raise exception 'FAIL: anonymous caller read qa_comments';
  exception when insufficient_privilege then
    raise notice 'PASS: anonymous table access denied';
  end;
  begin
    perform public.qa_set_quality('terminal:A', 'good');
    raise exception 'FAIL: anonymous caller executed qa_set_quality';
  exception when insufficient_privilege then
    raise notice 'PASS: anonymous quality changes denied';
  end;
end;
$$;
reset role;
set local role authenticated;
do $$
begin
  begin
    perform public.qa_load_state();
    raise exception 'FAIL: missing inspector identity executed qa_load_state';
  exception when insufficient_privilege then
    raise notice 'PASS: missing inspector identity denied by membership check';
  end;
  if exists (select 1 from public.qa_records) or exists (select 1 from public.qa_photos) or exists (select 1 from public.qa_comments) then
    raise exception 'FAIL: missing inspector identity can read inspection data';
  end if;
  begin
    perform public.qa_set_quality('terminal:A', 'bad');
    raise exception 'FAIL: missing inspector identity changed quality';
  exception when insufficient_privilege then
    raise notice 'PASS: missing inspector identity cannot change quality';
  end;
  if exists (select 1 from storage.objects where bucket_id = 'qa-evidence') then
    raise exception 'FAIL: missing inspector identity can list evidence';
  end if;
  raise notice 'PASS: table and storage RLS hide data without an inspector identity';
end;
$$;
reset role;
rollback;
