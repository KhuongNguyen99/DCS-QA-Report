import test from "node:test";
import assert from "node:assert/strict";
import {
  startVoiceRecording,
  transcribeVoice,
  MAX_RECORDING_MS,
  MAX_AUDIO_BYTES,
  MIN_RECORDING_MS,
} from "../src/voice-client.js";

function captureFixture(overrides = {}) {
  const events = { stoppedTracks: 0, clips: [], errors: [], timers: [] };
  let now = 0;
  class Recorder {
    static isTypeSupported(type) {
      return type === "audio/mp4";
    }
    constructor(stream, options) {
      this.mimeType = options.mimeType;
      this.state = "inactive";
      events.recorder = this;
      if (overrides.constructorError) throw new Error("Cannot start recorder");
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.onstop?.();
    }
  }
  const options = {
    mediaDevices: {
      async getUserMedia(request) {
        events.constraints = request;
        return {
          getTracks: () => [
            {
              stop() {
                events.stoppedTracks++;
              },
            },
          ],
        };
      },
    },
    Recorder,
    now: () => now,
    timers: {
      setTimeout(fn, ms) {
        events.timers.push({ fn, ms });
        return 1;
      },
      setInterval() {
        return 2;
      },
      clearTimeout() {},
      clearInterval() {},
    },
    onStop: (clip) => events.clips.push(clip),
    onError: (error) => events.errors.push(error),
  };
  return {
    events,
    options,
    setTime: (value) => {
      now = value;
    },
  };
}

test("microphone capture uses audio only, supports MP4 and releases tracks on normal stop", async () => {
  const { events, options, setTime } = captureFixture();
  const recording = await startVoiceRecording(options);
  assert.equal(events.constraints.video, false);
  events.recorder.ondataavailable({
    data: new Blob([new Uint8Array(200)], { type: "audio/mp4" }),
  });
  setTime(6000);
  recording.stop();
  assert.equal(events.stoppedTracks, 1);
  assert.equal(events.clips[0].blob.type, "audio/mp4");
  assert.equal(events.clips[0].durationMs, 6000);
});

test("cancel stops the microphone and prevents late callbacks from delivering a clip", async () => {
  const { events, options, setTime } = captureFixture();
  const recording = await startVoiceRecording(options);
  setTime(3000);
  recording.cancel();
  events.recorder.ondataavailable({
    data: new Blob([new Uint8Array(200)], { type: "audio/mp4" }),
  });
  events.recorder.onstop();
  assert.ok(events.stoppedTracks >= 1);
  assert.equal(events.clips.length, 0);
});

test("short recordings stop the microphone and cannot reach paid transcription", async () => {
  const { events, options, setTime } = captureFixture();
  const recording = await startVoiceRecording(options);
  events.recorder.ondataavailable({
    data: new Blob([new Uint8Array(200)], { type: "audio/mp4" }),
  });
  setTime(MIN_RECORDING_MS - 1);
  recording.stop();
  assert.equal(events.clips.length, 0);
  assert.equal(events.stoppedTracks, 1);
  assert.match(events.errors[0].message, /at least 5 seconds/);
  await assert.rejects(
    transcribeVoice({
      clip: {
        blob: new Blob([new Uint8Array(200)], { type: "audio/webm" }),
        durationMs: 4600,
      },
      backend: {
        getSession() {
          throw new Error("Must reject before reading a session");
        },
      },
      fetchImpl() {
        throw new Error("Must not send short audio");
      },
    }),
    /between 5 and 90 seconds/,
  );
});

test("construction failure, recording error and size limits release microphone tracks", async () => {
  const failed = captureFixture({ constructorError: true });
  await assert.rejects(startVoiceRecording(failed.options), /Cannot start/);
  assert.equal(failed.events.stoppedTracks, 1);
  for (const trigger of ["error", "size"]) {
    const { events, options } = captureFixture();
    await startVoiceRecording(options);
    if (trigger === "error")
      events.recorder.onerror({ error: new Error("Disconnected") });
    else
      events.recorder.ondataavailable({ data: { size: MAX_AUDIO_BYTES + 1 } });
    assert.ok(events.stoppedTracks >= 1);
    assert.equal(events.errors.length, 1);
    assert.equal(events.clips.length, 0);
  }
});

test("recording stops automatically at 90 seconds", async () => {
  const { events, options, setTime } = captureFixture();
  await startVoiceRecording(options);
  events.recorder.ondataavailable({
    data: new Blob([new Uint8Array(200)], { type: "audio/mp4" }),
  });
  setTime(MAX_RECORDING_MS);
  events.timers.find((timer) => timer.ms === MAX_RECORDING_MS).fn();
  assert.equal(events.recorder.state, "inactive");
  assert.equal(events.clips[0].durationMs, MAX_RECORDING_MS);
  assert.equal(events.stoppedTracks, 1);
});

test("browser sends only user JWT, public key and recording and returns an editable transcript", async () => {
  let sent;
  const text = await transcribeVoice({
    config: {
      url: "https://example.supabase.co",
      key: "sb_publishable_public",
    },
    backend: {
      walkdownId: "11111111-1111-4111-8111-111111111111",
      async getSession() {
        return { access_token: "user-jwt" };
      },
    },
    recordKey: "device:V-3541",
    clip: {
      blob: new Blob([new Uint8Array(200)], { type: "audio/mp4" }),
      durationMs: 6000,
    },
    async fetchImpl(url, options) {
      sent = { url, options };
      return Response.json({ text: " Review this comment. " });
    },
  });
  assert.equal(text, "Review this comment.");
  assert.match(sent.url, /\/functions\/v1\/transcribe-comment$/);
  assert.deepEqual(sent.options.headers, {
    Authorization: "Bearer user-jwt",
    apikey: "sb_publishable_public",
  });
  assert.equal(sent.options.body.get("audio").name, "comment.m4a");
  assert.equal(sent.options.body.get("record_key"), "device:V-3541");
  assert.equal(
    sent.options.body.get("walkdown_id"),
    "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(sent.options.body.get("duration_ms"), "6000");
});

test("missing session cannot send audio and missing deployment has a readable setup message", async () => {
  const args = {
    config: { url: "https://example.supabase.co", key: "public" },
    recordKey: "device:V-3541",
    clip: {
      blob: new Blob([new Uint8Array(200)], { type: "audio/webm" }),
      durationMs: 6000,
    },
  };
  await assert.rejects(
    transcribeVoice({
      ...args,
      backend: { getSession: async () => null },
      fetchImpl() {
        throw new Error("Must not send");
      },
    }),
    /Sign in/,
  );
  await assert.rejects(
    transcribeVoice({
      ...args,
      backend: {
        walkdownId: "11111111-1111-4111-8111-111111111111",
        getSession: async () => ({ access_token: "user-jwt" }),
      },
      fetchImpl: async () => new Response("Not deployed", { status: 404 }),
    }),
    /not configured yet/,
  );
});

test("a voice recording cannot be submitted without a selected skid report", async () => {
  await assert.rejects(
    transcribeVoice({
      config: { url: "https://example.supabase.co", key: "public" },
      backend: { getSession: async () => ({ access_token: "user-jwt" }) },
      recordKey: "device:V-3541",
      clip: {
        blob: new Blob([new Uint8Array(200)], { type: "audio/webm" }),
        durationMs: 6000,
      },
      fetchImpl() {
        throw new Error("Must not send unscoped audio");
      },
    }),
    /Choose a named skid report/,
  );
});
