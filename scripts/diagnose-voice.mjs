// Manual service check with synthetic audio only. Never prints credentials or QA audio.
import { createVoiceSdkClient } from "../supabase/functions/transcribe-comment/sdk-client.js";
import { readFile } from "node:fs/promises";

const env = (name) =>
  globalThis.Deno ? Deno.env.get(name) : process.env[name];
const key = env("ELEVENLABS_API_KEY");
if (!key) throw new Error("The server voice key is missing.");

// Offline synthesized speech: "Check the wiring at terminal A", padded to 6 seconds.
const bytes = await readFile(
  new URL("../tests/fixtures/voice-check.wav", import.meta.url),
);

let stage = "sdk-import";
try {
  const client = createVoiceSdkClient(key);
  stage = "audio-isolation";
  const stream = await client.audioIsolation.convert(
    {
      audio: new File([bytes], "synthetic-test.wav", { type: "audio/wav" }),
      fileFormat: "other",
    },
    { maxRetries: 0, timeoutInSeconds: 50 },
  );
  const isolated = await new Response(stream).arrayBuffer();
  console.log(
    JSON.stringify({
      check: "provider-isolation",
      ok: true,
      outputBytes: isolated.byteLength,
    }),
  );
  stage = "speech-to-text";
  const result = await client.speechToText.convert(
    {
      file: new File([isolated], "isolated.mp3", { type: "audio/mpeg" }),
      modelId: "scribe_v2",
      tagAudioEvents: false,
      diarize: false,
      useMultiChannel: false,
      webhook: false,
    },
    { maxRetries: 0, timeoutInSeconds: 50 },
  );
  if (!/wiring|terminal/i.test(result.text || ""))
    throw new Error("Synthetic speech was not recognized.");
  console.log(
    JSON.stringify({
      check: "provider-transcription",
      ok: true,
      recognizedTestSpeech: true,
    }),
  );
} catch (error) {
  const detail = error?.body?.detail;
  const safe = (value) =>
    typeof value === "string"
      ? value.replaceAll(key, "[redacted]").slice(0, 500)
      : undefined;
  console.log(
    JSON.stringify({
      check: "provider-isolation",
      ok: false,
      stage,
      name: safe(error?.name),
      status: error?.statusCode,
      code: safe(detail?.status),
      detail: safe(typeof detail === "string" ? detail : detail?.message),
      message: safe(error?.message),
    }),
  );
  if (globalThis.Deno) Deno.exit(1);
  else process.exitCode = 1;
}
