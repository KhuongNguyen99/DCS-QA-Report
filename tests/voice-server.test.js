import test from "node:test";
import assert from "node:assert/strict";
import {
  createVoiceHandler,
  MAX_AUDIO_BYTES,
} from "../supabase/functions/transcribe-comment/handler.js";

const walkdownId = "44444444-4444-4444-8444-444444444444";

function fixture(overrides = {}) {
  const calls = [];
  const handler = createVoiceHandler({
    getEnv: (name) =>
      name === "ELEVENLABS_API_KEY"
        ? overrides.noKey
          ? undefined
          : "server-only-test-key"
        : name === "SUPABASE_URL"
          ? "https://example.supabase.co"
          : "public-anon-key",
    createSupabaseClient: (args) => {
      calls.push(["supabase", args.authorization]);
      return {
        auth: {
          async getUser(token) {
            calls.push(["auth", token]);
            return overrides.unauthorized
              ? { error: new Error("expired") }
              : { data: { user: { id: "inspector-1" } } };
          },
        },
        async rpc(name, args) {
          calls.push([name, args]);
          if (name === "qa_authorize_voice")
            return {
              data: !overrides.rateLimited,
              error: overrides.noMigration
                ? new Error("missing function")
                : null,
            };
          return overrides.nonmember
            ? { error: new Error("Denied") }
            : {
                data: {
                  inspector: { id: "inspector-1" },
                  project: {
                    walkdownId: overrides.wrongWalkdown
                      ? "55555555-5555-4555-8555-555555555555"
                      : walkdownId,
                    nameRequired: !!overrides.unnamed,
                  },
                  records: [{ key: "device:V-3541" }],
                },
              };
        },
      };
    },
    createElevenLabsClient: (key) => {
      assert.equal(key, "server-only-test-key");
      calls.push(["sdk"]);
      return {
        audioIsolation: {
          async convert(args, options) {
            calls.push(["isolate", args, options]);
            if (overrides.isolationError) throw overrides.isolationError;
            if (overrides.hang) return new Promise(() => {});
            return new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([11, 22, 33]));
                controller.close();
              },
            });
          },
        },
        speechToText: {
          async convert(args, options) {
            calls.push(["transcribe", args, options]);
            return overrides.noSpeech
              ? { text: "", words: [] }
              : {
                  text: " Check terminal tightness. ",
                  words: [{ type: "word", text: "Check" }],
                };
          },
        },
      };
    },
    timeoutMs: overrides.timeoutMs || 1000,
  });
  return { handler, calls };
}

function request({
  origin = "https://khuongnguyen99.github.io",
  token = "session-jwt",
  type = "audio/webm;codecs=opus",
  size = 256,
  key = "device:V-3541",
  duration = 6000,
  walkdown = walkdownId,
  duplicateWalkdown = false,
  headers = {},
} = {}) {
  const form = new FormData();
  form.append(
    "audio",
    new Blob([new Uint8Array(size)], { type }),
    "comment.webm",
  );
  form.append("record_key", key);
  if (walkdown !== null) form.append("walkdown_id", walkdown);
  if (duplicateWalkdown) form.append("walkdown_id", walkdown);
  form.append("duration_ms", String(duration));
  return new Request(
    "https://example.supabase.co/functions/v1/transcribe-comment",
    {
      method: "POST",
      headers: {
        Origin: origin,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: form,
    },
  );
}

test("voice pipeline verifies user, membership, target and quota before isolation then Scribe v2", async () => {
  const { handler, calls } = fixture();
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    text: "Check terminal tightness.",
  });
  assert.deepEqual(
    calls.map((call) => call[0]),
    [
      "supabase",
      "auth",
      "qa_load_state",
      "qa_authorize_voice",
      "sdk",
      "isolate",
      "transcribe",
    ],
  );
  assert.deepEqual(
    calls.find((call) => call[0] === "qa_load_state"),
    ["qa_load_state", { p_walkdown_id: walkdownId }],
  );
  const isolation = calls.find((call) => call[0] === "isolate");
  const transcription = calls.find((call) => call[0] === "transcribe");
  assert.equal(isolation[1].audio.type, "audio/webm;codecs=opus");
  assert.equal(isolation[2].maxRetries, 0);
  assert.equal(transcription[1].modelId, "scribe_v2");
  assert.equal(transcription[1].file.name, "isolated.mp3");
  assert.deepEqual(
    [...new Uint8Array(await transcription[1].file.arrayBuffer())],
    [11, 22, 33],
  );
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "https://khuongnguyen99.github.io",
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("origin and preflight checks do not call any service", async () => {
  const { handler, calls } = fixture();
  const denied = await handler(request({ origin: "https://attacker.example" }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.has("access-control-allow-origin"), false);
  const allowed = await handler(
    new Request("https://example.supabase.co", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    }),
  );
  assert.equal(allowed.status, 204);
  assert.equal(calls.length, 0);
});

test("whole-walkdown voice scope uses the same membership and quota checks without adding a catalog record", async () => {
  const { handler, calls } = fixture();
  assert.equal(
    (await handler(request({ key: "walkdown:general" }))).status,
    200,
  );
  assert.deepEqual(
    calls.find((call) => call[0] === "qa_authorize_voice"),
    [
      "qa_authorize_voice",
      { p_walkdown_id: walkdownId, p_record_key: "walkdown:general" },
    ],
  );
  const denied = fixture({ nonmember: true });
  assert.equal(
    (await denied.handler(request({ key: "walkdown:general" }))).status,
    403,
  );
  assert.equal(
    denied.calls.some((call) => call[0] === "sdk"),
    false,
  );
  const unknown = fixture();
  assert.equal(
    (await unknown.handler(request({ key: "walkdown:other" }))).status,
    400,
  );
  assert.equal(
    unknown.calls.some((call) => call[0] === "sdk"),
    false,
  );
});

test("missing or invalid login, nonmembers and unknown records cannot start a paid request", async () => {
  for (const [options, req, status] of [
    [{}, { token: "" }, 401],
    [{ unauthorized: true }, {}, 401],
    [{ nonmember: true }, {}, 403],
    [{}, { key: "device:FAKE-0000" }, 400],
  ]) {
    const { handler, calls } = fixture(options);
    assert.equal((await handler(request(req))).status, status);
    assert.equal(
      calls.some((call) => call[0] === "sdk"),
      false,
    );
  }
});

test("unconfigured voice service and exhausted quota return friendly errors before the SDK", async () => {
  for (const [options, status] of [
    [{ noKey: true }, 503],
    [{ noMigration: true }, 503],
    [{ rateLimited: true }, 429],
  ]) {
    const { handler, calls } = fixture(options);
    const response = await handler(request());
    assert.equal(response.status, status);
    assert.match((await response.json()).error, /type your comment/i);
    assert.equal(
      calls.some((call) => call[0] === "sdk"),
      false,
    );
  }
});

test("unsupported, empty, oversized and excessive-duration audio is rejected before paid calls", async () => {
  for (const [options, status] of [
    [{ type: "image/svg+xml" }, 415],
    [{ size: 20 }, 422],
    [{ size: MAX_AUDIO_BYTES + 1 }, 413],
    [{ duration: 95000 }, 422],
    [{ duration: 4999 }, 422],
    [{ headers: { "Content-Length": String(MAX_AUDIO_BYTES + 70_000) } }, 413],
  ]) {
    const { handler, calls } = fixture();
    assert.equal((await handler(request(options))).status, status);
    assert.equal(
      calls.some((call) => call[0] === "sdk"),
      false,
    );
  }
});

test("provider short-audio errors produce useful guidance without leaking provider details or starting Scribe", async () => {
  for (const detail of [
    { code: "audio_too_short", message: "private-provider-detail" },
    { status: "invalid_audio_duration", message: "private-provider-detail" },
  ]) {
    const { handler, calls } = fixture({
      isolationError: { statusCode: 400, body: { detail } },
    });
    // The server still handles encoded audio shorter than its submitted wall-clock duration.
    const response = await handler(request({ duration: 5000 }));
    assert.equal(response.status, 422);
    const result = await response.json();
    assert.equal(result.code, "recording_too_short");
    assert.match(result.error, /at least 5 seconds/);
    assert.doesNotMatch(JSON.stringify(result), /private-provider-detail/);
    assert.equal(
      calls.some((call) => call[0] === "transcribe"),
      false,
    );
  }
});

test("isolation failure never falls back to transcribing the raw recording or leaks provider details", async () => {
  const { handler, calls } = fixture({
    isolationError: new Error("secret request data do-not-return"),
  });
  const response = await handler(request());
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /Noise removal failed/);
  assert.doesNotMatch(body, /do-not-return/);
  assert.equal(
    calls.some((call) => call[0] === "transcribe"),
    false,
  );
});

test("silence and timeouts provide retry guidance", async () => {
  const silence = await fixture({ noSpeech: true }).handler(request());
  assert.equal(silence.status, 422);
  assert.match((await silence.json()).error, /No clear speech/);
  const { handler, calls } = fixture({ hang: true, timeoutMs: 20 });
  const timeout = await handler(request());
  assert.equal(timeout.status, 504);
  assert.equal(
    calls.some((call) => call[0] === "transcribe"),
    false,
  );
});

test("voice requires one existing named skid and cannot use a mismatched state", async () => {
  for (const [options, input, status] of [
    [{}, { walkdown: null }, 400],
    [{}, { walkdown: "not-a-uuid" }, 400],
    [{}, { duplicateWalkdown: true }, 400],
    [{ wrongWalkdown: true }, {}, 403],
    [{ unnamed: true }, {}, 409],
  ]) {
    const { handler, calls } = fixture(options);
    assert.equal((await handler(request(input))).status, status);
    assert.equal(
      calls.some(
        (call) => call[0] === "sdk" || call[0] === "qa_authorize_voice",
      ),
      false,
    );
  }
});
