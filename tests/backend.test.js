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
  const state = {
    project: {
      title: "450k Skid x7 - DCS",
      revision: 17,
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
      if (overrides.rpcErrors?.[name])
        return { data: null, error: overrides.rpcErrors[name] };
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
        eq() {
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
  const backend = workspace.forWalkdown(walkdownId);
  return { workspace, backend, calls, photo, state, listing, walkdown };
}

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

test("workspace lists, creates and renames named skids before selecting an immutable scope", async () => {
  const { workspace, calls, listing, walkdown } = fixture();
  assert.equal(await workspace.listWalkdowns(), listing);
  assert.equal(await workspace.createWalkdown(" Skid A "), walkdown);
  assert.equal(
    await workspace.renameWalkdown(walkdownId, " Skid B "),
    walkdown,
  );
  assert.deepEqual(calls, [
    ["qa_list_walkdowns", {}],
    ["qa_create_walkdown", { p_skid_name: "Skid A" }],
    [
      "qa_rename_walkdown",
      { p_walkdown_id: walkdownId, p_skid_name: "Skid B" },
    ],
  ]);
  assert.equal(workspace.loadState, undefined);
  const a = workspace.forWalkdown(walkdownId);
  const b = workspace.forWalkdown(otherWalkdownId);
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
      workspace.renameWalkdown(walkdownId, name),
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
        p_record_key: "device:V-3571#2",
        p_text: "Check tightness",
      },
    ],
    [
      "qa_set_complete",
      {
        p_walkdown_id: walkdownId,
        p_record_key: "terminal:A",
        p_complete: false,
      },
    ],
  ]);
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
        p_record_key: "walkdown:general",
        p_text: "Overall walkdown note",
      },
    ],
  ]);
});

test("quality accepts a single good, bad, or null value and rejects invalid input", async () => {
  const { backend, calls } = fixture();
  for (const value of ["Good", "", true, undefined, ["good", "bad"]]) {
    await assert.rejects(
      backend.setQuality("device:V-3541", value),
      /Good, Bad, or unrated/,
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
        p_record_key: "device:V-3541",
        p_quality: "good",
      },
    ],
    [
      "qa_set_quality",
      {
        p_walkdown_id: walkdownId,
        p_record_key: "device:V-3541",
        p_quality: "bad",
      },
    ],
    [
      "qa_set_quality",
      {
        p_walkdown_id: walkdownId,
        p_record_key: "device:V-3541",
        p_quality: null,
      },
    ],
    [
      "qa_set_quality",
      {
        p_walkdown_id: walkdownId,
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
});
