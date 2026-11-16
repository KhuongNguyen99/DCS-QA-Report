import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { matchDeviceLabels } from "./domain.js";
import { createOcrSession } from "./ocr.js";
import { normalizePhoto, validatePhotoMetadata } from "./photos.js";
import "./camera.css";

function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function cameraErrorMessage(error) {
  if (
    error?.name === "NotAllowedError" ||
    error?.name === "PermissionDeniedError"
  ) {
    return "Camera access was denied. You can still choose a photo from your device.";
  }
  if (
    error?.name === "NotFoundError" ||
    error?.name === "DevicesNotFoundError"
  ) {
    return "No camera was found. You can still choose a photo from your device.";
  }
  return "The camera could not start. You can still choose a photo from your device.";
}

function captureVideoFrame(video) {
  const width = video?.videoWidth;
  const height = video?.videoHeight;
  if (!width || !height)
    throw new Error("The camera is not ready yet. Try again in a moment.");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(video, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("The camera photo could not be captured.")),
      "image/jpeg",
      0.92,
    );
  });
}

export default function CameraDialog({
  target,
  devices = [],
  terminal = null,
  onMatch,
  onPhoto,
  onClose,
}) {
  const [mode, setMode] = useState(target ? "photo" : "scan");
  const [cameraError, setCameraError] = useState("");
  const [cameraReady, setCameraReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState("");
  const [scanError, setScanError] = useState("");
  const [photoError, setPhotoError] = useState("");
  const [matches, setMatches] = useState([]);
  const [recognized, setRecognized] = useState("");
  const [preview, setPreview] = useState(null);
  const [savedMessage, setSavedMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const dialogRef = useRef(null);
  const scanInputRef = useRef(null);
  const photoInputRef = useRef(null);
  const ocrRef = useRef(null);
  const mountedRef = useRef(true);
  const runRef = useRef(0);
  const captureRef = useRef(0);
  const capturePendingRef = useRef(false);
  const busyRef = useRef(false);
  const savingRef = useRef(false);
  const previewRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    ocrRef.current = createOcrSession((message) => {
      if (mountedRef.current) {
        const percentage = Number.isFinite(message.progress)
          ? ` ${Math.round(message.progress * 100)}%`
          : "";
        setOcrProgress(`${message.status || "Reading label"}${percentage}`);
      }
    });
    return () => {
      mountedRef.current = false;
      runRef.current += 1;
      captureRef.current += 1;
      ocrRef.current?.dispose();
      ocrRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(
        "Camera access is unavailable in this browser. You can choose a photo instead.",
      );
      return undefined;
    }
    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      })
      .then(async (stream) => {
        if (cancelled || !mountedRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          try {
            await video.play();
          } catch {
            /* The user can still use the upload fallback. */
          }
        }
        if (!cancelled && mountedRef.current) setCameraReady(true);
      })
      .catch((error) => {
        if (!cancelled && mountedRef.current)
          setCameraError(cameraErrorMessage(error));
      });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (target && mode === "scan" && recognized) setMode("photo");
  }, [target, recognized, mode]);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    dialog.querySelector("button")?.focus();
    return () => dialog.close();
  }, []);

  function closeDialog() {
    if (!mountedRef.current || savingRef.current) return;
    mountedRef.current = false;
    runRef.current += 1;
    captureRef.current += 1;
    ocrRef.current?.dispose();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    onClose();
  }

  function clearPreview() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreview(null);
    setPhotoError("");
  }

  function showPreview(blob, name) {
    validatePhotoMetadata(blob);
    clearPreview();
    const url = URL.createObjectURL(blob);
    previewRef.current = url;
    setPreview({ blob, name, url });
    setSavedMessage("");
  }

  async function readLabel(blob) {
    if (!mountedRef.current || busyRef.current) return;
    const run = ++runRef.current;
    busyRef.current = true;
    setBusy(true);
    setScanError("");
    setMatches([]);
    setRecognized("");
    setOcrProgress("Preparing image…");
    try {
      const image = await normalizePhoto(blob, "label.jpg");
      if (runRef.current !== run || !mountedRef.current) return;
      const text = await ocrRef.current.recognize(image.blob);
      if (runRef.current !== run || !mountedRef.current) return;
      const found = matchDeviceLabels(text, devices, terminal);
      if (!found.length) {
        setScanError(
          "No device label matched. Try a clearer photo or select the device from the report.",
        );
        return;
      }
      setMatches(found);
      const exactMatches = found.filter((item) => item.confidence === "exact");
      if (found.length === 1 && exactMatches.length === 1) {
        selectMatch(found[0]);
      }
    } catch (error) {
      if (
        runRef.current === run &&
        mountedRef.current &&
        error?.name !== "AbortError"
      ) {
        setScanError(
          errorMessage(
            error,
            "The label could not be read. Try another photo.",
          ),
        );
      }
    } finally {
      if (runRef.current === run && mountedRef.current) {
        busyRef.current = false;
        setBusy(false);
        setOcrProgress("");
      }
    }
  }

  function selectMatch(item) {
    setRecognized(item.deviceId);
    setMatches([]);
    setScanError("");
    onMatch(item.deviceId);
    setMode("photo");
  }

  function cancelRead() {
    runRef.current += 1;
    captureRef.current += 1;
    capturePendingRef.current = false;
    busyRef.current = false;
    ocrRef.current?.cancel();
    setBusy(false);
    setOcrProgress("");
    setScanError("Label reading cancelled.");
  }

  async function captureLabel() {
    if (capturePendingRef.current || busyRef.current) return;
    const capture = ++captureRef.current;
    capturePendingRef.current = true;
    setBusy(true);
    setOcrProgress("Capturing label…");
    setScanError("");
    try {
      const frame = await captureVideoFrame(videoRef.current);
      if (mountedRef.current && captureRef.current === capture)
        await readLabel(frame);
    } catch (error) {
      if (mountedRef.current && captureRef.current === capture) {
        setScanError(errorMessage(error, "The label could not be captured."));
      }
    } finally {
      if (mountedRef.current && captureRef.current === capture) {
        capturePendingRef.current = false;
        if (!busyRef.current) {
          setBusy(false);
          setOcrProgress("");
        }
      }
    }
  }

  async function capturePhoto() {
    try {
      const frame = await captureVideoFrame(videoRef.current);
      if (mountedRef.current)
        showPreview(frame, `${target?.key || "evidence"}.jpg`);
    } catch (error) {
      if (mountedRef.current)
        setPhotoError(errorMessage(error, "The photo could not be captured."));
    }
  }

  async function onScanFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await readLabel(file);
  }

  function onPhotoFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      showPreview(file, file.name);
    } catch (error) {
      setPhotoError(errorMessage(error, "Choose another photo."));
    }
  }

  async function savePhoto() {
    if (!preview || savingRef.current || !target) return;
    savingRef.current = true;
    setSaving(true);
    setPhotoError("");
    try {
      const photo = await normalizePhoto(preview.blob, preview.name);
      if (!mountedRef.current) return;
      await onPhoto(photo);
      if (!mountedRef.current) return;
      clearPreview();
      setSavedMessage("Photo saved. You can take another.");
    } catch (error) {
      if (mountedRef.current)
        setPhotoError(
          errorMessage(error, "The photo could not be saved. Try again."),
        );
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className="camera-overlay"
      aria-labelledby="camera-title"
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <section className="camera-dialog">
        <header className="camera-header">
          <div>
            <p className="camera-eyebrow">Camera</p>
            <h2 id="camera-title">
              {mode === "scan"
                ? "Scan a device label"
                : `Photo evidence: ${target?.title || target?.key || "device"}`}
            </h2>
          </div>
          <button
            type="button"
            className="camera-close"
            onClick={closeDialog}
            aria-label="Close camera"
            disabled={saving}
          >
            ×
          </button>
        </header>

        <div className="camera-body">
          {target && (
            <nav className="camera-tabs" aria-label="Camera task">
              <button
                type="button"
                className={mode === "scan" ? "is-active" : ""}
                onClick={() => {
                  setMode("scan");
                  setRecognized("");
                  clearPreview();
                }}
                disabled={saving}
              >
                Change device
              </button>
              <button
                type="button"
                className={mode === "photo" ? "is-active" : ""}
                onClick={() => setMode("photo")}
              >
                Photo evidence
              </button>
            </nav>
          )}
          {mode === "photo" && recognized && (
            <p className="camera-match" role="status">
              Recognized device {recognized}. Check the label before saving
              evidence.
            </p>
          )}
          <div className="camera-viewfinder">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              aria-label="Live camera preview"
            />
            {!cameraReady && (
              <p className="camera-empty">
                {cameraError || "Starting camera…"}
              </p>
            )}
          </div>
          {cameraReady && (
            <p className="camera-hint">
              {mode === "scan"
                ? "Fill the frame with the printed device label."
                : "Frame the equipment and any relevant detail."}
            </p>
          )}

          {mode === "scan" ? (
            <div className="camera-task">
              <div className="camera-actions">
                <button
                  type="button"
                  className="camera-primary"
                  onClick={captureLabel}
                  disabled={!cameraReady || busy}
                >
                  Read label
                </button>
                <button
                  type="button"
                  onClick={() => scanInputRef.current?.click()}
                  disabled={busy}
                >
                  Choose label photo
                </button>
                {busy && (
                  <button type="button" onClick={cancelRead}>
                    Cancel reading
                  </button>
                )}
                <input
                  ref={scanInputRef}
                  className="camera-hidden-input"
                  type="file"
                  accept="image/*"
                  onChange={onScanFile}
                  aria-label="Choose label photo"
                />
              </div>
              {busy && (
                <p className="camera-progress" role="status">
                  {ocrProgress || "Reading label…"}
                </p>
              )}
              {scanError && (
                <p className="camera-error" role="alert">
                  {scanError}
                </p>
              )}
              {matches.length > 0 && (
                <div className="camera-results">
                  <h3>Choose the matching device</h3>
                  <p>Check the label before continuing.</p>
                  <div className="camera-result-list">
                    {matches.map((item) => (
                      <button
                        type="button"
                        key={item.deviceId}
                        onClick={() => selectMatch(item)}
                      >
                        <strong>{item.deviceId}</strong>
                        <span>
                          {item.confidence === "exact"
                            ? "Exact match"
                            : "Possible match"}{" "}
                          · {item.matchedText}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="camera-task">
              <div className="camera-actions">
                <button
                  type="button"
                  className="camera-primary"
                  onClick={capturePhoto}
                  disabled={!cameraReady || saving}
                >
                  Take photo
                </button>
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  disabled={saving}
                >
                  Choose photo
                </button>
                <input
                  ref={photoInputRef}
                  className="camera-hidden-input"
                  type="file"
                  accept="image/*"
                  onChange={onPhotoFile}
                  aria-label="Choose evidence photo"
                />
              </div>
              {preview && (
                <div className="camera-preview">
                  <img src={preview.url} alt="Evidence photo to save" />
                  <div className="camera-actions">
                    <button
                      type="button"
                      className="camera-primary"
                      onClick={savePhoto}
                      disabled={saving}
                    >
                      {saving ? "Saving photo…" : "Save photo"}
                    </button>
                    <button
                      type="button"
                      onClick={clearPreview}
                      disabled={saving}
                    >
                      Retake
                    </button>
                  </div>
                </div>
              )}
              {savedMessage && (
                <p className="camera-success" role="status">
                  {savedMessage}
                </p>
              )}
              {photoError && (
                <p className="camera-error" role="alert">
                  {photoError}
                </p>
              )}
            </div>
          )}
        </div>
      </section>
    </dialog>,
    document.body,
  );
}
