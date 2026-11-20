import React, { useRef, useState } from "react";
import Icon from "./Icons.jsx";

const approvedDate = (value) => new Date(value).toLocaleString(undefined, {
  dateStyle: "medium", timeStyle: "short",
});

export default function RevisionPanel({
  project, revisions = [], photoCount, commentCount, completedCount, targetCount,
  testRunCount = 0, pending = false, hasDraftComments = false, hasDraftTests = false,
  onApprove, onNewRevision, onExport, onExportTests,
}) {
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const closed = project.status === "closed";
  const supported = project.status === "draft" || closed;
  const changed = review && (review.walkdownId !== project.walkdownId
    || review.revision !== project.revision || review.contentVersion !== project.contentVersion
    || project.status !== "draft");
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
    if (blocked || hasDraftComments || hasDraftTests || project.status !== "draft") return;
    setError("");
    setReview({
      walkdownId: project.walkdownId, revision: project.revision,
      contentVersion: project.contentVersion, skidName: project.skidName,
      photoCount, commentCount, completedCount, testRunCount,
    });
  }

  return (
    <section className="card revision-panel" aria-label="Report revision">
      <div className="revision-heading">
        <div>
          <span className="eyebrow">REPORT REVISION</span>
          <h2>Revision {project.revision}</h2>
        </div>
        <span className={`revision-status ${closed ? "closed" : "draft"}`}>
          {closed ? <Icon name="check" size={15} /> : <Icon name="report" size={15} />}
          {closed ? "Approved & closed" : supported ? "Draft" : "Update required"}
        </span>
      </div>
      {!supported ? (
        <p className="field-error" role="alert">The workspace needs the report revision update before you can edit or export. Refresh after the update is complete.</p>
      ) : closed ? (
        <div className="revision-body">
          <p>Approved by <strong>{project.closedByName || "Inspector"}</strong> on {approvedDate(project.closedAt)}. This revision is locked and ready to export.</p>
          <button type="button" className="button secondary" disabled={blocked}
            onClick={() => action("new", () => onNewRevision(project.revision))}>
            <Icon name="plus" size={17} />{busy === "new" ? "Creating revision…" : "New revision"}
          </button>
          <small>A new draft starts with the current report’s content. This approved revision stays saved.</small>
        </div>
      ) : (
        <div className="revision-body">
          <p>Review the saved photos, comments, and test reports, then approve and close this revision to export it.</p>
          <span className="revision-summary">{photoCount} photos · {commentCount} comments · {completedCount}/{targetCount} items reviewed · {testRunCount} test runs</span>
          {!review && <button type="button" className="button primary" disabled={blocked || hasDraftComments || hasDraftTests} onClick={beginReview}>
            <Icon name="check" size={17} />Approve &amp; close
          </button>}
          {hasDraftComments && <p className="revision-draft-notice" role="status">Post or clear your draft comments before approving this revision.</p>}
          {hasDraftTests && <p className="revision-draft-notice" role="status">Save or discard your test run changes before approving this revision.</p>}
        </div>
      )}
      {review && (
        <div className="revision-confirmation" role="group" aria-label="Confirm report approval">
          <h3>Approve and close revision {review.revision}?</h3>
          <p><strong>{review.skidName}</strong> — {review.photoCount} photos, {review.commentCount} comments, {review.completedCount}/{targetCount} items reviewed, {review.testRunCount} test runs.</p>
          <p>Approval locks the inspection evidence and all saved test reports, including their software details, results, parameters, and graphs. Use New revision for any later changes.</p>
          {changed && <p className="field-error" role="alert">The report changed while you were reviewing. Cancel and review the updated report before approving.</p>}
          <div className="revision-actions">
            <button type="button" className="button secondary" disabled={blocked} onClick={() => setReview(null)}>Cancel</button>
            <button type="button" className="button primary" disabled={blocked || changed || hasDraftComments || hasDraftTests}
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
                  <strong>Revision {item.revision}</strong>
                  <span>{item.skidName || project.skidName}</span>
                  <small>{item.closedByName || "Inspector"} · {approvedDate(item.closedAt)}</small>
                </div>
                <div className="revision-export-actions"><button type="button" className="small-button" disabled={blocked}
                  aria-label={`Export revision ${item.revision}`}
                  onClick={() => action(`export-${item.revision}`, () => onExport(item.revision))}>
                  <Icon name="download" size={15} />{busy === `export-${item.revision}` ? "Exporting…" : "Export PDF"}
                </button>
                {item.testRunCount > 0 && onExportTests && <button type="button" className="small-button" disabled={blocked}
                  aria-label={`Export test reports revision ${item.revision}`}
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
