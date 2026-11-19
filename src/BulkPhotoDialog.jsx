import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icons.jsx";
import { normalizePhoto, validatePhotoMetadata } from "./photos.js";
import { createOcrSession } from "./ocr.js";
import {
  findBulkTargets,
  resolveBulkTarget,
  suggestBulkTargets,
  getBulkSuggestion,
} from "./bulk-photo-targets.js";
import "./bulk-photos.css";

const EMPTY_READING = { id: null, status: "idle", matches: [], message: "" };
const targetDetail = (target) =>
  target.kind === "device"
    ? `Device · Terminal ${target.terminal}`
    : target.kind === "terminal"
      ? "Terminal evidence"
      : "Equipment evidence";

/** Review a local queue; only a confirmed name sends a photo to the report. */
export default function BulkPhotoDialog({ targets, skidName, onPhoto, onClose }) {
  const [items, setItems] = useState([]);
  const [rejected, setRejected] = useState([]);
  const [prepared, setPrepared] = useState(null);
  const [photoError, setPhotoError] = useState(null);
  const [reading, setReading] = useState(EMPTY_READING);
  const [draft, setDraft] = useState({ id: null, value: "", active: -1 });
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState("");
  const [zoomed, setZoomed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [retry, setRetry] = useState(0);
  const dialogRef = useRef(null);
  const fileRef = useRef(null);
  const inputRef = useRef(null);
  const imageRef = useRef(null);
  const nextId = useRef(0);
  const mounted = useRef(false);
  const savingRef = useRef(false);
  const composing = useRef(false);
  const sessionRef = useRef(null);
  const runRef = useRef(0);
  const readingRun = useRef(null);

  const currentIndex = items.findIndex((item) => item.status === "pending");
  const current = currentIndex < 0 ? null : items[currentIndex];
  const currentId = current?.id ?? null;
  const quarterTurns = current?.quarterTurns ?? 0;
  const rotationVersion = current?.rotationVersion ?? 0;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const savedCount = items.filter((item) => item.status === "saved").length;
  const skippedCount = items.filter((item) => item.status === "skipped").length;
  const pendingCount = items.length - savedCount - skippedCount;
  const query = draft.id === currentId ? draft.value : "";
  const active = draft.id === currentId ? draft.active : -1;
  const currentReading = reading.id === currentId && reading.rotationVersion === rotationVersion
    ? reading : EMPTY_READING;
  const suggestion = getBulkSuggestion(currentReading.matches);
  const pinnedChoices = draft.id === currentId ? draft.choices : null;
  const choices = useMemo(
    () => pinnedChoices || (query.trim()
      ? findBulkTargets(query, targets)
      : currentReading.matches.length
        ? currentReading.matches.map((match) => match.target)
        : targets),
    [query, targets, currentReading.matches, pinnedChoices],
  );
  const selected = active >= 0
    ? choices[active]
    : resolveBulkTarget(query, targets);
  const placeholderTarget = active >= 0 ? selected : suggestion;
  const ready = prepared?.id === currentId && prepared.rotationVersion === rotationVersion
    && prepared.run === runRef.current ? prepared : null;
  const error = saveError?.id === currentId ? saveError.text : "";
  const preparationError = photoError?.id === currentId ? photoError.text : "";

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    fileRef.current?.nextElementSibling?.focus();
    sessionRef.current = createOcrSession((message) => {
      const run = readingRun.current;
      if (!mounted.current || !run || runRef.current !== run.number) return;
      setReading((previous) => previous.id === run.id && previous.rotationVersion === run.rotationVersion && previous.status === "reading"
        ? { ...previous, message: message.status === "recognizing text"
          ? `Reading label… ${Math.round((message.progress || 0) * 100)}%`
          : "Preparing label reader…" }
        : previous);
    }, { labelMode: true, hasLabelMatch: (text) => suggestBulkTargets(text, targets).length > 0 });
    return () => {
      mounted.current = false;
      ++runRef.current;
      sessionRef.current?.dispose();
      sessionRef.current = null;
      dialog.close();
      previousFocus?.focus?.();
    };
  }, []);

  useEffect(() => {
    if (!pendingCount && !saving) return undefined;
    const preventLoss = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [pendingCount, saving]);

  useEffect(() => {
    // Rotating an image preserves a name already typed or chosen for it.
    setDraft({ id: currentId, value: "", active: -1 });
    setZoomed(false);
    composing.current = false;
    if (currentId !== null) inputRef.current?.focus();
  }, [currentId]);

  useEffect(() => {
    const run = ++runRef.current;
    const session = sessionRef.current;
    let cancelled = false;
    let previewUrl;
    const isCurrent = () => !cancelled && mounted.current && runRef.current === run;
    setPrepared(null);
    setPhotoError(null);
    setSaveError(null);
    setReading({ ...EMPTY_READING, id: currentId, rotationVersion });
    if (!current) return undefined;

    async function prepare() {
      let photo;
      try {
        // Decode only the current image. The rest remain lightweight File references.
        photo = await normalizePhoto(current.file, current.name, { quarterTurns });
        if (!isCurrent()) return;
        previewUrl = URL.createObjectURL(photo.blob);
        setPrepared({ id: currentId, rotationVersion, run, photo, url: previewUrl });
      } catch (cause) {
        if (isCurrent()) setPhotoError({ id: currentId, text: cause.message || "This photo could not be opened. Skip it or try again." });
        return;
      }
      if (!isCurrent()) return;
      readingRun.current = { id: currentId, rotationVersion, number: run };
      setReading({ id: currentId, rotationVersion, status: "reading", matches: [], message: "Reading label…" });
      try {
        // Read the original, before the evidence upload's JPEG downscaling.
        const text = await session.recognize(current.file, { quarterTurns });
        if (isCurrent()) {
          setReading({ id: currentId, rotationVersion, status: "done", matches: suggestBulkTargets(text, targets), message: "" });
          // OCR never changes a name the inspector has typed or selected.
        }
      } catch (cause) {
        if (isCurrent() && cause?.name !== "AbortError") {
          setReading({ id: currentId, rotationVersion, status: "error", matches: [], message: "Label reading unavailable. Choose the name manually." });
        }
      } finally {
        if (readingRun.current?.number === run) readingRun.current = null;
      }
    }
    prepare();
    return () => {
      cancelled = true;
      if (readingRun.current?.number === run) {
        readingRun.current = null;
        session?.cancel();
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // Version also changes for rapid full turns back to the original orientation.
  }, [currentId, quarterTurns, rotationVersion, retry, targets]);

  useEffect(() => {
    if (active >= 0) {
      document.getElementById(`bulk-target-${active}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  useEffect(() => {
    if (!saving && currentId !== null) inputRef.current?.focus();
  }, [saving, currentId]);

  function addFiles(files) {
    if (savingRef.current) return;
    const accepted = [];
    const failures = [];
    for (const file of Array.from(files || [])) {
      try {
        validatePhotoMetadata(file);
        accepted.push({ id: ++nextId.current, file, name: file.name || "Photo", status: "pending", quarterTurns: 0, rotationVersion: 0 });
      } catch (cause) {
        failures.push({ name: file.name || "Photo", reason: cause.message });
      }
    }
    setRejected(failures);
    if (accepted.length) setItems((previous) => [...previous, ...accepted]);
  }

  function choose(target) {
    if (!target || savingRef.current) return;
    setDraft({ id: currentId, value: target.name, active: -1 });
    setSaveError(null);
    inputRef.current?.focus();
  }

  async function saveAndNext() {
    if (!current || savingRef.current || composing.current) return;
    if (!selected) {
      setSaveError({ id: currentId, text: suggestion && !query
        ? "Press Tab to accept the suggested name, or choose another name."
        : "Choose a matching device or terminal before saving." });
      inputRef.current?.focus();
      return;
    }
    if (!ready || ready.run !== runRef.current) return;
    const id = currentId;
    const target = selected;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    // Show exactly which target is being saved, even when chosen with arrow keys.
    setDraft({ id, value: target.name, active: -1 });
    try {
      await onPhoto(target.key, ready.photo);
      if (!mounted.current || currentIdRef.current !== id) return;
      setLastSaved(`${current.name} saved to ${target.name}`);
      setItems((previous) => previous.map((item) => item.id === id
        ? { ...item, file: null, status: "saved", targetName: target.name }
        : item));
    } catch (cause) {
      if (mounted.current && currentIdRef.current === id) {
        setSaveError({ id, text: cause.message || "The photo could not be saved. Try again." });
      }
    } finally {
      savingRef.current = false;
      if (mounted.current) {
        setSaving(false);
        inputRef.current?.focus();
      }
    }
  }

  function skip() {
    if (!current || savingRef.current) return;
    setItems((previous) => previous.map((item) => item.id === currentId
      ? { ...item, status: "skipped" }
      : item));
  }

  function rotatePhoto(direction) {
    if (!current || savingRef.current) return;
    // Invalidate the previous pixels synchronously, before a rapid Enter can save.
    ++runRef.current;
    if (readingRun.current) {
      readingRun.current = null;
      sessionRef.current?.cancel();
    }
    setItems((previous) => previous.map((item) => item.id === currentId
      ? { ...item, quarterTurns: ((item.quarterTurns || 0) + direction + 4) % 4,
          rotationVersion: (item.rotationVersion || 0) + 1 }
      : item));
    imageRef.current?.focus();
  }

  function handlePhotoKeys(event) {
    if (event.defaultPrevented || event.isComposing || event.nativeEvent?.isComposing
      || composing.current || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target === imageRef.current && event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    // Single-letter shortcuts must not interfere with typing a device/terminal.
    if (event.target?.closest?.("input, textarea, select, [contenteditable]")) return;
    const key = event.key.toLowerCase();
    if (current && (key === "q" || key === "e")) {
      event.preventDefault();
      if (!event.repeat) rotatePhoto(key === "q" ? -1 : 1);
    }
  }

  function close() {
    if (savingRef.current) return;
    if (pendingCount && !window.confirm(
      `${pendingCount} photo${pendingCount === 1 ? " is" : "s are"} still waiting to be saved. Close this queue? Photos already saved will stay in the report.`,
    )) return;
    sessionRef.current?.dispose();
    onClose();
  }

  function handleKeys(event) {
    if (event.isComposing || event.nativeEvent?.isComposing || composing.current || event.keyCode === 229) return;
    if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      imageRef.current?.focus();
    } else if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !query && placeholderTarget) {
      event.preventDefault();
      choose(placeholderTarget);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!choices.length || savingRef.current) return;
      event.preventDefault();
      const next = event.key === "ArrowDown"
        ? (active + 1) % choices.length
        : (active < 0 ? choices.length - 1 : (active - 1 + choices.length) % choices.length);
      // Keep the browsed choices stable if OCR finishes while arrows are in use.
      setDraft({ id: currentId, value: query, active: next, choices });
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) saveAndNext();
    }
  }

  const ocrMessage = currentReading.status === "reading" || currentReading.status === "error"
    ? currentReading.message
    : currentReading.status === "done"
      ? suggestion
        ? "Suggested from the label. Check the photo before accepting."
        : currentReading.matches.length
          ? "Multiple possible names. Choose the correct one."
          : "No clear label match. Search or pick a name."
      : "You can choose a name while the photo loads.";

  return createPortal(
    <dialog ref={dialogRef} className="modal bulk-photo-dialog" aria-labelledby="bulk-photo-title" onKeyDown={handlePhotoKeys}
      onCancel={(event) => { event.preventDefault(); close(); }}>
      <header className="modal-header">
        <div>
          <h2 id="bulk-photo-title">Bulk upload photos</h2>
          <p className="bulk-skid">Skid: <strong>{skidName}</strong></p>
        </div>
        <button type="button" className="icon-button" aria-label="Close bulk upload" onClick={close} disabled={saving}>
          <Icon name="close" />
        </button>
      </header>
      <div className="bulk-content"
        onDragOver={(event) => { event.preventDefault(); if (!saving) setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
        <div className={`bulk-file-picker ${dragging ? "is-dragging" : ""} ${items.length ? "has-photos" : ""}`}>
          {!items.length && <>
            <span className="bulk-upload-icon"><Icon name="upload" size={30} /></span>
            <h3>Select all your inspection photos</h3>
            <p>Review one at a time, choose its device or terminal, and press Enter to save and continue.</p>
          </>}
          <input ref={fileRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif"
            className="bulk-file-input" aria-label="Choose photos to review" disabled={saving}
            onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
          <button type="button" className={`button ${items.length ? "secondary" : "primary"}`} disabled={saving}
            onClick={() => fileRef.current?.click()}>
            <Icon name={items.length ? "plus" : "upload"} size={17} />
            {items.length ? "Add photos" : "Choose photos"}
          </button>
          {!items.length && <small>Or drop photos here · up to 20 MB per photo</small>}
          {items.length > 0 && <span className="bulk-counts" aria-live="polite">{savedCount} saved · {pendingCount} remaining{skippedCount > 0 ? ` · ${skippedCount} skipped` : ""}</span>}
        </div>
        {rejected.length > 0 && <details className="bulk-rejected" open>
          <summary>{rejected.length} photo{rejected.length === 1 ? " could" : "s could"} not be added</summary>
          <ul>{rejected.map((item, index) => <li key={index}><strong>{item.name}</strong>: {item.reason}</li>)}</ul>
        </details>}
        {current && <>
          <div className="bulk-progress">
            <span>Photo {currentIndex + 1} of {items.length}</span>
            <progress value={savedCount + skippedCount} max={items.length} aria-label="Photos reviewed" />
          </div>
          <div className="bulk-review">
            <section className="bulk-image-panel" aria-label="Photo preview">
              <div ref={imageRef} className={`bulk-image-viewport ${zoomed ? "is-zoomed" : ""}`}
                role="group" aria-label="Photo preview and rotation" aria-describedby="bulk-rotation-hint"
                aria-keyshortcuts="Q E" tabIndex={0} onClick={() => imageRef.current?.focus()}>
                {ready ? <img src={ready.url} alt={`Review ${current.name}, rotated ${quarterTurns * 90} degrees`} /> : <div className="bulk-image-loading">
                  <Icon name={preparationError ? "info" : "camera"} size={32} />
                  <p>{preparationError || "Preparing photo…"}</p>
                  {preparationError && <button type="button" className="button secondary" onClick={() => setRetry((value) => value + 1)}>Retry photo</button>}
                </div>}
              </div>
              <div className="bulk-image-caption">
                <span title={current.name}>{current.name}</span>
                <button type="button" className="small-button" disabled={!ready} aria-pressed={zoomed} onClick={() => setZoomed((value) => !value)}>
                  <Icon name="search" size={14} />{zoomed ? "Fit photo" : "Zoom photo"}
                </button>
              </div>
              <div className="bulk-rotation-controls">
                <button type="button" className="small-button" aria-label="Rotate photo left (Q)" aria-keyshortcuts="Q"
                  disabled={saving} onClick={() => rotatePhoto(-1)}>
                  <Icon name="rotate-left" size={16} />Left <kbd>Q</kbd>
                </button>
                <button type="button" className="small-button" aria-label="Rotate photo right (E)" aria-keyshortcuts="E"
                  disabled={saving} onClick={() => rotatePhoto(1)}>
                  <Icon name="rotate-right" size={16} />Right <kbd>E</kbd>
                </button>
                <small id="bulk-rotation-hint">Click the photo to use Q / E. Tab returns to the name.</small>
              </div>
            </section>
            <section className="bulk-assignment" aria-label="Assign photo">
              <label htmlFor="bulk-target-name">Device or terminal</label>
              <input ref={inputRef} id="bulk-target-name" type="text" role="combobox"
                autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={120}
                aria-autocomplete="list" aria-expanded={choices.length > 0} aria-controls="bulk-target-options"
                aria-activedescendant={active >= 0 && choices[active] ? `bulk-target-${active}` : undefined}
                aria-describedby="bulk-keyboard-hint bulk-ocr-status" aria-invalid={Boolean(error)}
                value={query} placeholder={placeholderTarget?.name || "e.g. V-3541 or Terminal B"} disabled={saving}
                onChange={(event) => { setDraft({ id: currentId, value: event.target.value, active: -1 }); setSaveError(null); }}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={() => { composing.current = false; }}
                onKeyDown={handleKeys} />
              <p id="bulk-keyboard-hint" className="bulk-keyboard-hint"><kbd>Tab</kbd> accept suggestion <span>·</span> <kbd>Enter</kbd> save & next <span>·</span> <kbd>Esc</kbd> focus photo</p>
              <p id="bulk-ocr-status" className="bulk-ocr-status" role="status">{ocrMessage}</p>
              <div className="bulk-target-options" id="bulk-target-options" role="listbox" aria-label="Matching devices and terminals">
                {choices.map((target, index) => <button key={target.key} id={`bulk-target-${index}`} type="button" role="option" tabIndex={-1}
                  aria-selected={selected?.key === target.key} className={selected?.key === target.key ? "is-selected" : ""}
                  disabled={saving} onClick={() => choose(target)}>
                  <span><strong>{target.name}</strong><small>{targetDetail(target)}</small></span>
                  {selected?.key === target.key ? <Icon name="check" size={18} /> : <Icon name="arrow" size={16} />}
                </button>)}
              </div>
              {!choices.length && <p className="bulk-no-match">No matching name. Try the device tag or a terminal letter (A–H).</p>}
              <small className="bulk-selection-hint">Type a full name, click a match, or use ↑ ↓ to choose.</small>
              {error && <p className="field-error" role="alert">{error}</p>}
              <div className="bulk-save-actions">
                <button type="button" className="button primary" onClick={saveAndNext} disabled={saving || !ready || !selected}>
                  <Icon name="check" size={18} />{saving ? "Saving photo…" : "Save & next"}
                </button>
                <button type="button" className="button secondary" onClick={skip} disabled={saving}>Skip photo</button>
              </div>
            </section>
          </div>
        </>}
        {items.length > 0 && !current && <div className="bulk-complete" role="status">
          <span className="bulk-upload-icon"><Icon name="check" size={30} /></span>
          <h3>All photos reviewed</h3>
          <p>{savedCount} photo{savedCount === 1 ? "" : "s"} saved to <strong>{skidName}</strong>.{skippedCount > 0 && ` ${skippedCount} skipped and not uploaded.`}</p>
          <div className="bulk-complete-actions">
            {skippedCount > 0 && <button type="button" className="button secondary" onClick={() => setItems((previous) => previous.map((item) => item.status === "skipped" ? { ...item, status: "pending" } : item))}>
              Review skipped photos
            </button>}
            <button type="button" className="button primary" onClick={close}>Done</button>
          </div>
        </div>}
        {lastSaved && <p className="bulk-last-saved" role="status"><Icon name="check" size={14} />{lastSaved}</p>}
      </div>
    </dialog>,
    document.body,
  );
}
