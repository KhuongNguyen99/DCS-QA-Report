import React, { useEffect, useRef, useState } from "react";
import VoiceComment from "./VoiceComment.jsx";

const formatDate = (value) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export default function CommentPanel({
  recordKey,
  title = "Inspection comments",
  comments,
  draft,
  onDraft,
  onPost,
  onDelete,
  inspector,
  readOnly = false,
  connected,
  config,
  backend,
}) {
  const [posting, setPosting] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [confirmRemoval, setConfirmRemoval] = useState(null);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const access = useRef({ connected, readOnly });
  access.current = { connected, readOnly };
  const latest = useRef(draft);
  latest.current = draft;
  const busy = posting || Boolean(removing);
  const canRemove = (item) => connected && !readOnly && typeof onDelete === "function"
    && Boolean(inspector?.id && (inspector.isAdmin || inspector.id === item.createdBy));
  useEffect(() => {
    if (!connected || readOnly) setConfirmRemoval(null);
  }, [connected, readOnly]);
  async function post(event) {
    event.preventDefault();
    if (!access.current.connected || access.current.readOnly || pending.current) return;
    const sent = latest.current;
    if (!sent.trim()) return;
    pending.current = true;
    setPosting(true);
    setError("");
    try {
      await onPost(sent.trim());
      onDraft((current) => (current === sent ? "" : current));
    } catch (e) {
      setError(e.message);
    } finally {
      pending.current = false;
      setPosting(false);
    }
  }
  async function remove(item) {
    if (!canRemove(item) || pending.current || confirmRemoval !== item.id) return;
    pending.current = true;
    setRemoving(item.id);
    setError("");
    try {
      await onDelete(item.id);
      setConfirmRemoval(null);
    } catch (failure) {
      setError(failure?.message || "The comment could not be removed. Try again.");
    } finally {
      pending.current = false;
      setRemoving(null);
    }
  }
  function transcript(text) {
    if (!access.current.connected || access.current.readOnly) return;
    const next = [latest.current.trimEnd(), text].filter(Boolean).join("\n");
    if (next.length > 4000)
      throw new Error(
        "The combined comment exceeds 4,000 characters. Shorten the draft, then retry the recording.",
      );
    latest.current = next;
    onDraft(next);
  }
  return (
    <section className="comments-section">
      <h3>
        {title} <span>{comments.length}</span>
      </h3>
      {comments.length > 0 && (
        <div className="comment-list">
          {comments.map((item) => (
            <article className="comment" key={item.id}>
              <div className="comment-heading">
                <strong>{item.authorName || "Inspector"}</strong>
                <time dateTime={item.createdAt}>
                  {formatDate(item.createdAt)}
                </time>
              </div>
              <p>{item.text}</p>
              {canRemove(item) && (
                confirmRemoval === item.id ? (
                  <div className="comment-remove-confirmation" role="group" aria-label="Remove comment confirmation">
                    <span>Remove this comment from the current draft?</span>
                    <div className="comment-actions">
                      <button type="button" className="small-button" disabled={busy}
                        onClick={() => setConfirmRemoval(null)}>
                        Cancel
                      </button>
                      <button type="button" className="small-button comment-remove-button" disabled={busy}
                        onClick={() => remove(item)}>
                        {removing === item.id ? "Removing…" : "Remove comment"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="text-button comment-remove-button" disabled={busy}
                    aria-label={`Remove comment by ${item.authorName || "Inspector"}`}
                    onClick={() => { setConfirmRemoval(item.id); setError(""); }}>
                    Remove
                  </button>
                )
              )}
            </article>
          ))}
        </div>
      )}
      {!readOnly && <><VoiceComment
        disabled={!connected || busy}
        config={config}
        backend={backend}
        recordKey={recordKey}
        onTranscript={transcript}
      />
      <form onSubmit={post}>
        <label htmlFor={`comment-${recordKey}`} className="sr-only">
          Add{" "}
          {recordKey === "walkdown:general" ? "general walkdown" : "inspection"}{" "}
          comment
        </label>
        <textarea
          id={`comment-${recordKey}`}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          maxLength={4000}
          placeholder={
            recordKey === "walkdown:general" ? "Walkdown comment…" : "Comment…"
          }
          disabled={!connected || busy}
        />
        <div className="comment-form-footer">
          <small>{draft.length}/4,000</small>
          <button
            className="small-button"
            type="submit"
            disabled={!connected || busy || !draft.trim()}
          >
            {posting
              ? "Saving…"
              : recordKey === "walkdown:general"
                ? "Add walkdown comment"
                : "Add comment"}
          </button>
        </div>
      </form></>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
