import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const sql = (name) => readFile(new URL(`../supabase/${name}`, import.meta.url), "utf8");
const schema = await sql("schema.sql");
const qcMigration = await sql("qc-revisions.sql");
const migration = await sql("proneta-test-reports.sql");
const verification = await sql("VERIFY.sql");
const deployScript = await readFile(new URL("../scripts/migrate-qc-revisions.mjs", import.meta.url), "utf8");
const deploymentChecks = deployScript.match(/const result = await query\(`([\s\S]*?)`, true\);/)[1];
const admin = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const outsider = "33333333-3333-4333-8333-333333333333";
const setup = `
create role anon; create role authenticated; create schema auth;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb default '{}'::jsonb);
alter table storage.objects enable row level security; grant usage on schema storage to authenticated,anon;
grant select,insert,update,delete on storage.objects to authenticated,anon;
insert into auth.users values('${admin}','khuong@jeevyfabrication.com',now()),('${second}','second@example.com',now()),('${outsider}','outside@example.com',now());
`;

async function database(t, initial = schema) {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(setup);
  await db.exec(initial);
  await db.exec("insert into public.qa_inspectors values('second@example.com','Second inspector',false,true)");
  const user = async (id = admin) => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec("set role authenticated");
  };
  const rpc = async (name, ...args) => (await db.query(
    `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as result`, args,
  )).rows[0].result;
  await user();
  return { db, user, rpc, state: (id) => rpc("qa_load_state", id) };
}

function runData({ timed = true } = {}) {
  const start = "2026-01-10T10:00:00", end = "2026-01-10T10:00:10";
  const startMs = Date.parse(`${start}Z`), endMs = Date.parse(`${end}Z`);
  return {
    schemaVersion: 1, name: "Synthetic functional test", software: { name: "PRONETA Basic", version: "3.9" },
    clock: { basis: "source-local", timeZone: "Source clock (unspecified)",
      start: timed ? start : null, end: timed ? end : null, startMs: timed ? startMs : null, endMs: timed ? endMs : null },
    sources: [{ id: "source-a", name: "synthetic.csv", kind: "results", stationId: "rio-a", size: 450, sha256: "a".repeat(64) }],
    stations: [{ id: "rio-a", name: "RIO A", modules: [{ slot: 1, name: "Synthetic module", parameters: [] }] }],
    devices: [{ id: "V-3541", name: "V-3541", status: "Passed", channels: [{
      id: "rio-a:1:0", stationId: "rio-a", slot: 1, channel: 0, sourceChannel: 0,
      symbolicName: "V-3541", role: "output", status: "Passed", rawStatus: "OK", comment: "Recorded test result",
      parameters: [{ name: "Enable diagnostics", value: "Enabled", rawValue: "1", scope: "channel" }],
      series: timed ? [{ id: "rio-a:1:0:digital", name: "Output", unit: "", kind: "digital", points: [
        { time: start, timeMs: startMs, value: 0, previousValue: null, rawValue: "0", previousRawValue: null,
          valid: true, sourceId: "source-a", sourceRow: 2 },
        { time: end, timeMs: endMs, value: 1, previousValue: 0, rawValue: "1", previousRawValue: "0",
          valid: true, sourceId: "source-a", sourceRow: 3 },
      ] }] : [],
    }] }],
    unassignedChannels: [], warnings: ["Synthetic fixture; source clock has no time zone."], unparsedEvents: [],
  };
}

test("functional test imports preserve old snapshots and share explicit approval/revision locks", async (t) => {
  const beforeImports = schema.split("-- PRONETA test report layer;")[0]
    .replace("    'testRuns', qa_private.test_runs_state(p_walkdown_id),\n", "") + "commit;";
  const h = await database(t, beforeImports);
  const report = await h.rpc("qa_create_walkdown", "Functional test skid");
  const original = await h.state(report.id);
  await h.rpc("qa_approve_revision", report.id, 1, original.project.contentVersion);
  const oldSnapshot = (await h.db.query("select snapshot from public.qa_report_revisions where walkdown_id=$1", [report.id])).rows[0].snapshot;
  assert.equal(Object.hasOwn(oldSnapshot, "testRuns"), false, "legacy snapshots predate imported test runs");
  await h.db.exec("reset role");
  await h.db.exec(qcMigration);
  await h.db.exec(migration);
  await h.db.exec(migration);
  await h.user();
  assert.deepEqual((await h.db.query("select snapshot from public.qa_report_revisions where walkdown_id=$1", [report.id])).rows[0].snapshot, oldSnapshot);
  assert.equal((await h.state(report.id)).testRuns, undefined, "legacy closed JSON remains byte-for-byte compatible");
  await h.rpc("qa_new_revision", report.id, 1);
  const draft = await h.state(report.id);
  const id = crypto.randomUUID(), data = runData();
  const saved = await h.rpc("qa_save_test_run", report.id, id, data, 2, null);
  assert.equal(saved.id, id);
  assert.equal(saved.walkdownId, report.id);
  assert.equal(saved.runVersion, 1);
  assert.equal(saved.createdBy, admin);
  assert.deepEqual(saved.sources, data.sources);
  let current = await h.state(report.id);
  assert.equal(current.project.revision, 2);
  assert.ok(current.project.contentVersion > draft.project.contentVersion);
  assert.deepEqual(current.testRuns, [saved]);
  const contentVersion = current.project.contentVersion;
  assert.deepEqual(await h.rpc("qa_save_test_run", report.id, id, data, 2, null), saved, "a lost import response can retry without duplication");
  assert.equal((await h.state(report.id)).project.contentVersion, contentVersion);
  await assert.rejects(h.rpc("qa_approve_revision", report.id, 2, draft.project.contentVersion), /changed since you reviewed/);
  const closed = await h.rpc("qa_approve_revision", report.id, 2, contentVersion);
  assert.deepEqual(closed.testRuns, [saved]);
  assert.equal(closed.revisions[0].testRunCount, 1);
  assert.equal(closed.revisions[1].testRunCount, 0);
  await assert.rejects(h.rpc("qa_save_test_run", report.id, crypto.randomUUID(), data, 2, null), /approved and closed/);
  await assert.rejects(h.rpc("qa_delete_test_run", report.id, id, 2, 1), /approved and closed/);
  await h.db.exec("reset role");
  await assert.rejects(h.db.query("update public.qa_test_runs set data=$1 where id=$2", [runData({ timed: false }), id]), /approved and closed/);
  await h.db.exec(schema);
  await h.db.exec(qcMigration);
  await h.db.exec(migration);
  assert.equal(Object.values((await h.db.query(deploymentChecks)).rows[0]).every(value => value === true), true);
  await h.db.exec(verification);
  await h.user();
  assert.deepEqual(await h.state(report.id), closed, "schema and individual migrations preserve the closed report");
  await h.rpc("qa_new_revision", report.id, 2);
  assert.deepEqual((await h.state(report.id)).testRuns, [saved], "the next draft starts with the current run");
  await assert.rejects(h.rpc("qa_save_test_run", report.id, id, { ...data, name: "Late overwrite" }, 2, 1), /different revision/);
  const editedData = { ...data, name: "Reviewed imported run", software: { name: "PRONETA Basic", version: "3.9.1" } };
  const edited = await h.rpc("qa_save_test_run", report.id, id, editedData, 3, 1);
  assert.equal(edited.runVersion, 2);
  await assert.rejects(h.rpc("qa_save_test_run", report.id, id, { ...editedData, name: "Stale" }, 3, 1), /changed since you opened/);
  await assert.rejects(h.rpc("qa_delete_test_run", report.id, id, 3, 1), /changed since you opened/);
  await h.rpc("qa_delete_test_run", report.id, id, 3, 2);
  const afterRemoval = await h.state(report.id);
  assert.deepEqual(afterRemoval.testRuns, []);
  await h.rpc("qa_delete_test_run", report.id, id, 3, 2);
  assert.equal((await h.state(report.id)).project.contentVersion, afterRemoval.project.contentVersion);
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 2)).testRuns, [saved], "later edits and removal cannot rewrite approved software/results/series");
  assert.equal((await h.rpc("qa_load_revision", report.id, 1)).testRuns, undefined);
});

test("functional test writes require source/software validity, ordered shared timing, and inspector ownership", async (t) => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Validation skid");
  const other = await h.rpc("qa_create_walkdown", "Other skid");
  const valid = runData();
  const checkInvalid = async (edit, pattern) => {
    const data = structuredClone(valid); edit(data);
    await assert.rejects(h.rpc("qa_save_test_run", report.id, crypto.randomUUID(), data, 1, null), pattern);
  };
  await checkInvalid(data => { data.software.version = " "; }, /software name and version/);
  await checkInvalid(data => { data.id = crypto.randomUUID(); }, /managed by the server/);
  await checkInvalid(data => { data.sources[0].sha256 = "missing"; }, /SHA-256/);
  await checkInvalid(data => { data.clock.endMs = data.clock.startMs - 1; }, /time limits are invalid/);
  await checkInvalid(data => { data.devices[0].channels[0].series[0].points.reverse(); }, /Measurements must be ordered/);
  await checkInvalid(data => { data.devices[0].channels[0].series[0].points[0].timeMs -= 1; }, /shared run time span/);
  await checkInvalid(data => { data.devices[0].channels[0].series[0].points[0].value = null; }, /numeric value/);
  await checkInvalid(data => { data.devices[0].channels[0].series[0].points[0].sourceId = "unknown"; }, /reference an imported source/);
  await checkInvalid(data => { data.devices[0].status = "Looks okay"; }, /device test result is invalid/);
  const untimed = runData({ timed: false }), id = crypto.randomUUID();
  const saved = await h.rpc("qa_save_test_run", report.id, id, untimed, 1, null);
  assert.equal(saved.clock.startMs, null, "results without dated series are supported");
  await assert.rejects(h.rpc("qa_save_test_run", other.id, id, untimed, 1, null), /belongs to another skid/);
  await assert.rejects(h.rpc("qa_delete_test_run", other.id, id, 1, 1), /not found in this skid/);
  await h.user(second);
  await assert.rejects(h.rpc("qa_delete_test_run", report.id, id, 1, 1), /Only the importing inspector/);
  await assert.rejects(h.rpc("qa_save_test_run", report.id, id, { ...untimed, name: "Another inspector" }, 1, 1), /Only the importing inspector/);
  const ownId = crypto.randomUUID();
  await h.rpc("qa_save_test_run", report.id, ownId, untimed, 1, null);
  await h.rpc("qa_delete_test_run", report.id, ownId, 1, 1);
  assert.equal((await h.db.query("select id from public.qa_test_runs where id=$1", [ownId])).rows.length, 0, "removed rows are hidden by RLS");
  await h.user(admin);
  const secondaryId = crypto.randomUUID();
  await h.user(second);
  await h.rpc("qa_save_test_run", report.id, secondaryId, untimed, 1, null);
  await h.user(admin);
  await h.rpc("qa_delete_test_run", report.id, secondaryId, 1, 1);
  await assert.rejects(h.db.query("delete from public.qa_test_runs where id=$1", [id]), /permission denied/);
  await h.user(outsider);
  await assert.rejects(h.rpc("qa_save_test_run", report.id, crypto.randomUUID(), untimed, 1, null), /approved project inspector/);
  assert.equal((await h.db.query("select id from public.qa_test_runs")).rows.length, 0);
});

test("deployment verification works for a table-read role without private helper execution", async (t) => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Read-only deployment verification");
  const data = runData();
  await h.rpc("qa_save_test_run", report.id, crypto.randomUUID(), data, 1, null);
  const removedId = crypto.randomUUID();
  await h.rpc("qa_save_test_run", report.id, removedId, data, 1, null);
  await h.rpc("qa_delete_test_run", report.id, removedId, 1, 1);
  await h.rpc("qa_save_test_run", report.id, crypto.randomUUID(), { ...data, name: "Second saved run" }, 1, null);
  const current = await h.state(report.id);
  assert.equal(current.testRuns.length, 2);
  await h.rpc("qa_approve_revision", report.id, 1, current.project.contentVersion);
  await h.db.exec(`
    reset role;
    create role qc_deployment_reader bypassrls;
    grant pg_read_all_data to qc_deployment_reader;
    set role qc_deployment_reader;
  `);
  assert.equal((await h.db.query("select has_function_privilege(current_user, 'qa_private.test_runs_state(uuid)', 'EXECUTE') as allowed")).rows[0].allowed, false);
  await assert.rejects(h.db.query("select qa_private.test_runs_state($1)", [report.id]), /permission denied/);
  await h.db.exec("begin read only");
  try {
    const checks = (await h.db.query(deploymentChecks)).rows[0];
    assert.equal(Object.keys(checks).length, 11);
    assert.equal(Object.values(checks).every(value => value === true), true);
    const manualCheck = verification.match(/select w\.id as closed_report_with_changed_test_runs[\s\S]*?;/)[0];
    assert.deepEqual((await h.db.query(manualCheck)).rows, []);
    const changedSnapshot = deploymentChecks.replace("r.snapshot->'testRuns'", "(r.snapshot #- '{testRuns,0,updatedBy}')->'testRuns'");
    assert.equal((await h.db.query(changedSnapshot)).rows[0].closed_test_runs_preserved, false,
      "verification compares complete frozen audit metadata, not just run counts");
  } finally {
    await h.db.exec("rollback");
  }
});
