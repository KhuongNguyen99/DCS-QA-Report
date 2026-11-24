import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { deviceGraphEntries } from "../src/test-graph-order.js";

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

function authoredGraphTools(data = runData()) {
  const deviceId = data.devices[0].id;
  const graphKey = deviceGraphEntries(data.devices[0])[0].key;
  const point = data.devices[0].channels[0].series[0].points[1];
  return { version: 1, deviceNames: [{ deviceId, name: "Checked valve" }], graphs: [{
    deviceId, graphKey, name: "V-3511-Y_FB", style: "step", measurements: [{
      id: "response-time", name: "Feedback response", unit: "s",
      start: { kind: "trigger", deviceId, graphKey, operator: "<=", threshold: 0 },
      end: { kind: "point", deviceId, graphKey, pointIndex: 1, timeMs: point.timeMs,
        value: point.value, sourceId: point.sourceId, sourceRow: point.sourceRow },
    }, { id: "manual-time", name: "Manual interval", unit: "min",
      start: { kind: "time", timeMs: data.clock.startMs }, end: { kind: "time", timeMs: data.clock.endMs } }],
  }] };
}

test("graph names, drawing styles and named calculations save with the run and freeze in approved snapshots", async t => {
  const h = await database(t), report = await h.rpc("qa_create_walkdown", "Graph tool report");
  await h.rpc("qa_set_checked_by", report.id, "Graph checker", 1, null);
  const data = runData(), evidence = structuredClone(data.devices);
  data.graphTools = authoredGraphTools(data);
  const id = crypto.randomUUID();
  const saved = await h.rpc("qa_save_test_run", report.id, id, data, 1, null);
  assert.deepEqual(saved.graphTools, data.graphTools);
  assert.deepEqual(saved.devices, evidence, "display edits do not rename or replace imported evidence");
  const current = await h.state(report.id);
  await h.rpc("qa_approve_revision", report.id, 1, current.project.contentVersion);
  const archived = await h.rpc("qa_load_revision", report.id, 1);
  await h.rpc("qa_new_revision", report.id, 1);
  await h.rpc("qa_set_checked_by", report.id, "Next checker", 2, null);
  const changed = structuredClone(data);
  changed.graphTools.deviceNames[0].name = "New display name";
  changed.graphTools.graphs[0].style = "smooth";
  changed.graphTools.graphs[0].measurements[0].unit = "h";
  changed.graphTools.graphs[0].measurements[0].start.graphKey = "graph:v1:unavailable:0";
  const next = await h.rpc("qa_save_test_run", report.id, id, changed, 2, saved.runVersion);
  assert.deepEqual(next.graphTools, changed.graphTools, "unavailable graph references remain available for an explicit unresolved result");
  assert.deepEqual(next.devices, evidence);
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 1)).testRuns, archived.testRuns);
  await h.db.exec("reset role");
  await h.db.exec(qcMigration);
  await h.db.exec(migration);
  await h.db.exec(setupMigration);
  await h.db.exec(schema);
  await h.user();
  assert.deepEqual((await h.state(report.id)).testRuns[0].graphTools, changed.graphTools);
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 1)).testRuns, archived.testRuns);
  await assert.rejects(h.db.query("select qa_private.validate_graph_tools($1::jsonb)", [JSON.stringify(data.graphTools)]), /permission denied/);
});

test("graph tools reject malformed formulas, duplicate references and unsupported fields before changing a run", async t => {
  const h = await database(t), report = await h.rpc("qa_create_walkdown", "Graph validation");
  await h.rpc("qa_set_checked_by", report.id, "Graph checker", 1, null);
  const base = runData(), tools = authoredGraphTools(base), id = crypto.randomUUID();
  const saved = await h.rpc("qa_save_test_run", report.id, id, base, 1, null);
  const before = await h.state(report.id);
  const variants = [null, [], {}, { ...tools, version: 2 }, { ...tools, unexpected: true }];
  const mutate = operation => { const value = structuredClone(tools); operation(value); variants.push(value); };
  mutate(value => { value.deviceNames[0].name = " "; });
  mutate(value => { value.deviceNames[0].name = "\u00a0Name\u00a0"; });
  mutate(value => { value.deviceNames[0].name = "Name\u0085break"; });
  mutate(value => { value.deviceNames[0].name = "x".repeat(161); });
  mutate(value => value.deviceNames.push(value.deviceNames[0]));
  mutate(value => { value.deviceNames = Array.from({ length: 251 }, (_, index) => ({ deviceId: `d${index}`, name: "Alias" })); });
  mutate(value => value.graphs.push(value.graphs[0]));
  mutate(value => { value.graphs[0].style = "spline"; });
  mutate(value => { value.graphs[0].unexpected = true; });
  mutate(value => { value.graphs[0].measurements = null; });
  mutate(value => value.graphs[0].measurements.push(value.graphs[0].measurements[0]));
  mutate(value => { value.graphs[0].measurements[0].unit = "days"; });
  mutate(value => { value.graphs[0].measurements[0].name = "Bad\nname"; });
  mutate(value => { value.graphs[0].measurements[0].start.operator = "=="; });
  mutate(value => { value.graphs[0].measurements[0].start.threshold = "0"; });
  mutate(value => { value.graphs[0].measurements[0].start.deviceId = ""; });
  mutate(value => { value.graphs[0].measurements[0].start.unexpected = true; });
  mutate(value => { value.graphs[0].measurements[0].end.pointIndex = 10000; });
  mutate(value => { value.graphs[0].measurements[0].end.pointIndex = 0.5; });
  mutate(value => { value.graphs[0].measurements[0].end.timeMs = 8640000000000001; });
  mutate(value => { value.graphs[0].measurements[0].end.value = null; });
  mutate(value => { value.graphs[0].measurements[0].end.sourceRow = 0; });
  mutate(value => { value.graphs[0].measurements[1].start.timeMs = 0.5; });
  mutate(value => { value.graphs[0].measurements[1].end = { kind: "other", timeMs: base.clock.endMs }; });
  for (const graphTools of variants)
    await assert.rejects(h.rpc("qa_save_test_run", report.id, id, { ...base, graphTools }, 1, saved.runVersion), /graph|calculation/i);
  assert.deepEqual(await h.state(report.id), before, "invalid settings cannot alter source data, versions, or approval review tokens");
});

test("functional test data, comments and setup photos all require the current draft's manual checker", async t => {
  const h = await database(t), report = await h.rpc("qa_create_walkdown", "Unchecked functional test");
  const runId = crypto.randomUUID(), data = runData();
  data.comment = "Manually entered run comment";
  await assert.rejects(h.rpc("qa_save_test_run", report.id, runId, data, 1, null), /Enter Checked by/);
  assert.deepEqual((await h.state(report.id)).testRuns, []);
  await h.rpc("qa_set_checked_by", report.id, "Functional checker", 1, null);
  const saved = await h.rpc("qa_save_test_run", report.id, runId, data, 1, null);
  const photo = await setupPhoto(h, report.id, runId, 1);
  const before = await h.state(report.id);
  const closed = await h.rpc("qa_approve_revision", report.id, 1, before.project.contentVersion);
  const next = await h.rpc("qa_new_revision", report.id, 1);
  assert.equal(next.project.checkedByName, null);
  assert.deepEqual(next.testRuns, closed.testRuns);
  const newId = crypto.randomUUID(), path = `${admin}/${newId}.jpg`;
  for (const [name, args] of [
    ["qa_save_test_run", [report.id, runId, { ...data, comment: "Unchecked edit" }, 2, saved.runVersion]],
    ["qa_delete_test_run", [report.id, runId, 2, saved.runVersion]],
    ["qa_prepare_test_setup_photo", [report.id, runId, newId, path, "Unchecked setup", 100, 100, 2]],
    ["qa_prepare_test_setup_photo", [report.id, runId, newId, path, "Unchecked setup", 100, 100, 2, "Caption"]],
    ["qa_add_test_setup_photo", [report.id, runId, photo.id, 2]],
    ["qa_update_test_setup_photo", [report.id, runId, photo.id, "Unchecked caption", 2]],
    ["qa_reorder_test_setup_photos", [report.id, runId, [photo.id], [photo.id], 2]],
    ["qa_delete_test_setup_photo", [report.id, runId, photo.id, 2]],
  ]) await assert.rejects(h.rpc(name, ...args), /Enter Checked by/, name);
  await h.db.exec("reset role");
  await assert.rejects(h.db.query("update public.qa_test_runs set data=$2 where id=$1", [runId, { ...data, comment: "Direct edit" }]), /Enter Checked by/);
  await assert.rejects(h.db.query("update public.qa_photos set caption='Direct edit' where id=$1", [photo.id]), /Enter Checked by/);
  await h.user();
  assert.deepEqual((await h.state(report.id)).testRuns, closed.testRuns);
  await h.rpc("qa_set_checked_by", report.id, "Next revision checker", 2, null);
  await h.rpc("qa_update_test_setup_photo", report.id, runId, photo.id, "Reviewed setup", 2);
  assert.equal((await h.state(report.id)).testRuns[0].setupPhotos[0].caption, "Reviewed setup");
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 1)).testRuns, closed.testRuns);
  assert.deepEqual((await h.db.query("select data from public.qa_test_runs where id=$1", [runId])).rows[0].data, data,
    "checker setup and photo edits never rewrite imported source JSON");
});

test("functional test imports preserve old snapshots and share explicit approval/revision locks", async (t) => {
  const beforeImports = schema.split("-- PRONETA test report layer;")[0]
    .replace(/    'testRuns', qa_private\.test_runs_state\(p_walkdown_id\),\r?\n/, "") + "commit;";
  const h = await database(t, beforeImports);
  const report = await h.rpc("qa_create_walkdown", "Functional test skid");
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
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
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", 2, null);
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
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", 3, null);
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
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
  const other = await h.rpc("qa_create_walkdown", "Other skid");
  await h.rpc("qa_set_checked_by", other.id, "Fixture checker", other.revision, null);
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
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
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
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", 2, null);
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
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
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
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", 2, null);
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
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
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
    assert.equal(Object.keys(checks).length, 14);
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
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
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
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", 2, null);
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

test("setup upload captions become visible with the photo, survive retries, and retain legacy upload compatibility", async t => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Captioned setup upload skid"), runId = crypto.randomUUID();
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
  await h.rpc("qa_save_test_run", report.id, runId, runData(), 1, null);
  const id = crypto.randomUUID(), path = `${admin}/${id}.jpg`;
  const caption = "Air supply at 6 bar\nFeedback connected to CH0";
  const prepare = value => h.rpc("qa_prepare_test_setup_photo", report.id, runId, id, path, "Connections.jpg", 1600, 900, 1, value);
  for (const invalid of [null, "x".repeat(1001)])
    await assert.rejects(prepare(invalid), /at most 1,000/);
  await prepare(caption);
  assert.equal((await h.state(report.id)).testRuns[0].setupPhotos, undefined,
    "a caption reservation must not expose a photo before image bytes are saved and finalized");
  await assert.rejects(h.rpc("qa_add_test_setup_photo", report.id, runId, id, 1), /Upload the image/);
  await h.db.query("insert into storage.objects(bucket_id,name) values('qa-evidence',$1)", [path]);
  const saved = await h.rpc("qa_add_test_setup_photo", report.id, runId, id, 1);
  assert.equal(saved.caption, caption);
  assert.deepEqual((await h.state(report.id)).testRuns[0].setupPhotos, [saved]);
  const version = (await h.state(report.id)).project.contentVersion;
  assert.deepEqual(await h.rpc("qa_add_test_setup_photo", report.id, runId, id, 1), saved);
  assert.equal((await h.state(report.id)).project.contentVersion, version,
    "retrying a lost response does not append a duplicate, rewrite its caption, or change report content");

  const legacy = await setupPhoto(h, report.id, runId, 1);
  assert.equal(legacy.photo.caption, "", "older requests with no caption retain their original behavior");
  const reviewed = await h.state(report.id);
  const closed = await h.rpc("qa_approve_revision", report.id, 1, reviewed.project.contentVersion);
  assert.equal(closed.testRuns[0].setupPhotos[0].caption, caption);
  const frozen = (await h.db.query("select snapshot from public.qa_report_revisions where walkdown_id=$1 and revision=1", [report.id])).rows[0].snapshot;
  await h.db.exec("reset role");
  await h.db.exec(setupMigration);
  await h.db.exec(setupMigration);
  await h.user();
  assert.deepEqual((await h.db.query("select snapshot from public.qa_report_revisions where walkdown_id=$1 and revision=1", [report.id])).rows[0].snapshot, frozen);
  await assert.rejects(prepare("Late caption"), /approved and closed/);
});

test("captioned setup reservations keep both RPC signatures restricted to verified run owners and administrators", async t => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Captioned setup access skid"), runId = crypto.randomUUID();
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
  await h.rpc("qa_save_test_run", report.id, runId, runData(), 1, null);
  for (const signature of [
    "public.qa_prepare_test_setup_photo(uuid,uuid,uuid,text,text,integer,integer,bigint)",
    "public.qa_prepare_test_setup_photo(uuid,uuid,uuid,text,text,integer,integer,bigint,text)",
  ]) {
    const grants = (await h.db.query("select has_function_privilege('authenticated',$1,'EXECUTE') as authenticated, has_function_privilege('anon',$1,'EXECUTE') as anon", [signature])).rows[0];
    assert.deepEqual(grants, { authenticated: true, anon: false });
  }
  const id = crypto.randomUUID(), path = `${second}/${id}.jpg`;
  await h.user(second);
  for (const args of [[], ["Cannot bypass ownership with a caption"]])
    await assert.rejects(h.rpc("qa_prepare_test_setup_photo", report.id, runId, id, path, "Denied.jpg", 100, 100, 1, ...args), /Only the importing inspector/);
  await h.user(outsider);
  await assert.rejects(h.rpc("qa_prepare_test_setup_photo", report.id, runId, id, path, "Denied.jpg", 100, 100, 1, "Denied"), /approved project inspector/);
  await h.user(admin);
  const secondRunId = crypto.randomUUID();
  await h.user(second);
  await h.rpc("qa_save_test_run", report.id, secondRunId, runData(), 1, null);
  await h.rpc("qa_prepare_test_setup_photo", report.id, secondRunId, id, path, "Owner.jpg", 100, 100, 1, "Owner's setup");
  await h.user(admin);
  const adminId = crypto.randomUUID();
  await h.rpc("qa_prepare_test_setup_photo", report.id, secondRunId, adminId, `${admin}/${adminId}.jpg`, "Admin.jpg", 100, 100, 1, "Administrator's setup");
});

test("setup photo writes require the owning saved run, validated scope, bounded captions, and bounded reservations", async (t) => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Setup permissions skid");
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
  const other = await h.rpc("qa_create_walkdown", "Another setup skid");
  await h.rpc("qa_set_checked_by", other.id, "Fixture checker", other.revision, null);
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

test("setup photo order persists atomically, appends uploads, detects competing changes, and freezes at approval", async t => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Ordered setup skid"), runId = crypto.randomUUID(), data = runData();
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
  await h.rpc("qa_save_test_run", report.id, runId, data, 1, null);
  const a = await setupPhoto(h, report.id, runId, 1), b = await setupPhoto(h, report.id, runId, 1), c = await setupPhoto(h, report.id, runId, 1);
  await h.rpc("qa_update_test_setup_photo", report.id, runId, b.id, "Middle connection", 1);
  const before = await h.state(report.id), original = before.testRuns[0].setupPhotos;
  const oldIds = [a.id, b.id, c.id], orderedIds = [c.id, a.id, b.id];
  const reordered = await h.rpc("qa_reorder_test_setup_photos", report.id, runId, orderedIds, oldIds, 1);
  assert.deepEqual(reordered, [original[2], original[0], original[1]], "only array order changes, preserving captions and private files");
  let current = await h.state(report.id);
  assert.deepEqual(current.testRuns[0].setupPhotos, reordered);
  assert.equal(current.project.contentVersion, before.project.contentVersion + 1, "one atomic reorder advances one review token");
  assert.equal(current.testRuns[0].runVersion, 1);
  assert.deepEqual((await h.db.query("select data from public.qa_test_runs where id=$1", [runId])).rows[0].data, data);
  await h.rpc("qa_reorder_test_setup_photos", report.id, runId, orderedIds, orderedIds, 1);
  assert.equal((await h.state(report.id)).project.contentVersion, current.project.contentVersion, "saving unchanged order is a no-op");
  await assert.rejects(h.rpc("qa_approve_revision", report.id, 1, before.project.contentVersion), /changed since you reviewed/);
  const competing = await Promise.allSettled([
    h.rpc("qa_reorder_test_setup_photos", report.id, runId, [a.id, c.id, b.id], orderedIds, 1),
    h.rpc("qa_reorder_test_setup_photos", report.id, runId, [b.id, a.id, c.id], orderedIds, 1),
  ]);
  assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
  assert.match(competing.find(result => result.status === "rejected").reason.message, /Setup photos changed/);
  const winningIds = (await h.state(report.id)).testRuns[0].setupPhotos.map(photo => photo.id);
  const d = await setupPhoto(h, report.id, runId, 1);
  const appendedIds = [...winningIds, d.id];
  assert.deepEqual((await h.state(report.id)).testRuns[0].setupPhotos.map(photo => photo.id), appendedIds);
  await assert.rejects(h.rpc("qa_reorder_test_setup_photos", report.id, runId, winningIds, winningIds, 1), /Setup photos changed/);
  await h.rpc("qa_delete_test_setup_photo", report.id, runId, d.id, 1);
  await assert.rejects(h.rpc("qa_reorder_test_setup_photos", report.id, runId, appendedIds, appendedIds, 1), /Setup photos changed/);
  current = await h.state(report.id);
  const closed = await h.rpc("qa_approve_revision", report.id, 1, current.project.contentVersion);
  await assert.rejects(h.rpc("qa_reorder_test_setup_photos", report.id, runId, oldIds, winningIds, 1), /approved and closed/);
  await h.db.exec("reset role");
  await h.db.exec(setupMigration);
  assert.equal(Object.values((await h.db.query(deploymentChecks)).rows[0]).every(value => value === true), true);
  const manualCheck = verification.match(/select w\.id as closed_report_with_changed_test_runs[\s\S]*?;/)[0];
  assert.deepEqual((await h.db.query(manualCheck)).rows, []);
  await h.user();
  await h.rpc("qa_new_revision", report.id, 1);
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", 2, null);
  await assert.rejects(h.rpc("qa_reorder_test_setup_photos", report.id, runId, oldIds, winningIds, 1), /different revision/);
  await h.rpc("qa_reorder_test_setup_photos", report.id, runId, [...winningIds].reverse(), winningIds, 2);
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 1)).testRuns, closed.testRuns,
    "later draft order cannot change the approved array order");
  assert.equal(await h.rpc("qa_delete_test_setup_photo", report.id, runId, a.id, 2), null);
  assert.equal((await h.db.query("delete from storage.objects where name=$1 returning name", [a.path])).rows.length, 0);
  assert.equal((await h.db.query("select name from storage.objects where name=$1", [a.path])).rows.length, 1);
});

test("setup photo order requires owner or admin access and an exact validated current photo list", async t => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Order permissions skid"), runId = crypto.randomUUID(), otherId = crypto.randomUUID();
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
  await h.rpc("qa_save_test_run", report.id, runId, runData(), 1, null);
  await h.rpc("qa_save_test_run", report.id, otherId, runData(), 1, null);
  const a = await setupPhoto(h, report.id, runId, 1), b = await setupPhoto(h, report.id, runId, 1);
  const foreign = await setupPhoto(h, report.id, otherId, 1), expected = [a.id, b.id];
  const pendingId = crypto.randomUUID();
  await h.rpc("qa_prepare_test_setup_photo", report.id, runId, pendingId, `${admin}/${pendingId}.jpg`, "Pending.jpg", 800, 600, 1);
  for (const invalid of [null, [a.id, a.id], [a.id, null], Array(31).fill(a.id), [[a.id, b.id]]]) {
    await assert.rejects(h.rpc("qa_reorder_test_setup_photos", report.id, runId, invalid, expected, 1), /complete order/);
    await assert.rejects(h.rpc("qa_reorder_test_setup_photos", report.id, runId, expected, invalid, 1), /complete order/);
  }
  for (const invalid of [[], [a.id], [a.id, foreign.id], [a.id, pendingId], [a.id, b.id, foreign.id]])
    await assert.rejects(h.rpc("qa_reorder_test_setup_photos", report.id, runId, invalid, expected, 1), /every current setup photo/);
  await assert.rejects(h.rpc("qa_reorder_test_setup_photos", report.id, runId, expected, [b.id, a.id], 1), /Setup photos changed/);
  await assert.rejects(h.db.query("update public.qa_photos set photo_position=99 where id=$1", [a.id]), /permission denied/);
  await h.user(second);
  await assert.rejects(h.rpc("qa_reorder_test_setup_photos", report.id, runId, [b.id, a.id], expected, 1), /Only the importing inspector/);
  const ownId = crypto.randomUUID();
  await h.rpc("qa_save_test_run", report.id, ownId, runData(), 1, null);
  assert.deepEqual(await h.rpc("qa_reorder_test_setup_photos", report.id, ownId, [], [], 1), []);
  const ownA = await setupPhoto(h, report.id, ownId, 1, second), ownB = await setupPhoto(h, report.id, ownId, 1, second);
  await h.rpc("qa_reorder_test_setup_photos", report.id, ownId, [ownB.id, ownA.id], [ownA.id, ownB.id], 1);
  await h.user(outsider);
  await assert.rejects(h.rpc("qa_reorder_test_setup_photos", report.id, runId, [b.id, a.id], expected, 1), /approved project inspector/);
  await h.db.exec("reset role; set role anon");
  await assert.rejects(h.rpc("qa_reorder_test_setup_photos", report.id, runId, [b.id, a.id], expected, 1), /permission denied/);
  await h.user(admin);
  const changed = await h.rpc("qa_reorder_test_setup_photos", report.id, ownId, [ownA.id, ownB.id], [ownB.id, ownA.id], 1);
  assert.deepEqual(changed.map(photo => photo.id), [ownA.id, ownB.id], "admins can reorder another inspector's run");
  await h.rpc("qa_delete_test_run", report.id, ownId, 1, 1);
  await assert.rejects(h.rpc("qa_reorder_test_setup_photos", report.id, ownId, [], [], 1), /Save an active test run/);
});

test("setup photo order migration backfills legacy timestamp and ID order without changing closed reports", async t => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Legacy photo order skid"), runId = crypto.randomUUID();
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
  await h.rpc("qa_save_test_run", report.id, runId, runData(), 1, null);
  const a = await setupPhoto(h, report.id, runId, 1), b = await setupPhoto(h, report.id, runId, 1), c = await setupPhoto(h, report.id, runId, 1);
  await h.db.exec("reset role");
  await h.db.query("update public.qa_photos set photo_position=null, created_at='2026-01-01T00:00:00Z' where test_run_id=$1", [runId]);
  await h.user();
  const before = await h.state(report.id), legacyIds = [a.id, b.id, c.id].sort();
  assert.deepEqual(before.testRuns[0].setupPhotos.map(photo => photo.id), legacyIds, "legacy ties use ID ordering");
  const closed = await h.rpc("qa_approve_revision", report.id, 1, before.project.contentVersion);
  await h.db.exec("reset role");
  await h.db.exec("alter table public.qa_photos drop column photo_position");
  await h.db.exec(setupMigration);
  await h.db.exec(setupMigration);
  await h.db.exec(schema);
  assert.deepEqual((await h.db.query("select id, photo_position from public.qa_photos where test_run_id=$1 order by photo_position", [runId])).rows,
    legacyIds.map((id, index) => ({ id, photo_position: index + 1 })));
  assert.equal(Object.values((await h.db.query(deploymentChecks)).rows[0]).every(value => value === true), true);
  await h.user();
  assert.deepEqual(await h.state(report.id), closed, "metadata backfill leaves frozen JSON and review tokens unchanged");
  await h.rpc("qa_new_revision", report.id, 1);
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", 2, null);
  const reversedIds = [...legacyIds].reverse();
  await h.rpc("qa_reorder_test_setup_photos", report.id, runId, reversedIds, legacyIds, 2);
  await h.db.exec("reset role");
  await h.db.exec(setupMigration);
  await h.user();
  assert.deepEqual((await h.state(report.id)).testRuns[0].setupPhotos.map(photo => photo.id), reversedIds,
    "reapplying the migration preserves an explicitly saved order");
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 1)).testRuns, closed.testRuns);
});
