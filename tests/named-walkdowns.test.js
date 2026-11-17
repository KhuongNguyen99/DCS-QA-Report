import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const root = new URL("../supabase/", import.meta.url);
const sql = (name) => readFile(new URL(name, root), "utf8");
const oldSchema = await readFile(
  new URL("./fixtures/legacy-single-walkdown.sql", import.meta.url),
  "utf8",
);
const schema = await sql("schema.sql");
const migration = await sql("named-walkdowns.sql");
const equipmentMigration = await sql("equipment-inspections.sql");
const quota = await sql("voice-rate-limit.sql");
const verification = await sql("VERIFY.sql");
const first = "11111111-1111-4111-8111-111111111111";
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
insert into auth.users values('${first}','khuong@jeevyfabrication.com',now()),('${second}','second@example.com',now()),('${outsider}','outside@example.com',now());
`;
test("named skid migration preserves legacy evidence, isolates reports, and closes unscoped access", async (t) => {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(setup);
  await db.exec(oldSchema);
  await db.exec(quota);
  await db.exec(
    "insert into public.qa_inspectors values('second@example.com','Second',false,true)",
  );
  async function user(id = first, pg = db) {
    await pg.exec("reset role");
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await pg.exec("set role authenticated");
  }
  await user();
  const legacyPhoto = crypto.randomUUID();
  const legacyPath = `${first}/${legacyPhoto}.jpg`;
  await db.query("select public.qa_prepare_photo($1,$2,$3,$4,$5,$6)", [
    legacyPhoto,
    "device:V-3541",
    legacyPath,
    "Legacy evidence",
    100,
    100,
  ]);
  await db.query(
    "insert into storage.objects(bucket_id,name) values('qa-evidence',$1)",
    [legacyPath],
  );
  await db.query("select public.qa_add_photo($1)", [legacyPhoto]);
  await db.query(
    "select public.qa_add_comment('device:V-3541','Existing device note')",
  );
  await db.query(
    "select public.qa_add_comment('walkdown:general','Existing general note')",
  );
  await db.query("select public.qa_set_quality('device:V-3541','good')");
  await db.query("select public.qa_set_complete('device:V-3541',true)");
  const oldState = (await db.query("select public.qa_load_state() as state"))
    .rows[0].state;
  await db.exec("reset role");
  await db.exec(migration);
  await user();
  const list = async () =>
    (await db.query("select public.qa_list_walkdowns() as result")).rows[0]
      .result;
  const state = async (id) =>
    (await db.query("select public.qa_load_state($1) as result", [id])).rows[0]
      .result;
  const create = async (name) =>
    (await db.query("select public.qa_create_walkdown($1) as result", [name]))
      .rows[0].result;
  let listed = await list();
  assert.equal(listed.walkdowns.length, 1);
  const legacy = listed.walkdowns[0].id;
  assert.equal(listed.walkdowns[0].skidName, "Unassigned skid");
  assert.equal(listed.walkdowns[0].nameRequired, true);
  assert.equal(listed.walkdowns[0].revision, oldState.project.revision);
  const preserved = await state(legacy);
  assert.deepEqual(preserved.records, oldState.records);
  assert.equal(preserved.photos[0].id, legacyPhoto);
  assert.equal(preserved.photos[0].path, legacyPath);
  assert.deepEqual(
    preserved.comments.map((c) => [c.id, c.text]),
    oldState.comments.map((c) => [c.id, c.text]),
  );
  for (const call of [
    () =>
      db.query(
        "select public.qa_add_comment($1,'walkdown:general','Must name first')",
        [legacy],
      ),
    () =>
      db.query("select public.qa_set_quality($1,'device:V-3541','bad')", [
        legacy,
      ]),
    () =>
      db.query("select public.qa_set_complete($1,'device:V-3541',false)", [
        legacy,
      ]),
    () =>
      db.query("select public.qa_delete_photo($1,$2)", [legacy, legacyPhoto]),
    () =>
      db.query("select public.qa_authorize_voice($1,'walkdown:general')", [
        legacy,
      ]),
  ])
    await assert.rejects(call(), /Name this skid/);
  const renamed = (
    await db.query(
      "select public.qa_rename_walkdown($1,'Original-01') as result",
      [legacy],
    )
  ).rows[0].result;
  assert.equal(renamed.revision, oldState.project.revision + 1);
  assert.equal(renamed.nameRequired, false);
  t.diagnostic(
    "PASS: upgrade preserves every legacy record, photo ID/path, note, completion, quality and revision; unnamed report is read-only until renamed.",
  );

  const a = await create("Skid A");
  const b = await create("Skid B");
  for (const report of [a, b]) {
    const snapshot = await state(report.id);
    assert.equal(snapshot.records.length, 36);
    assert.equal(snapshot.project.revision, 3);
    assert.equal(snapshot.photos.length, 0);
    assert.equal(snapshot.comments.length, 0);
  }
  await assert.rejects(create("skid a"), /already exists/);
  await assert.rejects(create("Unassigned skid"), /reserved/);
  await assert.rejects(create("x".repeat(121)), /120/);
  await db.query("select public.qa_set_quality($1,'device:V-3541','bad')", [
    a.id,
  ]);
  await db.query(
    "select public.qa_add_comment($1,'walkdown:general','Only Skid A')",
    [a.id],
  );
  assert.equal((await state(a.id)).project.revision, 5);
  assert.equal((await state(b.id)).project.revision, 3);
  assert.equal(
    (await state(b.id)).records.find((r) => r.key === "device:V-3541").quality,
    null,
  );
  assert.equal((await state(b.id)).comments.length, 0);
  async function photo(walkdown, key) {
    const id = crypto.randomUUID();
    const path = `${first}/${id}.jpg`;
    const before = (await state(walkdown)).project.revision;
    await db.query("select public.qa_prepare_photo($1,$2,$3,$4,$5,$6,$7)", [
      walkdown,
      id,
      key,
      path,
      "Evidence",
      100,
      100,
    ]);
    assert.equal((await state(walkdown)).project.revision, before);
    await db.query(
      "insert into storage.objects(bucket_id,name) values('qa-evidence',$1)",
      [path],
    );
    await db.query("select public.qa_add_photo($1,$2)", [walkdown, id]);
    assert.equal((await state(walkdown)).project.revision, before + 1);
    return id;
  }
  const aPhoto = await photo(a.id, "device:V-3541");
  await assert.rejects(
    db.query("select public.qa_set_complete($1,'device:V-3541',true)", [b.id]),
    /at least one/,
  );
  await assert.rejects(
    db.query("select public.qa_delete_photo($1,$2)", [b.id, aPhoto]),
    /not found in this skid/,
  );
  await assert.rejects(
    db.query("select public.qa_add_photo($1,$2)", [b.id, aPhoto]),
    /not found in this skid/,
  );
  assert.equal((await state(b.id)).photos.length, 0);
  let aHPhoto;
  for (const report of [a, b]) {
    for (const key of ["device:V-3561", "device:TH-3560", "terminal:H"]) {
      const id = await photo(report.id, key);
      if (report.id === a.id && key === "device:V-3561") aHPhoto = id;
      await db.query("select public.qa_set_complete($1,$2,true)", [
        report.id,
        key,
      ]);
    }
  }
  const bBefore = await state(b.id);
  const aBefore = await state(a.id);
  await db.query("select public.qa_delete_photo($1,$2)", [a.id, aHPhoto]);
  assert.equal(
    (await state(a.id)).project.revision,
    aBefore.project.revision + 1,
  );
  assert.equal(
    (await state(a.id)).records.find((r) => r.key === "terminal:H").complete,
    false,
  );
  assert.deepEqual(await state(b.id), bBefore);
  const noVoiceRevision = (await state(a.id)).project.revision;
  assert.equal(
    (
      await db.query(
        "select public.qa_authorize_voice($1,'walkdown:general') as allowed",
        [a.id],
      )
    ).rows[0].allowed,
    true,
  );
  assert.equal((await state(a.id)).project.revision, noVoiceRevision);
  t.diagnostic(
    "PASS: two named skids have independent comments/photos/quality/completion/revisions; cross-skid photo IDs and evidence reuse fail; only the correct terminal reopens.",
  );

  await assert.rejects(
    db.query("select public.qa_load_state()"),
    /permission denied/,
  );
  await assert.rejects(
    db.query(
      "select public.qa_add_comment('walkdown:general','Unscoped write')",
    ),
    /permission denied/,
  );
  await assert.rejects(
    db.query("select public.qa_authorize_voice('walkdown:general')"),
    /permission denied/,
  );
  await assert.rejects(
    db.query("update public.qa_walkdowns set revision=99"),
    /permission denied/,
  );
  await user(second);
  assert.equal(
    (await state(a.id)).comments.some((c) => c.text === "Only Skid A"),
    true,
  );
  await db.query(
    "select public.qa_add_comment($1,'walkdown:general','Second inspector on B')",
    [b.id],
  );
  assert.equal(
    (await state(a.id)).comments.some(
      (c) => c.text === "Second inspector on B",
    ),
    false,
  );
  await user(outsider);
  await assert.rejects(list(), /approved project inspector/);
  await assert.rejects(state(a.id), /approved project inspector/);
  await assert.rejects(create("Unauthorized"), /approved project inspector/);
  await user();
  const beforeRerun = await list();
  await db.exec("reset role");
  await db.exec(migration);
  await user();
  assert.deepEqual(await list(), beforeRerun);
  assert.equal((await state(legacy)).records.length, 36);
  const beforeEquipmentState = await state(legacy);
  await db.exec("reset role");
  await db.exec(equipmentMigration);
  await user();
  const afterEquipment = await list();
  for (const prior of beforeRerun.walkdowns) {
    const upgraded = afterEquipment.walkdowns.find((w) => w.id === prior.id);
    assert.equal(upgraded.revision, prior.revision + 1);
    assert.equal((await state(prior.id)).records.length, 39);
  }
  const upgradedLegacy = await state(legacy);
  assert.deepEqual(
    upgradedLegacy.records.filter((r) => !r.key.startsWith("equipment:")),
    beforeEquipmentState.records,
  );
  assert.deepEqual(upgradedLegacy.photos, beforeEquipmentState.photos);
  assert.deepEqual(upgradedLegacy.comments, beforeEquipmentState.comments);
  await db.exec("reset role");
  await db.exec(equipmentMigration);
  await db.exec(schema);
  await user();
  assert.deepEqual(await list(), afterEquipment);
  assert.deepEqual((await state(legacy)).photos, beforeEquipmentState.photos);
  await db.exec("reset role");
  await db.exec(verification);
  t.diagnostic(
    "PASS: old unscoped RPCs and direct metadata edits are denied; approved inspectors share reports; nonmembers fail; migration and full schema reruns preserve all reports.",
  );
});

test("fresh installation creates 39 empty records only after manual skid naming", async (t) => {
  const fresh = await PGlite.create();
  await fresh.exec(setup);
  await fresh.exec(schema);
  await fresh.query("select set_config('request.jwt.claim.sub',$1,false)", [
    first,
  ]);
  await fresh.exec("set role authenticated");
  t.after(() => fresh.close());
  assert.equal(
    (await fresh.query("select public.qa_list_walkdowns() as result")).rows[0]
      .result.walkdowns.length,
    0,
  );
  const newReport = (
    await fresh.query(
      "select public.qa_create_walkdown('Fresh skid') as result",
    )
  ).rows[0].result;
  assert.equal(
    (
      await fresh.query("select public.qa_load_state($1) as result", [
        newReport.id,
      ])
    ).rows[0].result.records.length,
    39,
  );
  await fresh.exec("reset role");
  await fresh.exec(verification);
  t.diagnostic(
    "PASS: clean installation starts with no unnamed report and creates exactly 39 fresh records per manually named skid.",
  );
});
