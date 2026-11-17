-- Run after schema.sql or equipment-inspections.sql in Supabase SQL Editor.
-- Read-only: no users, reports, evidence, or revisions are created/changed.
select
  (select count(*) from public.qa_targets where kind = 'device') as devices_expected_28,
  (select count(*) from public.qa_targets where kind = 'terminal') as terminals_expected_8,
  (select count(*) from public.qa_targets where kind = 'equipment') as equipment_expected_3,
  (select count(*) from public.qa_walkdowns) as named_or_legacy_walkdowns,
  (select not public from storage.buckets where id = 'qa-evidence') as private_bucket_expected_true,
  (select active and is_admin from public.qa_inspectors where email = 'khuong@jeevyfabrication.com') as admin_enabled_expected_true;

-- Each existing walkdown has 39 records and revision >= 3. A fresh install has
-- no walkdowns until an inspector manually creates one. Legacy data is retained
-- in Unassigned skid until renamed; adding equipment advances its revision once.
select w.id, w.skid_name, w.name_required, w.revision, w.updated_at,
  count(r.key) as records_expected_39
from public.qa_walkdowns w left join public.qa_records r on r.walkdown_id = w.id
 group by w.id order by w.created_at;
-- Expected: exactly these three equipment rows with NULL terminal.
select key, kind, terminal, label from public.qa_targets where kind = 'equipment' order by key;
-- Expected: zero rows. This catches missing/extra equipment rows and records.
select w.id as walkdown_with_incomplete_catalog
from public.qa_walkdowns w left join public.qa_records r on r.walkdown_id = w.id
group by w.id having count(r.key) <> 39;
select key as unexpected_equipment_target from public.qa_targets
where kind = 'equipment' and (key, label, terminal) is distinct from
  (case key when 'equipment:control-box' then key when 'equipment:solenoid-box' then key
    when 'equipment:transducer-panel' then key else null end,
   case key when 'equipment:control-box' then 'Control Box' when 'equipment:solenoid-box' then 'Solenoid Box'
    when 'equipment:transducer-panel' then 'Transducer Panel' else null end, null);
select tgname as installed_revision_trigger from pg_trigger
where not tgisinternal and tgname in ('qa_records_report_revision','qa_comments_report_revision',
  'qa_photos_insert_report_revision','qa_photos_update_report_revision','qa_photos_delete_report_revision')
order by tgname;

select c.relname, c.relrowsecurity as rls_expected_true,
  has_table_privilege('anon', c.oid, 'SELECT') as anonymous_read_expected_false,
  has_table_privilege('authenticated', c.oid, 'INSERT') as browser_insert_expected_false,
  has_table_privilege('authenticated', c.oid, 'UPDATE') as browser_update_expected_false,
  has_table_privilege('authenticated', c.oid, 'DELETE') as browser_delete_expected_false
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('qa_inspectors','qa_targets','qa_records','qa_photos','qa_comments','qa_walkdowns','qa_project')
order by c.relname;

-- Current scoped/workspace RPCs: authenticated execute true; anonymous false;
-- security_definer true; empty search_path. Old overloads below must be false.
select p.oid::regprocedure as function_signature, p.prosecdef, p.proconfig,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anonymous_execute_expected_false,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as inspector_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'qa\_%' escape '\'
order by p.proname, p.pronargs;
select signature as old_unscoped_function,
  coalesce(has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE'), false) as execute_expected_false
from unnest(array['public.qa_load_state()', 'public.qa_prepare_photo(uuid,text,text,text,integer,integer)',
  'public.qa_add_photo(uuid)', 'public.qa_cancel_photo(uuid)', 'public.qa_add_comment(text,text)',
  'public.qa_set_complete(text,boolean)', 'public.qa_set_quality(text,text)', 'public.qa_delete_photo(uuid)', 'public.qa_authorize_voice(text)']) signature;

-- Expected: zero rows from these integrity checks.
select walkdown_id, key as invalid_quality from public.qa_records where quality not in ('good','bad');
select r.walkdown_id, r.key as invalid_complete_without_evidence
from public.qa_records r where r.complete and not exists (
  select 1 from public.qa_photos p join storage.objects o on o.bucket_id = 'qa-evidence' and o.name = p.path
  where p.walkdown_id = r.walkdown_id and p.record_key = r.key and p.deleted_at is null and p.upload_state = 'ready'
);
select terminal.walkdown_id, terminal.key as invalid_complete_with_unfinished_device
from public.qa_records terminal join public.qa_targets t on t.key = terminal.key
where t.kind = 'terminal' and terminal.complete and exists (
  select 1 from public.qa_targets d join public.qa_records r on r.key = d.key
  where r.walkdown_id = terminal.walkdown_id and d.kind = 'device' and d.terminal = t.terminal and not r.complete
);

-- Inspect additional Storage policies: broad permissive policies can widen access.
select policyname, roles, cmd, qual, with_check
from pg_policies where schemaname = 'storage' and tablename = 'objects' order by policyname;
-- Expected: four realtime tables.
select tablename from pg_publication_tables
where pubname = 'supabase_realtime' and schemaname = 'public'
  and tablename in ('qa_records','qa_photos','qa_comments','qa_walkdowns') order by tablename;

begin read only;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '{}';
set local role anon;
do $$
begin
  begin
    perform public.qa_list_walkdowns();
    raise exception 'FAIL: anonymous caller listed walkdowns';
  exception when insufficient_privilege then raise notice 'PASS: anonymous RPC access denied'; end;
  begin
    perform 1 from public.qa_comments;
    raise exception 'FAIL: anonymous caller read qa_comments';
  exception when insufficient_privilege then raise notice 'PASS: anonymous table access denied'; end;
end;
$$;
reset role;
set local role authenticated;
do $$
begin
  begin
    perform public.qa_list_walkdowns();
    raise exception 'FAIL: missing inspector identity listed walkdowns';
  exception when insufficient_privilege then raise notice 'PASS: missing inspector identity denied'; end;
  begin
    perform public.qa_load_state('00000000-0000-4000-8000-000000000001');
    raise exception 'FAIL: missing inspector identity loaded a walkdown';
  exception when insufficient_privilege then raise notice 'PASS: scoped state requires membership'; end;
  begin
    perform public.qa_set_quality('00000000-0000-4000-8000-000000000001', 'terminal:A', 'bad');
    raise exception 'FAIL: missing inspector identity changed quality';
  exception when insufficient_privilege then raise notice 'PASS: scoped changes require membership'; end;
  if exists (select 1 from public.qa_walkdowns) or exists (select 1 from public.qa_records)
    or exists (select 1 from public.qa_photos) or exists (select 1 from public.qa_comments) then
    raise exception 'FAIL: missing inspector identity can read inspection data';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'qa-evidence') then
    raise exception 'FAIL: missing inspector identity can list evidence';
  end if;
  raise notice 'PASS: table and storage RLS hide data without an inspector identity';
end;
$$;
reset role;
rollback;
