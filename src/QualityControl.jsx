import { useRef, useState } from "react";

export default function QualityControl({
  name,
  value,
  disabled = false,
  onChange,
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  async function choose(next) {
    if (disabled || pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      await onChange(value === next ? null : next);
    } catch (failure) {
      setError(failure?.message || "Quality could not be saved.");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  return (
    <div className="quality-control">
      <div className="quality-options">
        {["good", "bad"].map((choice) => (
          <label key={choice} className={`quality-choice ${choice}`}>
            <input
              type="checkbox"
              aria-label={`${choice === "good" ? "Passed" : "Failed"} quality for ${name}`}
              checked={value === choice}
              disabled={disabled || saving}
              onChange={() => choose(choice)}
            />
            {choice === "good" ? "Passed" : "Failed"}
          </label>
        ))}
      </div>
      {saving && <small role="status">Saving…</small>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
