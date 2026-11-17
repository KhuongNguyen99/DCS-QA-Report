export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_AUDIO_BYTES + 64 * 1024;
const AUDIO_TYPES = new Set(["audio/webm", "audio/mp4", "audio/ogg"]);

class VoiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function allowedOrigin(origin) {
  return (
    origin === "https://khuongnguyen99.github.io" ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "")
  );
}

function abortable(promise, signal) {
  if (signal.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readBytes(stream, limit, signal) {
  if (!stream?.getReader)
    throw new VoiceError(
      422,
      "empty_audio",
      "The recording is empty. Record your comment again.",
    );
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > limit)
        throw new VoiceError(
          413,
          "audio_too_large",
          "The recording is too large. Record a shorter comment.",
        );
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Dependencies keep auth and the paid SDK pipeline testable without real calls. */
export function createVoiceHandler({
  getEnv,
  createSupabaseClient,
  createElevenLabsClient,
  timeoutMs = 115_000,
}) {
  const inFlight = new Set();
  return async function handle(request) {
    const origin = request.headers.get("origin");
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
      ...(allowedOrigin(origin)
        ? {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Headers":
              "authorization, apikey, content-type, x-client-info",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
          }
        : {}),
    };
    const json = (status, body) =>
      new Response(JSON.stringify(body), { status, headers });
    if (!allowedOrigin(origin))
      return json(403, {
        code: "origin_denied",
        error: "This app origin is not allowed.",
      });
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (request.method !== "POST")
      return json(405, {
        code: "method_not_allowed",
        error: "Use POST to transcribe a recording.",
      });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    let busyUser;
    let stage = "authentication";
    try {
      const authorization = request.headers.get("authorization") || "";
      if (!/^Bearer\s+\S+$/i.test(authorization))
        throw new VoiceError(
          401,
          "sign_in_required",
          "Sign in before transcribing a comment.",
        );
      const contentType = request.headers.get("content-type") || "";
      if (!contentType.toLowerCase().startsWith("multipart/form-data;"))
        throw new VoiceError(
          415,
          "invalid_audio",
          "Send a microphone recording as multipart audio.",
        );
      const declaredSize = Number(request.headers.get("content-length"));
      if (declaredSize > MAX_REQUEST_BYTES)
        throw new VoiceError(
          413,
          "audio_too_large",
          "The recording must be no larger than 10 MB.",
        );
      const url = getEnv("SUPABASE_URL");
      const key = getEnv("SUPABASE_ANON_KEY");
      if (!url || !key)
        throw new VoiceError(
          503,
          "not_configured",
          "Voice comments are not configured yet. You can type your comment.",
        );
      const supabase = createSupabaseClient({
        url,
        key,
        authorization,
        signal: controller.signal,
      });
      const userResult = await abortable(
        supabase.auth.getUser(authorization.replace(/^Bearer\s+/i, "")),
        controller.signal,
      );
      if (userResult.error || !userResult.data?.user?.id)
        throw new VoiceError(
          401,
          "sign_in_required",
          "Your session expired. Sign in again before transcribing.",
        );
      if (inFlight.has(userResult.data.user.id))
        throw new VoiceError(
          409,
          "already_processing",
          "A recording is already being processed. Wait for it to finish.",
        );
      busyUser = userResult.data.user.id;
      inFlight.add(busyUser);
      const body = await readBytes(
        request.body,
        MAX_REQUEST_BYTES,
        controller.signal,
      );
      let form;
      try {
        form = await new Response(body, {
          headers: { "Content-Type": contentType },
        }).formData();
      } catch {
        throw new VoiceError(
          400,
          "invalid_request",
          "The recording could not be read. Record it again.",
        );
      }
      const audio = form.get("audio");
      const recordKey = form.get("record_key");
      const submittedWalkdownId = form.get("walkdown_id");
      if (
        form.getAll("walkdown_id").length !== 1 ||
        typeof submittedWalkdownId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          submittedWalkdownId,
        )
      ) {
        throw new VoiceError(
          400,
          "invalid_walkdown",
          "Choose a named skid walkdown before transcribing.",
        );
      }
      const walkdownId = submittedWalkdownId.toLowerCase();
      const state = await abortable(
        supabase.rpc("qa_load_state", { p_walkdown_id: walkdownId }),
        controller.signal,
      );
      if (
        state.error ||
        !state.data?.inspector ||
        state.data.inspector.id !== userResult.data.user.id ||
        state.data.project?.walkdownId !== walkdownId
      ) {
        throw new VoiceError(
          403,
          "inspector_required",
          "Choose an accessible skid walkdown and sign in as an approved inspector.",
        );
      }
      if (state.data.project.nameRequired)
        throw new VoiceError(
          409,
          "skid_name_required",
          "Name this skid before recording inspection comments.",
        );
      const durationMs = Number(form.get("duration_ms"));
      if (
        form.getAll("audio").length !== 1 ||
        !(audio instanceof Blob) ||
        !AUDIO_TYPES.has(audio.type.split(";")[0].toLowerCase())
      ) {
        throw new VoiceError(
          415,
          "invalid_audio",
          "Use an audio WebM, MP4, or Ogg microphone recording.",
        );
      }
      if (audio.size < 100)
        throw new VoiceError(
          422,
          "empty_audio",
          "The recording is too short. Speak your comment and try again.",
        );
      if (audio.size > MAX_AUDIO_BYTES)
        throw new VoiceError(
          413,
          "audio_too_large",
          "The recording must be no larger than 10 MB.",
        );
      if (
        !Number.isFinite(durationMs) ||
        durationMs < 5_000 ||
        durationMs > 90_500
      ) {
        throw new VoiceError(
          422,
          "invalid_duration",
          "Record a comment between 5 and 90 seconds long.",
        );
      }
      if (
        typeof recordKey !== "string" ||
        (recordKey !== "walkdown:general" &&
          !state.data.records?.some((record) => record.key === recordKey))
      ) {
        throw new VoiceError(
          400,
          "invalid_record",
          "Choose an inspection target from the project schedule.",
        );
      }
      const apiKey = getEnv("ELEVENLABS_API_KEY");
      if (!apiKey)
        throw new VoiceError(
          503,
          "not_configured",
          "Voice comments are not configured yet. You can type your comment.",
        );
      const permitted = await abortable(
        supabase.rpc("qa_authorize_voice", {
          p_walkdown_id: walkdownId,
          p_record_key: recordKey,
        }),
        controller.signal,
      );
      if (permitted.error)
        throw new VoiceError(
          503,
          "not_configured",
          "Voice comments need administrator setup. You can type your comment.",
        );
      if (permitted.data !== true)
        throw new VoiceError(
          429,
          "rate_limited",
          "You have reached the voice comment limit. Wait a few minutes or type your comment.",
        );
      const eleven = createElevenLabsClient(apiKey);
      const options = {
        timeoutInSeconds: 50,
        maxRetries: 0,
        abortSignal: controller.signal,
      };
      stage = "isolation";
      const stream = await abortable(
        eleven.audioIsolation.convert({ audio, fileFormat: "other" }, options),
        controller.signal,
      );
      const isolated = await readBytes(
        stream,
        20 * 1024 * 1024,
        controller.signal,
      );
      if (!isolated.length)
        throw new VoiceError(
          422,
          "no_speech",
          "No clear speech was found. Record again closer to the microphone.",
        );
      stage = "transcription";
      const result = await abortable(
        eleven.speechToText.convert(
          {
            file: new File([isolated], "isolated.mp3", { type: "audio/mpeg" }),
            modelId: "scribe_v2",
            tagAudioEvents: false,
            diarize: false,
            useMultiChannel: false,
            webhook: false,
          },
          options,
        ),
        controller.signal,
      );
      const text = typeof result.text === "string" ? result.text.trim() : "";
      const onlyEvents =
        Array.isArray(result.words) &&
        !result.words.some((word) => word.type === "word" && word.text?.trim());
      if (!text || onlyEvents)
        throw new VoiceError(
          422,
          "no_speech",
          "No clear speech was found. Record again closer to the microphone.",
        );
      if (text.length > 4000)
        throw new VoiceError(
          422,
          "transcript_too_long",
          "That comment is too long. Record a shorter comment.",
        );
      return json(200, { text });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError")
        return json(504, {
          code: "timed_out",
          error: "Voice processing took too long. Try a shorter recording.",
        });
      if (error instanceof VoiceError)
        return json(error.status, { code: error.code, error: error.message });
      // Provider errors may contain request details. Never log or return them.
      const detail = error?.body?.detail;
      if (
        detail?.code === "audio_too_short" ||
        detail?.status === "invalid_audio_duration"
      )
        return json(422, {
          code: "recording_too_short",
          error:
            "The audio is too short for noise removal. Record at least 5 seconds and try again.",
        });
      if (error?.statusCode === 429)
        return json(429, {
          code: "busy",
          error: "The voice service is busy. Wait a moment and try again.",
        });
      if ([401, 403].includes(error?.statusCode))
        return json(503, {
          code: "not_configured",
          error:
            "Voice comments need administrator setup. You can type your comment.",
        });
      return json(502, {
        code: "processing_failed",
        error:
          stage === "isolation"
            ? "Noise removal failed. Record again or retry; transcription was not started."
            : "The recording could not be transcribed. Retry or type your comment.",
      });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      if (busyUser) inFlight.delete(busyUser);
    }
  };
}
