import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBackend, validateBackendConfig } from "../src/backend.js";

const config = {
  url: "https://example.supabase.co",
  key: "sb_publishable_example123",
};
const userId = "11111111-1111-4111-8111-111111111111";
const walkdownId = "44444444-4444-4444-8444-444444444444";
const otherWalkdownId = "55555555-5555-4555-8555-555555555555";
const photoId = "22222222-2222-4222-8222-222222222222";
const sample = {
  blob: new Blob(["image"], { type: "image/jpeg" }),
  width: 100,
  height: 150,
  name: "Panel",
};

function fixture(overrides = {}) {
  const calls = [];
  const filters = [];
  const state = {
    project: {
      title: "450k Skid x7 - DCS",
      revision: 17,
      status: "draft",
      contentVersion: 9,
      closedAt: null,
      scheduleRevision: 3,
      walkdownId,
      skidName: "Skid A",
      nameRequired: false,
      updatedAt: "2026-11-16T00:00:00Z",
    },
    records: [],
    photos: [],
    comments: [],
    inspector: { id: userId, email: "inspector@example.com" },
  };
  const photo = {
    id: photoId,
    walkdown_id: walkdownId,
    record_key: "device:V-3541",
    path: `${userId}/${photoId}.jpg`,
    name: "Panel",
    width: 100,
    height: 150,
    created_at: "2026-11-16T00:00:00Z",
    created_by: userId,
    ...overrides.photo,
  };
  const storage = {
    async upload(path) {
      calls.push(["upload", path]);
      return { error: overrides.uploadError || null };
    },
    async remove(paths) {
      calls.push(["remove", paths]);
      return { error: overrides.removeError || null };
    },
    async createSignedUrl(path, ttl) {
      calls.push(["signUrl", path, ttl]);
      return {
        data: { signedUrl: "https://example.supabase.co/signed" },
        error: null,
      };
    },
  };
  const walkdown = {
    id: walkdownId,
    skidName: "Skid A",
    nameRequired: false,
    revision: 17,
  };
  const listing = { inspector: state.inspector, walkdowns: [walkdown] };
  const client = {
    auth: {
      async getSession() {
        calls.push(["session"]);
        return {
          data: {
            session: overrides.noSession ? null : { user: { id: userId } },
          },
          error: null,
        };
      },
      async signInWithOtp(args) {
        calls.push(["sendCode", args]);
        return { error: null };
      },
      async verifyOtp(args) {
        calls.push(["verifyCode", args]);
        return { data: { session: { user: { id: userId } } }, error: null };
      },
      async signOut(args) {
        calls.push(["signOut", args]);
        return { error: null };
      },
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "qa-evidence");
        return storage;
      },
    },
    async rpc(name, args) {
      calls.push([name, args]);
      if (overrides.rpcThrows?.[name]) throw overrides.rpcThrows[name];
      if (overrides.rpcErrors?.[name])
        return { data: null, error: overrides.rpcErrors[name] };
      if (Object.hasOwn(overrides.rpcResults || {}, name))
        return { data: overrides.rpcResults[name], error: null };
      return {
        data:
          name === "qa_list_walkdowns"
            ? listing
            : ["qa_create_walkdown", "qa_rename_walkdown"].includes(name)
              ? walkdown
              : name === "qa_load_state"
                ? state
                : name === "qa_add_photo"
                  ? photo
                  : name === "qa_delete_photo"
                    ? photo.path
                    : null,
        error: null,
      };
    },
    from(table) {
      calls.push(["query", table]);
      const query = {
        select() {
          return query;
        },
        eq(column, value) {
          filters.push([column, value]);
          return query;
        },
        is() {
          return query;
        },
        async maybeSingle() {
          return { data: overrides.recoveredPhoto ? photo : null, error: null };
        },
      };
      return query;
    },
  };
  const workspace = createBackend(config, { clientFactory: () => client });
  const backend = workspace.forWalkdown(walkdownId, 17);
  return { workspace, backend, calls, filters, photo, state, listing, walkdown };
}

test("functional test runs retain provenance and are saved or removed only in their pinned revision", async () => {
  const id = "66666666-6666-4666-8666-666666666666";
  const payload = { schemaVersion: 1, name: "Control box functional test", software: { name: "PRONETA Basic", version: "3.9" },
    clock: { basis: "source-local", timeZone: "Source clock (unspecified)", start: null, end: null, startMs: null, endMs: null },
    sources: [{ id: "source-1", name: "station.csv", kind: "results", size: 200, sha256: "a".repeat(64) }],
    stations: [], devices: [], unassignedChannels: [], warnings: ["No timed events were provided."] };
  const saved = { ...payload, id, walkdownId, runVersion: 2, createdBy: userId,
    setupPhotos: [{ id: photoId, caption: "Saved separately", path: `${userId}/${photoId}.jpg` }] };
  const h = fixture({ rpcResults: { qa_save_test_run: saved } });
  assert.deepEqual(await h.backend.saveTestRun({ ...payload, id }), saved);
  assert.deepEqual(h.calls.at(-1), ["qa_save_test_run", {
    p_walkdown_id: walkdownId, p_id: id, p_data: payload, p_expected_revision: 17, p_expected_run_version: null,
  }]);
  await h.backend.saveTestRun(saved);
  assert.deepEqual(h.calls.at(-1), ["qa_save_test_run", {
    p_walkdown_id: walkdownId, p_id: id, p_data: payload, p_expected_revision: 17, p_expected_run_version: 2,
  }]);
  await h.backend.deleteTestRun(id, 2);
  assert.deepEqual(h.calls.at(-1), ["qa_delete_test_run", {
    p_walkdown_id: walkdownId, p_id: id, p_expected_revision: 17, p_expected_run_version: 2,
  }]);
  await assert.rejects(h.workspace.forWalkdown(walkdownId).saveTestRun({ ...payload, id }), /current revision/);
  await assert.rejects(h.backend.saveTestRun({ ...saved, walkdownId: otherWalkdownId }), /another skid/);
  await assert.rejects(h.backend.deleteTestRun(id), /Refresh the test run/);
  const denied = fixture({ rpcErrors: { qa_delete_test_run: { message: "Only the importing inspector can remove this test run." } } });
  await assert.rejects(denied.backend.deleteTestRun(id, 2), /Only the importing inspector/);
});

test("test run and device comments validate optional text without changing imported evidence", async () => {
  const h = fixture();
  const run = { id: "66666666-6666-4666-8666-666666666666", schemaVersion: 1, runVersion: 2,
    name: "Commented test", software: { name: "PRONETA Basic", version: "3.9" },
    sources: [{ id: "source-a", sha256: "a".repeat(64) }],
    devices: [{ id: "V-3541", channels: [{ comment: "Original tester evidence" }] }] };
  for (const comment of [undefined, null, 1, false, [], {}, "x".repeat(4001), "😀".repeat(4001), "Null\u0000byte"]) {
    await assert.rejects(h.backend.saveTestRun({ ...run, comment }), /comments.*4,000/);
    await assert.rejects(h.backend.saveTestRun({ ...run, devices: [{ ...run.devices[0], comment }] }), /comments.*4,000/);
  }
  assert.deepEqual(h.calls, [], "invalid authored comments never reach the server");
  for (const comment of [undefined, "", "  First line\nSecond line\t✓  ", "x".repeat(4000), "😀".repeat(4000)]) {
    const authored = comment === undefined ? {} : { comment };
    const devices = [{ ...run.devices[0], ...authored }];
    await h.backend.saveTestRun({ ...run, ...authored, devices });
    const request = h.calls.at(-1)[1];
    assert.deepEqual(request.p_data, {
      schemaVersion: run.schemaVersion, name: run.name, software: run.software,
      sources: run.sources, devices, ...authored,
    });
    assert.equal(request.p_expected_revision, 17);
    assert.equal(request.p_expected_run_version, 2);
  }
  assert.equal(run.devices[0].channels[0].comment, "Original tester evidence");
});

test("event exclusion validates optional booleans on assigned and unassigned channels while retaining every source row", async () => {
  const h = fixture();
  const run = { id: "66666666-6666-4666-8666-666666666666", schemaVersion: 1, runVersion: 2,
    name: "Reviewed events", software: { name: "PRONETA Basic", version: "3.9" }, devices: [], unassignedChannels: [] };
  const originalPoint = { timeMs: 1000, value: 4, valid: true, sourceId: "source-1", sourceRow: 2, rawValue: "4.0" };
  const withPoint = (point, assigned) => {
    const channel = { series: [{ points: [point] }] };
    return { ...run, ...(assigned ? { devices: [{ channels: [channel] }] } : { unassignedChannels: [channel] }) };
  };
  for (const assigned of [true, false]) {
    for (const excluded of [undefined, null, 0, 1, "true", [], {}])
      await assert.rejects(h.backend.saveTestRun(withPoint({ ...originalPoint, excluded }, assigned)), /excluded flag.*true or false/);
  }
  assert.deepEqual(h.calls, []);
  for (const assigned of [true, false]) {
    for (const flags of [{}, { excluded: true }, { excluded: false }]) {
      const payload = withPoint({ ...originalPoint, ...flags }, assigned);
      const before = structuredClone(payload);
      await h.backend.saveTestRun(payload);
      const request = h.calls.at(-1)[1];
      const channel = assigned ? request.p_data.devices[0].channels[0] : request.p_data.unassignedChannels[0];
      assert.deepEqual(channel.series[0].points, [{ ...originalPoint, ...flags }]);
      assert.equal(request.p_expected_run_version, 2);
      assert.equal(request.p_expected_revision, 17);
      assert.deepEqual(payload, before);
    }
  }
  await assert.rejects(h.backend.saveTestRun(withPoint({ ...originalPoint, excluded: true, value: NaN }, true)), /finite numbers/);
});

test("setup photo uploads use the saved run and pinned revision without creating an inspection record", async () => {
  const runId = "66666666-6666-4666-8666-666666666666";
  const saved = { id: photoId, walkdownId, testRunId: runId, path: `${userId}/${photoId}.jpg`, caption: "", name: "Setup", width: 100, height: 150 };
  const h = fixture({ rpcResults: { qa_add_test_setup_photo: saved } });
  assert.deepEqual(await h.backend.addTestSetupPhoto(runId, sample), saved);
  assert.deepEqual(h.calls.map(call => call[0]), ["session", "qa_prepare_test_setup_photo", "upload", "qa_add_test_setup_photo"]);
  const prepare = h.calls[1][1];
  assert.equal(prepare.p_run_id, runId);
  assert.equal(prepare.p_walkdown_id, walkdownId);
  assert.equal(prepare.p_expected_revision, 17);
  assert.equal(prepare.p_caption, "");
  assert.ok(!Object.hasOwn(prepare, "p_record_key"));
  assert.equal(h.calls.at(-1)[1].p_id, prepare.p_id);
  assert.equal(h.calls.at(-1)[1].p_run_id, runId);
  await h.backend.getPhotoUrl(saved);
  assert.equal(h.calls.at(-1)[0], "signUrl");
});

test("setup photo captions are saved with the upload instead of a separate post-upload write", async () => {
  const runId = "66666666-6666-4666-8666-666666666666";
  const caption = "Air supply at 6 bar\nFeedback connected to CH0";
  const saved = { id: photoId, walkdownId, testRunId: runId, caption };
  const h = fixture({ rpcResults: { qa_add_test_setup_photo: saved } });
  assert.deepEqual(await h.backend.addTestSetupPhoto(runId, { ...sample, caption: `  ${caption}  ` }), saved);
  assert.deepEqual(h.calls.map(call => call[0]), ["session", "qa_prepare_test_setup_photo", "upload", "qa_add_test_setup_photo"]);
  assert.equal(h.calls[1][1].p_caption, caption);

  const rejected = fixture({ rpcErrors: { qa_prepare_test_setup_photo: { message: "Caption was rejected" } } });
  await assert.rejects(rejected.backend.addTestSetupPhoto(runId, { ...sample, caption }), /Caption was rejected/);
  assert.deepEqual(rejected.calls.map(call => call[0]), ["session", "qa_prepare_test_setup_photo"],
    "a rejected caption must never leave uploaded image bytes or a ready photo to duplicate on retry");
});

test("invalid setup upload captions are rejected before authentication, reservation, or image upload", async () => {
  const h = fixture(), runId = "66666666-6666-4666-8666-666666666666";
  for (const caption of [null, 12, {}, "x".repeat(1001), "Bad\u0000caption"])
    await assert.rejects(h.backend.addTestSetupPhoto(runId, { ...sample, caption }), /1,000 characters/);
  assert.deepEqual(h.calls, []);
});

test("setup photo upload failures clean up reservations and lost finalization responses recover within the same run", async () => {
  const runId = "66666666-6666-4666-8666-666666666666";
  const failed = fixture({ uploadError: { message: "Offline" } });
  await assert.rejects(failed.backend.addTestSetupPhoto(runId, sample), /Offline/);
  assert.deepEqual(failed.calls.slice(-2).map(call => call[0]), ["qa_cancel_photo", "remove"]);
  for (const failure of [
    { rpcErrors: { qa_add_test_setup_photo: { message: "Response lost" } } },
    { rpcThrows: { qa_add_test_setup_photo: new Error("Transport response lost") } },
  ]) {
    const h = fixture({ ...failure, recoveredPhoto: true,
      photo: { test_run_id: runId, record_key: null, caption: "Wiring setup" } });
    const recovered = await h.backend.addTestSetupPhoto(runId, { ...sample, caption: "Wiring setup" });
    assert.equal(recovered.testRunId, runId);
    assert.equal(recovered.caption, "Wiring setup");
    assert.equal(h.calls.filter(call => call[0] === "upload").length, 1);
    assert.ok(!h.calls.some(call => call[0] === "qa_update_test_setup_photo"));
    assert.ok(h.filters.some(([key, value]) => key === "test_run_id" && value === runId));
    assert.ok(!h.calls.some(call => ["qa_cancel_photo", "remove"].includes(call[0])));
  }
});

test("setup captions and removal preserve revision scope and archived objects", async () => {
  const runId = "66666666-6666-4666-8666-666666666666";
  const h = fixture({ rpcResults: { qa_delete_test_setup_photo: null } });
  await h.backend.updateTestSetupPhoto(runId, photoId, "  Air supply and feedback wiring  ");
  assert.deepEqual(h.calls.at(-1), ["qa_update_test_setup_photo", {
    p_walkdown_id: walkdownId, p_run_id: runId, p_id: photoId, p_caption: "Air supply and feedback wiring", p_expected_revision: 17,
  }]);
  await h.backend.deleteTestSetupPhoto(runId, photoId);
  assert.equal(h.calls.at(-1)[0], "qa_delete_test_setup_photo");
  assert.ok(!h.calls.some(call => call[0] === "remove"));
  const fresh = fixture({ rpcResults: { qa_delete_test_setup_photo: "private/unarchived.jpg" } });
  await fresh.backend.deleteTestSetupPhoto(runId, photoId);
  assert.deepEqual(fresh.calls.at(-1), ["remove", ["private/unarchived.jpg"]]);
  const count = h.calls.length;
  await assert.rejects(h.backend.updateTestSetupPhoto(runId, photoId, "x".repeat(1001)), /1,000/);
  await assert.rejects(h.backend.addTestSetupPhoto("wrong-run", sample), /valid imported test run/);
  await assert.rejects(h.backend.deleteTestSetupPhoto(runId, "wrong-photo"), /existing setup photo/);
  await assert.rejects(h.workspace.forWalkdown(walkdownId).addTestSetupPhoto(runId, sample), /current revision/);
  assert.equal(h.calls.length, count);
});

test("setup photo reordering sends the complete expected order and returns saved photo metadata", async () => {
  const runId = "66666666-6666-4666-8666-666666666666";
  const nextId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  const photos = [{ id: nextId, caption: "Second", path: "second.jpg" }, { id: photoId, caption: "First", path: "first.jpg" }];
  const h = fixture({ rpcResults: { qa_reorder_test_setup_photos: photos } });
  assert.deepEqual(await h.backend.reorderTestSetupPhotos(runId, [nextId.toUpperCase(), photoId], [photoId, nextId]), photos);
  assert.deepEqual(h.calls, [["qa_reorder_test_setup_photos", {
    p_walkdown_id: walkdownId, p_run_id: runId, p_ordered_photo_ids: [nextId, photoId],
    p_expected_photo_ids: [photoId, nextId], p_expected_revision: 17,
  }]]);
  const conflict = fixture({ rpcErrors: { qa_reorder_test_setup_photos: { message: "Setup photos changed. Refresh before saving." } } });
  await assert.rejects(conflict.backend.reorderTestSetupPhotos(runId, [nextId, photoId], [photoId, nextId]),
    /Could not save the setup photo order: Setup photos changed/);
});

test("setup photo reordering rejects malformed, duplicate, incomplete and unpinned requests before RPC", async () => {
  const h = fixture(), runId = "66666666-6666-4666-8666-666666666666";
  await assert.rejects(h.backend.reorderTestSetupPhotos("invalid", [], []), /valid imported test run/);
  for (const invalid of [null, "photos", [null], ["wrong-photo"], [photoId, photoId], Array(31).fill(photoId)]) {
    await assert.rejects(h.backend.reorderTestSetupPhotos(runId, invalid, [photoId]), /setup photo|30 photos/);
    await assert.rejects(h.backend.reorderTestSetupPhotos(runId, [photoId], invalid), /setup photo|30 photos/);
  }
  await assert.rejects(h.backend.reorderTestSetupPhotos(runId, [], [photoId]), /every current setup photo/);
  await assert.rejects(h.backend.reorderTestSetupPhotos(runId, [userId], [photoId]), /every current setup photo/);
  await assert.rejects(h.workspace.forWalkdown(walkdownId).reorderTestSetupPhotos(runId, [], []), /current revision/);
  assert.deepEqual(h.calls, []);
});

test("inspection photo reordering supports device, terminal and equipment scopes with a pinned expected order", async () => {
  const nextId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  const photos = [{ id: nextId, recordKey: "device:V-3541", name: "Second" }, { id: photoId, recordKey: "device:V-3541", name: "First" }];
  const h = fixture({ rpcResults: { qa_reorder_photos: photos } });
  for (const recordKey of ["device:V-3541", "terminal:A", "equipment:control-box"]) {
    assert.deepEqual(await h.backend.reorderPhotos(recordKey, [nextId.toUpperCase(), photoId], [photoId, nextId]), photos);
    assert.deepEqual(h.calls.at(-1), ["qa_reorder_photos", { p_walkdown_id: walkdownId, p_record_key: recordKey,
      p_ordered_photo_ids: [nextId, photoId], p_expected_photo_ids: [photoId, nextId], p_expected_revision: 17 }]);
  }
  const count = h.calls.length;
  for (const invalid of [null, [photoId, photoId], ["invalid"], Array(1001).fill(photoId), Array(1)]) {
    await assert.rejects(h.backend.reorderPhotos("device:V-3541", invalid, [photoId]), /inspection photo|1000 photos/);
    await assert.rejects(h.backend.reorderPhotos("device:V-3541", [photoId], invalid), /inspection photo|1000 photos/);
  }
  await assert.rejects(h.backend.reorderPhotos("walkdown:general", [], []), /inspection target/);
  await assert.rejects(h.backend.reorderPhotos("device:V-3541", [], [photoId]), /every current inspection photo/);
  await assert.rejects(h.backend.reorderPhotos("device:V-3541", [nextId], [photoId]), /every current inspection photo/);
  await assert.rejects(h.workspace.forWalkdown(walkdownId).reorderPhotos("terminal:A", [], []), /current revision/);
  assert.equal(h.calls.length, count);
  const many = Array.from({ length: 31 }, () => crypto.randomUUID());
  await h.backend.reorderPhotos("terminal:A", [...many].reverse(), many);
  const conflict = fixture({ rpcErrors: { qa_reorder_photos: { message: "Inspection photos changed. Refresh before saving." } } });
  await assert.rejects(conflict.backend.reorderPhotos("device:V-3541", [nextId, photoId], [photoId, nextId]), /Could not save the inspection photo order: Inspection photos changed/);
});

test("functional test runs require software metadata and finite bounded serialized evidence", async () => {
  const h = fixture();
  const run = { id: "66666666-6666-4666-8666-666666666666", schemaVersion: 1,
    name: "I/O test", software: { name: "PRONETA Basic", version: "3.9" }, devices: [] };
  for (const version of ["", "  ", undefined])
    await assert.rejects(h.backend.saveTestRun({ ...run, software: { ...run.software, version } }), /software name and version/);
  await assert.rejects(h.backend.saveTestRun({ ...run, samples: [NaN] }), /finite numbers/);
  await assert.rejects(h.backend.saveTestRun({ ...run, samples: [Infinity] }), /finite numbers/);
  const cyclic = { ...run }; cyclic.self = cyclic;
  await assert.rejects(h.backend.saveTestRun(cyclic), /circular data reference/);
  await assert.rejects(h.backend.saveTestRun({ ...run, warnings: ["x".repeat(4 * 1024 * 1024)] }), /exceeds 4 MB/);
  await assert.rejects(h.backend.saveTestRun({ ...run, runVersion: -1 }), /Refresh the test run/);
  assert.equal(h.calls.length, 0, "invalid runs cannot reach the shared backend");
});

test("configuration accepts only HTTPS/local URLs and public keys", () => {
  assert.deepEqual(
    validateBackendConfig({ ...config, url: `${config.url}/` }),
    config,
  );
  assert.equal(
    validateBackendConfig({ ...config, url: "http://127.0.0.1:54321" }).url,
    "http://127.0.0.1:54321",
  );
  const anon = `a.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.b`;
  assert.equal(validateBackendConfig({ ...config, key: anon }).key, anon);
  for (const key of [
    "sb_secret_do_not_use",
    "",
    "not-a-key",
    `a.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.b`,
  ]) {
    assert.throws(
      () => validateBackendConfig({ ...config, key }),
      /publishable key/,
    );
  }
  for (const url of [
    "http://example.supabase.co",
    "https://example.supabase.co/path",
    "https://user:pass@example.supabase.co",
    "https://example.supabase.co?key=private",
  ]) {
    assert.throws(
      () => validateBackendConfig({ ...config, url }),
      /HTTPS Supabase/,
    );
  }
});

test("email code flow normalizes email and verifies membership before returning a session", async () => {
  const { workspace: backend, calls } = fixture();
  await backend.requestCode(" Inspector@Example.com ");
  const session = await backend.verifyCode(
    " Inspector@Example.com ",
    " 123456 ",
  );
  assert.equal(calls[0][1].email, "inspector@example.com");
  assert.deepEqual(calls[1], [
    "verifyCode",
    { email: "inspector@example.com", token: "123456", type: "email" },
  ]);
  assert.equal(calls[2][0], "qa_list_walkdowns");
  assert.equal(session.user.id, userId);
  await assert.rejects(
    backend.verifyCode("inspector@example.com", "123"),
    /numeric code/,
  );
  await assert.rejects(backend.requestCode("invalid"), /valid inspector email/);
});

test("verified nonmembers are signed out with the access error preserved", async () => {
  const { workspace: backend, calls } = fixture({
    rpcErrors: { qa_list_walkdowns: { message: "Not an approved inspector" } },
  });
  await assert.rejects(
    backend.verifyCode("outsider@example.com", "123456"),
    /Not an approved inspector/,
  );
  assert.deepEqual(calls.at(-1), ["signOut", { scope: "local" }]);
});

test("loadState returns one scoped shared snapshot", async () => {
  const { backend, state, calls } = fixture();
  assert.equal(await backend.loadState(), state);
  assert.deepEqual(calls, [["qa_load_state", { p_walkdown_id: walkdownId }]]);
});

test("write scopes stay pinned to their revision while unbound scopes can only read", async () => {
  const { workspace, backend, state, calls } = fixture();
  const reader = workspace.forWalkdown(walkdownId);
  assert.equal(reader.expectedRevision, null);
  for (const write of [
    () => reader.addComment("walkdown:general", "Note"),
    () => reader.deleteComment(photoId),
    () => reader.setQuality("terminal:A", "good"),
    () => reader.setComplete("terminal:A", false),
    () => reader.addPhoto("terminal:A", sample),
    () => reader.deletePhoto(photoId),
    () => reader.approveRevision(9),
    () => reader.newRevision(),
    () => workspace.renameWalkdown(walkdownId, "Renamed skid"),
  ]) await assert.rejects(write, /current revision/);
  assert.deepEqual(calls, [], "missing revision cannot send writes or upload bytes");
  for (const revision of [null, 0, -1, 1.5, "17", Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => reader.forRevision(revision), /current revision/);
  const next = reader.forRevision(18);
  assert.equal(Object.isFrozen(next), true);
  assert.equal(next.walkdownId, walkdownId);
  state.project.revision = 18;
  await backend.loadState();
  await backend.addComment("walkdown:general", "Original draft request");
  await next.addComment("walkdown:general", "New draft request");
  assert.equal(backend.expectedRevision, 17, "refresh must not rebind an outstanding editor");
  assert.equal(calls.at(-2)[1].p_expected_revision, 17);
  assert.equal(calls.at(-1)[1].p_expected_revision, 18);
});

test("closing, reopening, and loading revisions use authoritative versioned RPCs", async () => {
  const closed = { project: { walkdownId, revision: 17, status: "closed", contentVersion: 9,
    closedAt: "2026-11-19T20:00:00Z", closedBy: userId, closedByName: "Inspector" } };
  const next = { project: { ...closed.project, revision: 18, status: "draft", closedAt: null } };
  const revisions = [closed.project];
  const { backend, calls } = fixture({ rpcResults: {
    qa_approve_revision: closed, qa_new_revision: next,
    qa_list_revisions: revisions, qa_load_revision: closed,
  } });
  assert.equal(await backend.approveRevision(9), closed);
  assert.equal(await backend.listRevisions(), revisions);
  assert.equal(await backend.loadRevision(17), closed);
  assert.equal(await backend.newRevision(), next);
  assert.deepEqual(calls, [
    ["qa_approve_revision", { p_walkdown_id: walkdownId, p_expected_revision: 17, p_expected_version: 9 }],
    ["qa_list_revisions", { p_walkdown_id: walkdownId }],
    ["qa_load_revision", { p_walkdown_id: walkdownId, p_revision: 17 }],
    ["qa_new_revision", { p_walkdown_id: walkdownId, p_expected_revision: 17 }],
  ]);
  calls.length = 0;
  for (const version of [null, -1, 1.5, "9", Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(backend.approveRevision(version), /Refresh the report/);
  await assert.rejects(backend.loadRevision(0), /current revision/);
  assert.deepEqual(calls, []);
  const stale = fixture({ rpcErrors: { qa_approve_revision: { message: "Report changed. Refresh before approving." } } });
  await assert.rejects(stale.backend.approveRevision(8), /Report changed.*Refresh/);
});

test("comment removal is scoped to the draft revision and surfaces server permission errors", async () => {
  const { backend, calls } = fixture();
  await backend.deleteComment(photoId);
  assert.deepEqual(calls, [["qa_delete_comment", {
    p_walkdown_id: walkdownId, p_id: photoId, p_expected_revision: 17,
  }]]);
  for (const id of [undefined, "", "comment-1", "../comment"])
    await assert.rejects(backend.deleteComment(id), /existing comment/);
  assert.equal(calls.length, 1);
  const forbidden = fixture({ rpcErrors: { qa_delete_comment: { message: "Only its author or an administrator can remove this comment." } } });
  await assert.rejects(forbidden.backend.deleteComment(photoId), /author or an administrator/);
});

test("workspace lists, creates and renames named skids before selecting an immutable scope", async () => {
  const { workspace, calls, listing, walkdown } = fixture();
  assert.equal(await workspace.listWalkdowns(), listing);
  assert.equal(await workspace.createWalkdown(" Skid A "), walkdown);
  assert.equal(
    await workspace.renameWalkdown(walkdownId, " Skid B ", 17),
    walkdown,
  );
  assert.deepEqual(calls, [
    ["qa_list_walkdowns", {}],
    ["qa_create_walkdown", { p_skid_name: "Skid A" }],
    [
      "qa_rename_walkdown",
      { p_walkdown_id: walkdownId, p_skid_name: "Skid B", p_expected_revision: 17 },
    ],
  ]);
  assert.equal(workspace.loadState, undefined);
  const a = workspace.forWalkdown(walkdownId, 17);
  const b = workspace.forWalkdown(otherWalkdownId, 17);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(a.walkdownId, walkdownId);
  await b.setQuality("device:V-3541", "bad");
  await a.addComment("walkdown:general", "Stays on Skid A");
  assert.equal(calls.at(-2)[1].p_walkdown_id, otherWalkdownId);
  assert.equal(calls.at(-1)[1].p_walkdown_id, walkdownId);
});

test("invalid or reserved skid names and missing IDs fail before requests", async () => {
  const { workspace, backend, calls } = fixture();
  for (const name of [
    null,
    "",
    "  ",
    "Unassigned skid",
    "unassigned SKID",
    "x".repeat(121),
    "Panel\n2",
  ]) {
    await assert.rejects(workspace.createWalkdown(name), /skid name/);
    await assert.rejects(
      workspace.renameWalkdown(walkdownId, name, 17),
      /skid name/,
    );
  }
  for (const id of [undefined, "", "walkdown:general", "../other"])
    assert.throws(() => workspace.forWalkdown(id), /named skid/);
  await assert.rejects(
    backend.getPhotoUrl({ walkdownId: otherWalkdownId, path: "private.jpg" }),
    /another skid/,
  );
  assert.deepEqual(calls, []);
});

test("photo upload reserves first, uploads without overwrite, then finalizes server metadata", async () => {
  const { backend, calls } = fixture();
  const result = await backend.addPhoto("device:V-3541", sample);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["session", "qa_prepare_photo", "upload", "qa_add_photo"],
  );
  assert.equal(calls[1][1].p_record_key, "device:V-3541");
  assert.equal(calls[1][1].p_walkdown_id, walkdownId);
  assert.equal(calls[3][1].p_walkdown_id, walkdownId);
  assert.equal(calls[1][1].p_expected_revision, 17);
  assert.equal(calls[3][1].p_expected_revision, 17);
  assert.equal(result.walkdownId, walkdownId);
  assert.match(calls[1][1].p_path, new RegExp(`^${userId}/[0-9a-f-]+\\.jpg$`));
  assert.equal(calls[2][1], calls[1][1].p_path);
  assert.equal(calls[3][1].p_id, calls[1][1].p_id);
  assert.equal(result.recordKey, "device:V-3541");
  assert.equal(result.createdBy, userId);
});

test("upload failures cancel the reservation before storage cleanup", async () => {
  const { backend, calls } = fixture({
    uploadError: { message: "Upload offline" },
  });
  await assert.rejects(
    backend.addPhoto("device:V-3541", sample),
    /Upload offline/,
  );
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["session", "qa_prepare_photo", "upload", "qa_cancel_photo", "remove"],
  );
});

test("registration failures clean up uploaded bytes when no completed photo is found", async () => {
  const { backend, calls } = fixture({
    rpcErrors: { qa_add_photo: { message: "Registration failed" } },
  });
  await assert.rejects(
    backend.addPhoto("device:V-3541", sample),
    /Registration failed/,
  );
  assert.deepEqual(
    calls.slice(-3).map((call) => call[0]),
    ["query", "qa_cancel_photo", "remove"],
  );
});

test("lost finalization responses recover saved evidence without deleting it", async () => {
  const { backend, calls } = fixture({
    rpcErrors: { qa_add_photo: { message: "Response lost" } },
    recoveredPhoto: true,
  });
  const photo = await backend.addPhoto("device:V-3541", sample);
  assert.equal(photo.id, photoId);
  assert.equal(
    calls.some((call) => call[0] === "remove" || call[0] === "qa_cancel_photo"),
    false,
  );
});

test("photo validation rejects unsupported files, excess size, invalid dimensions and missing session", async () => {
  const { backend, calls } = fixture();
  await assert.rejects(
    backend.addPhoto("device:V-3541", {
      ...sample,
      blob: new Blob(["x"], { type: "image/svg+xml" }),
    }),
    /JPEG, PNG, or WebP/,
  );
  await assert.rejects(
    backend.addPhoto("device:V-3541", {
      ...sample,
      blob: {
        type: "image/jpeg",
        size: 12 * 1024 * 1024 + 1,
        arrayBuffer() {},
      },
    }),
    /12 MB/,
  );
  await assert.rejects(
    backend.addPhoto("device:V-3541", { ...sample, height: 0 }),
    /dimensions/,
  );
  await assert.rejects(
    backend.addPhoto("../outside", sample),
    /project schedule/,
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    fixture({ noSession: true }).backend.addPhoto("device:V-3541", sample),
    /Sign in/,
  );
});

test("comment and completion input is validated before sending authoritative RPCs", async () => {
  const { backend, calls } = fixture();
  await assert.rejects(
    backend.addComment("device:V-3541", "   "),
    /between 1 and 4,000/,
  );
  await assert.rejects(
    backend.addComment("device:V-3541", "a".repeat(4001)),
    /between 1 and 4,000/,
  );
  await assert.rejects(
    backend.setComplete("terminal:I", true),
    /project schedule/,
  );
  await assert.rejects(
    backend.setComplete("terminal:A", "yes"),
    /true or false/,
  );
  await backend.addComment("device:V-3571#2", " Check tightness ");
  await backend.setComplete("terminal:A", false);
  assert.deepEqual(calls, [
    [
      "qa_add_comment",
      {
        p_walkdown_id: walkdownId,
        p_expected_revision: 17,
        p_record_key: "device:V-3571#2",
        p_text: "Check tightness",
      },
    ],
    [
      "qa_set_complete",
      {
        p_walkdown_id: walkdownId,
        p_expected_revision: 17,
        p_record_key: "terminal:A",
        p_complete: false,
      },
    ],
  ]);
});

test("only the three scheduled equipment keys are accepted for inspection actions", async () => {
  const { backend, calls } = fixture();
  const keys = [
    "equipment:control-box",
    "equipment:solenoid-box",
    "equipment:transducer-panel",
  ];
  for (const key of keys) {
    await backend.addComment(key, "Equipment note");
    await backend.setQuality(key, "good");
    await backend.setComplete(key, false);
  }
  await backend.addPhoto(keys[0], sample);
  for (const key of [
    "equipment:other",
    "equipment:Control-Box",
    "equipment:control-box:extra",
    "equipment:control-box/../terminal:A",
  ]) {
    await assert.rejects(backend.addComment(key, "note"), /project schedule/);
    await assert.rejects(backend.setComplete(key, true), /project schedule/);
    await assert.rejects(backend.setQuality(key, "good"), /project schedule/);
    await assert.rejects(backend.addPhoto(key, sample), /project schedule/);
  }
  assert.deepEqual(
    calls.filter((call) => call[0].startsWith("qa_") && call[1]?.p_record_key)
      .map((call) => call[1].p_record_key),
    keys.flatMap((key) => [key, key, key]).concat(keys[0]),
  );
});

test("private photo URLs are cached briefly and removal reopens the record before storage deletion", async () => {
  const { backend, calls, photo } = fixture();
  await backend.getPhotoUrl(photo);
  await backend.getPhotoUrl(photo);
  assert.deepEqual(calls, [["signUrl", photo.path, 600]]);
  await backend.deletePhoto(photo.id);
  assert.deepEqual(
    calls.slice(1).map((call) => call[0]),
    ["qa_delete_photo", "remove"],
  );
  await backend.getPhotoUrl(photo);
  assert.equal(calls.at(-1)[0], "signUrl");
});

test("photo removal preserves files referenced by closed revisions", async () => {
  const { backend, calls, photo } = fixture({ rpcResults: { qa_delete_photo: null } });
  await backend.getPhotoUrl(photo);
  await backend.deletePhoto(photo.id);
  await backend.getPhotoUrl(photo);
  assert.deepEqual(calls.map((call) => call[0]), ["signUrl", "qa_delete_photo"]);
  assert.equal(calls[1][1].p_expected_revision, 17);
  assert.equal(calls.some((call) => call[0] === "remove"), false);
});

test("whole-walkdown scope accepts comments but cannot become a photo, quality, or completion target", async () => {
  const { backend, calls } = fixture();
  await backend.addComment("walkdown:general", " Overall walkdown note ");
  await assert.rejects(
    backend.addComment("walkdown:other", "invalid"),
    /project schedule/,
  );
  await assert.rejects(backend.addComment(null, "invalid"), /project schedule/);
  await assert.rejects(
    backend.addPhoto("walkdown:general", sample),
    /project schedule/,
  );
  await assert.rejects(
    backend.setQuality("walkdown:general", "good"),
    /project schedule/,
  );
  await assert.rejects(
    backend.setComplete("walkdown:general", true),
    /project schedule/,
  );
  assert.deepEqual(calls, [
    [
      "qa_add_comment",
      {
        p_walkdown_id: walkdownId,
        p_expected_revision: 17,
        p_record_key: "walkdown:general",
        p_text: "Overall walkdown note",
      },
    ],
  ]);
});

test("quality accepts a single good, bad, or null value and rejects invalid input", async () => {
  const { backend, calls } = fixture();
  for (const value of ["Passed", "Failed", "", true, undefined, ["good", "bad"]]) {
    await assert.rejects(
      backend.setQuality("device:V-3541", value),
      /Passed, Failed, or unrated/,
    );
  }
  await assert.rejects(
    backend.setQuality("terminal:I", "good"),
    /project schedule/,
  );
  for (const value of ["good", "bad", null])
    await backend.setQuality("device:V-3541", value);
  await backend.setQuality("terminal:A", "bad");
  assert.deepEqual(calls, [
    [
      "qa_set_quality",
      {
        p_walkdown_id: walkdownId,
        p_expected_revision: 17,
        p_record_key: "device:V-3541",
        p_quality: "good",
      },
    ],
    [
      "qa_set_quality",
      {
        p_walkdown_id: walkdownId,
        p_expected_revision: 17,
        p_record_key: "device:V-3541",
        p_quality: "bad",
      },
    ],
    [
      "qa_set_quality",
      {
        p_walkdown_id: walkdownId,
        p_expected_revision: 17,
        p_record_key: "device:V-3541",
        p_quality: null,
      },
    ],
    [
      "qa_set_quality",
      {
        p_walkdown_id: walkdownId,
        p_expected_revision: 17,
        p_record_key: "terminal:A",
        p_quality: "bad",
      },
    ],
  ]);
});

test("storage deletion failure reports that the inspection has already reopened", async () => {
  const { backend } = fixture({
    removeError: { message: "Network unavailable" },
  });
  await assert.rejects(
    backend.deletePhoto(photoId),
    /completion was reopened.*storage cleanup failed/,
  );
});

test("database catalog matches every exact revision-3 schedule ID and terminal", async () => {
  const schedule = JSON.parse(
    await readFile(
      new URL("../src/data/schedule.json", import.meta.url),
      "utf8",
    ),
  );
  const sql = await readFile(
    new URL("../supabase/schema.sql", import.meta.url),
    "utf8",
  );
  const seeded = [
    ...sql.matchAll(/\('([A-Z]+-\d{4}(?:#[1-9]\d*|-Y)?)','([A-H])'\)/g),
  ].map((match) => `${match[1]}:${match[2]}`);
  const expected = schedule.devices.map(
    (device) => `${device.id}:${device.terminal}`,
  );
  assert.equal(seeded.length, 28);
  assert.deepEqual(seeded.sort(), expected.sort());
  const equipment = [
    ["equipment:control-box", "Control Box"],
    ["equipment:solenoid-box", "Solenoid Box"],
    ["equipment:transducer-panel", "Transducer Panel"],
  ];
  assert.deepEqual(
    schedule.equipment.map((item) => [`equipment:${item.id}`, item.name]),
    equipment,
  );
  for (const [key, label] of equipment)
    assert.match(sql, new RegExp(`\\('${key}', 'equipment', null, '${label}'\\)`));
});
