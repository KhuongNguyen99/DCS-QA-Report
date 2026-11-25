import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatSourceTime, formatTestValue } from "./test-chart.js";
import { formatSourceTimeInput, parseSourceTimeInput, resolveGraphMeasurement } from "./test-graph-tools.js";
import GraphPointPicker from "./GraphPointPicker.jsx";

const UNIT_NAMES = { s: "seconds", min: "minutes", h: "hours" };
const STYLE_NAMES = { auto: "Automatic", line: "Line", step: "Step", smooth: "Smooth" };
const validName = value => value && value.length <= 160 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const graphReference = (deviceId, graphKey) => JSON.stringify([deviceId, graphKey]);

function useEditorNotice(key, dirty, onDirtyChange) {
  useEffect(() => { onDirtyChange?.(key, Boolean(dirty)); }, [key, dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(key, false), [key, onDirtyChange]);
}

export function DisplayNameEditor({ kind, sourceName, value, scope, canEdit, disabled,
  editorKey, onDirtyChange, onApply }) {
  const id = useId();
  const current = value || sourceName;
  const [entry, setEntry] = useState(() => ({ value: current, scope, edited: false }));
  const [error, setError] = useState("");
  const dirty = entry.edited && entry.value.trim() !== current;
  const stale = dirty && entry.scope !== scope;
  useEditorNotice(editorKey, dirty, onDirtyChange);
  useEffect(() => {
    setEntry(previous => previous.edited && previous.value.trim() !== current ? previous : { value: current, scope, edited: false });
  }, [current, scope]);
  function apply(name) {
    if (!canEdit || disabled || stale) return;
    if (!validName(name)) { setError("Enter a name of 1–160 characters without control characters."); return; }
    try {
      if (name !== current) onApply(name === sourceName ? null : name);
      setEntry({ value: name, scope, edited: false }); setError("");
    } catch (failure) { setError(failure.message); }
  }
  if (!canEdit && !dirty) return null;
  return <form className="test-display-name-editor" aria-label={`${kind} display name`} onSubmit={event => {
    event.preventDefault(); apply(entry.value.trim());
  }}>
    <label htmlFor={id}>{kind === "device" ? "Device" : "Graph"} display name</label>
    <div className="test-graph-tool-actions">
      <input id={id} value={entry.value} maxLength={160} disabled={!canEdit || disabled || stale}
        onChange={event => { setEntry(previous => ({ ...previous, value: event.target.value, edited: true })); setError(""); }} />
      <button type="submit" className="small-button" disabled={!canEdit || disabled || stale || !entry.value.trim()}>Apply {kind} name</button>
      <button type="button" className="small-button" disabled={!canEdit || disabled || stale} onClick={() => apply(sourceName)}>Use source {kind} name</button>
      {dirty && <button type="button" className="small-button" onClick={() => {
        setEntry({ value: current, scope, edited: false }); setError("");
      }}>Cancel {kind} name edit</button>}
    </div>
    <small>Source name: {sourceName}. Apply the display name, then save the test run.</small>
    {stale && <p className="field-error" role="alert">This report changed. Your entered name is retained; cancel this editor and reopen it for the current report.</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </form>;
}

function endpointEditor(endpoint, ownerGraph) {
  return {
    kind: endpoint?.kind || "point", point: endpoint?.kind === "point" ? endpoint : null,
    time: endpoint?.kind === "time" ? formatSourceTimeInput(endpoint.timeMs) : "",
    graph: ["point", "trigger"].includes(endpoint?.kind) ? graphReference(endpoint.deviceId, endpoint.graphKey) : ownerGraph,
    operator: endpoint?.kind === "trigger" ? endpoint.operator : ">",
    threshold: endpoint?.kind === "trigger" ? String(endpoint.threshold) : "",
    timeRange: endpoint?.kind === "trigger" && endpoint.timeRange ? { ...endpoint.timeRange } : null,
  };
}

function endpointValue(editor, clock, label) {
  if (editor.kind === "time") return { kind: "time", timeMs: parseSourceTimeInput(editor.time, clock) };
  if (editor.kind === "point") {
    if (!editor.point) throw new Error(`Pick a recorded ${label.toLowerCase()} point, or choose another time source.`);
    if (editor.graph !== graphReference(editor.point.deviceId, editor.point.graphKey))
      throw new Error(`Pick a recorded ${label.toLowerCase()} point on the selected graph.`);
    return editor.point;
  }
  if (!editor.graph) throw new Error(`Choose a graph for the ${label.toLowerCase()} trigger.`);
  if (!editor.threshold.trim() || !Number.isFinite(Number(editor.threshold))) throw new Error(`Enter a finite ${label.toLowerCase()} threshold.`);
  if (!editor.timeRange) throw new Error("Choose a valid Device time axis before applying a graph threshold.");
  const [deviceId, graphKey] = JSON.parse(editor.graph);
  return { kind: "trigger", deviceId, graphKey, operator: editor.operator, threshold: Number(editor.threshold),
    timeRange: { ...editor.timeRange } };
}

function EndpointGraphSelect({ id, label, value, graphChoices, onChange }) {
  const knownGraph = graphChoices.some(entry => graphReference(entry.deviceId, entry.graphKey) === value);
  return <>
    <label htmlFor={id}>{label}</label>
    <select id={id} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">Choose a graph</option>
      {value && !knownGraph && <option value={value}>Previously selected graph (unavailable)</option>}
      {graphChoices.map(entry => <option key={graphReference(entry.deviceId, entry.graphKey)} value={graphReference(entry.deviceId, entry.graphKey)}>
        {entry.deviceName} / {entry.name}{entry.series.unit ? ` (${entry.series.unit})` : ""}
      </option>)}
    </select>
  </>;
}

function EndpointEditor({ label, value, clock, graphChoices, timeRange, disabled, picking, selectedPicker,
  run, onChange, onPick, onChoose, onCancelPick }) {
  const id = useId();
  const pickButton = useRef(null);
  const wasPickingSelected = useRef(false);
  const selectedGraph = graphChoices.find(entry => graphReference(entry.deviceId, entry.graphKey) === value.graph);
  useEffect(() => {
    if (disabled || value.kind !== "trigger" || !timeRange) return;
    if (value.timeRange?.startMs !== timeRange.startMs || value.timeRange?.endMs !== timeRange.endMs)
      onChange({ ...value, timeRange: { startMs: timeRange.startMs, endMs: timeRange.endMs } });
  }, [disabled, value, timeRange?.startMs, timeRange?.endMs, onChange]);
  useEffect(() => {
    if (wasPickingSelected.current && !selectedPicker && !disabled) pickButton.current?.focus();
    wasPickingSelected.current = Boolean(selectedPicker);
  }, [selectedPicker, disabled]);
  function changeGraph(graph) {
    onCancelPick();
    onChange({ ...value, graph, point: null });
  }
  return <fieldset className="test-duration-endpoint" disabled={disabled}>
    <legend>{label}</legend>
    <label htmlFor={`${id}-source`}>{label} time source</label>
    <select id={`${id}-source`} value={value.kind} onChange={event => {
      onCancelPick();
      onChange({ ...value, kind: event.target.value });
    }}>
      <option value="point">Picked graph point</option><option value="time">Manual time</option><option value="trigger">Graph threshold</option>
    </select>
    {value.kind === "point" && <>
      <EndpointGraphSelect id={`${id}-point-graph`} label={`${label} point graph`} value={value.graph}
        graphChoices={graphChoices} onChange={changeGraph} />
      <div className="test-duration-point">
        <button type="button" className="small-button" ref={pickButton} disabled={!selectedGraph}
          onClick={() => onPick(false)}>{picking || selectedPicker ? `Picking ${label.toLowerCase()} point…` : `Pick ${label.toLowerCase()} point`}</button>
        <p>{value.point ? <>
          {formatSourceTime(value.point.timeMs, true, true)} · recorded value {formatTestValue(value.point.value)}{selectedGraph?.series.unit && ` ${selectedGraph.series.unit}`}
          {value.point.sourceRow != null && ` · source row ${value.point.sourceRow}`}
        </> : "Pick an original recorded point from the selected graph."}</p>
      </div>
    </>}
    {value.kind === "time" && <>
      <label htmlFor={`${id}-time`}>{label} source time</label>
      <input id={`${id}-time`} type="datetime-local" step="0.001" value={value.time}
        min={formatSourceTimeInput(clock.startMs)} max={formatSourceTimeInput(clock.endMs)}
        onChange={event => onChange({ ...value, time: event.target.value })} />
      <small>{clock.basis === "absolute" ? "UTC" : "Recorded source clock"}; include the date and time.</small>
    </>}
    {value.kind === "trigger" && <>
      <EndpointGraphSelect id={`${id}-graph`} label={`${label} threshold graph`} value={value.graph}
        graphChoices={graphChoices} onChange={changeGraph} />
      <button type="button" className="small-button test-pick-selected-graph" ref={pickButton} disabled={!selectedGraph}
        onClick={() => onPick(true)}>Pick {label.toLowerCase()} point from selected graph</button>
      <div className="test-duration-threshold">
        <div><label htmlFor={`${id}-comparison`}>{label} comparison</label><select id={`${id}-comparison`} value={value.operator} onChange={event => onChange({ ...value, operator: event.target.value })}>
          <option value=">">Greater than (&gt;)</option><option value=">=">At least (≥)</option>
          <option value="<">Less than (&lt;)</option><option value="<=">At most (≤)</option>
        </select></div>
        <div><label htmlFor={`${id}-threshold`}>{label} threshold</label><input id={`${id}-threshold`} type="number" step="any" value={value.threshold}
          onChange={event => onChange({ ...value, threshold: event.target.value })} /></div>
      </div>
      <small>{label === "Start" ? "First matching recorded reading within the Device time axis." : "First matching recorded reading at or after the resolved start, within the Device time axis."} Removed and invalid readings do not match.</small>
      {value.timeRange && <small className="test-threshold-time-range">
        Device time axis: {formatSourceTime(value.timeRange.startMs, true, true)} – {formatSourceTime(value.timeRange.endMs, true, true)}{clock.basis === "absolute" ? " UTC" : " (source clock)"}. This window is saved with the calculation.
      </small>}
    </>}
    {selectedPicker && selectedGraph && <GraphPointPicker run={run} entry={selectedGraph} label={label}
      timeRange={timeRange} disabled={disabled} onChoose={onChoose} onCancel={onCancelPick} />}
  </fieldset>;
}

function MeasurementResult({ run, measurement }) {
  const result = resolveGraphMeasurement(run, measurement);
  return <div className={`test-duration-result ${result.status}`} data-duration-status={result.status}>
    {result.status === "resolved" ? <strong>{formatTestValue(result.value)} {UNIT_NAMES[measurement.unit]}</strong>
      : <strong>{result.status === "unresolved" ? "Unresolved" : "Invalid interval"}: {result.reason}</strong>}
    <dl>{["start", "end"].map(field => <div key={field}><dt>{field === "start" ? "Start" : "End"}</dt>
      <dd>{result[field]?.status === "resolved" ? formatSourceTime(result[field].timeMs, true, true) : result[field]?.reason || "Not resolved"}
        {result[field]?.detail && <small>{result[field].detail}</small>}</dd></div>)}</dl>
  </div>;
}

export default function GraphToolsPanel({ run, deviceId, graphKey, sourceName, settings, graphChoices,
  graphTimeRange, scope, canEdit, disabled, editorKey, onDirtyChange, onChange, onStartPick, onCancelPick, picking }) {
  const [editor, setEditor] = useState(null);
  const [error, setError] = useState("");
  const [selectedPicker, setSelectedPicker] = useState(null);
  const id = useId();
  const ownerGraph = graphReference(deviceId, graphKey);
  const measurements = settings.measurements || [];
  const editorValue = editor && { name: editor.name, unit: editor.unit, start: editor.start, end: editor.end };
  const dirty = Boolean(editor && (editor.isNew || JSON.stringify(editorValue) !== editor.initial));
  const stale = Boolean(editor && editor.scope !== scope);
  const blocked = !canEdit || disabled || stale;
  const cancelPicking = useCallback(() => { setSelectedPicker(null); onCancelPick(); }, [onCancelPick]);
  useEditorNotice(`${editorKey}:calculation`, dirty, onDirtyChange);
  useEffect(() => { if (blocked) cancelPicking(); }, [blocked, cancelPicking]);
  useEffect(() => {
    if (selectedPicker && (!editor || selectedPicker.editorId !== editor.id || selectedPicker.scope !== scope
      || selectedPicker.graph !== editor[selectedPicker.field]?.graph
      || !graphChoices.some(entry => graphReference(entry.deviceId, entry.graphKey) === selectedPicker.graph))) cancelPicking();
  }, [selectedPicker, editor, scope, graphChoices, cancelPicking]);
  function change(settingsUpdate) {
    if (!canEdit || disabled) return;
    onChange(settingsUpdate); setError("");
  }
  function openEditor(measurement = null) {
    if (!canEdit || disabled || editor) return;
    const fields = { name: measurement?.name || "", unit: measurement?.unit || "s",
      start: endpointEditor(measurement?.start, ownerGraph), end: endpointEditor(measurement?.end, ownerGraph) };
    setEditor({ ...fields, id: measurement?.id || crypto.randomUUID(), isNew: !measurement, scope, initial: JSON.stringify(fields) });
    setError("");
  }
  function cancelEditor() { setEditor(null); setError(""); cancelPicking(); }
  function startPicking(field, useSelectedGraph) {
    if (blocked || !editor) return;
    const graph = editor[field].graph;
    if (!graphChoices.some(entry => graphReference(entry.deviceId, entry.graphKey) === graph)) return;
    cancelPicking();
    if (useSelectedGraph || graph !== ownerGraph) {
      setSelectedPicker({ field, graph, scope, editorId: editor.id });
    } else {
      onStartPick(field, endpoint => setEditor(previous => previous?.id === editor.id && previous.scope === scope
        && previous[field].kind === "point" && previous[field].graph === graph
        ? { ...previous, [field]: { ...previous[field], point: endpoint } } : previous));
    }
  }
  function chooseSelectedPoint(field, endpoint) {
    if (blocked || !editor || selectedPicker?.field !== field || selectedPicker.editorId !== editor.id
      || selectedPicker.scope !== scope || selectedPicker.graph !== editor[field].graph
      || selectedPicker.graph !== graphReference(endpoint.deviceId, endpoint.graphKey)
      || !graphTimeRange || endpoint.timeMs < graphTimeRange.startMs || endpoint.timeMs > graphTimeRange.endMs) return;
    setEditor(previous => previous?.id === editor.id ? { ...previous,
      [field]: { ...previous[field], kind: "point", point: endpoint, graph: selectedPicker.graph } } : previous);
    cancelPicking();
  }
  function candidate() {
    const name = editor.name.trim();
    if (!validName(name)) throw new Error("Enter a calculation name of 1–160 characters without control characters.");
    return { id: editor.id, name, unit: editor.unit,
      start: endpointValue(editor.start, run.clock, "Start"), end: endpointValue(editor.end, run.clock, "End") };
  }
  let preview = null;
  if (editor) { try { preview = candidate(); } catch { /* Incomplete editor fields are explained when applied. */ } }
  function apply(event) {
    event.preventDefault();
    if (blocked) return;
    try {
      const measurement = candidate();
      const resolved = resolveGraphMeasurement(run, measurement);
      if (resolved.status === "invalid") throw new Error(resolved.reason);
      change({ ...settings, measurements: editor.isNew ? [...measurements, measurement]
        : measurements.map(item => item.id === measurement.id ? measurement : item) });
      cancelEditor();
    } catch (failure) { setError(failure.message); }
  }
  return <section className="test-graph-tools" aria-label={`Graph tools for ${settings.name || sourceName}`}>
    {measurements.length > 0 && <div className="test-duration-list"><h4>Duration calculations</h4>
      {measurements.map((measurement, index) => <article key={measurement.id}>
        <h5>{measurement.name}</h5><MeasurementResult run={run} measurement={measurement} />
        {canEdit && <div className="test-graph-tool-actions">
          <button type="button" className="small-button" disabled={disabled || Boolean(editor)}
            aria-label={`Edit calculation ${measurement.name}${measurements.some((other, otherIndex) => otherIndex !== index && other.name === measurement.name) ? ` (${index + 1})` : ""}`}
            onClick={() => openEditor(measurement)}>Edit</button>
          <button type="button" className="small-button test-remove" disabled={disabled || Boolean(editor)}
            aria-label={`Remove calculation ${measurement.name}${measurements.some((other, otherIndex) => otherIndex !== index && other.name === measurement.name) ? ` (${index + 1})` : ""}`}
            onClick={() => { try { change({ ...settings, measurements: measurements.filter(item => item.id !== measurement.id) }); } catch (failure) { setError(failure.message); } }}>Remove</button>
        </div>}
      </article>)}
    </div>}
    <details className="test-graph-tools-editor" open={editor ? true : undefined}><summary>Graph tools</summary>
      <DisplayNameEditor kind="graph" sourceName={sourceName} value={settings.name} scope={scope}
        canEdit={canEdit} disabled={disabled} editorKey={`${editorKey}:name`} onDirtyChange={onDirtyChange}
        onApply={name => { const next = { ...settings }; if (name === null) delete next.name; else next.name = name; change(next); }} />
      {canEdit ? <div className="test-graph-style"><label htmlFor={`${id}-style`}>Graph style</label><select id={`${id}-style`} value={settings.style || "auto"} disabled={disabled}
        onChange={event => { try { change({ ...settings, style: event.target.value }); } catch (failure) { setError(failure.message); } }}>
        {Object.entries(STYLE_NAMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></div> : <p>Graph style: {STYLE_NAMES[settings.style || "auto"]}</p>}
      <p className="test-muted">Styles change the connecting trace. Calculations use original recorded readings.{canEdit && " Apply changes here, then save the test run."}</p>
      {canEdit && !editor && <button type="button" className="small-button" disabled={disabled || measurements.length >= 20}
        onClick={() => openEditor()}>Add duration calculation</button>}
      {editor && <form className="test-duration-editor" aria-label="Duration calculation" noValidate onSubmit={apply}>
        <h4>{editor.isNew ? "New duration calculation" : "Edit duration calculation"}</h4>
        <fieldset className="test-duration-metadata" disabled={blocked}>
          <label htmlFor={`${id}-name`}>Calculation name</label><input id={`${id}-name`} maxLength={160} value={editor.name}
            onChange={event => setEditor(previous => ({ ...previous, name: event.target.value }))} />
          <label htmlFor={`${id}-unit`}>Duration unit</label><select id={`${id}-unit`} value={editor.unit}
            onChange={event => setEditor(previous => ({ ...previous, unit: event.target.value }))}>
            {Object.entries(UNIT_NAMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </fieldset>
        <div className="test-duration-endpoints">{["start", "end"].map(field => <EndpointEditor key={field}
          label={field === "start" ? "Start" : "End"} value={editor[field]} clock={run.clock} graphChoices={graphChoices}
          run={run} timeRange={graphTimeRange} selectedPicker={selectedPicker?.field === field}
          disabled={blocked} picking={picking === field} onCancelPick={cancelPicking}
          onChange={value => setEditor(previous => ({ ...previous, [field]: value }))}
          onPick={useSelectedGraph => startPicking(field, useSelectedGraph)} onChoose={endpoint => chooseSelectedPoint(field, endpoint)} />)}</div>
        {preview && <MeasurementResult run={run} measurement={preview} />}
        {stale && <p className="field-error" role="alert">This report changed. Your calculation editor is retained; cancel it and reopen it for the current report.</p>}
        {!canEdit && <p className="field-error" role="status">Editing is paused. Your calculation editor is retained.</p>}
        <div className="test-graph-tool-actions">
          <button type="submit" className="small-button" disabled={blocked}>{editor.isNew ? "Add calculation" : "Update calculation"}</button>
          <button type="button" className="small-button" onClick={cancelEditor}>Cancel calculation</button>
        </div>
      </form>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </details>
  </section>;
}
