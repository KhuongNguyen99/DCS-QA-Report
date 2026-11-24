import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { revisionNumber } from "../src/domain.js";

const sql = (name) => readFile(new URL(`../supabase/${name}`, import.meta.url), "utf8");
const schema = await sql("schema.sql");
const migration = await sql("qc-revisions.sql");
const verification = await sql("VERIFY.sql");
const deploymentScript = await readFile(new URL("../scripts/migrate-qc-revisions.mjs", import.meta.url), "utf8");
const deploymentChecks = deploymentScript.match(/const result = await query\(`([\s\S]*?)`, true\);/)[1];
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

async function inspectionPhoto(h, walkdownId, recordKey, revision = 1, userId = admin) {
  const id = crypto.randomUUID(), path = `${userId}/${id}.jpg`;
  await h.rpc("qa_prepare_photo", walkdownId, id, recordKey, path, "Inspection evidence", 100, 150, revision);
  await h.db.query("insert into storage.objects(bucket_id,name) values('qa-evidence',$1)", [path]);
  await h.rpc("qa_add_photo", walkdownId, id, revision);
  return { id, path };
}

test("manual Checked by gates inspection writes while creation, naming and viewing stay available", async t => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Unchecked report");
  const first = await h.state(report.id);
  assert.equal(first.project.checkedByName, null);
  assert.equal(first.project.checkedByRecordedAt, null);
  assert.equal(first.project.checkedByRecordedBy, null);
  assert.equal(first.records.length, 39, "report creation still seeds empty inspection targets");
  assert.ok(first.records.every(record => !record.complete && record.quality === null));
  assert.equal((await h.rpc("qa_rename_walkdown", report.id, "Named before inspection", 1)).skidName, "Named before inspection");
  const renamed = await h.state(report.id);
  const id = crypto.randomUUID(), path = `${admin}/${id}.jpg`;
  for (const [name, args] of [
    ["qa_add_comment", [report.id, "walkdown:general", "Unchecked comment", 1]],
    ["qa_delete_comment", [report.id, id, 1]],
    ["qa_set_quality", [report.id, "device:V-3541", "good", 1]],
    ["qa_set_complete", [report.id, "device:V-3541", true, 1]],
    ["qa_prepare_photo", [report.id, id, "device:V-3541", path, "Unchecked photo", 100, 100, 1]],
    ["qa_add_photo", [report.id, id, 1]], ["qa_delete_photo", [report.id, id, 1]],
    ["qa_reorder_photos", [report.id, "device:V-3541", [], [], 1]],
    ["qa_authorize_voice", [report.id, "walkdown:general"]],
    ["qa_approve_revision", [report.id, 1, renamed.project.contentVersion]],
  ]) await assert.rejects(h.rpc(name, ...args), /Enter Checked by/, name);
  for (const name of [null, "", "  ", "\t\n ", "x".repeat(121), "Amy\nNg", "Amy\tNg", "Amy\u007fNg"])
    await assert.rejects(h.rpc("qa_set_checked_by", report.id, name, 1, null), /Checked by name/);
  await assert.rejects(h.rpc("qa_set_checked_by", report.id, "Manual checker", null, null), /different revision/);
  await assert.rejects(h.rpc("qa_set_checked_by", report.id, "Manual checker", 2, null), /different revision/);
  assert.deepEqual(await h.state(report.id), renamed, "blocked writes and invalid names do not change evidence or review tokens");
  await assert.rejects(h.db.query("update public.qa_walkdowns set checked_by_name='Bypass' where id=$1", [report.id]), /permission denied/);
  await h.db.exec("reset role");
  await assert.rejects(h.db.query("update public.qa_records set quality='good' where walkdown_id=$1", [report.id]), /Enter Checked by/);
  await assert.rejects(h.db.query("insert into public.qa_comments(walkdown_id,text,created_by,author_name) values($1,'Bypass',$2,'Bypass')", [report.id, admin]), /Enter Checked by/);
  await h.user(outsider);
  await assert.rejects(h.rpc("qa_set_checked_by", report.id, "Manual checker", 1, null), /approved project inspector/);
  await h.db.exec("reset role; set role anon");
  await assert.rejects(h.rpc("qa_set_checked_by", report.id, "Manual checker", 1, null), /permission denied/);
  await h.user();
  const checked = await h.rpc("qa_set_checked_by", report.id, "  José Nguyen  ", 1, null);
  assert.equal(checked.project.checkedByName, "José Nguyen", "the manually supplied name is trimmed, not inferred from the account");
  assert.equal(checked.project.checkedByRecordedBy, admin);
  assert.ok(checked.project.checkedByRecordedAt);
  assert.equal(checked.project.contentVersion, renamed.project.contentVersion + 1);
  assert.deepEqual(checked.records, first.records);
  assert.deepEqual(checked.revisions, []);
  assert.deepEqual(await h.rpc("qa_set_checked_by", report.id, "José Nguyen", 1, null), checked, "retry is a no-op even with the original expected value");
  await h.user(second);
  const retry = await h.rpc("qa_set_checked_by", report.id, "José Nguyen", 1, "old cached value");
  assert.deepEqual(retry.project, checked.project, "same-name retries cannot reattribute the manual checker to another account");
  const attempts = await Promise.allSettled([
    h.rpc("qa_set_checked_by", report.id, "Checker A", 1, "José Nguyen"),
    h.rpc("qa_set_checked_by", report.id, "Checker B", 1, "José Nguyen"),
  ]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.match(attempts.find(result => result.status === "rejected").reason.message, /Checked by changed/);
  const current = await h.state(report.id);
  assert.equal(current.project.checkedByRecordedBy, second);
  assert.equal(current.project.contentVersion, checked.project.contentVersion + 1);
  await assert.rejects(h.rpc("qa_approve_revision", report.id, 1, checked.project.contentVersion), /changed since you reviewed/);
  await h.rpc("qa_add_comment", report.id, "walkdown:general", "Recorded after checker setup", 1);
  await h.rpc("qa_set_quality", report.id, "device:V-3541", "good", 1);
  assert.equal((await h.state(report.id)).comments.length, 1);
});

test("checker attribution freezes with the authenticated sign-off and resets for each new draft", async t => {
  const h = await database(t), report = await h.rpc("qa_create_walkdown", "Checker closeout");
  const checked = await h.rpc("qa_set_checked_by", report.id, "Manual technician", 1, null);
  const closed = await h.rpc("qa_approve_revision", report.id, 1, checked.project.contentVersion);
  assert.equal(closed.project.checkedByName, "Manual technician");
  assert.equal(closed.project.closedBy, admin);
  assert.equal(closed.project.closedByName, "Khuong");
  assert.equal(closed.project.closedByTitle, "Project Manager");
  assert.equal(closed.revisions[0].checkedByName, "Manual technician");
  assert.equal(closed.revisions[0].checkedByRecordedBy, admin);
  assert.equal(closed.revisions[0].checkedByRecordedAt, checked.project.checkedByRecordedAt);
  assert.equal(closed.revisions[0].closedByTitle, "Project Manager");
  await assert.rejects(h.rpc("qa_set_checked_by", report.id, "Changed after sign-off", 1, "Manual technician"), /approved and closed/);
  const snapshot = (await h.db.query("select snapshot::text as value from public.qa_report_revisions where walkdown_id=$1", [report.id])).rows[0].value;
  const next = await h.rpc("qa_new_revision", report.id, 1);
  for (const field of ["checkedByName", "checkedByRecordedAt", "checkedByRecordedBy", "closedBy", "closedByName", "closedAt"])
    assert.equal(next.project[field], null, `${field} starts empty in the next revision`);
  await assert.rejects(h.rpc("qa_add_comment", report.id, "walkdown:general", "Unchecked revision", 2), /Enter Checked by/);
  await assert.rejects(h.rpc("qa_approve_revision", report.id, 2, next.project.contentVersion), /Enter Checked by/);
  await h.user(second);
  const secondChecked = await h.rpc("qa_set_checked_by", report.id, "Different technician", 2, null);
  assert.equal(secondChecked.project.checkedByRecordedBy, second);
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 1)).project, closed.project);
  await h.db.exec("reset role");
  await h.db.exec(migration);
  await h.db.exec(schema);
  await h.db.exec(migration);
  assert.equal((await h.db.query("select snapshot::text as value from public.qa_report_revisions where walkdown_id=$1", [report.id])).rows[0].value, snapshot);
  await h.user(second);
  assert.deepEqual((await h.state(report.id)).project, secondChecked.project, "repeatable migrations do not rewrite checker attribution or review tokens");
});

test("upgrades preserve legacy approved snapshots without inventing a checker or changing their evidence", async t => {
  const beforeCloseout = schema.split("-- QC revision closeout layer;")[0] + "commit;";
  const h = await database(t, beforeCloseout), report = await h.rpc("qa_create_walkdown", "Legacy signed report");
  await h.rpc("qa_add_comment", report.id, "walkdown:general", "Original recorded note");
  await h.db.exec("reset role");
  await h.db.exec(migration);
  await h.user();
  const loaded = await h.state(report.id);
  const closedAt = "2026-11-20T10:00:00.000Z";
  const legacy = { ...loaded, project: { ...loaded.project, status: "closed", closedAt,
    closedBy: admin, closedByName: "Khuong", closedByTitle: "Project Manager" } };
  delete legacy.inspector; delete legacy.revisions;
  for (const field of ["checkedByName", "checkedByRecordedAt", "checkedByRecordedBy"]) delete legacy.project[field];
  // Seed a pre-feature archive exactly as the old closeout function stored it.
  await h.db.exec("reset role");
  await h.db.query("update public.qa_walkdowns set status='closed',closed_at=$2,closed_by=$3,closed_by_name='Khuong' where id=$1", [report.id, closedAt, admin]);
  await h.db.query("insert into public.qa_report_revisions(walkdown_id,revision,skid_name,closed_at,closed_by,closed_by_name,snapshot) values($1,$2,$3,$4,$5,'Khuong',$6)",
    [report.id, loaded.project.revision, loaded.project.skidName, closedAt, admin, legacy]);
  const frozen = (await h.db.query("select snapshot::text as value from public.qa_report_revisions where walkdown_id=$1", [report.id])).rows[0].value;
  await h.db.exec(migration);
  await h.db.exec(schema);
  await h.db.exec(migration);
  assert.equal((await h.db.query("select snapshot::text as value from public.qa_report_revisions where walkdown_id=$1", [report.id])).rows[0].value, frozen);
  assert.equal(Object.values((await h.db.query(deploymentChecks)).rows[0]).every(value => value === true), true);
  await h.user();
  const closed = await h.state(report.id);
  assert.equal(Object.hasOwn(closed.project, "checkedByName"), false);
  assert.deepEqual(closed.comments, loaded.comments);
  assert.equal(closed.revisions[0].checkedByName, null);
  assert.equal(closed.revisions[0].closedByTitle, "Project Manager");
  assert.deepEqual(await h.rpc("qa_approve_revision", report.id, closed.project.revision, closed.project.contentVersion), closed,
    "retrying an already approved legacy report does not retroactively require a checker");
  const next = await h.rpc("qa_new_revision", report.id, closed.project.revision);
  assert.equal(next.project.checkedByName, null);
  await h.rpc("qa_set_checked_by", report.id, "New revision checker", next.project.revision, null);
  const archived = await h.rpc("qa_load_revision", report.id, closed.project.revision);
  assert.equal(Object.hasOwn(archived.project, "checkedByName"), false);
  assert.deepEqual(archived.comments, legacy.comments);
});

test("pending uploads from before checker enforcement can be cancelled or resumed after manual setup", async t => {
  const beforeCloseout = schema.split("-- QC revision closeout layer;")[0] + "commit;";
  const h = await database(t, beforeCloseout), report = await h.rpc("qa_create_walkdown", "Legacy pending uploads");
  const cancelId = crypto.randomUUID(), resumeId = crypto.randomUUID();
  const cancelPath = `${admin}/${cancelId}.jpg`, resumePath = `${admin}/${resumeId}.jpg`;
  for (const [id, path] of [[cancelId, cancelPath], [resumeId, resumePath]])
    await h.rpc("qa_prepare_photo", report.id, id, "device:V-3541", path, "Original pending upload", 100, 100);
  await h.db.exec("reset role");
  await h.db.exec(migration);
  await h.user();
  const draft = await h.state(report.id);
  await assert.rejects(h.db.query("insert into storage.objects(bucket_id,name) values('qa-evidence',$1)", [resumePath]), /row-level security/);
  await assert.rejects(h.rpc("qa_add_photo", report.id, resumeId, draft.project.revision), /Enter Checked by/);
  await h.rpc("qa_cancel_photo", report.id, cancelId);
  assert.equal((await h.state(report.id)).project.contentVersion, draft.project.contentVersion, "abandoned reservations are cleanup, not inspection data");
  await h.rpc("qa_set_checked_by", report.id, "Resuming checker", draft.project.revision, null);
  await h.db.query("insert into storage.objects(bucket_id,name) values('qa-evidence',$1)", [resumePath]);
  await h.rpc("qa_add_photo", report.id, resumeId, draft.project.revision);
  assert.deepEqual((await h.state(report.id)).photos.map(photo => photo.id), [resumeId]);
  await assert.rejects(h.db.query("insert into storage.objects(bucket_id,name) values('qa-evidence',$1)", [cancelPath]), /row-level security/);
});

test("QC migration preserves existing revisions and evidence; draft edits no longer change revision", async (t) => {
  const beforeCloseout = schema.split("-- QC revision closeout layer;")[0] + "commit;";
  const h = await database(t, beforeCloseout);
  const report = await h.rpc("qa_create_walkdown", "Existing skid");
  await h.rpc("qa_add_comment", report.id, "walkdown:general", "Existing note");
  await h.rpc("qa_set_quality", report.id, "device:V-3541", "good");
  const id = crypto.randomUUID(), path = `${admin}/${id}.jpg`;
  await h.rpc("qa_prepare_photo", report.id, id, "device:V-3541", path, "Existing image", 100, 100);
  await h.db.query("insert into storage.objects(bucket_id,name) values('qa-evidence',$1)", [path]);
  await h.rpc("qa_add_photo", report.id, id);
  const before = await h.state(report.id);
  assert.ok(before.project.revision > 3);
  await h.db.exec("reset role");
  await h.db.exec(migration);
  await h.user();
  const after = await h.state(report.id);
  assert.equal(after.project.revision, before.project.revision);
  assert.equal(after.project.status, "draft");
  assert.equal(after.project.contentVersion, 1);
  assert.deepEqual(after.records, before.records);
  assert.deepEqual(after.photos, before.photos);
  assert.deepEqual(after.comments, before.comments);
  assert.equal(after.project.checkedByName, null, "upgrades do not infer a checker for existing evidence");
  await assert.rejects(h.rpc("qa_add_comment", report.id, "walkdown:general", "Unchecked draft edit", after.project.revision), /Enter Checked by/);
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", after.project.revision, null);
  await h.rpc("qa_add_comment", report.id, "walkdown:general", "First draft edit", after.project.revision);
  const changed = await h.state(report.id);
  assert.equal(changed.project.revision, before.project.revision);
  assert.equal(changed.project.contentVersion, 3);
  await h.db.exec("reset role");
  await h.db.exec(migration);
  await h.db.exec(schema);
  await h.user();
  assert.deepEqual(await h.state(report.id), changed, "migration and schema reruns preserve the draft exactly");
});

test("approval locks immutable revisions and archived evidence; new revision pins all later edits", async (t) => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Skid A");
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
  const other = await h.rpc("qa_create_walkdown", "Skid B");
  await h.rpc("qa_set_checked_by", other.id, "Fixture checker", other.revision, null);
  assert.equal(report.revision, 1);
  const version = async () => (await h.state(report.id)).project.contentVersion;
  const photo = async (label, who = admin, revision = 1) => {
    const id = crypto.randomUUID(), path = `${who}/${id}.jpg`;
    await h.rpc("qa_prepare_photo", report.id, id, "device:V-3541", path, label, 100, 100, revision);
    await h.db.query("insert into storage.objects(bucket_id,name) values('qa-evidence',$1)", [path]);
    await h.rpc("qa_add_photo", report.id, id, revision);
    return { id, path };
  };
  const evidence = await photo("First revision evidence");
  const note = await h.rpc("qa_add_comment", report.id, "walkdown:general", "Approved general note", 1);
  await h.rpc("qa_set_quality", report.id, "device:V-3541", "bad", 1);
  const reviewed = await version();
  await h.user(second);
  const secondNote = await h.rpc("qa_add_comment", report.id, "device:V-3541", "Second inspector note", 1);
  await assert.rejects(h.rpc("qa_delete_comment", report.id, note.id, 1), /Only the author/);
  await assert.rejects(h.rpc("qa_delete_comment", other.id, note.id, 1), /not found in this skid/);
  await h.user();
  await assert.rejects(h.rpc("qa_approve_revision", report.id, 1, reviewed), /changed since you reviewed/);
  assert.equal((await h.rpc("qa_list_revisions", report.id)).length, 0);

  const pending = crypto.randomUUID(), pendingPath = `${admin}/${pending}.jpg`;
  await h.rpc("qa_prepare_photo", report.id, pending, "device:V-3541", pendingPath, "Still uploading", 100, 100, 1);
  const finalVersion = await version();
  const closed = await h.rpc("qa_approve_revision", report.id, 1, finalVersion);
  assert.equal(closed.project.status, "closed");
  assert.equal(closed.project.revision, 1);
  assert.equal(closed.project.contentVersion, finalVersion);
  assert.equal(closed.project.closedBy, admin);
  assert.ok(closed.project.closedAt);
  assert.equal(closed.project.closedByName, "Khuong");
  assert.equal(closed.project.closedByTitle, "Project Manager");
  assert.equal(closed.photos.length, 1);
  assert.equal(closed.comments.length, 2);
  assert.equal(closed.catalog.length, 39);
  assert.deepEqual(closed.catalog.slice(0, 4).map((entry) => entry.key), [
    "equipment:control-box", "equipment:solenoid-box", "equipment:transducer-panel", "terminal:A",
  ]);
  assert.equal(closed.records.every((r) => !r.complete), true, "explicit approval permits documented unfinished items");
  assert.deepEqual(await h.rpc("qa_approve_revision", report.id, 1, finalVersion), closed, "lost close response retries are idempotent");
  assert.deepEqual(await h.state(report.id), closed);
  const history = await h.rpc("qa_list_revisions", report.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].revision, 1);
  assert.equal(history[0].closedAt, closed.project.closedAt);
  await assert.rejects(h.rpc("qa_load_revision", other.id, 1), /approved and closed/);
  await assert.rejects(h.rpc("qa_load_revision", report.id, 99), /approved and closed/);

  for (const [name, args] of [
    ["qa_add_comment", [report.id, "walkdown:general", "Late comment", 1]],
    ["qa_delete_comment", [report.id, note.id, 1]],
    ["qa_set_quality", [report.id, "device:V-3541", "good", 1]],
    ["qa_set_complete", [report.id, "device:V-3541", true, 1]],
    ["qa_delete_photo", [report.id, evidence.id, 1]],
    ["qa_add_photo", [report.id, pending, 1]],
    ["qa_prepare_photo", [report.id, crypto.randomUUID(), "device:V-3541", "invalid", "Late", 100, 100, 1]],
    ["qa_rename_walkdown", [report.id, "Renamed closed report", 1]],
    ["qa_authorize_voice", [report.id, "walkdown:general"]],
  ]) await assert.rejects(h.rpc(name, ...args), /approved and closed/, name);
  await h.rpc("qa_cancel_photo", report.id, pending);
  await assert.rejects(h.db.query("insert into storage.objects(bucket_id,name) values('qa-evidence',$1)", [pendingPath]), /row-level security/);
  await assert.rejects(h.rpc("qa_cancel_photo", report.id, evidence.id), /already saved/);
  assert.equal((await h.db.query("delete from storage.objects where name=$1 returning name", [evidence.path])).rows.length, 0);

  for (const [name, args] of [
    ["qa_add_comment", [report.id, "walkdown:general", "Old client"]],
    ["qa_rename_walkdown", [report.id, "Old client name"]],
    ["qa_set_quality", [report.id, "device:V-3541", "good"]],
    ["qa_set_complete", [report.id, "device:V-3541", true]],
    ["qa_delete_photo", [report.id, evidence.id]],
    ["qa_add_photo", [report.id, evidence.id]],
  ]) await assert.rejects(h.rpc(name, ...args), /permission denied/, name);

  const next = await h.rpc("qa_new_revision", report.id, 1);
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", 2, null);
  assert.equal(next.project.revision, 2);
  assert.equal(next.project.status, "draft");
  assert.equal(next.project.closedAt, null);
  assert.deepEqual(next.photos, closed.photos);
  assert.deepEqual(next.comments, closed.comments);
  await assert.rejects(h.rpc("qa_new_revision", report.id, 1), /different revision/);
  await assert.rejects(h.rpc("qa_new_revision", report.id, 2), /Approve and close/);
  await assert.rejects(h.rpc("qa_add_comment", report.id, "walkdown:general", "Stale queue", 1), /different revision/);
  await assert.rejects(h.rpc("qa_delete_photo", report.id, evidence.id, 1), /different revision/);
  await assert.rejects(h.rpc("qa_add_photo", report.id, pending, 2), /reservation was not found/);
  await h.rpc("qa_rename_walkdown", report.id, "Skid A renamed", 2);
  await h.rpc("qa_delete_comment", report.id, note.id, 2);
  await h.rpc("qa_delete_comment", report.id, secondNote.id, 2);
  const versionAfterRemoval = await version();
  await h.rpc("qa_delete_comment", report.id, secondNote.id, 2);
  assert.equal(await version(), versionAfterRemoval, "repeat comment removal has no content effect");
  assert.equal(await h.rpc("qa_delete_photo", report.id, evidence.id, 2), null, "archived blobs are retained");
  assert.equal((await h.db.query("delete from storage.objects where name=$1 returning name", [evidence.path])).rows.length, 0);
  await h.user(second);
  assert.equal((await h.db.query("select name from storage.objects where name=$1", [evidence.path])).rows.length, 1, "other inspectors can still read archived evidence");
  const archived = await h.rpc("qa_load_revision", report.id, 1);
  assert.equal(archived.inspector.id, second, "current caller identity is never frozen into archived snapshots");
  assert.equal(archived.project.closedByTitle, "Project Manager", "the cover title belongs to the approver");
  assert.deepEqual({ ...archived, inspector: closed.inspector, revisions: closed.revisions }, closed);
  await h.user();
  const current = await h.state(report.id);
  assert.equal(current.project.revision, 2);
  assert.equal(current.photos.length, 0);
  assert.equal(current.comments.length, 0);
  assert.equal(current.project.skidName, "Skid A renamed");
  assert.equal((await h.state(other.id)).project.revision, 1);
  const closed2 = await h.rpc("qa_approve_revision", report.id, 2, current.project.contentVersion);
  assert.equal(closed2.project.revision, 2);
  assert.deepEqual((await h.rpc("qa_list_revisions", report.id)).map((r) => r.revision), [2, 1]);
  assert.deepEqual({ ...await h.rpc("qa_load_revision", report.id, 1), revisions: closed.revisions }, closed);
  await h.db.exec("reset role");
  await assert.rejects(h.db.query("update public.qa_report_revisions set skid_name='mutated' where walkdown_id=$1", [report.id]), /immutable/);
  await assert.rejects(h.db.query("delete from public.qa_revision_photos where walkdown_id=$1", [report.id]), /immutable/);
  await assert.rejects(h.db.query("update public.qa_comments set text='mutated' where id=$1", [note.id]), /approved and closed/);
  await h.db.exec(schema);
  await h.db.exec(migration);
  await h.db.exec(verification);
  await h.user();
  assert.deepEqual(await h.state(report.id), closed2, "full schema cannot unlock or alter a closed revision");
  assert.deepEqual({ ...await h.rpc("qa_load_revision", report.id, 1), revisions: closed.revisions }, closed);
  await h.db.exec("reset role");
  await h.db.query("update public.qa_targets set label='Updated terminal label' where key='terminal:A'");
  await h.user();
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 1)).catalog, closed.catalog,
    "later catalog edits do not change approved target names or ordering");
  assert.deepEqual((await h.state(report.id)).catalog, closed2.catalog);
  assert.equal((await h.state(other.id)).catalog.find((entry) => entry.key === "terminal:A").label, "Terminal Updated terminal label");
  await h.user(outsider);
  for (const [name, args] of [
    ["qa_load_revision", [report.id, 1]], ["qa_list_revisions", [report.id]],
    ["qa_new_revision", [report.id, 2]], ["qa_approve_revision", [other.id, 1, 1]],
  ]) await assert.rejects(h.rpc(name, ...args), /approved project inspector/);
});

test("comment authors can remove their own notes and missing evidence cannot be approved", async (t) => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Comment review");
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
  await h.user(second);
  const note = await h.rpc("qa_add_comment", report.id, "device:V-3541", "My note", 1);
  await h.rpc("qa_delete_comment", report.id, note.id, 1);
  assert.equal((await h.state(report.id)).comments.length, 0);
  assert.equal((await h.db.query("select id from public.qa_comments where id=$1", [note.id])).rows.length, 0);
  await assert.rejects(h.rpc("qa_add_comment", report.id, "walkdown:general", "Missing revision", null), /different revision/);
  const photoId = crypto.randomUUID(), path = `${second}/${photoId}.jpg`;
  await h.rpc("qa_prepare_photo", report.id, photoId, "device:V-3541", path, "Missing storage later", 100, 100, 1);
  await h.db.query("insert into storage.objects(bucket_id,name) values('qa-evidence',$1)", [path]);
  await h.rpc("qa_add_photo", report.id, photoId, 1);
  await h.db.exec("reset role");
  await h.db.query("delete from storage.objects where name=$1", [path]);
  await h.user(second);
  const before = await h.state(report.id);
  await assert.rejects(h.rpc("qa_approve_revision", report.id, 1, before.project.contentVersion), /image is missing/);
  assert.equal((await h.state(report.id)).project.status, "draft");
  assert.equal((await h.rpc("qa_list_revisions", report.id)).length, 0);
  assert.equal(await h.rpc("qa_delete_photo", report.id, photoId, 1), path);
});

test("inspection photo order saves atomically for every target kind, appends uploads, and rejects competing changes", async t => {
  const h = await database(t), report = await h.rpc("qa_create_walkdown", "Ordered inspection skid");
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
  const key = "device:V-3541", otherKey = "equipment:control-box";
  const a = await inspectionPhoto(h, report.id, key), other = await inspectionPhoto(h, report.id, otherKey);
  const b = await inspectionPhoto(h, report.id, key), c = await inspectionPhoto(h, report.id, key);
  await h.rpc("qa_set_complete", report.id, key, true, 1);
  const before = await h.state(report.id), original = before.photos.filter(photo => photo.recordKey === key);
  const oldIds = [a.id, b.id, c.id], orderedIds = [c.id, a.id, b.id];
  await h.user(second);
  const changed = await h.rpc("qa_reorder_photos", report.id, key, orderedIds, oldIds, 1);
  assert.deepEqual(changed, [original[2], original[0], original[1]], "any approved inspector can order a page without changing evidence metadata");
  let current = await h.state(report.id);
  assert.deepEqual(current.records, before.records, "reordering does not reopen completed inspections or change their status");
  assert.deepEqual(current.photos.filter(photo => photo.recordKey === key), changed);
  assert.deepEqual(current.photos.filter(photo => photo.recordKey === otherKey), before.photos.filter(photo => photo.recordKey === otherKey));
  assert.equal(current.project.contentVersion, before.project.contentVersion + 1);
  await h.rpc("qa_reorder_photos", report.id, key, orderedIds, orderedIds, 1);
  assert.equal((await h.state(report.id)).project.contentVersion, current.project.contentVersion);
  await assert.rejects(h.rpc("qa_approve_revision", report.id, 1, before.project.contentVersion), /changed since you reviewed/);
  const competing = await Promise.allSettled([
    h.rpc("qa_reorder_photos", report.id, key, [a.id, c.id, b.id], orderedIds, 1),
    h.rpc("qa_reorder_photos", report.id, key, [b.id, c.id, a.id], orderedIds, 1),
  ]);
  assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
  assert.match(competing.find(result => result.status === "rejected").reason.message, /Inspection photos changed/);
  const winner = (await h.state(report.id)).photos.filter(photo => photo.recordKey === key).map(photo => photo.id);
  const d = await inspectionPhoto(h, report.id, key, 1, second), appended = [...winner, d.id];
  assert.deepEqual((await h.state(report.id)).photos.filter(photo => photo.recordKey === key).map(photo => photo.id), appended);
  await assert.rejects(h.rpc("qa_reorder_photos", report.id, key, winner, winner, 1), /Inspection photos changed/);
  await h.rpc("qa_delete_photo", report.id, d.id, 1);
  await assert.rejects(h.rpc("qa_reorder_photos", report.id, key, appended, appended, 1), /Inspection photos changed/);
  const equipment = await inspectionPhoto(h, report.id, otherKey, 1, second);
  await h.rpc("qa_reorder_photos", report.id, otherKey, [equipment.id, other.id], [other.id, equipment.id], 1);
  const terminalA = await inspectionPhoto(h, report.id, "terminal:A", 1, second), terminalB = await inspectionPhoto(h, report.id, "terminal:A", 1, second);
  await h.rpc("qa_reorder_photos", report.id, "terminal:A", [terminalB.id, terminalA.id], [terminalA.id, terminalB.id], 1);
  current = await h.state(report.id);
  assert.deepEqual(current.photos.filter(photo => photo.recordKey === "terminal:A").map(photo => photo.id), [terminalB.id, terminalA.id]);
  assert.deepEqual(current.photos.filter(photo => photo.recordKey === otherKey).map(photo => photo.id), [equipment.id, other.id]);
  const closed = await h.rpc("qa_approve_revision", report.id, 1, current.project.contentVersion);
  await assert.rejects(h.rpc("qa_reorder_photos", report.id, key, oldIds, winner, 1), /approved and closed/);
  await h.db.exec("reset role");
  await h.db.exec(schema);
  await h.db.exec(migration);
  assert.equal(Object.values((await h.db.query(deploymentChecks)).rows[0]).every(value => value === true), true);
  await h.user(second);
  assert.deepEqual((await h.state(report.id)).photos, closed.photos);
  await h.rpc("qa_new_revision", report.id, 1);
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", 2, null);
  await assert.rejects(h.rpc("qa_reorder_photos", report.id, key, oldIds, winner, 1), /different revision/);
  await h.rpc("qa_reorder_photos", report.id, key, [...winner].reverse(), winner, 2);
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 1)).photos, closed.photos);
  await h.user();
  assert.equal(await h.rpc("qa_delete_photo", report.id, a.id, 2), null);
  assert.equal((await h.db.query("delete from storage.objects where name=$1 returning name", [a.path])).rows.length, 0);
  assert.equal((await h.db.query("select name from storage.objects where name=$1", [a.path])).rows.length, 1);
});

test("inspection photo order validates exact scope and permutation and denies anonymous or unapproved users", async t => {
  const h = await database(t), report = await h.rpc("qa_create_walkdown", "Inspection order validation skid");
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
  const another = await h.rpc("qa_create_walkdown", "Foreign inspection order skid"), key = "device:V-3541";
  await h.rpc("qa_set_checked_by", another.id, "Fixture checker", another.revision, null);
  const a = await inspectionPhoto(h, report.id, key), b = await inspectionPhoto(h, report.id, key), expected = [a.id, b.id];
  const foreign = await inspectionPhoto(h, another.id, key), otherTarget = await inspectionPhoto(h, report.id, "terminal:A");
  const pending = crypto.randomUUID();
  await h.rpc("qa_prepare_photo", report.id, pending, key, `${admin}/${pending}.jpg`, "Pending photo", 100, 100, 1);
  for (const invalid of [null, [a.id, a.id], [a.id, null], Array(1001).fill(a.id), [[a.id, b.id]]]) {
    await assert.rejects(h.rpc("qa_reorder_photos", report.id, key, invalid, expected, 1), /complete order/);
    await assert.rejects(h.rpc("qa_reorder_photos", report.id, key, expected, invalid, 1), /complete order/);
  }
  for (const invalid of [[], [a.id], [a.id, foreign.id], [a.id, otherTarget.id], [a.id, pending], [a.id, b.id, otherTarget.id]])
    await assert.rejects(h.rpc("qa_reorder_photos", report.id, key, invalid, expected, 1), /every current inspection photo/);
  await assert.rejects(h.rpc("qa_reorder_photos", report.id, key, expected, [b.id, a.id], 1), /Inspection photos changed/);
  await assert.rejects(h.rpc("qa_reorder_photos", report.id, "walkdown:general", [], [], 1), /Unknown inspection target/);
  await assert.rejects(h.rpc("qa_reorder_photos", report.id, key, expected, expected, null), /different revision/);
  await assert.rejects(h.db.query("update public.qa_photos set photo_position=50 where id=$1", [a.id]), /permission denied/);
  assert.deepEqual(await h.rpc("qa_reorder_photos", report.id, "terminal:B", [], [], 1), []);
  await h.user(outsider);
  await assert.rejects(h.rpc("qa_reorder_photos", report.id, key, [b.id, a.id], expected, 1), /approved project inspector/);
  await h.db.exec("reset role; set role anon");
  await assert.rejects(h.rpc("qa_reorder_photos", report.id, key, [b.id, a.id], expected, 1), /permission denied/);
});

test("inspection ordering backfills each legacy target and preserves approved arrays and review tokens on upgrades", async t => {
  const h = await database(t), report = await h.rpc("qa_create_walkdown", "Legacy inspection ordering skid");
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
  const key = "device:V-3541", otherKey = "terminal:A";
  const a = await inspectionPhoto(h, report.id, key), b = await inspectionPhoto(h, report.id, otherKey);
  const c = await inspectionPhoto(h, report.id, key), d = await inspectionPhoto(h, report.id, otherKey);
  await h.db.exec("reset role");
  await h.db.exec(migration.replaceAll("order by p.record_key, p.photo_position, p.created_at, p.id", "order by p.created_at, p.id"));
  await h.db.query("update public.qa_photos set photo_position=null where walkdown_id=$1", [report.id]);
  await h.user();
  const before = await h.state(report.id);
  assert.deepEqual(before.photos.map(photo => photo.id), [a.id, b.id, c.id, d.id]);
  const closed = await h.rpc("qa_approve_revision", report.id, 1, before.project.contentVersion);
  await h.db.exec("reset role");
  await h.db.exec("alter table public.qa_photos drop column photo_position");
  await h.db.exec(migration);
  await h.db.exec(migration);
  await h.db.exec(schema);
  const positions = (await h.db.query("select id, photo_position from public.qa_photos where walkdown_id=$1", [report.id])).rows;
  for (const [id, position] of [[a.id, 1], [b.id, 1], [c.id, 2], [d.id, 2]])
    assert.equal(positions.find(photo => photo.id === id).photo_position, position);
  assert.equal(Object.values((await h.db.query(deploymentChecks)).rows[0]).every(value => value === true), true);
  const manualCheck = verification.match(/select w\.id as closed_report_with_changed_inspection_photos[\s\S]*?;/)[0];
  assert.deepEqual((await h.db.query(manualCheck)).rows, []);
  await h.user();
  assert.deepEqual(await h.state(report.id), closed, "backfill leaves the entire approved array and report metadata unchanged");
  await h.rpc("qa_new_revision", report.id, 1);
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", 2, null);
  await h.rpc("qa_reorder_photos", report.id, key, [c.id, a.id], [a.id, c.id], 2);
  await h.db.exec("reset role");
  await h.db.exec(schema);
  await h.user();
  assert.deepEqual((await h.state(report.id)).photos.filter(photo => photo.recordKey === key).map(photo => photo.id), [c.id, a.id]);
  assert.deepEqual((await h.rpc("qa_load_revision", report.id, 1)).photos, closed.photos);
});

test("Skid 1 resets its report numbering while retaining approved revisions and evidence", async t => {
  const h = await database(t);
  const report = await h.rpc("qa_create_walkdown", "Skid 1");
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", report.revision, null);
  const other = await h.rpc("qa_create_walkdown", "Skid 2");
  await h.rpc("qa_set_checked_by", other.id, "Fixture checker", other.revision, null);
  await inspectionPhoto(h, report.id, "terminal:A");
  const firstDraft = await h.state(report.id);
  const first = await h.rpc("qa_approve_revision", report.id, 1, firstDraft.project.contentVersion);
  await h.rpc("qa_new_revision", report.id, 1);
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", 2, null);
  await h.db.exec("reset role");
  await h.db.query("update public.qa_walkdowns set revision=243 where id=$1", [report.id]);
  await h.user();
  const draft = await h.state(report.id);
  const closed = await h.rpc("qa_approve_revision", report.id, 243, draft.project.contentVersion);
  await h.db.exec("reset role");
  const reset = deploymentScript.match(/update public\.qa_walkdowns\s+set revision_number_base = 243[\s\S]*?;/)[0];
  await h.db.exec(reset);
  await h.db.exec(reset);
  await h.user();

  const current = await h.state(report.id);
  assert.deepEqual(current, { ...closed, project: { ...closed.project, revisionNumberBase: 243 } });
  assert.equal(revisionNumber(current.project), 1);
  assert.deepEqual(current.revisions.map(item => item.revision), [243, 1]);
  assert.equal(revisionNumber((await h.rpc("qa_load_revision", report.id, 243)).project), 1);
  const earlier = await h.rpc("qa_load_revision", report.id, 1);
  assert.equal(revisionNumber(earlier.project), 1);
  assert.deepEqual(earlier.photos, first.photos);
  const next = await h.rpc("qa_new_revision", report.id, 243);
  await h.rpc("qa_set_checked_by", report.id, "Fixture checker", 244, null);
  assert.equal(next.project.revision, 244);
  assert.equal(revisionNumber(next.project), 2);
  assert.deepEqual(next.photos, closed.photos);
  assert.equal((await h.state(other.id)).project.revisionNumberBase, 1);
});
