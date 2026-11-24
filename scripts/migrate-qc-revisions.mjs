import { readFile } from "node:fs/promises";

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is required in the existing deployment environment.");
const endpoint = "https://api.supabase.com/v1/projects/ybeinufetluekswsulvj/database/query";

async function query(sql, readOnly = false) {
  const response = await fetch(`${endpoint}${readOnly ? "/read-only" : ""}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`The QC database update failed (HTTP ${response.status}). Check the Supabase database logs.`);
  return response.json();
}

await query(await readFile(new URL("../supabase/qc-revisions.sql", import.meta.url), "utf8"));
await query(await readFile(new URL("../supabase/proneta-test-reports.sql", import.meta.url), "utf8"));
await query(await readFile(new URL("../supabase/test-setup-photos.sql", import.meta.url), "utf8"));
const result = await query(`
  select
    (select count(*) from public.qa_targets) = 39
      and not exists (select 1 from public.qa_walkdowns w left join public.qa_records r on r.walkdown_id = w.id
        group by w.id having count(r.key) <> 39) as catalog_preserved,
    not exists (select 1 from public.qa_walkdowns where revision < 1 or content_version < 1
      or status not in ('draft', 'closed')) as revisions_valid,
    (select count(*) = 2 and bool_and(relrowsecurity) from pg_class
      where oid in ('public.qa_report_revisions'::regclass, 'public.qa_revision_photos'::regclass))
      and not has_table_privilege('authenticated', 'public.qa_report_revisions', 'INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated', 'public.qa_revision_photos', 'INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon', 'public.qa_report_revisions', 'SELECT') as archives_protected,
    (select count(*) = 5 from pg_trigger where not tgisinternal and tgenabled = 'O'
      and tgname in ('qa_records_draft_only','qa_comments_draft_only','qa_photos_draft_only',
        'qa_report_revisions_immutable','qa_revision_photos_immutable')) as locks_installed,
    not exists (select 1 from unnest(array[
      'public.qa_rename_walkdown(uuid,text)', 'public.qa_prepare_photo(uuid,uuid,text,text,text,integer,integer)',
      'public.qa_add_photo(uuid,uuid)', 'public.qa_add_comment(uuid,text,text)',
      'public.qa_set_complete(uuid,text,boolean)', 'public.qa_set_quality(uuid,text,text)',
      'public.qa_delete_photo(uuid,uuid)']) signature
      where has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE')) as old_writes_blocked,
    (select bool_and(has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE')
      and not has_function_privilege('anon', to_regprocedure(signature), 'EXECUTE')) from unnest(array[
      'public.qa_approve_revision(uuid,bigint,bigint)', 'public.qa_new_revision(uuid,bigint)',
      'public.qa_delete_comment(uuid,uuid,bigint)', 'public.qa_load_revision(uuid,bigint)',
      'public.qa_reorder_photos(uuid,text,uuid[],uuid[],bigint)',
      'public.qa_list_revisions(uuid)']) signature) as revision_access_verified,
    not exists (select 1 from public.qa_walkdowns w left join public.qa_report_revisions r
      on r.walkdown_id = w.id and r.revision = w.revision
      where w.status = 'closed' and (r.walkdown_id is null or r.closed_at is distinct from w.closed_at
        or r.closed_by is distinct from w.closed_by or r.skid_name is distinct from w.skid_name)) as closed_reports_preserved,
    not exists (select 1 from public.qa_revision_photos p where not exists
      (select 1 from storage.objects o where o.bucket_id = 'qa-evidence' and o.name = p.path)) as archived_photos_preserved,
    not exists (select 1 from public.qa_walkdowns w join public.qa_report_revisions r
      on r.walkdown_id = w.id and r.revision = w.revision where w.status = 'closed'
      and coalesce((select jsonb_agg(photo order by photo->>'recordKey', ordinal)
        from jsonb_array_elements(r.snapshot->'photos') with ordinality as frozen(photo, ordinal)), '[]'::jsonb)
      is distinct from (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'walkdownId', p.walkdown_id, 'recordKey', p.record_key,
        'path', p.path, 'name', p.name, 'width', p.width, 'height', p.height, 'createdAt', p.created_at, 'createdBy', p.created_by)
        order by p.record_key, p.photo_position, p.created_at, p.id), '[]'::jsonb)
        from public.qa_photos p where p.walkdown_id = w.id and p.record_key is not null
          and p.upload_state = 'ready' and p.deleted_at is null)) as closed_inspection_photos_preserved,
    (select relrowsecurity from pg_class where oid = 'public.qa_test_runs'::regclass)
      and not has_table_privilege('authenticated', 'public.qa_test_runs', 'INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon', 'public.qa_test_runs', 'SELECT')
      and (select count(*) = 2 from pg_trigger where not tgisinternal and tgenabled = 'O'
        and tgname in ('qa_test_runs_draft_only','qa_test_runs_report_revision')) as test_runs_protected,
    (select bool_and(to_regprocedure(signature) is not null
      and has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE')
      and not has_function_privilege('anon', to_regprocedure(signature), 'EXECUTE')) from unnest(array[
      'public.qa_save_test_run(uuid,uuid,jsonb,bigint,bigint)',
      'public.qa_delete_test_run(uuid,uuid,bigint,bigint)',
      'public.qa_prepare_test_setup_photo(uuid,uuid,uuid,text,text,integer,integer,bigint)',
      'public.qa_prepare_test_setup_photo(uuid,uuid,uuid,text,text,integer,integer,bigint,text)',
      'public.qa_add_test_setup_photo(uuid,uuid,uuid,bigint)',
      'public.qa_update_test_setup_photo(uuid,uuid,uuid,text,bigint)',
      'public.qa_reorder_test_setup_photos(uuid,uuid,uuid[],uuid[],bigint)',
      'public.qa_delete_test_setup_photo(uuid,uuid,uuid,bigint)']) signature) as test_run_access_verified,
    -- The read-only API role has table access but cannot execute private helpers.
    -- Keep this aggregate aligned with test_run_info/test_runs_state without grants.
    not exists (select 1 from public.qa_walkdowns w join public.qa_report_revisions r
      on r.walkdown_id = w.id and r.revision = w.revision
      where w.status = 'closed' and coalesce(r.snapshot->'testRuns', '[]'::jsonb)
        is distinct from (select coalesce(jsonb_agg(t.data || jsonb_build_object(
          'id', t.id, 'walkdownId', t.walkdown_id, 'runVersion', t.run_version,
          'createdAt', t.created_at, 'createdBy', t.created_by,
          'updatedAt', t.updated_at, 'updatedBy', t.updated_by
        ) || coalesce((select jsonb_build_object('setupPhotos', jsonb_agg(jsonb_build_object(
            'id', p.id, 'walkdownId', p.walkdown_id, 'testRunId', p.test_run_id,
            'path', p.path, 'name', p.name, 'width', p.width, 'height', p.height, 'caption', p.caption,
            'createdAt', p.created_at, 'createdBy', p.created_by
          ) order by p.photo_position, p.created_at, p.id)) from public.qa_photos p
          where p.test_run_id = t.id and p.walkdown_id = t.walkdown_id
            and p.upload_state = 'ready' and p.deleted_at is null having count(*) > 0), '{}'::jsonb) order by t.created_at, t.id), '[]'::jsonb)
        from public.qa_test_runs t where t.walkdown_id = w.id and t.deleted_at is null))
      as closed_test_runs_preserved;
`, true);
const row = Array.isArray(result) ? result[0] : result.data?.[0] ?? result.result?.[0] ?? result;
const checks = ["catalog_preserved", "revisions_valid", "archives_protected", "locks_installed",
  "old_writes_blocked", "revision_access_verified", "closed_reports_preserved", "archived_photos_preserved", "closed_inspection_photos_preserved",
  "test_runs_protected", "test_run_access_verified", "closed_test_runs_preserved"];
const failed = checks.filter((key) => row?.[key] !== true);
if (failed.length) throw new Error(`QC revision verification failed: ${failed.join(", ")}`);
console.log("QC revision and test-run migrations verified: existing reports preserved, closed revisions protected, and versioned write access enabled.");

// Start Skid 1's new report numbering at the approved reset point.
// The revision ID is still the key for archived reports, photos, and edits.
await query(`
  update public.qa_walkdowns
  set revision_number_base = 243
  where lower(skid_name) = 'skid 1' and revision = 243 and revision_number_base = 1;
`);
