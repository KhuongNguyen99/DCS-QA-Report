export const MAX_RECORDING_MS = 90_000;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const TYPES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

export function microphoneError(error) {
  if (["NotAllowedError", "SecurityError"].includes(error?.name))
    return "Microphone access was blocked. Allow microphone access in your browser, then try again.";
  if (error?.name === "NotFoundError")
    return "No microphone was found. Connect one or type your comment.";
  if (error?.name === "NotReadableError")
    return "The microphone is busy. Close other apps using it and try again.";
  return (
    error?.message ||
    "The microphone could not record. You can type your comment instead."
  );
}

/** All capture resources are owned here and released on stop, error, or cancel. */
export async function startVoiceRecording({
  onStop,
  onError,
  onTick = () => {},
  mediaDevices = globalThis.navigator?.mediaDevices,
  Recorder = globalThis.MediaRecorder,
  now = () => Date.now(),
  timers = globalThis,
} = {}) {
  if (!mediaDevices?.getUserMedia || !Recorder)
    throw new Error(
      "Voice recording is unavailable in this browser. Use a current browser on HTTPS, or type your comment.",
    );
  const stream = await mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    video: false,
  });
  let recorder;
  let ended = false;
  let cancelled = false;
  let durationTimer;
  let tickTimer;
  let bytes = 0;
  const chunks = [];
  const startedAt = now();
  const cleanup = () => {
    timers.clearTimeout(durationTimer);
    timers.clearInterval(tickTimer);
    stream.getTracks().forEach((track) => track.stop());
  };
  const finishError = (error) => {
    if (ended) return;
    ended = true;
    cleanup();
    if (recorder?.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        /* Already stopped. */
      }
    }
    onError?.(error);
  };
  try {
    const mimeType = TYPES.find((type) => Recorder.isTypeSupported?.(type));
    recorder = new Recorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 64_000,
    });
    recorder.ondataavailable = (event) => {
      if (ended || cancelled || !event.data?.size) return;
      bytes += event.data.size;
      if (bytes > MAX_AUDIO_BYTES)
        return finishError(
          new Error("The recording reached 10 MB. Record a shorter comment."),
        );
      chunks.push(event.data);
    };
    recorder.onerror = (event) =>
      finishError(
        event.error ||
          new Error("Recording stopped unexpectedly. Please record again."),
      );
    recorder.onstop = () => {
      cleanup();
      if (ended || cancelled) return;
      ended = true;
      const durationMs = Math.min(now() - startedAt, MAX_RECORDING_MS);
      const type = recorder.mimeType || chunks[0]?.type || "audio/webm";
      const blob = new Blob(chunks, { type });
      if (blob.size < 100 || durationMs < 300)
        onError?.(
          new Error(
            "The recording is too short. Speak your comment and try again.",
          ),
        );
      else onStop?.({ blob, durationMs });
    };
    recorder.start(1000);
    durationTimer = timers.setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, MAX_RECORDING_MS);
    tickTimer = timers.setInterval(
      () => onTick(Math.min(now() - startedAt, MAX_RECORDING_MS)),
      250,
    );
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    stop() {
      if (!ended && recorder.state !== "inactive") recorder.stop();
    },
    cancel() {
      cancelled = true;
      ended = true;
      cleanup();
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* Already stopped. */
        }
      }
    },
  };
}

export async function transcribeVoice({
  config,
  backend,
  recordKey,
  clip,
  signal,
  fetchImpl = fetch,
}) {
  if (!clip?.blob || clip.blob.size > MAX_AUDIO_BYTES || clip.blob.size < 100)
    throw new Error("Record a comment no larger than 10 MB.");
  const session = await backend?.getSession();
  if (!session?.access_token)
    throw new Error("Sign in before transcribing your comment.");
  if (!backend.walkdownId)
    throw new Error(
      "Choose a named skid report before transcribing your comment.",
    );
  if (!config?.url || !config?.key)
    throw new Error("The shared project connection is missing.");
  const type = clip.blob.type.split(";")[0];
  const extension =
    type === "audio/mp4" ? "m4a" : type === "audio/ogg" ? "ogg" : "webm";
  const form = new FormData();
  form.append("audio", clip.blob, `comment.${extension}`);
  form.append("record_key", recordKey);
  form.append("walkdown_id", backend.walkdownId);
  form.append("duration_ms", String(clip.durationMs));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 125_000);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const response = await fetchImpl(
      `${config.url.replace(/\/$/, "")}/functions/v1/transcribe-comment`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: config.key,
        },
        body: form,
        signal: controller.signal,
      },
    );
    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const fallback =
        response.status === 404 || response.status === 503
          ? "Voice comments are not configured yet. You can type your comment."
          : response.status === 401
            ? "Your session expired. Sign in again before transcribing."
            : "The recording could not be transcribed. Retry or type your comment.";
      throw new Error(typeof data.error === "string" ? data.error : fallback);
    }
    if (typeof data.text !== "string" || !data.text.trim())
      throw new Error(
        "No clear speech was found. Record again closer to the microphone.",
      );
    return data.text.trim();
  } catch (error) {
    if (error.name === "AbortError" && !signal?.aborted)
      throw new Error(
        "Voice processing took too long. Try a shorter recording.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
