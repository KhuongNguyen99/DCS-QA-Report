import React, { useRef, useState } from "react";
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
  connected,
  config,
  backend,
}) {
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(draft);
  latest.current = draft;
  async function post(event) {
    event.preventDefault();
    const sent = latest.current;
    if (!sent.trim()) return;
    setPosting(true);
    setError("");
    try {
      await onPost(sent.trim());
      onDraft((current) => (current === sent ? "" : current));
    } catch (e) {
      setError(e.message);
    } finally {
      setPosting(false);
    }
  }
  function transcript(text) {
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
              <div>
                <strong>{item.authorName || "Inspector"}</strong>
                <time dateTime={item.createdAt}>
                  {formatDate(item.createdAt)}
                </time>
              </div>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      )}
      <VoiceComment
        disabled={!connected || posting}
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
          disabled={!connected || posting}
        />
        <div className="comment-form-footer">
          <small>{draft.length}/4,000</small>
          <button
            className="small-button"
            type="submit"
            disabled={!connected || posting || !draft.trim()}
          >
            {posting
              ? "Saving…"
              : recordKey === "walkdown:general"
                ? "Add walkdown comment"
                : "Add comment"}
          </button>
        </div>
      </form>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
