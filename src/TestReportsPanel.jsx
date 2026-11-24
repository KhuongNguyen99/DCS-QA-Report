import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Icon from "./Icons.jsx";
import { revisionNumber } from "./domain.js";
import PhotoGallery from "./PhotoGallery.jsx";
import { parsePronetaFiles } from "./proneta-parser.js";
import { importNoteClarification } from "./proneta-notes.js";
import { buildTestChart, deviceChartTimeRange, isTestTimeRange, formatSourceTime, formatTestValue, isDigitalOutputChannel } from "./test-chart.js";
import { testCommentDraftScope, readTestCommentDrafts, writeTestCommentDraft, removeTestCommentDraft } from "./test-comment-drafts.js";
import { testCommentBlocks } from "./test-comment-format.js";
import { testTimeRangeScope, readDeviceTimeRange, saveDeviceTimeRange, resetDeviceTimeRange,
  readTestSelection, rememberTestSelection } from "./test-time-ranges.js";
import { testGraphOrderScope, normalizeGraphOrder, orderDeviceGraphs,
  readDeviceGraphOrder, saveDeviceGraphOrder, resetDeviceGraphOrder } from "./test-graph-order.js";
import { createTestEventEdit, setTestEventEdit, applyTestEventEdits } from "./test-event-edits.js";
import { UNKNOWN_TIME_ZONE, getLocalTimeZone, getTimeZoneOptions } from "./test-timezones.js";
import GraphToolsPanel, { DisplayNameEditor } from "./GraphToolsPanel.jsx";
import { emptyGraphTools, assertGraphTools, getDeviceDisplayName, getGraphSettings, runGraphEntries, createPointEndpoint } from "./test-graph-tools.js";
import "./test-reports.css";

const statusClass = (status) => status === "Passed" ? "passed" : status === "Failed" ? "failed" : "untested";
const describeTime = (clock) => Number.isFinite(clock?.startMs) && Number.isFinite(clock?.endMs)
  ? `${formatSourceTime(clock.startMs, true)} – ${formatSourceTime(clock.endMs, true)}${clock.basis === "absolute" ? " UTC" : ""}`
  : "No timestamped events in this run";
const EMPTY_SOFTWARE = { name: "Siemens PRONETA Basic", version: "" };

function TestStatus({ status }) {
  return <span className={`test-status ${statusClass(status)}`}>{status || "Not tested"}</span>;
}

function TestComment({ title, label = title, value, onChange, disabled, editing = true }) {
  const text = typeof value === "string" ? value : "";
  const blocks = testCommentBlocks(text);
  const hasDiagnostics = blocks.some(block => block.kind === "diagnostics");
  return <section className="test-comment" aria-label={label}>
    <h4>{title}</h4>
    {onChange && (editing || !hasDiagnostics) ? <>
      <label><span className="sr-only">{label}</span><textarea rows={3} maxLength={8000}
        value={text} onChange={event => onChange(Array.from(event.target.value).slice(0, 4000).join(""))}
        disabled={disabled} placeholder="Add a comment…" /></label>
      <small>{Array.from(text).length}/4,000 · Save with Save test run.</small>
    </> : hasDiagnostics ? blocks.map(({ kind, lines }, index) => kind === "diagnostics"
      ? <ul className="test-comment-diagnostics" key={index}>
        {lines.map((diagnostic, item) => <li key={item}>{diagnostic} <TestStatus status="Passed" /></li>)}
      </ul>
      : lines.join("\n").trim() && <p key={index}>{lines.join("\n").trim()}</p>)
    : <p className={text ? "" : "test-muted"}>{text || "No comment added."}</p>}
  </section>;
}

function DeviceTimeAxis({ clock, timeRange, onChange, warning }) {
  const [start, setStart] = useState(() => timeRange?.startMs ?? clock?.startMs);
  const [end, setEnd] = useState(() => timeRange?.endMs ?? clock?.endMs);
  const [error, setError] = useState("");
  const startHandle = useRef(null);
  const endHandle = useRef(null);
  if (!Number.isSafeInteger(clock?.startMs) || !Number.isSafeInteger(clock?.endMs) || clock.endMs <= clock.startMs) return null;
  const span = clock.endMs - clock.startMs;
  const startPercent = (start - clock.startMs) / span * 100;
  const endPercent = (end - clock.startMs) / span * 100;
  const midpoint = (startPercent + endPercent) / 2;
  const includeDate = formatSourceTime(clock.startMs, true).slice(0, 10) !== formatSourceTime(clock.endMs, true).slice(0, 10);
  const labelTime = value => formatSourceTime(value, includeDate, value % 1000 !== 0);
  function moveStart(value) {
    if (Number.isFinite(value)) setStart(Math.max(clock.startMs, Math.min(Math.round(value), end - 1)));
    setError("");
  }
  function moveEnd(value) {
    if (Number.isFinite(value)) setEnd(Math.min(clock.endMs, Math.max(Math.round(value), start + 1)));
    setError("");
  }
  return <form className="test-time-axis" aria-label="Device time axis" onSubmit={event => {
    event.preventDefault();
    const range = { startMs: start, endMs: end };
    if (!isTestTimeRange(range, clock)) {
      setError("Choose a start before the end, within the recorded run time span."); return;
    }
    setError(""); onChange(range);
  }}>
    <div className="test-time-axis-heading"><strong>Device time axis</strong><span>{timeRange ? "Manual" : "Automatic"}</span></div>
    <div className="test-time-slider-labels">
      <span>Start time<strong>{labelTime(start)}</strong></span><span>End time<strong>{labelTime(end)}</strong></span>
    </div>
    <div className="test-time-slider" role="group" aria-label="Select device time interval" onPointerDown={event => {
      if (event.target.tagName === "INPUT") return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (!bounds.width) return;
      const value = clock.startMs + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * span;
      event.preventDefault();
      if (Math.abs(value - start) <= Math.abs(value - end)) { moveStart(value); startHandle.current?.focus(); }
      else { moveEnd(value); endHandle.current?.focus(); }
    }}>
      <div className="test-time-slider-track"><span style={{ left: `${startPercent}%`, right: `${100 - endPercent}%` }} /></div>
      <div className="test-time-slider-handle" style={{ clipPath: `inset(-8px ${100 - midpoint}% -8px -16px)` }}>
        <input ref={startHandle} name="rangeStart" type="range" aria-label="Start time" step={1}
          min={clock.startMs} max={clock.endMs} value={start} aria-valuemax={end - 1}
          aria-valuetext={formatSourceTime(start, true, start % 1000 !== 0)}
          onChange={event => moveStart(event.target.valueAsNumber)} />
      </div>
      <div className="test-time-slider-handle" style={{ clipPath: `inset(-8px -16px -8px ${midpoint}%)` }}>
        <input ref={endHandle} name="rangeEnd" type="range" aria-label="End time" step={1}
          min={clock.startMs} max={clock.endMs} value={end} aria-valuemin={start + 1}
          aria-valuetext={formatSourceTime(end, true, end % 1000 !== 0)}
          onChange={event => moveEnd(event.target.valueAsNumber)} />
      </div>
    </div>
    <div className="test-time-axis-actions">
      <button className="small-button" type="submit">Apply time range</button>
      <button className="small-button" type="button" onClick={() => {
        setStart(clock.startMs); setEnd(clock.endMs); setError(""); onChange(null);
      }}>Reset to auto</button>
    </div>
    <p>Applies to all graphs for this device and its PDF. Times use {clock.basis === "absolute" ? "UTC" : "the recorded source clock"}.</p>
    {error && <p className="field-error" role="alert">{error}</p>}
    {warning && <p className="field-error" role="alert">{warning}</p>}
  </form>;
}

function DeviceGraphOrder({ entries, onChange, warning, disabled = false }) {
  const [draggedKey, setDraggedKey] = useState(null);
  const [dropKey, setDropKey] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  const dragged = useRef(null);
  const buttons = useRef(new Map());
  const pendingFocus = useRef(null);
  const nameCounts = new Map();
  const graphName = entry => entry.displayName || entry.series.name;
  for (const entry of entries) nameCounts.set(graphName(entry), (nameCounts.get(graphName(entry)) || 0) + 1);
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    const preferred = buttons.current.get(`${pending.key}:${pending.direction}`);
    const fallback = buttons.current.get(`${pending.key}:${pending.direction === "up" ? "down" : "up"}`);
    (preferred && !preferred.disabled ? preferred : fallback)?.focus();
    pendingFocus.current = null;
  }, [entries]);
  function move(key, targetIndex, direction = null) {
    const index = entries.findIndex(entry => entry.key === key);
    if (disabled || index < 0 || index === targetIndex || targetIndex < 0 || targetIndex >= entries.length) return;
    const next = entries.map(entry => entry.key);
    next.splice(targetIndex, 0, next.splice(index, 1)[0]);
    if (direction) pendingFocus.current = { key, direction };
    onChange(next);
    setAnnouncement(`${graphName(entries[index])} moved to position ${targetIndex + 1} of ${entries.length}.`);
  }
  function finishDrag() { dragged.current = null; setDraggedKey(null); setDropKey(null); }
  return <details className="test-graph-order">
    <summary>Arrange graphs</summary>
    <p>Drag graphs or use the buttons. Your order saves in this browser and applies to this device’s PDF.</p>
    <ol aria-label="Graph order">{entries.map((entry, index) => {
      const label = nameCounts.get(graphName(entry)) > 1 ? `${graphName(entry)} (graph ${index + 1} of ${entries.length})` : graphName(entry);
      return <li key={entry.key} draggable={!disabled}
      className={[draggedKey === entry.key && "is-dragging", dropKey === entry.key && "is-drop-target"].filter(Boolean).join(" ")}
      onDragStart={event => {
        if (disabled) { event.preventDefault(); return; }
        dragged.current = entry.key; setDraggedKey(entry.key);
        if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", entry.key); }
      }} onDragOver={event => {
        if (!dragged.current || dragged.current === entry.key) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        setDropKey(entry.key);
      }} onDrop={event => {
        if (!dragged.current) return;
        event.preventDefault(); move(dragged.current, index); finishDrag();
      }} onDragEnd={finishDrag}>
      <span className="test-graph-drag-handle" aria-hidden="true">⠿</span>
      <div className="test-graph-order-label"><strong>{graphName(entry)}</strong>
        <span>{entry.series.unit || (entry.series.kind === "digital" ? "State" : "Recorded value")}</span>
        <small>{entry.channel.symbolicName || `Channel ${entry.channel.channel}`}</small>
      </div>
      <div className="test-graph-order-actions">{["up", "down"].map(direction => <button key={direction} type="button" className="small-button"
        ref={button => { const key = `${entry.key}:${direction}`; if (button) buttons.current.set(key, button); else buttons.current.delete(key); }}
        disabled={disabled || (direction === "up" ? index === 0 : index === entries.length - 1)}
        aria-label={`Move ${label} ${direction}`}
        onClick={() => move(entry.key, index + (direction === "up" ? -1 : 1), direction)}>Move {direction}</button>)}</div>
    </li>;
    })}</ol>
    <button type="button" className="small-button" disabled={disabled} onClick={() => {
      onChange(null); setAnnouncement("Graph order reset to the original order.");
    }}>Reset graph order</button>
    <p className="test-graph-order-feedback" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    {warning && <p className="field-error" role="alert">{warning}</p>}
  </details>;
}

function graphChannelGroups(device, entries) {
  const groups = [];
  for (const entry of entries) {
    let group = groups.at(-1);
    if (!group || group.channelIndex !== entry.channelIndex) {
      group = { key: entry.key, channel: entry.channel, channelIndex: entry.channelIndex, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  for (const [channelIndex, channel] of (device?.channels || []).entries()) {
    if (entries.some(entry => entry.channelIndex === channelIndex)) continue;
    const next = groups.findIndex(group => group.channelIndex > channelIndex);
    groups.splice(next < 0 ? groups.length : next, 0, { key: `empty:${channelIndex}`, channel, channelIndex, entries: [] });
  }
  return groups;
}

function TestEventTable({ entries, seriesName = "recorded signal", onExclusionChange, disabled, restoring = false }) {
  return <div className="test-table-scroll"><table>
    <thead><tr><th>Source time</th><th>Previous</th><th>Recorded value</th><th>Source row</th>{onExclusionChange && <th>Action</th>}</tr></thead>
    <tbody>{entries.map(({ point, index }) => <tr key={index}>
      <td>{point.time || formatSourceTime(point.timeMs, true)}</td>
      <td>{point.previousRawValue ?? formatTestValue(point.previousValue)}</td>
      <td>{point.rawValue ?? formatTestValue(point.value)}{point.valid === false && " (invalid)"}</td>
      <td>{point.sourceRow}</td>
      {onExclusionChange && <td><button type="button" className={`small-button ${restoring ? "" : "test-remove"}`}
        disabled={disabled} aria-label={`${restoring ? "Restore" : "Remove"} event from ${seriesName}, ${point.sourceRow == null ? `event ${index + 1}` : `source row ${point.sourceRow}`}`}
        onClick={() => onExclusionChange(index, !restoring)}>{restoring ? "Restore" : "Remove"}</button></td>}
    </tr>)}</tbody>
  </table></div>;
}

export function TestSeriesChart({ series, clock, timeRange = null, deviceTimeRange = null, onExclusionChange, editsDisabled = false, showInitialState = false,
  run, deviceId, graphKey, settings = {}, graphChoices = [], graphEditorScope, onGraphSettingsChange, onGraphEditorDirty }) {
  const [picker, setPicker] = useState(null);
  const [pickError, setPickError] = useState("");
  const figure = useRef(null);
  const cancelPicking = useCallback(() => { setPicker(null); setPickError(""); }, []);
  const canPick = Boolean(picker && onGraphSettingsChange && !editsDisabled);
  const displayName = settings.name || series.name;
  useEffect(() => { if (picker) figure.current?.querySelector('.test-observation[role="button"]')?.focus(); }, [picker]);
  useEffect(() => { if (!onGraphSettingsChange || editsDisabled) setPicker(null); }, [onGraphSettingsChange, editsDisabled]);
  function pick(point) {
    if (!canPick) return;
    try { picker.choose(createPointEndpoint(run, deviceId, graphKey, point.pointIndex)); setPicker(null); setPickError(""); }
    catch (failure) { setPickError(failure.message); }
  }
  let chart;
  try { chart = buildTestChart(series, clock, { timeRange, deviceTimeRange, showInitialState, style: settings.style || "auto" }); }
  catch (e) { return <p className="field-error">{e.message}</p>; }
  const { plot } = chart;
  const entries = series.points.map((point, index) => ({ point, index }));
  const retained = entries.filter(({ point }) => point.excluded !== true);
  const removed = entries.filter(({ point }) => point.excluded === true);
  const graphClock = { ...clock, startMs: chart.domain.startMs, endMs: chart.domain.endMs };
  return (
    <figure className="test-chart" ref={figure} onKeyDown={event => { if (event.key === "Escape" && picker) { event.preventDefault(); setPicker(null); } }}>
      <figcaption><div><strong>{displayName}</strong>{displayName !== series.name && <small>Source: {series.name}</small>}</div><span>{chart.unit}</span></figcaption>
      {canPick && <div className="test-point-picker" role="status">
        <strong>Picking {picker.field} point on {displayName}</strong>
        <p>Choose a recorded dot with the pointer or keyboard. You can also choose Manual time in the calculation editor.</p>
        {!chart.points.length && <p>No recorded points are visible. Reset the time range or enter a manual time.</p>}
        <button type="button" className="small-button" onClick={() => setPicker(null)}>Cancel point picking</button>
      </div>}
      {pickError && <p className="field-error" role="alert">{pickError}</p>}
      <div className="test-chart-scroll">
        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role={canPick ? "group" : "img"}
          aria-label={`${displayName}: ${chart.observedCount} recorded values, ${describeTime(graphClock)}${chart.initialLabel ? `, ${chart.initialLabel}` : ""}`}
          data-time-start={chart.domain.startMs} data-time-end={chart.domain.endMs}>
          {chart.yTicks.map((tick, index) => <g key={`y-${index}`}>
            <line x1={plot.left} y1={tick.y} x2={plot.left + plot.width} y2={tick.y} className="test-gridline" />
            <text x={plot.left - 8} y={tick.y + 4} textAnchor="end">{tick.label}</text>
          </g>)}
          {chart.xTicks.map((tick, index) => <g key={`x-${index}`}>
            <line x1={tick.x} y1={plot.top} x2={tick.x} y2={plot.top + plot.height} className="test-gridline" />
            <text x={tick.x} y={plot.top + plot.height + 21} textAnchor="middle">{tick.label}</text>
            {tick.dateLabel && <text x={tick.x} y={plot.top + plot.height + 37} textAnchor="middle">{tick.dateLabel}</text>}
          </g>)}
          {chart.connections.map((segment, index) => <line key={`trace-${index}`}
            x1={segment.from.x} y1={segment.from.y} x2={segment.to.x} y2={segment.to.y} className="test-trace" />)}
          {chart.curves.map((curve, index) => <path key={`curve-${index}`} className="test-trace test-smooth-trace"
            d={`M ${curve.from.x} ${curve.from.y} C ${curve.control1.x} ${curve.control1.y} ${curve.control2.x} ${curve.control2.y} ${curve.to.x} ${curve.to.y}`} />)}
          {chart.leading && <line x1={chart.leading.from.x} y1={chart.leading.from.y}
            x2={chart.leading.to.x} y2={chart.leading.to.y} className="test-held-value test-initial-state">
            <title>{chart.initialLabel} before the first recorded change</title>
          </line>}
          {chart.extension && <line x1={chart.extension.from.x} y1={chart.extension.from.y}
            x2={chart.extension.to.x} y2={chart.extension.to.y} className="test-held-value">
            <title>Last recorded value held to the end of the graph</title>
          </line>}
          {chart.points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={canPick ? 7 : 3}
            className={`test-observation${canPick ? " is-pickable" : ""}`} data-point-index={point.pointIndex}
            role={canPick ? "button" : undefined} tabIndex={canPick ? 0 : undefined}
            aria-label={canPick ? `Choose ${picker.field}: ${formatSourceTime(point.timeMs, true, true)}, ${formatTestValue(point.value)} ${chart.unit}, source row ${point.sourceRow ?? point.pointIndex + 1}` : undefined}
            onClick={() => pick(point)} onKeyDown={event => {
              if (canPick && ["Enter", " "].includes(event.key)) { event.preventDefault(); pick(point); }
            }}>
            <title>{formatSourceTime(point.timeMs, true)}: {formatTestValue(point.value)} {series.unit} · source row {point.sourceRow}</title>
          </circle>)}
          {chart.invalidPoints.filter(point => point.x !== null).map((point, index) =>
            <path key={`invalid-${index}`} d={`M${point.x - 4} ${plot.top + plot.height - 4}l8 8m-8 0l8 -8`} className="test-invalid-observation">
              <title>{point.time}: invalid reading {point.rawValue}</title>
            </path>)}
        </svg>
      </div>
      <p>{chart.initialLabel && <>{chart.initialLabel}. </>}{chart.manualTimeRange ? `${chart.visibleObservedCount} of ${chart.observedCount}` : chart.observedCount} recorded change values{chart.manualTimeRange && " shown"}{chart.invalidCount ? ` · ${chart.invalidCount} invalid readings` : ""}{chart.excludedCount ? ` · ${chart.excludedCount} removed events` : ""}. {chart.interpolation === "step" ? series.kind === "digital" ? "Steps connect recorded states" : "Steps hold each recorded value until the next reading" : chart.interpolation === "smooth" ? "Smooth curves connect recorded readings" : "Lines connect recorded readings"}; the dashed tail holds the last value to the graph end. {chart.manualTimeRange ? "The manual device time range applies; readings outside it remain in the recorded events." : "All graphs for this device share the same automatic time axis."}{clock.basis === "absolute" && " Times are UTC."}</p>
      {run && graphKey && <GraphToolsPanel run={run} deviceId={deviceId} graphKey={graphKey} sourceName={series.name} settings={settings}
        graphChoices={graphChoices} scope={graphEditorScope} canEdit={Boolean(onGraphSettingsChange)} disabled={editsDisabled}
        editorKey={JSON.stringify([run.id, deviceId, graphKey])} onDirtyChange={onGraphEditorDirty} onChange={onGraphSettingsChange}
        picking={canPick ? picker.field : null} onStartPick={(field, choose) => { setPicker({ field, choose }); setPickError(""); }}
        onCancelPick={cancelPicking} />}
      <details className="test-events"><summary>View recorded events ({retained.length})</summary>
        <TestEventTable entries={retained} seriesName={series.name} onExclusionChange={onExclusionChange} disabled={editsDisabled} />
      </details>
      {removed.length > 0 && <details className="test-events test-removed-events"><summary>Removed events ({removed.length})</summary>
        <TestEventTable entries={removed} seriesName={series.name} onExclusionChange={onExclusionChange} disabled={editsDisabled} restoring />
      </details>}
    </figure>
  );
}

function Parameters({ parameters = [], title = "Set parameters" }) {
  if (!parameters.length) return <p className="test-muted">No saved parameters were supplied for this channel.</p>;
  return <details className="test-parameters">
    <summary>{title} ({parameters.length})</summary>
    <div className="test-table-scroll"><table>
      <thead><tr><th>Parameter</th><th>Selected value</th><th>Record</th></tr></thead>
      <tbody>{parameters.map((parameter, index) => <tr key={index}>
        <td>{parameter.name}{parameter.help && <small>{parameter.help}</small>}</td>
        <td><strong>{String(parameter.value ?? parameter.rawValue ?? "—")}{parameter.unit ? ` ${parameter.unit}` : ""}</strong>
          {parameter.enumId && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(String(parameter.value)) && String(parameter.value) === String(parameter.rawValue) && <small>Encoded selection</small>}
          {parameter.rawValue != null && String(parameter.value) !== String(parameter.rawValue) && <small>Raw: {String(parameter.rawValue)}</small>}</td>
        <td>{parameter.recordIndex ?? "—"}</td>
      </tr>)}</tbody>
    </table></div>
  </details>;
}

export function TestRunDetail({ run, runId = run.id, onCommentChange, commentsDisabled = false, editingComments = true,
  timeRangeScope = null, selectionScope = null, rangeOverrides = {}, onTimeRangeChange, onEventExclusionChange,
  graphOrderScope = null, orderOverrides = {}, onGraphOrderChange,
  onGraphToolsChange, graphEditorDirty = false, onGraphEditorDirty, graphEditorScope }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(() => readTestSelection(selectionScope, runId));
  const [localRanges, setLocalRanges] = useState({});
  const [localOrders, setLocalOrders] = useState({});
  const devices = run.devices || [];
  const shown = useMemo(() => devices.filter(device => `${getDeviceDisplayName(device, run.graphTools)} ${device.name} ${device.status}`.toLowerCase().includes(search.toLowerCase())), [devices, run.graphTools, search]);
  const device = shown.find(item => item.id === selected) || shown[0];
  const displayDeviceName = getDeviceDisplayName(device, run.graphTools);
  const graphChoices = useMemo(() => runGraphEntries(run), [run]);
  const availableGraphs = new Set(graphChoices.map(entry => JSON.stringify([entry.deviceId, entry.graphKey])));
  const unmatchedTools = (run.graphTools?.graphs || []).filter(entry => !availableGraphs.has(JSON.stringify([entry.deviceId, entry.graphKey])));
  const viewKey = JSON.stringify([timeRangeScope, runId, device?.id, run.clock?.startMs, run.clock?.endMs]);
  const storedRange = useMemo(() => readDeviceTimeRange(timeRangeScope, runId, device?.id, run.clock),
    [timeRangeScope, runId, device?.id, run.clock?.startMs, run.clock?.endMs]);
  const override = rangeOverrides[device?.id];
  const chosenRange = localRanges[viewKey] || (Object.hasOwn(rangeOverrides, device?.id)
    && (override === null || isTestTimeRange(override, run.clock)) ? { range: override, error: "" } : storedRange);
  const automaticRange = deviceChartTimeRange(device, run.clock);
  const sliderClock = { ...run.clock,
    startMs: Math.min(automaticRange.startMs, chosenRange.range?.startMs ?? automaticRange.startMs),
    endMs: Math.max(automaticRange.endMs, chosenRange.range?.endMs ?? automaticRange.endMs) };
  const sliderKey = JSON.stringify([viewKey, sliderClock.startMs, sliderClock.endMs, chosenRange.range]);
  const orderViewKey = JSON.stringify([graphOrderScope, runId, device?.id]);
  const storedOrder = useMemo(() => readDeviceGraphOrder(graphOrderScope, runId, device), [graphOrderScope, runId, device]);
  const chosenOrder = localOrders[orderViewKey] || (Object.hasOwn(orderOverrides, device?.id)
    ? { order: orderOverrides[device?.id], error: "" } : storedOrder);
  const orderedGraphs = useMemo(() => orderDeviceGraphs(device, chosenOrder.order).map(entry => ({ ...entry,
    displayName: getGraphSettings(run.graphTools, device?.id, entry.key).name || entry.series.name })), [device, chosenOrder.order, run.graphTools]);
  const graphGroups = graphChannelGroups(device, orderedGraphs);
  function changeTimeRange(range) {
    const error = range ? saveDeviceTimeRange(timeRangeScope, runId, device.id, run.clock, range)
      : resetDeviceTimeRange(timeRangeScope, runId, device.id);
    setLocalRanges(previous => ({ ...previous, [viewKey]: { range, error } }));
    onTimeRangeChange?.(timeRangeScope, runId, device.id, range);
  }
  function changeGraphOrder(order) {
    if (graphEditorDirty) return;
    const normalized = order === null ? null : normalizeGraphOrder(device, order);
    const error = normalized ? saveDeviceGraphOrder(graphOrderScope, runId, device, normalized)
      : resetDeviceGraphOrder(graphOrderScope, runId, device.id);
    setLocalOrders(previous => ({ ...previous, [orderViewKey]: { order: normalized, error } }));
    onGraphOrderChange?.(graphOrderScope, runId, device.id, normalized);
  }
  const counts = devices.reduce((result, item) => ({ ...result, [item.status]: (result[item.status] || 0) + 1 }), {});
  const noteClarification = importNoteClarification(run.warnings);
  return <div className="test-run-detail">
    <div className="test-run-facts">
      <div><span>Software</span><strong>{run.software?.name} {run.software?.version || "— version required"}</strong></div>
      <div><span>Run time span</span><strong>{describeTime(run.clock)}</strong><small>{run.clock?.basis === "absolute" ? "Graphs use UTC. Original event timestamps retain their source offsets." : run.clock?.timeZone || "Source clock, timezone not recorded"}</small></div>
      <div><span>Device results</span><strong>{counts.Passed || 0} passed · {counts.Failed || 0} failed · {counts["Not tested"] || 0} not tested</strong></div>
    </div>
    <p className="test-meaning">Passed/Failed comes from the recorded PRONETA wiring result. Graphs show logged signal changes in their original units.</p>
    {unmatchedTools.length > 0 && <details className="test-unmatched-graph-tools" open>
      <summary>{unmatchedTools.length} saved graph configuration{unmatchedTools.length === 1 ? " has" : "s have"} no matching graph</summary>
      <p>These names, styles, and calculations are retained. Restore the matching source files to view them with their graph.</p>
      <ul>{unmatchedTools.map(item => <li key={JSON.stringify([item.deviceId, item.graphKey])}>{item.name || "Previously configured graph"}
        {item.measurements?.length ? ` · ${item.measurements.map(measurement => measurement.name).join(", ")}` : ""}</li>)}</ul>
    </details>}
    <TestComment title="Overall test run comment" value={run.comment} disabled={commentsDisabled} editing={editingComments}
      onChange={onCommentChange && (value => onCommentChange(null, value))} />
    {run.warnings?.length > 0 && <details className="test-import-notes" open>
      <summary>Import notes ({run.warnings.length})</summary>
      {noteClarification && <p>{noteClarification}</p>}
      <ul>{run.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </details>}
    <div className="test-device-layout">
      <aside className="test-device-picker" aria-label="Tested devices">
        <label className="test-search">Find a device<input type="search" value={search} disabled={graphEditorDirty} onChange={event => setSearch(event.target.value)} placeholder="Device name or result…" /></label>
        <div className="test-device-list">{shown.map(item => <button type="button" key={item.id}
          className={device?.id === item.id ? "selected" : ""} aria-pressed={device?.id === item.id} disabled={graphEditorDirty} onClick={() => {
            setSelected(item.id);
            rememberTestSelection(selectionScope, item.id, runId);
          }}>
          <strong>{getDeviceDisplayName(item, run.graphTools)}</strong><TestStatus status={item.status} />
        </button>)}</div>
        {!shown.length && <p className="test-muted">No matching device.</p>}
      </aside>
      <section className="test-device-content" aria-label="Device test results">
        {device ? <>
          <div className="test-device-heading"><div><h3>{displayDeviceName}</h3>{displayDeviceName !== device.name && <small>Source: {device.name}</small>}</div><TestStatus status={device.status} /></div>
          <details className="test-device-name-tools"><summary>{onGraphToolsChange ? "Rename device" : "Device display name"}</summary>
            <DisplayNameEditor kind="device" sourceName={device.name} value={run.graphTools?.deviceNames?.find(item => item.deviceId === device.id)?.name}
              scope={graphEditorScope} canEdit={Boolean(onGraphToolsChange)} disabled={commentsDisabled}
              editorKey={JSON.stringify([runId, device.id, "device-name"])} onDirtyChange={onGraphEditorDirty}
              onApply={name => onGraphToolsChange(previous => ({ ...previous,
                deviceNames: [...previous.deviceNames.filter(item => item.deviceId !== device.id), ...(name === null ? [] : [{ deviceId: device.id, name }])] }))} />
            {!onGraphToolsChange && <p>{displayDeviceName}{displayDeviceName !== device.name ? ` · Source: ${device.name}` : ""}</p>}
          </details>
          <DeviceTimeAxis key={sliderKey} clock={sliderClock} timeRange={chosenRange.range}
            onChange={changeTimeRange} warning={chosenRange.error} />
          {orderedGraphs.length > 1 && <DeviceGraphOrder key={orderViewKey} entries={orderedGraphs}
            onChange={changeGraphOrder} warning={chosenOrder.error} disabled={graphEditorDirty} />}
          {graphGroups.map(group => {
            const { channel } = group;
            const station = run.stations?.find(item => item.id === channel.stationId);
            const module = station?.modules?.find(item => item.slot === channel.slot);
            return <section className="test-channel" key={group.key}>
              <div className="test-channel-heading"><div><h4>{channel.symbolicName}</h4>
                <p>{station?.name || channel.stationId} · Slot {channel.slot} · Channel {channel.channel}
                  {channel.sourceChannel !== channel.channel && ` (CSV channel ${channel.sourceChannel})`} · {channel.role}</p>
                {module?.name && <small>{module.name}</small>}</div><TestStatus status={channel.status} /></div>
              <p className="test-source-result">Recorded wiring status: <strong>{channel.rawStatus || "Not recorded"}</strong>{channel.comment ? ` · ${channel.comment}` : ""}</p>
              {!group.entries.length && <p className="test-muted">No signal changes were recorded for this channel in the supplied logs.</p>}
              {group.entries.map(({ key, series, seriesIndex }) =>
                <TestSeriesChart key={key} series={series} clock={run.clock}
                  timeRange={chosenRange.range} deviceTimeRange={automaticRange}
                  run={run} deviceId={device.id} graphKey={key} settings={getGraphSettings(run.graphTools, device.id, key)}
                  graphChoices={graphChoices} graphEditorScope={graphEditorScope} onGraphEditorDirty={onGraphEditorDirty}
                  onGraphSettingsChange={onGraphToolsChange && (settings => onGraphToolsChange(previous => {
                    const next = { ...settings, deviceId: device.id, graphKey: key };
                    const position = previous.graphs.findIndex(item => item.deviceId === device.id && item.graphKey === key);
                    return { ...previous, graphs: position < 0 ? [...previous.graphs, next]
                      : previous.graphs.map((item, index) => index === position ? next : item) };
                  }))}
                  editsDisabled={commentsDisabled} showInitialState={isDigitalOutputChannel(channel)}
                  onExclusionChange={onEventExclusionChange && ((pointIndex, excluded) =>
                    onEventExclusionChange(device.id, channel.id, seriesIndex, pointIndex, excluded))} />)}
              <Parameters parameters={channel.parameters} />
              {module?.parameters?.length > 0 && <Parameters parameters={module.parameters} title="Shared module parameters" />}
            </section>;
          })}
          <TestComment title="Device comment" label={`Device comment for ${displayDeviceName}`} value={device.comment} editing={editingComments}
            disabled={commentsDisabled} onChange={onCommentChange && (value => onCommentChange(device.id, value))} />
        </> : <p className="test-muted">No named device results to display.</p>}
      </section>
    </div>
    <details className="test-sources"><summary>Source files and station details ({run.sources?.length || 0})</summary>
      <div className="test-table-scroll"><table><thead><tr><th>File</th><th>Type</th><th>Station</th><th>SHA-256</th></tr></thead>
        <tbody>{(run.sources || []).map(source => <tr key={source.id}><td>{source.name}</td><td>{source.kind}</td><td>{source.stationId || "Unassigned"}</td><td className="test-hash">{source.sha256}</td></tr>)}</tbody></table></div>
      {(run.stations || []).map(station => <div key={station.id} className="test-station"><h4>{station.name}</h4><p>Serial: {station.serialNumber || "Not supplied"} · MAC: {station.macAddress || "Not supplied"}</p>
        <div className="test-table-scroll"><table><thead><tr><th>Slot</th><th>Module</th><th>Order number</th><th>Serial number</th></tr></thead>
          <tbody>{(station.modules || []).map(module => <tr key={module.slot}><td>{module.slot}</td><td>{module.name}</td><td>{module.orderNumber || "—"}</td><td>{module.serialNumber || "—"}</td></tr>)}</tbody></table></div>
      </div>)}
    </details>
    {run.unassignedChannels?.length > 0 && <details className="test-sources"><summary>Unassigned or not applicable channels ({run.unassignedChannels.length})</summary>
      <div className="test-table-scroll"><table><thead><tr><th>Station / slot / channel</th><th>Symbolic name</th><th>Recorded status</th></tr></thead>
        <tbody>{run.unassignedChannels.map((channel, index) => <tr key={channel.id || index}><td>{channel.stationId} / {channel.slot} / {channel.channel}</td><td>{channel.symbolicName || "Unnamed"}</td><td>{channel.rawStatus || "Not recorded"}</td></tr>)}</tbody></table></div>
    </details>}
    {run.unparsedEvents?.length > 0 && <details className="test-sources"><summary>Events requiring review ({run.unparsedEvents.length})</summary>
      <p className="test-muted">These original events could not be assigned safely to a graph. Review their source time, channel, and description.</p>
      <div className="test-table-scroll"><table><thead><tr><th>Source / row</th><th>Source time</th><th>Original event</th><th>Import note</th></tr></thead>
        <tbody>{run.unparsedEvents.map((event, index) => <tr key={index}><td>{run.sources?.find(source => source.id === event.sourceId)?.name || event.sourceId} / {event.sourceRow}</td>
          <td>{event.time || "Not recorded"}</td><td>{event.description}</td><td>{event.reason}</td></tr>)}</tbody></table></div>
    </details>}
  </div>;
}

export default function TestReportsPanel(props) {
  const scope = testCommentDraftScope(props.storageScope, props.inspector?.id, props.project.walkdownId);
  return <ScopedTestReportsPanel key={scope || "unscoped"} {...props} cacheScope={scope} />;
}

function ScopedTestReportsPanel({
  project, runs = [], inspector, readOnly = false, checkerRequired = false, pending = false, exportProgress = "",
  onSave, onDelete, onExport, onReview, onDirtyChange,
  getPhotoUrl, onAddSetupPhoto, onUpdateSetupPhoto, onRemoveSetupPhoto, onReorderSetupPhotos, cacheScope, storageScope,
  timeRangeChanges = {}, onTimeRangeChange, graphOrderChanges = {}, onGraphOrderChange,
}) {
  const timeZoneId = useId();
  const computerTimeZone = getLocalTimeZone();
  function recover(records) {
    const cached = records.find(item => item.revision === project.revision) || records[0];
    if (!cached) return null;
    const run = runs.find(item => item.id === cached.id && item.runVersion === cached.runVersion);
    let data = null, eventReplayError = "";
    try { if (run && !cached.requiresFiles) data = applyTestEventEdits(run, cached.eventEdits || []); }
    catch (failure) { eventReplayError = failure.message; }
    return { ...cached, walkdownId: project.walkdownId, recovered: true,
      timeZone: cached.timeZone?.trim() ? cached.timeZone : UNKNOWN_TIME_ZONE,
      graphTools: cached.graphTools ?? run?.graphTools,
      eventEdits: cached.eventEdits || [], eventReplayError,
      reselectSources: cached.requiresFiles ? cached.sources : null,
      data };
  }
  const [recovery] = useState(() => readTestCommentDrafts(cacheScope));
  const [draft, setDraft] = useState(() => recover(recovery.drafts));
  const timeZoneOptions = useMemo(() => draft ? getTimeZoneOptions(draft.timeZone, computerTimeZone) : [],
    [draft?.timeZone, computerTimeZone]);
  const draftRef = useRef(draft);
  const [selectedId, setSelectedId] = useState(() => draft?.id || readTestSelection(cacheScope));
  const [cacheError, setCacheError] = useState(recovery.error);
  const [files, setFiles] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [setupDirty, setSetupDirty] = useState(false);
  const [graphEditors, setGraphEditors] = useState({});
  const graphEditorDirty = Object.keys(graphEditors).length > 0;
  const changeGraphEditorDirty = useCallback((key, dirty) => {
    setGraphEditors(previous => {
      if (Boolean(previous[key]) === Boolean(dirty)) return previous;
      if (dirty) return { ...previous, [key]: true };
      const next = { ...previous }; delete next[key]; return next;
    });
  }, []);
  const busyRef = useRef(false);
  const parseRef = useRef(0);
  const access = useRef(null);
  access.current = { readOnly, revision: project.revision, walkdownId: project.walkdownId };
  const selectedRun = runs.find(run => run.id === selectedId) || runs[0];
  const draftRun = runs.find(run => run.id === draft?.id);
  const stale = draft && (draft.eventReplayError || draft.revision !== project.revision || draft.walkdownId !== project.walkdownId
    || (draft.runVersion !== null && (!draftRun || draftRun.runVersion !== draft.runVersion
      || !(inspector?.isAdmin || inspector?.id === draftRun.createdBy))));
  const blocked = pending || Boolean(busy);
  const canEdit = run => !readOnly && Boolean(inspector?.id && (inspector.isAdmin || inspector.id === run.createdBy));
  const confirmsRun = run => confirmDelete?.id === run.id && confirmDelete.revision === project.revision
    && confirmDelete.walkdownId === project.walkdownId && confirmDelete.runVersion === run.runVersion;
  useEffect(() => { onDirtyChange?.(Boolean(draft) || setupDirty || graphEditorDirty); }, [draft, setupDirty, graphEditorDirty, onDirtyChange]);
  useEffect(() => () => { ++parseRef.current; onDirtyChange?.(false); }, [onDirtyChange]);
  useEffect(() => { setConfirmDelete(null); }, [readOnly, project.revision, project.walkdownId, selectedRun?.id, selectedRun?.runVersion]);
  useEffect(() => {
    if (!draft && !setupDirty && !graphEditorDirty) return;
    const preventDiscard = event => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventDiscard);
    return () => window.removeEventListener("beforeunload", preventDiscard);
  }, [Boolean(draft), setupDirty, graphEditorDirty]);

  function draftFrom(run) {
    const eventEdits = [];
    for (const device of run?.devices || []) for (const channel of device.channels || [])
      (channel.series || []).forEach((series, seriesIndex) => (series.points || []).forEach((point, pointIndex) => {
        if (point.excluded === true) eventEdits.push(createTestEventEdit(run,
          { deviceId: device.id, channelId: channel.id, seriesIndex, pointIndex }, true));
      }));
    return {
      revision: project.revision, walkdownId: project.walkdownId,
      id: run?.id || crypto.randomUUID(), runVersion: run?.runVersion ?? null,
      name: run?.name || "Control box I/O test", software: { ...(run?.software || EMPTY_SOFTWARE) },
      timeZone: run
        ? (run.clock?.timeZone?.trim() ? run.clock.timeZone : UNKNOWN_TIME_ZONE)
        : getLocalTimeZone() || UNKNOWN_TIME_ZONE,
      comment: run?.comment || "",
      graphTools: run?.graphTools === undefined ? undefined : structuredClone(run.graphTools),
      deviceComments: Object.fromEntries((run?.devices || []).map(device => [device.id, device.comment || ""])),
      deviceNames: Object.fromEntries((run?.devices || []).map(device => [device.id, device.name])),
      sources: (run?.sources || []).map(({ name, sha256 }) => ({ name, sha256 })),
      requiresFiles: !run,
      eventEdits,
      data: run ? structuredClone(run) : null,
    };
  }
  function updateDraft(update) {
    const next = typeof update === "function" ? update(draftRef.current) : update;
    draftRef.current = next;
    setDraft(next);
    if (next) setCacheError(writeTestCommentDraft(cacheScope, next));
  }
  function finishDraft() {
    const warning = removeTestCommentDraft(cacheScope, draftRef.current);
    const remaining = readTestCommentDrafts(cacheScope);
    const next = recover(remaining.drafts.filter(item => item.id !== draftRef.current.id || item.revision !== draftRef.current.revision));
    draftRef.current = next;
    setDraft(next); setFiles([]); setAssignments({});
    if (next) setSelectedId(next.id);
    setCacheError(warning || remaining.error);
  }
  function begin(run = null) {
    if (readOnly || blocked || setupDirty || graphEditorDirty || draft || (run && !canEdit(run))) return;
    setError(""); setFiles([]); setAssignments({}); setConfirmDelete(null);
    updateDraft(draftFrom(run));
  }
  function changeComment(deviceId, value) {
    if (readOnly || stale || blocked || setupDirty || busyRef.current || (!draft && (!selectedRun || !canEdit(selectedRun)))) return;
    setConfirmDelete(null);
    updateDraft(previous => {
      const next = previous || draftFrom(selectedRun);
      return deviceId === null ? { ...next, comment: value }
        : { ...next, deviceComments: { ...next.deviceComments, [deviceId]: value } };
    });
  }
  function changeEventExclusion(deviceId, channelId, seriesIndex, pointIndex, excluded) {
    if (readOnly || stale || blocked || setupDirty || busyRef.current || (!draft && (!selectedRun || !canEdit(selectedRun)))) return;
    try {
      const next = draftRef.current || draftFrom(selectedRun);
      if (!next.data) return;
      const edit = createTestEventEdit(next.data, { deviceId, channelId, seriesIndex, pointIndex }, excluded);
      const eventEdits = setTestEventEdit(next.eventEdits || [], edit);
      updateDraft({ ...next, eventEdits, data: applyTestEventEdits(next.data, [edit]) });
      setConfirmDelete(null); setError("");
    } catch (failure) { setError(failure.message); }
  }
  function changeGraphTools(update) {
    if (readOnly || stale || blocked || setupDirty || busyRef.current || (!draft && (!selectedRun || !canEdit(selectedRun))))
      throw new Error("Graph tools cannot be changed in this report right now. Your editor is retained.");
    const next = draftRef.current || draftFrom(selectedRun);
    const current = next.graphTools || emptyGraphTools();
    const graphTools = assertGraphTools(update(current));
    if (JSON.stringify(graphTools) === JSON.stringify(current)) return;
    updateDraft({ ...next, graphTools: structuredClone(graphTools) });
    setConfirmDelete(null); setError("");
  }
  function discard() {
    if (busyRef.current || graphEditorDirty) return;
    ++parseRef.current; finishDraft(); setError("");
  }
  async function parseFiles(incoming = files, stationAssignments = assignments) {
    if (!draft || busyRef.current || readOnly || stale || graphEditorDirty) return;
    if (!incoming.length) { setError("Choose the CSV results, event logs, and parameter files for one test run."); return; }
    const run = ++parseRef.current;
    busyRef.current = true; setBusy("parse"); setError("");
    try {
      const parsed = await parsePronetaFiles(incoming, {
        name: draft.name, softwareName: draft.software.name, softwareVersion: draft.software.version,
        timeZone: draft.timeZone, stationAssignments,
      });
      if (draft.reselectSources?.length) {
        const hashes = sources => sources.map(source => source.sha256).sort().join(",");
        if (hashes(parsed.sources) !== hashes(draft.reselectSources))
          throw new Error("These files do not match the recovered import. Reselect the original files to keep these comments with their test evidence.");
      }
      const data = applyTestEventEdits(parsed, draft.eventEdits || []);
      if (run === parseRef.current) updateDraft(previous => previous && ({ ...previous, data, reselectSources: null, eventReplayError: "",
        sources: parsed.sources.map(({ name, sha256 }) => ({ name, sha256 })),
        deviceNames: { ...previous.deviceNames, ...Object.fromEntries(parsed.devices.map(device => [device.id, device.name])) } }));
    } catch (e) {
      if (run === parseRef.current) { setError(e.message); updateDraft(previous => previous && ({ ...previous, data: null })); }
    } finally {
      if (run === parseRef.current) { busyRef.current = false; setBusy(""); }
    }
  }
  async function chooseFiles(event) {
    if (readOnly || stale || blocked || graphEditorDirty) return;
    const chosen = Array.from(event.target.files || []); event.target.value = "";
    if (!chosen.length) return;
    updateDraft(previous => previous && ({ ...previous, requiresFiles: true }));
    setFiles(chosen); setAssignments({});
    await parseFiles(chosen, {});
  }
  async function save() {
    if (!draft?.data || blocked || busyRef.current || readOnly || stale || graphEditorDirty) return;
    if (!draft.name.trim() || !draft.software.name.trim() || !draft.software.version.trim()) {
      setError("Enter the test run name, software name, and software version before saving."); return;
    }
    const payload = { ...preview, id: draft.id, runVersion: draft.runVersion,
      name: draft.name.trim(), software: { name: draft.software.name.trim(), version: draft.software.version.trim() },
      clock: { ...draft.data.clock, timeZone: draft.timeZone?.trim() ? draft.timeZone : UNKNOWN_TIME_ZONE },
    };
    busyRef.current = true; setBusy("save"); setError("");
    try {
      if (access.current.readOnly || access.current.revision !== draft.revision || access.current.walkdownId !== draft.walkdownId)
        throw new Error("This draft belongs to an earlier revision. Discard it and reopen the current report.");
      const saved = await onSave(payload, draft.revision);
      const savedId = saved?.id || draft.id;
      setSelectedId(savedId);
      if (runs.some(run => run.id !== savedId)) rememberTestSelection(cacheScope, savedId);
      finishDraft();
    } catch (e) { setError(e.message); }
    finally { busyRef.current = false; setBusy(""); }
  }
  async function remove(run) {
    if (!canEdit(run) || blocked || setupDirty || graphEditorDirty || busyRef.current || !confirmsRun(run)) return;
    busyRef.current = true; setBusy("delete"); setError("");
    try { await onDelete(run, project.revision); setConfirmDelete(null); }
    catch (e) { setError(e.message); }
    finally { busyRef.current = false; setBusy(""); }
  }
  const preview = draft ? (draft.data ? { ...draft.data, name: draft.name, software: draft.software,
    comment: draft.comment,
    ...(draft.graphTools === undefined ? {} : { graphTools: draft.graphTools }),
    devices: draft.data.devices.map(device => ({ ...device,
      comment: Object.hasOwn(draft.deviceComments, device.id) ? draft.deviceComments[device.id] : device.comment ?? "" })),
    clock: { ...draft.data.clock, timeZone: draft.timeZone } } : null) : selectedRun;
  const canComment = draft ? !readOnly && !stale : selectedRun && canEdit(selectedRun);
  const rangeScope = testTimeRangeScope(storageScope, inspector?.id, draft?.walkdownId || project.walkdownId, draft?.revision || project.revision);
  const orderScope = testGraphOrderScope(storageScope, inspector?.id, draft?.walkdownId || project.walkdownId, draft?.revision || project.revision);
  const previewRunId = preview?.id || draft?.id;
  const graphEditorScope = JSON.stringify([project.walkdownId, draft?.revision || project.revision, previewRunId, draft?.runVersion ?? preview?.runVersion ?? null]);
  return <section className="test-reports" aria-label="I/O test reports">
    <div className="card test-intro">
      <div><span className="eyebrow">SOFTWARE TEST EVIDENCE</span><h2>I/O test reports</h2>
        <p>Import all PRONETA CSV results, event logs, and .mpr parameter files from one run together.</p></div>
      {!readOnly && !draft && <button className="button primary" type="button" onClick={() => begin()} disabled={blocked || setupDirty || graphEditorDirty}><Icon name="upload" />Import test run</button>}
      <button type="button" className="button secondary" onClick={onReview}>Revision {revisionNumber(project)} · {project.status === "closed" ? "Approved & closed" : "Review & approve"}</button>
    </div>
    {exportProgress && <p className="test-export-progress" role="status"><span className="spinner" />{exportProgress}</p>}
    {error && <p className="message error" role="alert">{error}</p>}
    {cacheError && <p className="message error" role="alert">{cacheError}</p>}
    {graphEditorDirty && <p className="test-graph-editor-notice" role="status">Apply or cancel the open graph name or calculation editor before saving or switching devices. Keep this tab open until the editor is applied; applied changes are saved with Save test run.</p>}
    {draft && <section className="card test-import-form" aria-label="Import test run">
      <h3>{draft.runVersion ? "Edit test run" : "Import a test run"}</h3>
      {draft.recovered && <p role="status">Recovered pending {draft.eventEdits?.length ? "comments and event edits" : "comments"} for {draft.name || "this test run"}, revision {revisionNumber(project, draft.revision)}. They remain unsaved until Save test run.</p>}
      {draft.eventReplayError && <p className="field-error" role="alert">{draft.eventReplayError}</p>}
      {(readOnly || stale) && <p className="field-error" role="alert">{checkerRequired && !stale
        ? "Save Checked by to resume this test run. Your pending changes are retained and will be available after the name is saved."
        : "This revision or test run was closed or changed. Your local preview is retained for review and copying. Discard this draft and reopen the current run before saving."}</p>}
      {draft.recovered && draft.requiresFiles && !draft.data && <p role="status">Reselect the original source files to restore this import before saving: {draft.sources.map(source => source.name).join(", ") || "the files for this test run"}.</p>}
      <fieldset disabled={blocked || readOnly || stale || graphEditorDirty}>
        <div className="test-metadata-grid">
          <label>Test run name<input value={draft.name} maxLength={160} onChange={event => updateDraft(previous => ({ ...previous, name: event.target.value }))} /></label>
          <label>Software name<input value={draft.software.name} maxLength={120} onChange={event => updateDraft(previous => ({ ...previous, software: { ...previous.software, name: event.target.value } }))} /></label>
          <label>Software version<input value={draft.software.version} placeholder="Version used for this test" maxLength={80} onChange={event => updateDraft(previous => ({ ...previous, software: { ...previous.software, version: event.target.value } }))} /></label>
          <div className="test-timezone-field">
            <label htmlFor={timeZoneId}>Source clock / timezone</label>
            <select id={timeZoneId} value={draft.timeZone} aria-describedby={`${timeZoneId}-help`}
              onChange={event => updateDraft(previous => ({ ...previous, timeZone: event.target.value }))}>
              {timeZoneOptions.map(zone => <option key={zone} value={zone}>
                {zone}{zone === computerTimeZone ? " (this computer)" : ""}
              </option>)}
            </select>
            <p id={`${timeZoneId}-help`} className="test-timezone-help">{computerTimeZone
              ? "New imports use this computer’s current UTC offset. Choose the offset used when the test was recorded."
              : "The local UTC offset could not be detected. Choose the offset used to record this test."}</p>
          </div>
        </div>
        <p className="test-muted">Use the software version you ran. Module firmware versions in the files are recorded separately. Times stay as recorded by the source computer.</p>
        <label className="test-file-choice">{draft.data ? "Replace source files" : "Source files"}<input type="file" multiple accept=".csv,.mpr,text/csv,application/xml,text/xml" onChange={chooseFiles} /></label>
        {files.length > 0 && <div className="test-file-list">
          <p>Station names are matched automatically. For renamed files, enter their station name below, then read the files again.</p>
          {files.map((file, index) => <label key={`${file.name}:${index}`}><span>{file.name}</span>
            <input aria-label={`Station for ${file.name}`} placeholder="Auto-detect station" value={assignments[file.name] || ""}
              onChange={event => { setAssignments(previous => ({ ...previous, [file.name]: event.target.value })); updateDraft(previous => ({ ...previous, data: null })); }} /></label>)}
          <button className="small-button" type="button" onClick={() => parseFiles()}>Read files again</button>
        </div>}
      </fieldset>
      <div className="test-import-actions">
        <button type="button" className="button secondary" disabled={Boolean(busy) || graphEditorDirty} onClick={discard}>Discard changes</button>
        <button type="button" className="button primary" disabled={!draft.data || blocked || readOnly || stale || graphEditorDirty} onClick={save}>
          {busy === "parse" ? "Reading files…" : busy === "save" ? "Saving…" : "Save test run"}
        </button>
        <small>Save the reviewed import, then add setup photos before approving the skid revision.</small>
      </div>
    </section>}
    {draft && !draft.data && <section className="card test-preview" aria-label="Recovered test comments">
      <TestComment title="Overall test run comment" value={draft.comment} disabled={blocked}
        onChange={canComment ? value => changeComment(null, value) : undefined} />
      {Object.entries(draft.deviceComments).map(([id, comment]) => <TestComment key={id}
        title={`Device comment for ${draft.deviceNames[id] || id}`} value={comment} disabled={blocked}
        onChange={canComment ? value => changeComment(id, value) : undefined} />)}
    </section>}
    {!draft && runs.length > 0 && <div className="test-run-toolbar">
      <label>Saved test run<select disabled={blocked || setupDirty || graphEditorDirty} value={selectedRun?.id || ""} onChange={event => {
        setSelectedId(event.target.value); rememberTestSelection(cacheScope, event.target.value); setConfirmDelete(null);
      }}>{runs.map(run => <option key={run.id} value={run.id}>{run.name}</option>)}</select></label>
      <div className="test-run-actions">
        {selectedRun && canEdit(selectedRun) && <>
          <button type="button" className="small-button" disabled={blocked || setupDirty || graphEditorDirty} onClick={() => begin(selectedRun)}>Edit run</button>
          {confirmsRun(selectedRun) ? <>
            <span>Remove from this draft?</span><button className="small-button" type="button" disabled={blocked} onClick={() => setConfirmDelete(null)}>Cancel</button>
            <button className="small-button test-remove" type="button" disabled={blocked || setupDirty || graphEditorDirty} onClick={() => remove(selectedRun)}>Confirm removal</button>
          </> : <button type="button" className="small-button test-remove" disabled={blocked || setupDirty || graphEditorDirty} onClick={() => setConfirmDelete({ id: selectedRun.id, runVersion: selectedRun.runVersion, revision: project.revision, walkdownId: project.walkdownId })}>Remove run</button>}
        </>}
        <button type="button" className="button primary" disabled={blocked || project.status !== "closed"} onClick={() => onExport(selectedRun?.id)}><Icon name="download" />{exportProgress ? "Exporting…" : "Export test PDF"}</button>
      </div>
    </div>}
    {!draft && selectedRun && <PhotoGallery key={`${selectedRun.id}:${project.revision}`}
      run={selectedRun} revision={project.revision} skidName={project.skidName} readOnly={!canEdit(selectedRun)} pending={blocked}
      getPhotoUrl={getPhotoUrl} onAddPhoto={onAddSetupPhoto} onUpdatePhoto={onUpdateSetupPhoto}
      onRemovePhoto={onRemoveSetupPhoto} onReorderPhotos={onReorderSetupPhotos} onDirtyChange={setSetupDirty} />}
    {preview && <section className="card test-preview"><header><h2>{preview.name}</h2><span>{draft ? "Unsaved preview" : `Revision ${revisionNumber(project)}`}</span></header>
      <TestRunDetail key={preview.id || draft?.id} run={preview} onCommentChange={canComment ? changeComment : undefined}
        onEventExclusionChange={canComment ? changeEventExclusion : undefined}
        onGraphToolsChange={canComment ? changeGraphTools : undefined} graphEditorDirty={graphEditorDirty}
        graphEditorScope={graphEditorScope} onGraphEditorDirty={changeGraphEditorDirty}
        commentsDisabled={blocked || setupDirty} editingComments={Boolean(draft)} runId={previewRunId} timeRangeScope={rangeScope} selectionScope={cacheScope}
        rangeOverrides={timeRangeChanges[rangeScope]?.[previewRunId]} onTimeRangeChange={onTimeRangeChange}
        graphOrderScope={orderScope} orderOverrides={graphOrderChanges[orderScope]?.[previewRunId]} onGraphOrderChange={onGraphOrderChange} /></section>}
    {!preview && !draft && <div className="card test-empty"><Icon name="report" size={36} /><h3>No test runs in this revision</h3><p>{checkerRequired ? "Save Checked by to import a test run in this revision." : readOnly ? "Start a new revision to import a test run." : "Import the files for your test, review the devices and parameters, then save the run."}</p></div>}
  </section>;
}
