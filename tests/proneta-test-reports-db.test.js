import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const sql = (name) => readFile(new URL(`../supabase/${name}`, import.meta.url), "utf8");
const schema = await sql("schema.sql");
const qcMigration = await sql("qc-revisions.sql");
const migration = await sql("proneta-test-reports.sql");
const setupMigration = await sql("test-setup-photos.sql");
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

async function setupPhoto(h, walkdownId, runId, revision, userId = admin) {
  const id = crypto.randomUUID(), path = `${userId}/${id}.jpg`;
  await h.rpc("qa_prepare_test_setup_photo", walkdownId, runId, id, path, "Synthetic setup.jpg", 1600, 900, revision);
  await h.db.query("insert into storage.objects(bucket_id,name) values('qa-evidence',$1)", [path]);
  const photo = await h.rpc("qa_add_test_setup_photo", walkdownId, runId, id, revision);
  return { id, path, photo };
}

test("functional test imports preserve old snapshots and share explicit approval/revision locks", async (t) => {
  const beforeImports = schema.split("-- PRONETA test report layer;")[0]
    .replace(/    'testRuns', qa_private\.test_runs_state\(p_walkdown_id\),\r?\n/, "") + "commit;";
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
  await h.db.exec(setupMigration);
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
  await h.db.exec(setupMigration);
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
  for (const excluded of [null, 0, 1, "true", [], {}]) {
    await checkInvalid(data => { data.devices[0].channels[0].series[0].points[0].excluded = excluded; }, /excluded flag.*true or false/);
    await checkInvalid(data => {
      data.unassignedChannels = data.devices[0].channels; data.devices = [];
      data.unassignedChannels[0].series[0].points[0].excluded = excluded;
    }, /excluded flag.*true or false/);
  }
  await checkInvalid(data => {
    const point = data.devices[0].channels[0].series[0].points[0]; point.excluded = true; point.timeMs -= 1;
  }, /shared run time span/);
  await checkInvalid(data => {
    const points = data.devices[0].channels[0].series[0].points; points[1].excluded = true; points.reverse();
  }, /Measurements must be ordered/);
  await checkInvalid(data => {
    const point = data.devices[0].channels[0].series[0].points[0]; point.excluded = true; point.sourceId = "unknown";
  }, /reference an imported source/);
  for (const comment of [null, 1, false, [], {}, "x".repeat(4001), "😀".repeat(4001)]) {
    await checkInvalid(data => { data.comment = comment; }, /comments.*4,000/);
    await checkInvalid(data => { data.devices[0].comment = comment; }, /comments.*4,000/);
  }
  await checkInvalid(data => { data.comment = "Null\u0000byte"; }, /unsupported Unicode escape/);
  await checkInvalid(data => { data.devices[0].comment = "Null\u0000byte"; }, /unsupported Unicode escape/);
  const bounded = runData();
  bounded.comment = "😀".repeat(4000);
  bounded.devices[0].comment = "x".repeat(4000);
  const boundedId = crypto.randomUUID();
  const boundarySaved = await h.rpc("qa_save_test_run", report.id, boundedId, bounded, 1, null);
  assert.equal(boundarySaved.comment, bounded.comment);
  assert.equal(boundarySaved.devices[0].comment, bounded.devices[0].comment);
  bounded.comment = "x".repeat(4000);
  bounded.devices[0].comment = "😀".repeat(4000);
  const boundaryEdited = await h.rpc("qa_save_test_run", report.id, boundedId, bounded, 1, 1);
  assert.equal(boundaryEdited.comment, bounded.comment);
  assert.equal(boundaryEdited.devices[0].comment, bounded.devices[0].comment);
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

test("authored comments belong to one test run and remain frozen after approval and later clearing", async (t) => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Authored test comments skid");
  const id = crypto.randomUUID(), otherId = crypto.randomUUID(), data = runData();
  await h.user(second);
  const legacy = await h.rpc("qa_save_test_run", report.id, id, data, 1, null);
  const other = await h.rpc("qa_save_test_run", report.id, otherId, data, 1, null);
  assert.equal(Object.hasOwn(legacy, "comment"), false);
  assert.equal(Object.hasOwn(legacy.devices[0], "comment"), false);
  const initial = await h.state(report.id);
  const authored = structuredClone(data);
  authored.comment = "  Overall run review\nRetest completed.  ";
  authored.devices[0].comment = "Device reviewed\nTravel verified ✓";
  const saved = await h.rpc("qa_save_test_run", report.id, id, authored, 1, 1);
  assert.equal(saved.runVersion, 2);
  assert.equal(saved.comment, authored.comment);
  assert.equal(saved.devices[0].comment, authored.devices[0].comment);
  assert.deepEqual(saved.devices[0].channels, data.devices[0].channels);
  assert.deepEqual(saved.sources, data.sources);
  let current = await h.state(report.id);
  assert.ok(current.project.contentVersion > initial.project.contentVersion);
  assert.deepEqual(current.testRuns.find(run => run.id === otherId), other);
  assert.deepEqual(current.comments, initial.comments, "authored notes are not whole-walkdown comments");
  assert.deepEqual(current.records, initial.records);
  await assert.rejects(h.rpc("qa_save_test_run", report.id, id, { ...authored, comment: "Stale overwrite" }, 1, 1), /changed since you opened/);
  assert.deepEqual(await h.rpc("qa_save_test_run", report.id, id, authored, 1, 1), saved,
    "retrying an identical comment save is idempotent even after the response is lost");
  assert.equal((await h.state(report.id)).project.contentVersion, current.project.contentVersion);
  await h.user(admin);
  const adminData = { ...authored, comment: "Administrator review\nApproved for closeout." };
  const reviewed = await h.rpc("qa_save_test_run", report.id, id, adminData, 1, 2);
  assert.equal(reviewed.updatedBy, admin);
  assert.equal(reviewed.runVersion, 3);
  current = await h.state(report.id);
  const closed = await h.rpc("qa_approve_revision", report.id, 1, current.project.contentVersion);
  assert.deepEqual(closed.testRuns.find(run => run.id === id), reviewed);
  await assert.rejects(h.rpc("qa_save_test_run", report.id, id, { ...adminData, comment: "Late edit" }, 1, 3), /approved and closed/);
  await h.db.exec("reset role");
  await h.db.exec(migration);
  await h.db.exec(setupMigration);
  await h.user(second);
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 1)).testRuns, closed.testRuns,
    "upgrading validation preserves approved comments and legacy runs");
  await h.rpc("qa_new_revision", report.id, 1);
  await assert.rejects(h.rpc("qa_save_test_run", report.id, id, { ...adminData, comment: null }, 2, 3), /comments.*4,000/);
  const clearedData = { ...adminData, comment: "", devices: [{ ...adminData.devices[0], comment: "" }] };
  const cleared = await h.rpc("qa_save_test_run", report.id, id, clearedData, 2, 3);
  assert.equal(cleared.comment, "");
  assert.equal(cleared.devices[0].comment, "");
  assert.equal(cleared.runVersion, 4);
  assert.deepEqual(cleared.devices[0].channels, data.devices[0].channels);
  assert.deepEqual(cleared.sources, data.sources);
  assert.deepEqual((await h.state(report.id)).testRuns.find(run => run.id === otherId), other);
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 1)).testRuns, closed.testRuns);
});

test("event exclusions retain original source JSON, require normal save locks, and stay frozen after later restoration", async t => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Reviewed event rows skid");
  const id = crypto.randomUUID(), data = runData();
  const saved = await h.rpc("qa_save_test_run", report.id, id, data, 1, null);
  assert.equal(Object.hasOwn(saved.devices[0].channels[0].series[0].points[0], "excluded"), false);
  const excluded = structuredClone(data);
  excluded.devices[0].channels[0].series[0].points[0].excluded = true;
  await h.user(second);
  await assert.rejects(h.rpc("qa_save_test_run", report.id, id, excluded, 1, 1), /Only the importing inspector/);
  await h.user(admin);
  const changed = await h.rpc("qa_save_test_run", report.id, id, excluded, 1, 1);
  assert.equal(changed.runVersion, 2);
  assert.deepEqual(changed.devices[0].channels[0].series[0].points, excluded.devices[0].channels[0].series[0].points);
  assert.deepEqual(changed.sources, data.sources);
  const stored = (await h.db.query("select data from public.qa_test_runs where id=$1", [id])).rows[0].data;
  delete stored.devices[0].channels[0].series[0].points[0].excluded;
  assert.deepEqual(stored, data, "the exclusion flag is the only change to imported source evidence");
  const restored = structuredClone(excluded);
  restored.devices[0].channels[0].series[0].points[0].excluded = false;
  await assert.rejects(h.rpc("qa_save_test_run", report.id, id, restored, 1, 1), /changed since you opened/);
  const current = await h.state(report.id);
  const closed = await h.rpc("qa_approve_revision", report.id, 1, current.project.contentVersion);
  await assert.rejects(h.rpc("qa_save_test_run", report.id, id, restored, 1, 2), /approved and closed/);
  await h.db.exec("reset role");
  await h.db.exec(migration);
  await h.db.exec(setupMigration);
  await h.user(admin);
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 1)).testRuns, closed.testRuns);
  await h.rpc("qa_new_revision", report.id, 1);
  await assert.rejects(h.rpc("qa_save_test_run", report.id, id, restored, 1, 2), /different revision/);
  const invalid = structuredClone(restored);
  invalid.devices[0].channels[0].series[0].points[0].excluded = "false";
  await assert.rejects(h.rpc("qa_save_test_run", report.id, id, invalid, 2, 2), /excluded flag.*true or false/);
  const active = await h.rpc("qa_save_test_run", report.id, id, restored, 2, 2);
  assert.equal(active.runVersion, 3);
  assert.equal(active.devices[0].channels[0].series[0].points[0].excluded, false);
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 1)).testRuns, closed.testRuns,
    "restoring a source event cannot rewrite its exclusion in an approved snapshot");
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

test("setup photos share closeout locks and frozen revisions without entering inspection evidence or source JSON", async (t) => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Setup photo revision skid");
  const runId = crypto.randomUUID(), data = runData();
  const saved = await h.rpc("qa_save_test_run", report.id, runId, data, 1, null);
  const before = await h.state(report.id);
  assert.equal(saved.setupPhotos, undefined, "runs without setup images retain their earlier JSON shape");
  const image = await setupPhoto(h, report.id, runId, 1);
  assert.equal(image.photo.testRunId, runId);
  assert.equal(image.photo.caption, "");
  const afterUpload = await h.state(report.id);
  assert.deepEqual(afterUpload.photos, before.photos, "setup photos stay out of ordinary QC inspection photos");
  assert.deepEqual(afterUpload.records, before.records, "adding a setup photo does not touch inspection status");
  assert.equal(afterUpload.catalog.length, 39);
  assert.equal(afterUpload.testRuns[0].setupPhotos.length, 1);
  assert.equal(afterUpload.testRuns[0].runVersion, 1);
  assert.ok(afterUpload.project.contentVersion > before.project.contentVersion);
  assert.deepEqual(await h.rpc("qa_add_test_setup_photo", report.id, runId, image.id, 1), image.photo,
    "a lost finalization response can retry without a second photo");
  assert.equal((await h.state(report.id)).project.contentVersion, afterUpload.project.contentVersion);
  await h.rpc("qa_update_test_setup_photo", report.id, runId, image.id, "Pneumatic test connections", 1);
  const reviewed = await h.state(report.id);
  await assert.rejects(h.rpc("qa_approve_revision", report.id, 1, afterUpload.project.contentVersion), /changed since you reviewed/);
  assert.deepEqual((await h.db.query("select data from public.qa_test_runs where id=$1", [runId])).rows[0].data, data,
    "private image paths and captions are server-derived, outside normalized imported data");
  const pendingId = crypto.randomUUID(), pendingPath = `${admin}/${pendingId}.jpg`;
  await h.rpc("qa_prepare_test_setup_photo", report.id, runId, pendingId, pendingPath, "Pending.jpg", 800, 600, 1);
  const closed = await h.rpc("qa_approve_revision", report.id, 1, reviewed.project.contentVersion);
  assert.equal(closed.testRuns[0].setupPhotos[0].caption, "Pneumatic test connections");
  assert.equal(closed.photos.length, 0, "ordinary inspection photo counts remain unchanged");
  const frozen = (await h.db.query("select snapshot from public.qa_report_revisions where walkdown_id=$1 and revision=1", [report.id])).rows[0].snapshot;
  assert.equal((await h.db.query("select photo_id from public.qa_revision_photos where walkdown_id=$1", [report.id])).rows.length, 1);
  await assert.rejects(h.rpc("qa_update_test_setup_photo", report.id, runId, image.id, "Late edit", 1), /approved and closed/);
  await assert.rejects(h.rpc("qa_delete_test_setup_photo", report.id, runId, image.id, 1), /approved and closed/);
  await assert.rejects(h.db.query("insert into storage.objects(bucket_id,name) values('qa-evidence',$1)", [pendingPath]), /row-level security/);

  await h.db.exec("reset role");
  await h.db.exec(schema);
  await h.db.exec(qcMigration);
  await h.db.exec(migration);
  await h.db.exec(setupMigration);
  await h.db.exec(setupMigration);
  await h.db.exec("create role setup_deployment_reader bypassrls; grant pg_read_all_data to setup_deployment_reader; set role setup_deployment_reader");
  assert.equal(Object.values((await h.db.query(deploymentChecks)).rows[0]).every(value => value === true), true,
    "read-only deployment checks compare the full frozen setup-photo metadata");
  const manualCheck = verification.match(/select w\.id as closed_report_with_changed_test_runs[\s\S]*?;/)[0];
  assert.deepEqual((await h.db.query(manualCheck)).rows, []);
  await h.user();
  assert.deepEqual((await h.db.query("select snapshot from public.qa_report_revisions where walkdown_id=$1 and revision=1", [report.id])).rows[0].snapshot, frozen);
  await h.rpc("qa_new_revision", report.id, 1);
  assert.deepEqual((await h.state(report.id)).testRuns[0].setupPhotos, closed.testRuns[0].setupPhotos);
  await assert.rejects(h.rpc("qa_add_test_setup_photo", report.id, runId, pendingId, 1), /different revision/);
  await assert.rejects(h.rpc("qa_add_test_setup_photo", report.id, runId, pendingId, 2), /reservation was not found/);
  await h.rpc("qa_update_test_setup_photo", report.id, runId, image.id, "Revised setup caption", 2);
  assert.equal((await h.rpc("qa_load_revision", report.id, 1)).testRuns[0].setupPhotos[0].caption, "Pneumatic test connections");
  assert.equal(await h.rpc("qa_delete_test_setup_photo", report.id, runId, image.id, 2), null, "archived files never receive a deletion path");
  assert.equal((await h.state(report.id)).testRuns[0].setupPhotos, undefined);
  assert.equal((await h.db.query("delete from storage.objects where name=$1 returning name", [image.path])).rows.length, 0,
    "storage RLS independently prevents removing a file referenced by an approved revision");
  assert.equal((await h.db.query("select name from storage.objects where name=$1", [image.path])).rows.length, 1,
    "the archived image remains privately readable after removal from the current draft");
  assert.deepEqual((await h.db.query("select snapshot from public.qa_report_revisions where walkdown_id=$1 and revision=1", [report.id])).rows[0].snapshot, frozen);
});

test("setup photo writes require the owning saved run, validated scope, bounded captions, and bounded reservations", async (t) => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Setup permissions skid");
  const other = await h.rpc("qa_create_walkdown", "Another setup skid");
  await h.user(second);
  const runId = crypto.randomUUID(), otherRunId = crypto.randomUUID();
  await h.rpc("qa_save_test_run", report.id, runId, runData(), 1, null);
  await h.rpc("qa_save_test_run", report.id, otherRunId, runData(), 1, null);
  const image = await setupPhoto(h, report.id, runId, 1, second);
  await assert.rejects(h.rpc("qa_update_test_setup_photo", other.id, runId, image.id, "Wrong skid", 1), /Save an active test run/);
  await assert.rejects(h.rpc("qa_update_test_setup_photo", report.id, otherRunId, image.id, "Wrong run", 1), /not found in this test run/);
  await assert.rejects(h.rpc("qa_delete_test_setup_photo", report.id, otherRunId, image.id, 1), /not found in this test run/);
  await assert.rejects(h.rpc("qa_add_test_setup_photo", report.id, otherRunId, image.id, 1), /reservation was not found/);
  await assert.rejects(h.rpc("qa_add_photo", report.id, image.id, 1), /inspection photo reservation/);
  await assert.rejects(h.rpc("qa_delete_photo", report.id, image.id, 1), /Inspection photo not found/);
  await assert.rejects(h.rpc("qa_update_test_setup_photo", report.id, runId, image.id, "x".repeat(1001), 1), /at most 1,000/);
  await assert.rejects(h.rpc("qa_update_test_setup_photo", report.id, runId, image.id, null, 1), /at most 1,000/);
  await assert.rejects(h.rpc("qa_save_test_run", report.id, runId, { ...runData(), setupPhotos: [image.photo] }, 1, 1), /managed separately by the server/);
  await assert.rejects(h.db.query("update public.qa_photos set caption='Bypassed' where id=$1", [image.id]), /permission denied/);
  await h.user(outsider);
  await assert.rejects(h.rpc("qa_update_test_setup_photo", report.id, runId, image.id, "Outsider", 1), /approved project inspector/);
  assert.equal((await h.db.query("select name from storage.objects where name=$1", [image.path])).rows.length, 0);
  await h.user(admin);
  const adminRunId = crypto.randomUUID();
  await h.rpc("qa_save_test_run", report.id, adminRunId, runData(), 1, null);
  const adminImage = await setupPhoto(h, report.id, runId, 1, admin);
  await h.user(second);
  await assert.rejects(h.rpc("qa_prepare_test_setup_photo", report.id, adminRunId, crypto.randomUUID(), "invalid/path.jpg", "Cannot edit.jpg", 100, 100, 1), /Only the importing inspector/);
  assert.equal(await h.rpc("qa_delete_test_setup_photo", report.id, runId, adminImage.id, 1), adminImage.path,
    "a run owner can remove images an administrator added to the run");
  assert.equal((await h.db.query("delete from storage.objects where name=$1 returning name", [adminImage.path])).rows.length, 1);
  await h.rpc("qa_update_test_setup_photo", report.id, runId, image.id, "", 1);
  for (let index = 1; index < 30; index += 1) {
    const id = crypto.randomUUID();
    await h.rpc("qa_prepare_test_setup_photo", report.id, runId, id, `${second}/${id}.jpg`, "Reserved.jpg", 100, 100, 1);
  }
  const overflowId = crypto.randomUUID();
  await assert.rejects(h.rpc("qa_prepare_test_setup_photo", report.id, runId, overflowId, `${second}/${overflowId}.jpg`, "Over limit.jpg", 100, 100, 1), /at most 30/);
  await h.rpc("qa_delete_test_run", report.id, runId, 1, 1);
  assert.equal((await h.db.query("select id from public.qa_photos where test_run_id=$1", [runId])).rows.length, 0,
    "removing a run retires its setup photos and pending reservations");
  await assert.rejects(h.rpc("qa_add_test_setup_photo", report.id, runId, image.id, 1), /Save an active test run/);
  await assert.rejects(h.rpc("qa_prepare_test_setup_photo", report.id, runId, crypto.randomUUID(), "invalid/path.jpg", "Removed run.jpg", 100, 100, 1), /Save an active test run/);
});
