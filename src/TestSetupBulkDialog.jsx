import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icons.jsx";
import { normalizePhoto, validatePhotoMetadata } from "./photos.js";
import "./bulk-photos.css";
import "./test-setup-bulk.css";

const MAX_PHOTOS = 30;
const MAX_CAPTION = 1000;
const clampSlots = (value) => Number.isFinite(value)
  ? Math.max(0, Math.min(MAX_PHOTOS, Math.floor(value))) : 0;
const photoCount = (count) => `${count} photo${count === 1 ? "" : "s"}`;

/** Review local images and captions; onPhoto resolves after both are saved. */
export default function TestSetupBulkDialog({
  runName, skidName, onPhoto, onClose, readOnly = false, pending = false,
  remainingSlots = MAX_PHOTOS, onDirtyChange, scopeKey,
}) {
  const id = useId();
  const [items, setItems] = useState([]);
  const [rejected, setRejected] = useState([]);
  const [prepared, setPrepared] = useState(null);
  const [photoError, setPhotoError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState("");
  const [zoomed, setZoomed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [retry, setRetry] = useState(0);
  const dialogRef = useRef(null);
  const fileRef = useRef(null);
  const chooseRef = useRef(null);
  const captionRef = useRef(null);
  const imageRef = useRef(null);
  const completeRef = useRef(null);
  const nextId = useRef(0);
  const mounted = useRef(false);
  const savingRef = useRef(false);
  const composing = useRef(false);
  const prepareRun = useRef(0);
  const openingScope = useRef(scopeKey);
  const openingSlots = useRef(clampSlots(remainingSlots));
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const permissions = useRef(null);
  permissions.current = { readOnly, pending, scopeKey, remainingSlots };
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;

  const current = items.find((item) => item.status === "pending") || null;
  const currentId = current?.id ?? null;
  const quarterTurns = current?.quarterTurns ?? 0;
  const rotationVersion = current?.rotationVersion ?? 0;
  const savedCount = items.filter((item) => item.status === "saved").length;
  const skippedCount = items.filter((item) => item.status === "skipped").length;
  const pendingCount = items.length - savedCount - skippedCount;
  const unsavedCount = pendingCount + skippedCount;
  // Parent capacity may update before or after onPhoto resolves. Do not subtract
  // our saved count from that live value a second time, or trust a stale refresh.
  const availableSlots = Math.min(clampSlots(remainingSlots), openingSlots.current - savedCount);
  const selectionSlots = Math.max(0, availableSlots - unsavedCount);
  const scopeChanged = scopeKey !== openingScope.current;
  const blocked = readOnly || pending || scopeChanged;
  const ready = prepared?.id === currentId && prepared.rotationVersion === rotationVersion
    && prepared.run === prepareRun.current ? prepared : null;
  const preparationError = photoError?.id === currentId ? photoError.text : "";
  const error = saveError?.id === currentId ? saveError.text : "";
  const dirty = unsavedCount > 0 || saving;
  const reportName = runName || "Selected test report";

  function updateItems(update) {
    // Keep consecutive events and asynchronous save completion on the same queue.
    const next = update(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  }

  function cannotWrite() {
    const access = permissions.current;
    return access.readOnly || access.pending || access.scopeKey !== openingScope.current;
  }

  function slotsNow() {
    const locallySaved = itemsRef.current.filter((item) => item.status === "saved").length;
    return Math.min(clampSlots(permissions.current.remainingSlots), openingSlots.current - locallySaved);
  }

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    chooseRef.current?.focus();
    return () => {
      mounted.current = false;
      ++prepareRun.current;
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus?.();
    };
  }, []);

  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);

  useEffect(() => () => dirtyCallback.current?.(false), []);

  useEffect(() => {
    if (!dirty) return undefined;
    const preventLoss = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty]);

  useEffect(() => {
    setZoomed(false);
    composing.current = false;
    if (currentId !== null) captionRef.current?.focus();
    else completeRef.current?.focus();
  }, [currentId]);

  useEffect(() => {
    const run = ++prepareRun.current;
    let cancelled = false;
    let previewUrl;
    const isCurrent = () => !cancelled && mounted.current && prepareRun.current === run;
    setPrepared(null);
    setPhotoError(null);
    setSaveError(null);
    if (!current) return undefined;

    async function prepare() {
      try {
        // The rest of the queue remains File references, not decoded image data.
        const photo = await normalizePhoto(current.file, current.name, { quarterTurns });
        if (!isCurrent()) return;
        previewUrl = URL.createObjectURL(photo.blob);
        setPrepared({ id: currentId, rotationVersion, run, photo, url: previewUrl });
      } catch (cause) {
        if (isCurrent()) setPhotoError({
          id: currentId,
          text: cause.message || "This image could not be opened. Try again or skip it for now.",
        });
      }
    }
    prepare();
    return () => {
      cancelled = true;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [currentId, quarterTurns, rotationVersion, retry]);

  useEffect(() => {
    if (!saving && !pending && currentId !== null) captionRef.current?.focus();
  }, [saving, pending, currentId]);

  function addFiles(files) {
    if (savingRef.current || cannotWrite()) return;
    const accepted = [];
    const failures = [];
    const queued = itemsRef.current.filter((item) => item.status !== "saved").length;
    const free = Math.max(0, slotsNow() - queued);
    for (const file of Array.from(files || [])) {
      const name = file.name || "Photo";
      try {
        validatePhotoMetadata(file);
        if (accepted.length >= free) {
          throw new Error(`No more spaces in this batch. A test report can contain up to ${MAX_PHOTOS} setup photos, including photos already saved or queued.`);
        }
        accepted.push({
          id: ++nextId.current, file, name, status: "pending", caption: "",
          quarterTurns: 0, rotationVersion: 0,
        });
      } catch (cause) {
        failures.push({ name, reason: cause.message || "This image could not be added." });
      }
    }
    setRejected(failures);
    if (accepted.length) updateItems((previous) => [...previous, ...accepted]);
  }

  function changeCaption(value) {
    if (!current || savingRef.current || cannotWrite()) return;
    updateItems((previous) => previous.map((item) => item.id === currentId
      ? { ...item, caption: value.slice(0, MAX_CAPTION) } : item));
    setSaveError(null);
  }

  async function saveAndNext() {
    if (!current || savingRef.current || cannotWrite() || composing.current || slotsNow() < 1) return;
    if (!ready || ready.run !== prepareRun.current) return;
    const item = itemsRef.current.find((entry) => entry.id === currentId);
    if (!item || item.status !== "pending") return;
    const caption = item.caption.trim();
    if (caption.includes("\0")) {
      setSaveError({ id: item.id, text: "Remove the unsupported character from this caption before saving." });
      captionRef.current?.focus();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onPhoto({ ...ready.photo, caption });
      // The parent may be pending while its own upload completes. That does not
      // invalidate an already saved image or its pinned report/revision callback.
      if (!mounted.current) return;
      setLastSaved(`${item.name} saved${caption ? " with its caption" : ""}.`);
      updateItems((previous) => previous.map((entry) => entry.id === item.id
        ? { ...entry, file: null, status: "saved", caption } : entry));
    } catch (cause) {
      if (mounted.current) setSaveError({
        id: item.id,
        text: cause.message || "The photo could not be saved. Your image and caption are still here; try again.",
      });
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  function skip() {
    if (!current || savingRef.current || pending) return;
    ++prepareRun.current;
    updateItems((previous) => previous.map((item) => item.id === currentId
      ? { ...item, status: "skipped" } : item));
  }

  function reviewSkipped() {
    if (savingRef.current) return;
    updateItems((previous) => previous.map((item) => item.status === "skipped"
      ? { ...item, status: "pending" } : item));
  }

  function rotatePhoto(direction, { focusPhoto = true } = {}) {
    if (!current || savingRef.current || cannotWrite()) return;
    // Invalidate old pixels immediately, including rapid rotate-then-save keys.
    ++prepareRun.current;
    updateItems((previous) => previous.map((item) => item.id === currentId
      ? { ...item, quarterTurns: (item.quarterTurns + direction + 4) % 4,
          rotationVersion: item.rotationVersion + 1 } : item));
    if (focusPhoto) imageRef.current?.focus();
  }

  function handleKeys(event) {
    if (event.defaultPrevented || event.isComposing || event.nativeEvent?.isComposing
      || composing.current || event.keyCode === 229 || event.altKey
      || event.getModifierState?.("AltGraph")) return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!event.repeat) saveAndNext();
      return;
    }
    if (!event.ctrlKey || event.metaKey) return;
    const left = event.key === "<" || (event.shiftKey && (event.key === "," || event.code === "Comma"));
    const right = event.key === ">" || (event.shiftKey && (event.key === "." || event.code === "Period"));
    if (!left && !right) return;
    event.preventDefault();
    if (!event.repeat) rotatePhoto(left ? -1 : 1, { focusPhoto: false });
  }

  function close() {
    if (savingRef.current) return;
    const unsaved = itemsRef.current.filter((item) => item.status !== "saved").length;
    if (unsaved && !window.confirm(`Discard ${photoCount(unsaved)} that have not been saved, including any skipped photos and captions? Photos already saved will stay in the test report.`)) return;
    onClose();
  }

  const notice = scopeChanged
    ? "The selected test report or revision changed. Close this upload and reopen it from the correct report. Your queued photos have not been saved to another report."
    : readOnly
      ? "This test report is read-only. Your queued photos and captions are still here."
      : availableSlots < 1
        ? "No photo slots remain for this report. Each test report can contain up to 30 setup photos."
        : pending && !saving ? "Waiting for another change to finish before saving photos…" : "";

  return createPortal(
    <dialog ref={dialogRef} className="modal bulk-photo-dialog test-setup-bulk-dialog"
      aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); close(); }}
      onKeyDown={handleKeys}>
      <div className="modal-header">
        <div>
          <h2 id={`${id}-title`}>Bulk upload setup photos</h2>
          <div className="bulk-skid">{[skidName, reportName].filter(Boolean).join(" · ")}</div>
        </div>
        <button type="button" className="icon-button" aria-label="Close bulk upload" onClick={close} disabled={saving}>
          <Icon name="close" size={20} />
        </button>
      </div>
      <div className="bulk-content"
        onDragOver={(event) => { event.preventDefault(); if (!blocked && !saving) setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
        {notice && <p className="test-setup-bulk-notice" role="status">{notice}</p>}
        <div className={`bulk-file-picker${items.length ? " has-photos" : ""}${dragging ? " is-dragging" : ""}`}>
          {!items.length && <>
            <span className="bulk-upload-icon"><Icon name="upload" size={28} /></span>
            <h3>Add images to this test report</h3>
            <p>Choose several images or drop them here. Review each photo and add a caption before saving.</p>
          </>}
          <input ref={fileRef} type="file" className="bulk-file-input" multiple
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif"
            aria-label="Choose test setup photos" disabled={blocked || saving || selectionSlots < 1}
            onChange={(event) => { addFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
          <button ref={chooseRef} type="button" className="button secondary"
            disabled={blocked || saving || selectionSlots < 1} onClick={() => fileRef.current?.click()}>
            <Icon name="plus" size={16} />{items.length ? "Add more photos" : "Choose photos"}
          </button>
          {items.length ? <span className="bulk-counts" role="status">
            {savedCount} saved · {pendingCount} awaiting review · {skippedCount} skipped
          </span> : <small>JPEG, PNG, WebP or HEIC · Up to 20 MB each · {photoCount(selectionSlots)} available</small>}
        </div>

        {rejected.length > 0 && <details className="bulk-rejected" open>
          <summary>{photoCount(rejected.length)} could not be added</summary>
          <ul>{rejected.map((file, index) => <li key={`${file.name}-${index}`}><strong>{file.name}</strong>: {file.reason}</li>)}</ul>
        </details>}

        {current && <>
          <div className="bulk-progress">
            <span>{savedCount + skippedCount} of {items.length} reviewed</span>
            <progress max={items.length} value={savedCount + skippedCount} aria-label="Photos reviewed" />
            <span>{availableSlots} save {availableSlots === 1 ? "slot" : "slots"} left</span>
          </div>
          <div className="bulk-review">
            <div className="bulk-image-panel">
              <div ref={imageRef} className={`bulk-image-viewport${zoomed ? " is-zoomed" : ""}`}
                role="group" aria-label="Photo preview and rotation" tabIndex={0} aria-busy={!ready && !preparationError}
                aria-keyshortcuts="Control+< Control+>" aria-describedby={`${id}-rotation-help`}>
                {ready ? <img src={ready.url} alt={`Setup photo: ${current.name}, rotated ${quarterTurns * 90} degrees`} />
                  : <div className="bulk-image-loading">
                    <Icon name="camera" size={28} />
                    {preparationError ? <>
                      <p role="alert">{preparationError}</p>
                      <button type="button" className="button secondary" onClick={() => setRetry((value) => value + 1)} disabled={saving}>Retry preview</button>
                    </> : <p role="status">Preparing image…</p>}
                  </div>}
              </div>
              <div className="bulk-image-caption">
                <span title={current.name}>{current.name}</span>
                <button type="button" className="button secondary small" disabled={!ready} aria-pressed={zoomed} onClick={() => setZoomed((value) => !value)}>
                  <Icon name="search" size={14} />{zoomed ? "Fit image" : "Zoom in"}
                </button>
              </div>
              <div className="bulk-rotation-controls">
                <button type="button" className="button secondary small" disabled={blocked || saving}
                  aria-label="Rotate photo left" onClick={() => rotatePhoto(-1)}><Icon name="rotate-left" size={15} />Rotate left</button>
                <button type="button" className="button secondary small" disabled={blocked || saving}
                  aria-label="Rotate photo right" onClick={() => rotatePhoto(1)}><Icon name="rotate-right" size={15} />Rotate right</button>
                <small id={`${id}-rotation-help`}><kbd>Ctrl</kbd> + <kbd>&lt;</kbd> / <kbd>&gt;</kbd> rotates the photo. The saved image keeps this orientation.</small>
              </div>
            </div>
            <div className="bulk-assignment">
              <label htmlFor={`${id}-caption`}>Caption <span className="test-setup-bulk-optional">(optional)</span></label>
              <textarea ref={captionRef} id={`${id}-caption`} rows={6} maxLength={MAX_CAPTION}
                value={current.caption} readOnly={readOnly || scopeChanged} disabled={saving || pending}
                placeholder="Describe the setup or what this image shows…"
                aria-describedby={`${id}-caption-help ${id}-keyboard`}
                aria-keyshortcuts="Control+Enter Meta+Enter Control+< Control+>"
                onChange={(event) => changeCaption(event.target.value)}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={() => { composing.current = false; }} />
              <div className="test-setup-bulk-caption-help" id={`${id}-caption-help`}>
                <span>You can edit captions later in the test report.</span>
                <span>{current.caption.length}/{MAX_CAPTION}</span>
              </div>
              <div className="bulk-keyboard-hint" id={`${id}-keyboard`}>
                <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>Enter</kbd> saves and moves to the next photo.
              </div>
              <p className="test-setup-bulk-review-help">Skipped images keep their captions so you can review them again before closing.</p>
              {error && <p className="field-error" role="alert">{error}</p>}
              <div className="bulk-save-actions">
                <button type="button" className="button secondary" disabled={saving || pending} onClick={skip}>Skip for now</button>
                <button type="button" className="button primary" disabled={blocked || saving || !ready || availableSlots < 1}
                  onClick={saveAndNext} aria-busy={saving}>
                  {saving ? "Saving photo…" : <><Icon name="check" size={16} />Save &amp; next</>}
                </button>
              </div>
            </div>
          </div>
        </>}

        {!current && items.length > 0 && <div className="bulk-complete">
          <span className="bulk-upload-icon"><Icon name="check" size={30} /></span>
          <h3>All photos reviewed</h3>
          <p>{photoCount(savedCount)} saved to {reportName}.
            {skippedCount > 0 && <> {photoCount(skippedCount)} skipped and still unsaved.</>}</p>
          <div className="bulk-complete-actions">
            {skippedCount > 0 && <button ref={completeRef} type="button" className="button secondary" onClick={reviewSkipped}>Review skipped photos</button>}
            <button ref={skippedCount ? undefined : completeRef} type="button" className="button primary" onClick={close}>{skippedCount ? "Close upload" : "Done"}</button>
          </div>
        </div>}

        {lastSaved && <p className="bulk-last-saved" role="status"><Icon name="check" size={15} />{lastSaved}</p>}
      </div>
    </dialog>, document.body,
  );
}
