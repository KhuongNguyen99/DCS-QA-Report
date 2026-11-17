import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const schema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const inspector = "11111111-1111-4111-8111-111111111111";
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
insert into auth.users values('${inspector}','khuong@jeevyfabrication.com',now());
`;

test("equipment catalog and per-skid records are exact and independent", async (t) => {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(setup);
  await db.exec(schema);
  const equipment = (await db.query(
    "select key, kind, terminal, label from public.qa_targets where kind='equipment' order by key",
  )).rows;
  assert.deepEqual(equipment, [
    { key: "equipment:control-box", kind: "equipment", terminal: null, label: "Control Box" },
    { key: "equipment:solenoid-box", kind: "equipment", terminal: null, label: "Solenoid Box" },
    { key: "equipment:transducer-panel", kind: "equipment", terminal: null, label: "Transducer Panel" },
  ]);
  assert.equal((await db.query("select count(*)::int as n from public.qa_targets")).rows[0].n, 39);
  for (const [key, kind, terminal, label] of [
    ["equipment:unknown", "equipment", null, "Unknown"],
    ["equipment:control-box", "equipment", null, "Wrong label"],
    ["equipment:control-box", "equipment", "A", "Control Box"],
    ["device:TEST-0001", "device", null, "TEST-0001"],
  ]) {
    await assert.rejects(
      db.query("insert into public.qa_targets(key,kind,terminal,label) values($1,$2,$3,$4)", [key, kind, terminal, label]),
      /violates check constraint/,
    );
  }

  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [inspector]);
  await db.exec("set role authenticated");
  const create = async (name) => (await db.query(
    "select public.qa_create_walkdown($1) as result", [name],
  )).rows[0].result;
  const state = async (id) => (await db.query(
    "select public.qa_load_state($1) as result", [id],
  )).rows[0].result;
  const a = await create("Equipment A");
  const b = await create("Equipment B");
  for (const report of [a, b]) {
    const snapshot = await state(report.id);
    assert.equal(snapshot.project.revision, 3);
    assert.equal(snapshot.records.length, 39);
    for (const { key } of equipment) {
      const record = snapshot.records.find((row) => row.key === key);
      assert.equal(record.complete, false);
      assert.equal(record.quality, null);
    }
  }

  const control = "equipment:control-box";
  const solenoid = "equipment:solenoid-box";
  await assert.rejects(
    db.query("select public.qa_set_complete($1,$2,true)", [a.id, control]),
    /at least one inspection photo/,
  );
  await db.query("select public.qa_add_comment($1,$2,'Control box note')", [a.id, control]);
  await db.query("select public.qa_set_quality($1,$2,'good')", [a.id, control]);
  assert.equal((await state(a.id)).project.revision, 5);
  const addPhoto = async (key) => {
    const id = crypto.randomUUID();
    const path = `${inspector}/${id}.jpg`;
    await db.query("select public.qa_prepare_photo($1,$2,$3,$4,'Evidence',100,100)", [a.id, id, key, path]);
    await db.query("insert into storage.objects(bucket_id,name) values('qa-evidence',$1)", [path]);
    await db.query("select public.qa_add_photo($1,$2)", [a.id, id]);
    return id;
  };
  const controlPhoto = await addPhoto(control);
  assert.equal((await state(a.id)).project.revision, 6);
  await db.query("select public.qa_set_complete($1,$2,true)", [a.id, control]);
  assert.equal((await state(a.id)).project.revision, 7);
  assert.equal((await db.query("select public.qa_authorize_voice($1,$2) as ok", [a.id, control])).rows[0].ok, true);
  assert.equal((await state(a.id)).project.revision, 7);
  await assert.rejects(
    db.query("select public.qa_authorize_voice($1,'equipment:unknown')", [a.id]),
    /Unknown comment scope/,
  );

  await addPhoto(solenoid);
  await db.query("select public.qa_set_complete($1,$2,true)", [a.id, solenoid]);
  const beforeDelete = await state(a.id);
  const terminalBefore = beforeDelete.records.find((row) => row.key === "terminal:A");
  await db.query("select public.qa_delete_photo($1,$2)", [a.id, controlPhoto]);
  const afterDelete = await state(a.id);
  assert.equal(afterDelete.project.revision, beforeDelete.project.revision + 1);
  assert.equal(afterDelete.records.find((row) => row.key === control).complete, false);
  assert.equal(afterDelete.records.find((row) => row.key === solenoid).complete, true);
  assert.deepEqual(afterDelete.records.find((row) => row.key === "terminal:A"), terminalBefore);
  assert.equal((await state(b.id)).project.revision, 3);
  assert.equal((await state(b.id)).photos.length, 0);
  assert.equal((await state(b.id)).comments.length, 0);

  for (const [rpc, args] of [
    ["qa_set_complete", [a.id, "walkdown:general", true]],
    ["qa_set_quality", [a.id, "walkdown:general", "good"]],
    ["qa_prepare_photo", [a.id, crypto.randomUUID(), "walkdown:general", `${inspector}/${crypto.randomUUID()}.jpg`, "Note", 100, 100]],
  ]) {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(",");
    await assert.rejects(db.query(`select public.${rpc}(${placeholders})`, args), /Unknown inspection target/);
  }
});
