import React, { useEffect, useRef, useState } from "react";
import Icon from "./Icons.jsx";
import { revisionNumber } from "./domain.js";

const approvedDate = (value) => new Date(value).toLocaleString(undefined, {
  dateStyle: "medium", timeStyle: "short",
});
const signatory = project => project.closedByName?.trim()
  ? [project.closedByName.trim(), project.closedByTitle?.trim()].filter(Boolean).join(" · ") : "Not recorded";

export function CheckedByForm({ project, pending = false, onSave, onDirtyChange }) {
  const savedName = project.checkedByName ?? null;
  const [entry, setEntry] = useState(() => ({ name: savedName || "", expectedName: savedName, edited: false }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const changed = savedName !== entry.expectedName;
  const dirty = entry.name.trim() !== (savedName || "");
  const blocked = pending || busy || project.status !== "draft";
  useEffect(() => {
    setEntry(previous => previous.edited ? previous : { name: savedName || "", expectedName: savedName, edited: false });
  }, [savedName]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  function reset() {
    setEntry({ name: savedName || "", expectedName: savedName, edited: false }); setError("");
  }
  async function save(event) {
    event.preventDefault();
    if (blocked || busyRef.current || changed || !onSave) return;
    const name = entry.name.trim();
    if (!name || Array.from(name).length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
      setError("Enter a name of 1–120 characters without control characters."); return;
    }
    busyRef.current = true; setBusy(true); setError("");
    try {
      const saved = await onSave(name, entry.expectedName, project.revision, project.walkdownId);
      const next = saved?.project?.checkedByName ?? name;
      setEntry({ name: next, expectedName: next, edited: false });
    } catch (failure) { setError(failure.message); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <form className="checked-by-form" aria-label="Checked by" noValidate onSubmit={save}>
    <label htmlFor="checked-by-name">Checked by</label>
    <div className="checked-by-fields">
      <input id="checked-by-name" name="checkedByName" required maxLength={120} autoComplete="off"
        value={entry.name} disabled={blocked} placeholder="Enter the checker’s name"
        aria-describedby={`checked-by-help${error ? " checked-by-error" : ""}`}
        aria-invalid={Boolean(error)} onChange={event => {
          setEntry(previous => ({ ...previous, name: event.target.value, edited: true })); setError("");
        }} />
      <button type="submit" className="button primary" disabled={blocked || changed || !entry.name.trim() || !onSave}>
        {busy ? "Saving checked by…" : "Save checked by"}
      </button>
      {dirty && !changed && savedName !== null && <button type="button" className="button secondary" disabled={blocked} onClick={reset}>Use saved name</button>}
    </div>
    <p id="checked-by-help">Enter the person who checked this revision. The approval signature is recorded separately.</p>
    {changed && <div className="checked-by-conflict" role="alert">
      <p>Checked by changed to <strong>{savedName || "Not recorded"}</strong>. Review the saved name before making another change.</p>
      <button type="button" className="small-button" disabled={blocked} onClick={reset}>Use saved name</button>
    </div>}
    {error && <p id="checked-by-error" className="field-error" role="alert">{error}</p>}
  </form>;
}

export default function RevisionPanel({
  project, revisions = [], photoCount, commentCount, completedCount, targetCount,
  testRunCount = 0, setupPhotoCount = 0, pending = false, hasDraftComments = false, hasDraftTests = false,
  onApprove, onNewRevision, onExport, onExportTests, onSaveCheckedBy,
}) {
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [checkerDirty, setCheckerDirty] = useState(false);
  const busyRef = useRef(false);
  const closed = project.status === "closed";
  const supported = project.status === "draft" || closed;
  const checkerRequired = !project.checkedByName?.trim();
  const changed = review && (review.walkdownId !== project.walkdownId
    || review.revision !== project.revision || review.contentVersion !== project.contentVersion
    || review.checkedByName !== project.checkedByName || project.status !== "draft");
  const blocked = pending || Boolean(busy);

  async function action(name, operation) {
    if (busyRef.current || pending) return;
    busyRef.current = true;
    setBusy(name);
    setError("");
    try {
      await operation();
      setReview(null);
    } catch (e) {
      setError(e.message);
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  function beginReview() {
    if (blocked || checkerRequired || checkerDirty || hasDraftComments || hasDraftTests || project.status !== "draft") return;
    setError("");
    setReview({
      walkdownId: project.walkdownId, revision: project.revision,
      contentVersion: project.contentVersion, skidName: project.skidName,
      checkedByName: project.checkedByName,
      photoCount, commentCount, completedCount, testRunCount, setupPhotoCount,
    });
  }

  return (
    <section className="card revision-panel" aria-label="Report revision">
      <div className="revision-heading">
        <div>
          <span className="eyebrow">REPORT REVISION</span>
          <h2>Revision {revisionNumber(project)}</h2>
        </div>
        <span className={`revision-status ${closed ? "closed" : "draft"}`}>
          {closed ? <Icon name="check" size={15} /> : <Icon name="report" size={15} />}
          {closed ? "Approved & closed" : supported ? "Draft" : "Update required"}
        </span>
      </div>
      {supported && <dl className="revision-signatures">
        <div><dt>Checked by</dt><dd>{project.checkedByName || "Not recorded"}</dd></div>
        <div><dt>Signed off by</dt><dd>{closed ? signatory(project) : "Pending approval"}</dd></div>
      </dl>}
      {!closed && supported && !checkerRequired && <CheckedByForm project={project} pending={blocked} onSave={onSaveCheckedBy} onDirtyChange={setCheckerDirty} />}
      {!supported ? (
        <p className="field-error" role="alert">The workspace needs the report revision update before you can edit or export. Refresh after the update is complete.</p>
      ) : closed ? (
        <div className="revision-body">
          <p>Approved on {approvedDate(project.closedAt)}. This revision is locked and ready to export.</p>
          <button type="button" className="button secondary" disabled={blocked}
            onClick={() => action("new", () => onNewRevision(project.revision))}>
            <Icon name="plus" size={17} />{busy === "new" ? "Creating revision…" : "New revision"}
          </button>
          <small>A new draft starts with the current report’s content. This approved revision stays saved.</small>
        </div>
      ) : (
        <div className="revision-body">
          <p>Review the saved photos, comments, and test reports, then approve and close this revision to export it.</p>
          <span className="revision-summary">{photoCount} photos · {commentCount} comments · {completedCount}/{targetCount} items reviewed · {testRunCount} test runs{setupPhotoCount > 0 && ` · ${setupPhotoCount} setup photos`}</span>
          {!review && <button type="button" className="button primary" disabled={blocked || checkerRequired || checkerDirty || hasDraftComments || hasDraftTests} onClick={beginReview}>
            <Icon name="check" size={17} />Approve &amp; close
          </button>}
          {checkerRequired && <p className="revision-draft-notice" role="status">Save Checked by before entering data or approving this revision.</p>}
          {checkerDirty && <p className="revision-draft-notice" role="status">Save Checked by or use the saved name before approving this revision.</p>}
          {hasDraftComments && <p className="revision-draft-notice" role="status">{checkerRequired
            ? "Your draft comments are retained. Save Checked by to resume editing."
            : "Post or clear your draft comments before approving this revision."}</p>}
          {hasDraftTests && <p className="revision-draft-notice" role="status">{checkerRequired
            ? "Your test run changes are retained. Save Checked by to resume them."
            : "Save or discard your test run changes before approving this revision."}</p>}
        </div>
      )}
      {review && (
        <div className="revision-confirmation" role="group" aria-label="Confirm report approval">
          <h3>Approve and close revision {revisionNumber(project, review.revision)}?</h3>
          <p><strong>{review.skidName}</strong> — {review.photoCount} photos, {review.commentCount} comments, {review.completedCount}/{targetCount} items reviewed, {review.testRunCount} test runs{review.setupPhotoCount > 0 && ` with ${review.setupPhotoCount} setup photos`}.</p>
          <p>Checked by <strong>{review.checkedByName}</strong>.</p>
          <p>Approval locks the inspection evidence and all saved test reports, including their setup photos, captions, software details, results, parameters, and graphs. Use New revision for any later changes.</p>
          {changed && <p className="field-error" role="alert">The report changed while you were reviewing. Cancel and review the updated report before approving.</p>}
          <div className="revision-actions">
            <button type="button" className="button secondary" disabled={blocked} onClick={() => setReview(null)}>Cancel</button>
            <button type="button" className="button primary" disabled={blocked || changed || checkerRequired || checkerDirty || hasDraftComments || hasDraftTests}
              onClick={() => action("approve", () => onApprove(review))}>
              {busy === "approve" ? "Approving…" : "Confirm approval & close"}
            </button>
          </div>
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      {revisions.length > 0 && (
        <div className="revision-history">
          <h3>Closed revisions</h3>
          <ul>
            {revisions.map((item) => (
              <li key={item.revision}>
                <div>
                  <strong>Revision {revisionNumber(project, item.revision)}</strong>
                  {item.revision < project.revisionNumberBase && <small>Previous numbering</small>}
                  <span>{item.skidName || project.skidName}</span>
                  <small>Checked by: {item.checkedByName || "Not recorded"}</small>
                  <small>Signed off by: {signatory(item)} · {approvedDate(item.closedAt)}</small>
                </div>
                <div className="revision-export-actions"><button type="button" className="small-button" disabled={blocked}
                  aria-label={`Export revision ${revisionNumber(project, item.revision)}${item.revision < project.revisionNumberBase ? ' (previous numbering)' : ''}`}
                  onClick={() => action(`export-${item.revision}`, () => onExport(item.revision))}>
                  <Icon name="download" size={15} />{busy === `export-${item.revision}` ? "Exporting…" : "Export PDF"}
                </button>
                {item.testRunCount > 0 && onExportTests && <button type="button" className="small-button" disabled={blocked}
                  aria-label={`Export test reports revision ${revisionNumber(project, item.revision)}${item.revision < project.revisionNumberBase ? ' (previous numbering)' : ''}`}
                  onClick={() => action(`tests-${item.revision}`, () => onExportTests(item.revision))}>
                  <Icon name="download" size={15} />{busy === `tests-${item.revision}` ? "Exporting…" : "Export test PDF"}
                </button>}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
