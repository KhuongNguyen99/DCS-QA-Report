import { useEffect, useRef, useState } from "react";
import {
  microphoneError,
  startVoiceRecording,
  transcribeVoice,
} from "./voice-client.js";
import "./voice.css";

export default function VoiceComment({
  disabled = false,
  onTranscript,
  config,
  backend,
  recordKey,
}) {
  const [phase, setPhase] = useState("idle");
  const [clip, setClip] = useState(null);
  const [playbackUrl, setPlaybackUrl] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const capture = useRef(null);
  const request = useRef(null);
  const generation = useRef(0);
  const supported = Boolean(
    globalThis.navigator?.mediaDevices?.getUserMedia &&
    globalThis.MediaRecorder,
  );

  function release() {
    generation.current += 1;
    capture.current?.cancel();
    capture.current = null;
    request.current?.abort();
    request.current = null;
  }

  function cancel() {
    release();
    setPhase("idle");
    setClip(null);
    setError("");
    setNotice("");
    setElapsed(0);
  }

  useEffect(() => {
    cancel();
    return release;
    // Record changes/unmount must never deliver speech into another item's draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordKey, backend?.walkdownId]);

  useEffect(() => {
    if (disabled) cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  useEffect(() => {
    if (!clip) {
      setPlaybackUrl("");
      return undefined;
    }
    const url = URL.createObjectURL(clip.blob);
    setPlaybackUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [clip]);

  async function record() {
    release();
    const current = generation.current;
    setClip(null);
    setError("");
    setNotice("");
    setElapsed(0);
    setPhase("permission");
    try {
      const recorder = await startVoiceRecording({
        onTick: (value) => {
          if (current === generation.current) setElapsed(value);
        },
        onStop: (value) => {
          if (current !== generation.current) return;
          capture.current = null;
          setClip(value);
          setPhase("ready");
        },
        onError: (failure) => {
          if (current !== generation.current) return;
          capture.current = null;
          setError(microphoneError(failure));
          setPhase("idle");
        },
      });
      if (current !== generation.current) {
        recorder.cancel();
        return;
      }
      capture.current = recorder;
      setPhase("recording");
    } catch (failure) {
      if (current === generation.current) {
        setError(microphoneError(failure));
        setPhase("idle");
      }
    }
  }

  async function transcribe() {
    const current = generation.current;
    const controller = new AbortController();
    request.current = controller;
    setError("");
    setNotice("");
    setPhase("transcribing");
    try {
      const text = await transcribeVoice({
        config,
        backend,
        recordKey,
        clip,
        signal: controller.signal,
      });
      if (current !== generation.current || controller.signal.aborted) return;
      onTranscript(text);
      setClip(null);
      setPhase("idle");
      setNotice(
        "Transcript added to the draft. Review it, then add your comment.",
      );
    } catch (failure) {
      if (current !== generation.current || controller.signal.aborted) return;
      setError(failure.message || "Transcription failed. Try again.");
      setPhase("ready");
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  const busy = phase === "permission" || phase === "transcribing";
  return (
    <div className="voice-comment">
      <div className="voice-comment__actions">
        {(phase === "idle" || phase === "ready") && (
          <button
            type="button"
            className="voice-comment__button"
            onClick={record}
            disabled={disabled || !supported}
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <rect x="9" y="2" width="6" height="13" rx="3" />
              <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
            </svg>
            {clip ? "Record again" : "Record voice comment"}
          </button>
        )}
        {phase === "recording" && (
          <button
            type="button"
            className="voice-comment__button voice-comment__stop"
            onClick={() => capture.current?.stop()}
          >
            <span aria-hidden="true">■</span> Stop ·{" "}
            {Math.floor(elapsed / 1000)}s / 90s
          </button>
        )}
        {phase === "ready" && (
          <button
            type="button"
            className="voice-comment__button"
            onClick={transcribe}
            disabled={disabled}
          >
            Transcribe recording
          </button>
        )}
        {phase !== "idle" && (
          <button
            type="button"
            className="voice-comment__button voice-comment__cancel"
            onClick={cancel}
          >
            Cancel
          </button>
        )}
      </div>
      {playbackUrl && (
        <audio
          className="voice-comment__playback"
          controls
          src={playbackUrl}
          aria-label="Recorded comment preview"
        />
      )}
      <div aria-live="polite" className="voice-comment__status">
        {phase === "permission" && "Waiting for microphone permission…"}
        {phase === "recording" &&
          "Recording your comment. Stops automatically at 90 seconds."}
        {phase === "transcribing" &&
          "Removing background noise, then transcribing…"}
        {notice}
      </div>
      {error && (
        <p className="voice-comment__error" role="alert">
          {error}
        </p>
      )}
      {!supported && (
        <p className="voice-comment__help">
          Microphone recording is unavailable here. You can type your comment.
        </p>
      )}
      {!busy && !notice && (
        <p className="voice-comment__help">
          Review the recording before sending it to ElevenLabs for noise removal
          and transcription. Edit the text before adding the comment.
        </p>
      )}
    </div>
  );
}
