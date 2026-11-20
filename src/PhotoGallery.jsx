import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icons.jsx";
import { normalizePhoto } from "./photos.js";
import "./test-setup-photos.css";

const MAX_PHOTOS = 30;
const messageFor = error => error?.message || "The setup photo could not be saved. Try again.";

function SetupImage({ photo, getPhotoUrl, large = false }) {
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setSource(""); setError("");
    Promise.resolve().then(() => {
      if (typeof getPhotoUrl !== "function") throw new Error("Reconnect to open this photo.");
      return getPhotoUrl(photo);
    }).then(url => { if (!cancelled) setSource(url); })
      .catch(error => { if (!cancelled) setError(messageFor(error)); });
    return () => { cancelled = true; };
  }, [photo.id, photo.path, photo.walkdownId, getPhotoUrl]);
  if (error) return <span className="test-setup-image-error">Photo unavailable<small>{error}</small></span>;
  if (!source) return <span className="test-setup-image-loading">Loading photo…</span>;
  return <img src={source} alt={photo.caption || photo.name || "Test setup"} loading={large ? "eager" : "lazy"} draggable={false}
    onError={() => setError("The image could not be loaded. Reopen it to try again.")} />;
}

function SetupPhotoDialog({ photo, index, count, getPhotoUrl, onClose, inspection }) {
  const dialog = useRef(null);
  const closeButton = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previousFocus = document.activeElement;
    const element = dialog.current;
    if (!element.open) element.showModal();
    closeButton.current?.focus();
    return () => {
      if (element.open) element.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return createPortal(<dialog className="test-setup-dialog" ref={dialog} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header><h3 id={titleId}>{inspection ? "Evidence photo" : "Setup photo"} {index + 1} of {count}</h3>
      <button type="button" className="icon-button" aria-label={inspection ? "Close evidence photo" : "Close setup photo"} onClick={onClose} ref={closeButton}><Icon name="close" /></button>
    </header>
    <div className="test-setup-full-image"><SetupImage photo={photo} getPhotoUrl={getPhotoUrl} large /></div>
    <p className="test-setup-filename">{photo.name}</p>
    {photo.caption && <p className="test-setup-caption">{photo.caption}</p>}
  </dialog>, document.body);
}

/** Each evidence write remains pinned to its opening collection and revision. */
export default function PhotoGallery(props) {
  return <ScopedPhotoGallery key={JSON.stringify([props.run.walkdownId, props.run.id, props.revision])} {...props} />;
}

function ScopedPhotoGallery({
  run, revision, readOnly = false, pending = false, getPhotoUrl,
  onAddPhoto, onUpdatePhoto, onRemovePhoto, onReorderPhotos, onDirtyChange,
  kind = "setup", headerActions, canRemovePhoto = () => true,
}) {
  const inspection = kind === "inspection";
  const savedPhotos = run.setupPhotos || [];
  const [movingOrder, setMovingOrder] = useState(null);
  const [draggedId, setDraggedId] = useState(null);
  const [dropId, setDropId] = useState(null);
  const drag = useRef(null);
  const showMove = movingOrder && !readOnly && savedPhotos.length === movingOrder.before.length
    && savedPhotos.every((photo, index) => photo.id === movingOrder.before[index]);
  const photos = showMove ? movingOrder.after.map(id => savedPhotos.find(photo => photo.id === id)) : savedPhotos;
  const [busy, setBusy] = useState("");
  const [queue, setQueue] = useState([]);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [viewedId, setViewedId] = useState(null);
  const input = useRef(null);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const operation = useRef(0);
  const scope = useRef(null);
  scope.current = { run, revision, readOnly, pending };
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const captionDirty = editing !== null && editing.text !== (editing.photo.caption || "");
  const dirty = Boolean((busy && busy !== "order") || queue.length || captionDirty);
  const blocked = pending || Boolean(busy);
  const editingLocked = blocked || Boolean(queue.length) || Boolean(editing);
  const canReorder = !readOnly && typeof onReorderPhotos === "function" && photos.length > 1;
  const orderLocked = !canReorder || editingLocked;
  const viewed = photos.find(photo => photo.id === viewedId);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++operation.current; dirtyCallback.current?.(false); };
  }, []);
  useEffect(() => { dirtyCallback.current?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    ++operation.current;
    busyRef.current = false;
    setBusy(""); setQueue([]); setProgress(""); setError(""); setNotice("");
    setEditing(null); setConfirmRemove(null); setViewedId(null);
  }, [run.id, run.walkdownId, revision]);
  useEffect(() => {
    if (!dirty) return;
    const preventDiscard = event => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventDiscard);
    return () => window.removeEventListener("beforeunload", preventDiscard);
  }, [dirty]);

  const isCurrent = (token, captured) => mounted.current && token === operation.current
    && scope.current.run.id === captured.run.id
    && scope.current.run.walkdownId === captured.run.walkdownId
    && scope.current.revision === captured.revision;
  function requireScope(token, captured) {
    if (!isCurrent(token, captured) || scope.current.readOnly)
      throw new Error("This revision is closed or changed. Open the current draft to continue.");
  }
  function start(kind) {
    if (busyRef.current || scope.current.readOnly || scope.current.pending) return null;
    const captured = scope.current;
    const token = ++operation.current;
    busyRef.current = true;
    setBusy(kind); setError(""); setNotice(""); setConfirmRemove(null);
    return { token, captured };
  }
  function finish(token, captured) {
    if (isCurrent(token, captured)) { busyRef.current = false; setBusy(""); setProgress(""); }
  }

  async function upload(chosen) {
    if (!chosen.length || editing || readOnly || pending || busyRef.current) return;
    if (photos.length + chosen.length > MAX_PHOTOS) {
      setError(`A test run can have up to ${MAX_PHOTOS} setup photos. Choose at most ${Math.max(0, MAX_PHOTOS - photos.length)} more, or remove a photo first.`);
      return;
    }
    const task = start("upload");
    if (!task) return;
    const { token, captured } = task;
    const remaining = [...chosen];
    let saved = 0;
    setQueue([...remaining]);
    try {
      while (remaining.length) {
        requireScope(token, captured);
        const file = remaining[0];
        setProgress(`Uploading setup photo ${saved + 1} of ${chosen.length}: ${file.name}`);
        const normalized = await normalizePhoto(file, file.name);
        requireScope(token, captured);
        await onAddPhoto(captured.run, normalized, captured.revision);
        remaining.shift(); saved += 1;
        if (isCurrent(token, captured)) setQueue([...remaining]);
      }
      if (isCurrent(token, captured)) setNotice(`${saved} setup ${saved === 1 ? "photo" : "photos"} saved.`);
    } catch (error) {
      if (isCurrent(token, captured)) {
        setQueue([...remaining]);
        setError(`${saved ? `${saved} ${saved === 1 ? "photo was" : "photos were"} saved. ` : ""}${remaining[0]?.name ? `${remaining[0].name}: ` : ""}${messageFor(error)}`);
      }
    } finally { finish(token, captured); }
  }
  async function choosePhotos(event) {
    const chosen = Array.from(event.target.files || []);
    event.target.value = "";
    if (queue.length) return;
    await upload(chosen);
  }
  async function saveCaption() {
    if (!editing || !captionDirty || queue.length) return;
    const task = start("caption");
    if (!task) return;
    const { token, captured } = task;
    try {
      requireScope(token, captured);
      await onUpdatePhoto(captured.run, editing.photo, editing.text.trim(), captured.revision);
      if (isCurrent(token, captured)) { setEditing(null); setNotice("Setup caption saved."); }
    } catch (error) { if (isCurrent(token, captured)) setError(messageFor(error)); }
    finally { finish(token, captured); }
  }
  async function removePhoto(photo) {
    if (confirmRemove !== photo.id || editing || queue.length || !canRemovePhoto(photo)) return;
    const task = start("remove");
    if (!task) return;
    const { token, captured } = task;
    try {
      requireScope(token, captured);
      await onRemovePhoto(captured.run, photo, captured.revision);
      if (isCurrent(token, captured)) setNotice(`${inspection ? "Evidence" : "Setup"} photo removed from this draft.`);
    } catch (error) { if (isCurrent(token, captured)) { setError(messageFor(error)); setConfirmRemove(photo.id); } }
    finally { finish(token, captured); }
  }

  async function movePhoto(id, destination) {
    if (orderLocked) return;
    const before = savedPhotos.map(photo => photo.id);
    const from = before.indexOf(id);
    if (from < 0 || destination < 0 || destination >= before.length || from === destination) return;
    const task = start("order");
    if (!task) return;
    const { token, captured } = task;
    const after = [...before];
    after.splice(from, 1);
    after.splice(destination, 0, id);
    setMovingOrder({ before, after });
    try {
      requireScope(token, captured);
      await onReorderPhotos(captured.run, after, before, captured.revision);
    } catch (error) {
      if (isCurrent(token, captured)) setError(error?.message || "Could not save the photo order. Try moving the photo again.");
    } finally {
      if (isCurrent(token, captured)) {
        setMovingOrder(null);
        finish(token, captured);
      }
    }
  }
  function beginDrag(event, id) {
    if (orderLocked || busyRef.current) { event.preventDefault(); return; }
    drag.current = id;
    setDraggedId(id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  }
  function endDrag() { drag.current = null; setDraggedId(null); setDropId(null); }

  return <section className="test-setup" aria-label={inspection ? "Evidence photos" : "Test setup"}>
    <header className="test-setup-header">
      <div><h3>{inspection ? "Evidence photos" : "Setup"}</h3><p>{inspection ? "Saved photo order is used in the inspection report and PDF." : "Photos of the setup used for this test are included in the report."}</p></div>
      <span className="test-setup-count">{inspection ? photos.length : `${photos.length} / ${MAX_PHOTOS}`} photos</span>
      {headerActions}
      {!readOnly && typeof onAddPhoto === "function" && <>
        <input ref={input} className="test-setup-file-input" type="file" multiple tabIndex={-1}
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" aria-label="Choose setup photos"
          disabled={editingLocked || photos.length >= MAX_PHOTOS} onChange={choosePhotos} />
        <button type="button" className="button secondary" disabled={editingLocked || photos.length >= MAX_PHOTOS}
          onClick={() => input.current?.click()}><Icon name="upload" />Add setup photos</button>
      </>}
    </header>
    {error && <p className="field-error test-setup-message" role="alert">{error}</p>}
    {(progress || notice) && <p className="test-setup-message" role="status">{progress || notice}</p>}
    {queue.length > 0 && !busy && <div className="test-setup-retry">
      <p>{queue.length} {queue.length === 1 ? "photo remains" : "photos remain"} to upload: {queue.map(file => file.name).join(", ")}.</p>
      <button type="button" className="small-button" disabled={readOnly || pending} onClick={() => upload(queue)}>Retry remaining photos</button>
      <button type="button" className="small-button" onClick={() => { setQueue([]); setError(""); }}>Discard remaining photos</button>
    </div>}
    {!photos.length && <p className="test-setup-empty">{inspection ? "No evidence photos have been added to this item." : readOnly
      ? "No setup photos were added to this test run."
      : "Add photos of the wiring, instruments, and pneumatic setup used for this test."}</p>}
    {photos.length > 0 && <div className="test-setup-grid">{photos.map((photo, index) => <article
      className={`test-setup-photo${draggedId === photo.id ? " is-dragging" : ""}${dropId === photo.id ? " is-drop-target" : ""}`} key={photo.id}
      onDragOver={event => { if (!drag.current || orderLocked) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropId(photo.id); }}
      onDrop={event => { if (!drag.current || orderLocked) return; event.preventDefault(); movePhoto(drag.current, index); endDrag(); }}>
      <button type="button" className="test-setup-thumbnail" aria-label={`View ${inspection ? "evidence" : "setup"} photo ${index + 1}: ${photo.name}`}
        draggable={!orderLocked} onDragStart={event => beginDrag(event, photo.id)} onDragEnd={endDrag}
        onClick={() => setViewedId(photo.id)}><SetupImage photo={photo} getPhotoUrl={getPhotoUrl} /></button>
      <div className="test-setup-photo-body">
        <div className="test-setup-photo-position"><span>Photo {index + 1} of {photos.length}</span>
          {canReorder && <div className="test-setup-order-controls">
            <button type="button" className="small-button" aria-label={`Move ${photo.name} earlier`} title="Move earlier"
              disabled={orderLocked || index === 0} onClick={() => movePhoto(photo.id, index - 1)}><Icon name="up" size={15} /></button>
            <button type="button" className="small-button" aria-label={`Move ${photo.name} later`} title="Move later"
              disabled={orderLocked || index === photos.length - 1} onClick={() => movePhoto(photo.id, index + 1)}><Icon name="down" size={15} /></button>
            <button type="button" className="small-button test-setup-drag" aria-label={`Drag ${photo.name} to reorder`} title="Drag to reorder"
              disabled={orderLocked} draggable={!orderLocked} onDragStart={event => beginDrag(event, photo.id)}
              onDragEnd={endDrag}><Icon name="drag" size={15} /></button>
          </div>}
        </div>
        <p className="test-setup-filename" title={photo.name}>{photo.name}</p>
        {inspection && photo.createdAt && <p className="test-muted">{new Date(photo.createdAt).toLocaleString()}</p>}
        {editing?.photo.id === photo.id ? <div className="test-setup-caption-editor">
          <label>Caption<textarea value={editing.text} maxLength={1000} disabled={blocked || readOnly}
            onChange={event => setEditing(previous => ({ ...previous, text: event.target.value }))} /></label>
          <small>{editing.text.length} / 1,000</small>
          {readOnly && <p className="field-error">This revision is closed. Your unsaved caption is shown above.</p>}
          <div className="test-setup-actions">
            {!readOnly && <button type="button" className="small-button" disabled={blocked || !captionDirty} onClick={saveCaption}>{busy === "caption" ? "Saving…" : "Save caption"}</button>}
            <button type="button" className="small-button" disabled={Boolean(busy)} onClick={() => { setEditing(null); setError(""); }}>Cancel caption edit</button>
          </div>
        </div> : <>
          {photo.caption && <p className="test-setup-caption">{photo.caption}</p>}
          {!readOnly && <div className="test-setup-actions">
            {typeof onUpdatePhoto === "function" && <button type="button" className="small-button" disabled={editingLocked}
              onClick={() => { setEditing({ photo, text: photo.caption || "" }); setConfirmRemove(null); setError(""); }}>{photo.caption ? "Edit caption" : "Add caption"}</button>}
            {typeof onRemovePhoto === "function" && canRemovePhoto(photo) && (confirmRemove === photo.id ? <>
              <span>Remove this photo?</span>
              <button type="button" className="small-button test-remove" disabled={editingLocked} onClick={() => removePhoto(photo)}>Confirm removal</button>
              <button type="button" className="small-button" disabled={blocked} onClick={() => setConfirmRemove(null)}>Cancel removal</button>
            </> : <button type="button" className="small-button test-remove" disabled={editingLocked}
              onClick={() => { setConfirmRemove(photo.id); setError(""); }}>Remove photo</button>)}
          </div>}
        </>}
      </div>
    </article>)}</div>}
    {viewed && <SetupPhotoDialog photo={viewed} index={photos.indexOf(viewed)} count={photos.length}
      getPhotoUrl={getPhotoUrl} inspection={inspection} onClose={() => setViewedId(null)} />}
  </section>;
}
