import React, { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icons.jsx";
import TestSetupPhotos from "./TestSetupPhotos.jsx";
import { parsePronetaFiles } from "./proneta-parser.js";
import { importNoteClarification } from "./proneta-notes.js";
import { buildTestChart, isTestTimeRange, formatSourceTime, formatTestValue } from "./test-chart.js";
import { testCommentDraftScope, readTestCommentDrafts, writeTestCommentDraft, removeTestCommentDraft } from "./test-comment-drafts.js";
import { testTimeRangeScope, readDeviceTimeRange, saveDeviceTimeRange, resetDeviceTimeRange } from "./test-time-ranges.js";
import "./test-reports.css";

const statusClass = (status) => status === "Passed" ? "passed" : status === "Failed" ? "failed" : "untested";
const describeTime = (clock) => Number.isFinite(clock?.startMs) && Number.isFinite(clock?.endMs)
  ? `${formatSourceTime(clock.startMs, true)} – ${formatSourceTime(clock.endMs, true)}${clock.basis === "absolute" ? " UTC" : ""}`
  : "No timestamped events in this run";
const EMPTY_SOFTWARE = { name: "Siemens PRONETA Basic", version: "" };

function TestStatus({ status }) {
  return <span className={`test-status ${statusClass(status)}`}>{status || "Not tested"}</span>;
}

function TestComment({ title, label = title, value, onChange, disabled }) {
  const text = typeof value === "string" ? value : "";
  return <section className="test-comment" aria-label={label}>
    <h4>{title}</h4>
    {onChange ? <>
      <label><span className="sr-only">{label}</span><textarea rows={3} maxLength={8000}
        value={text} onChange={event => onChange(Array.from(event.target.value).slice(0, 4000).join(""))}
        disabled={disabled} placeholder="Add a comment…" /></label>
      <small>{Array.from(text).length}/4,000 · Save with Save test run.</small>
    </> : <p className={text ? "" : "test-muted"}>{text || "No comment added."}</p>}
  </section>;
}

function DeviceTimeAxis({ clock, timeRange, onChange, warning }) {
  const inputTime = value => {
    const date = new Date(value);
    return Number.isFinite(value) && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 23) : "";
  };
  const [start, setStart] = useState(() => inputTime(timeRange?.startMs ?? clock?.startMs));
  const [end, setEnd] = useState(() => inputTime(timeRange?.endMs ?? clock?.endMs));
  const [error, setError] = useState("");
  if (!Number.isFinite(clock?.startMs) || !Number.isFinite(clock?.endMs) || clock.endMs <= clock.startMs) return null;
  return <form className="test-time-axis" aria-label="Device time axis" onSubmit={event => {
    event.preventDefault();
    const range = { startMs: event.currentTarget.elements.rangeStart.valueAsNumber,
      endMs: event.currentTarget.elements.rangeEnd.valueAsNumber };
    if (!isTestTimeRange(range, clock)) {
      setError("Choose a start before the end, within the recorded run time span."); return;
    }
    setStart(inputTime(range.startMs)); setEnd(inputTime(range.endMs)); setError(""); onChange(range);
  }}>
    <div className="test-time-axis-heading"><strong>Device time axis</strong><span>{timeRange ? "Manual" : "Automatic"}</span></div>
    <div className="test-time-axis-fields">
      <label>Start time<input name="rangeStart" type="datetime-local" step="0.001" required
        min={inputTime(clock.startMs)} max={inputTime(clock.endMs)} value={start} onChange={event => setStart(event.target.value)} /></label>
      <label>End time<input name="rangeEnd" type="datetime-local" step="0.001" required
        min={inputTime(clock.startMs)} max={inputTime(clock.endMs)} value={end} onChange={event => setEnd(event.target.value)} /></label>
      <button className="small-button" type="submit">Apply time range</button>
      <button className="small-button" type="button" onClick={() => {
        setStart(inputTime(clock.startMs)); setEnd(inputTime(clock.endMs)); setError(""); onChange(null);
      }}>Reset to auto</button>
    </div>
    <p>Applies to all graphs for this device and its PDF. Times use {clock.basis === "absolute" ? "UTC" : "the recorded source clock"}.</p>
    {error && <p className="field-error" role="alert">{error}</p>}
    {warning && <p className="field-error" role="alert">{warning}</p>}
  </form>;
}

export function TestSeriesChart({ series, clock, timeRange = null }) {
  let chart;
  try { chart = buildTestChart(series, clock, { timeRange }); }
  catch (e) { return <p className="field-error">{e.message}</p>; }
  const { plot } = chart;
  const graphClock = { ...clock, startMs: chart.domain.startMs, endMs: chart.domain.endMs };
  return (
    <figure className="test-chart">
      <figcaption><strong>{series.name}</strong><span>{chart.unit}</span></figcaption>
      <div className="test-chart-scroll">
        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img"
          aria-label={`${series.name}: ${chart.observedCount} recorded values, ${describeTime(graphClock)}`}
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
          {chart.extension && <line x1={chart.extension.from.x} y1={chart.extension.from.y}
            x2={chart.extension.to.x} y2={chart.extension.to.y} className="test-held-value">
            <title>Last recorded value held to the end of the graph</title>
          </line>}
          {chart.points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={3} className="test-observation">
            <title>{formatSourceTime(point.timeMs, true)}: {formatTestValue(point.value)} {series.unit} · source row {point.sourceRow}</title>
          </circle>)}
          {chart.invalidPoints.filter(point => point.x !== null).map((point, index) =>
            <path key={`invalid-${index}`} d={`M${point.x - 4} ${plot.top + plot.height - 4}l8 8m-8 0l8 -8`} className="test-invalid-observation">
              <title>{point.time}: invalid reading {point.rawValue}</title>
            </path>)}
        </svg>
      </div>
      <p>{chart.manualTimeRange ? `${chart.visibleObservedCount} of ${chart.observedCount}` : chart.observedCount} recorded change values{chart.manualTimeRange && " shown"}{chart.invalidCount ? ` · ${chart.invalidCount} invalid readings` : ""}. {series.kind === "digital" ? "Steps connect recorded states" : "Lines connect recorded readings"}; the dashed tail holds the last value to the graph end. {chart.manualTimeRange ? "The manual device time range applies; readings outside it remain in the recorded events." : "The time axis automatically fits this series."}{clock.basis === "absolute" && " Times are UTC."}</p>
      <details className="test-events"><summary>View recorded events ({series.points.length})</summary>
        <div className="test-table-scroll"><table>
          <thead><tr><th>Source time</th><th>Previous</th><th>Recorded value</th><th>Source row</th></tr></thead>
          <tbody>{series.points.map((point, index) => <tr key={index}>
            <td>{point.time || formatSourceTime(point.timeMs, true)}</td>
            <td>{point.previousRawValue ?? formatTestValue(point.previousValue)}</td>
            <td>{point.rawValue ?? formatTestValue(point.value)}{point.valid === false && " (invalid)"}</td>
            <td>{point.sourceRow}</td>
          </tr>)}</tbody>
        </table></div>
      </details>
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

export function TestRunDetail({ run, runId = run.id, onCommentChange, commentsDisabled = false,
  timeRangeScope = null, rangeOverrides = {}, onTimeRangeChange }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [localRanges, setLocalRanges] = useState({});
  const devices = run.devices || [];
  const shown = useMemo(() => devices.filter(device => `${device.name} ${device.status}`.toLowerCase().includes(search.toLowerCase())), [devices, search]);
  const device = shown.find(item => item.id === selected) || shown[0];
  const viewKey = JSON.stringify([timeRangeScope, runId, device?.id, run.clock?.startMs, run.clock?.endMs]);
  const storedRange = useMemo(() => readDeviceTimeRange(timeRangeScope, runId, device?.id, run.clock),
    [timeRangeScope, runId, device?.id, run.clock?.startMs, run.clock?.endMs]);
  const override = rangeOverrides[device?.id];
  const chosenRange = localRanges[viewKey] || (Object.hasOwn(rangeOverrides, device?.id)
    && (override === null || isTestTimeRange(override, run.clock)) ? { range: override, error: "" } : storedRange);
  function changeTimeRange(range) {
    const error = range ? saveDeviceTimeRange(timeRangeScope, runId, device.id, run.clock, range)
      : resetDeviceTimeRange(timeRangeScope, runId, device.id);
    setLocalRanges(previous => ({ ...previous, [viewKey]: { range, error } }));
    onTimeRangeChange?.(timeRangeScope, runId, device.id, range);
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
    <TestComment title="Overall test run comment" value={run.comment} disabled={commentsDisabled}
      onChange={onCommentChange && (value => onCommentChange(null, value))} />
    {run.warnings?.length > 0 && <details className="test-import-notes" open>
      <summary>Import notes ({run.warnings.length})</summary>
      {noteClarification && <p>{noteClarification}</p>}
      <ul>{run.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </details>}
    <div className="test-device-layout">
      <aside className="test-device-picker" aria-label="Tested devices">
        <label className="test-search">Find a device<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Device name or result…" /></label>
        <div className="test-device-list">{shown.map(item => <button type="button" key={item.id}
          className={device?.id === item.id ? "selected" : ""} aria-pressed={device?.id === item.id} onClick={() => setSelected(item.id)}>
          <strong>{item.name}</strong><TestStatus status={item.status} />
        </button>)}</div>
        {!shown.length && <p className="test-muted">No matching device.</p>}
      </aside>
      <section className="test-device-content" aria-label="Device test results">
        {device ? <>
          <div className="test-device-heading"><h3>{device.name}</h3><TestStatus status={device.status} /></div>
          <DeviceTimeAxis key={viewKey} clock={run.clock} timeRange={chosenRange.range}
            onChange={changeTimeRange} warning={chosenRange.error} />
          {(device.channels || []).map(channel => {
            const station = run.stations?.find(item => item.id === channel.stationId);
            const module = station?.modules?.find(item => item.slot === channel.slot);
            return <section className="test-channel" key={channel.id}>
              <div className="test-channel-heading"><div><h4>{channel.symbolicName}</h4>
                <p>{station?.name || channel.stationId} · Slot {channel.slot} · Channel {channel.channel}
                  {channel.sourceChannel !== channel.channel && ` (CSV channel ${channel.sourceChannel})`} · {channel.role}</p>
                {module?.name && <small>{module.name}</small>}</div><TestStatus status={channel.status} /></div>
              <p className="test-source-result">Recorded wiring status: <strong>{channel.rawStatus || "Not recorded"}</strong>{channel.comment ? ` · ${channel.comment}` : ""}</p>
              {!channel.series?.some(series => series.points?.length) && <p className="test-muted">No signal changes were recorded for this channel in the supplied logs.</p>}
              {(channel.series || []).filter(series => series.points?.length).map((series, index) =>
                <TestSeriesChart key={series.id || index} series={series} clock={run.clock} timeRange={chosenRange.range} />)}
              <Parameters parameters={channel.parameters} />
              {module?.parameters?.length > 0 && <Parameters parameters={module.parameters} title="Shared module parameters" />}
            </section>;
          })}
          <TestComment title="Device comment" label={`Device comment for ${device.name}`} value={device.comment}
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
  project, runs = [], inspector, readOnly = false, pending = false, exportProgress = "",
  onSave, onDelete, onExport, onReview, onDirtyChange,
  getPhotoUrl, onAddSetupPhoto, onUpdateSetupPhoto, onRemoveSetupPhoto, cacheScope, storageScope,
  timeRangeChanges = {}, onTimeRangeChange,
}) {
  function recover(records) {
    const cached = records.find(item => item.revision === project.revision) || records[0];
    if (!cached) return null;
    const run = runs.find(item => item.id === cached.id && item.runVersion === cached.runVersion);
    return { ...cached, walkdownId: project.walkdownId, recovered: true,
      reselectSources: cached.requiresFiles ? cached.sources : null,
      data: run && !cached.requiresFiles ? structuredClone(run) : null };
  }
  const [recovery] = useState(() => readTestCommentDrafts(cacheScope));
  const [draft, setDraft] = useState(() => recover(recovery.drafts));
  const draftRef = useRef(draft);
  const [selectedId, setSelectedId] = useState(draft?.id || null);
  const [cacheError, setCacheError] = useState(recovery.error);
  const [files, setFiles] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [setupDirty, setSetupDirty] = useState(false);
  const busyRef = useRef(false);
  const parseRef = useRef(0);
  const access = useRef(null);
  access.current = { readOnly, revision: project.revision, walkdownId: project.walkdownId };
  const selectedRun = runs.find(run => run.id === selectedId) || runs[0];
  const draftRun = runs.find(run => run.id === draft?.id);
  const stale = draft && (draft.revision !== project.revision || draft.walkdownId !== project.walkdownId
    || (draft.runVersion !== null && (!draftRun || draftRun.runVersion !== draft.runVersion
      || !(inspector?.isAdmin || inspector?.id === draftRun.createdBy))));
  const blocked = pending || Boolean(busy);
  const canEdit = run => !readOnly && Boolean(inspector?.id && (inspector.isAdmin || inspector.id === run.createdBy));
  const confirmsRun = run => confirmDelete?.id === run.id && confirmDelete.revision === project.revision
    && confirmDelete.walkdownId === project.walkdownId && confirmDelete.runVersion === run.runVersion;
  useEffect(() => { onDirtyChange?.(Boolean(draft) || setupDirty); }, [draft, setupDirty, onDirtyChange]);
  useEffect(() => () => { ++parseRef.current; onDirtyChange?.(false); }, [onDirtyChange]);
  useEffect(() => { setConfirmDelete(null); }, [readOnly, project.revision, project.walkdownId, selectedRun?.id, selectedRun?.runVersion]);
  useEffect(() => {
    if (!draft && !setupDirty) return;
    const preventDiscard = event => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventDiscard);
    return () => window.removeEventListener("beforeunload", preventDiscard);
  }, [Boolean(draft), setupDirty]);

  function draftFrom(run) {
    return {
      revision: project.revision, walkdownId: project.walkdownId,
      id: run?.id || crypto.randomUUID(), runVersion: run?.runVersion ?? null,
      name: run?.name || "Control box I/O test", software: { ...(run?.software || EMPTY_SOFTWARE) },
      timeZone: run?.clock?.timeZone || "Source clock (timezone not recorded)",
      comment: run?.comment || "",
      deviceComments: Object.fromEntries((run?.devices || []).map(device => [device.id, device.comment || ""])),
      deviceNames: Object.fromEntries((run?.devices || []).map(device => [device.id, device.name])),
      sources: (run?.sources || []).map(({ name, sha256 }) => ({ name, sha256 })),
      requiresFiles: !run,
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
    if (readOnly || blocked || setupDirty || draft || (run && !canEdit(run))) return;
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
  function discard() {
    if (busyRef.current) return;
    ++parseRef.current; finishDraft(); setError("");
  }
  async function parseFiles(incoming = files, stationAssignments = assignments) {
    if (!draft || busyRef.current || readOnly || stale) return;
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
      if (run === parseRef.current) updateDraft(previous => previous && ({ ...previous, data: parsed, reselectSources: null,
        sources: parsed.sources.map(({ name, sha256 }) => ({ name, sha256 })),
        deviceNames: { ...previous.deviceNames, ...Object.fromEntries(parsed.devices.map(device => [device.id, device.name])) } }));
    } catch (e) {
      if (run === parseRef.current) { setError(e.message); updateDraft(previous => previous && ({ ...previous, data: null })); }
    } finally {
      if (run === parseRef.current) { busyRef.current = false; setBusy(""); }
    }
  }
  async function chooseFiles(event) {
    const chosen = Array.from(event.target.files || []); event.target.value = "";
    if (!chosen.length) return;
    updateDraft(previous => previous && ({ ...previous, requiresFiles: true }));
    setFiles(chosen); setAssignments({});
    await parseFiles(chosen, {});
  }
  async function save() {
    if (!draft?.data || blocked || busyRef.current || readOnly || stale) return;
    if (!draft.name.trim() || !draft.software.name.trim() || !draft.software.version.trim()) {
      setError("Enter the test run name, software name, and software version before saving."); return;
    }
    const payload = { ...preview, id: draft.id, runVersion: draft.runVersion,
      name: draft.name.trim(), software: { name: draft.software.name.trim(), version: draft.software.version.trim() },
      clock: { ...draft.data.clock, timeZone: draft.timeZone.trim() || "Source clock (timezone not recorded)" },
    };
    busyRef.current = true; setBusy("save"); setError("");
    try {
      if (access.current.readOnly || access.current.revision !== draft.revision || access.current.walkdownId !== draft.walkdownId)
        throw new Error("This draft belongs to an earlier revision. Discard it and reopen the current report.");
      const saved = await onSave(payload, draft.revision);
      setSelectedId(saved?.id || draft.id); finishDraft();
    } catch (e) { setError(e.message); }
    finally { busyRef.current = false; setBusy(""); }
  }
  async function remove(run) {
    if (!canEdit(run) || blocked || setupDirty || busyRef.current || !confirmsRun(run)) return;
    busyRef.current = true; setBusy("delete"); setError("");
    try { await onDelete(run, project.revision); setConfirmDelete(null); }
    catch (e) { setError(e.message); }
    finally { busyRef.current = false; setBusy(""); }
  }
  const preview = draft ? (draft.data ? { ...draft.data, name: draft.name, software: draft.software,
    comment: draft.comment,
    devices: draft.data.devices.map(device => ({ ...device,
      comment: Object.hasOwn(draft.deviceComments, device.id) ? draft.deviceComments[device.id] : device.comment ?? "" })),
    clock: { ...draft.data.clock, timeZone: draft.timeZone } } : null) : selectedRun;
  const canComment = draft ? !readOnly && !stale : selectedRun && canEdit(selectedRun);
  const rangeScope = testTimeRangeScope(storageScope, inspector?.id, draft?.walkdownId || project.walkdownId, draft?.revision || project.revision);
  const previewRunId = preview?.id || draft?.id;
  return <section className="test-reports" aria-label="I/O test reports">
    <div className="card test-intro">
      <div><span className="eyebrow">SOFTWARE TEST EVIDENCE</span><h2>I/O test reports</h2>
        <p>Import all PRONETA CSV results, event logs, and .mpr parameter files from one run together.</p></div>
      {!readOnly && !draft && <button className="button primary" type="button" onClick={() => begin()} disabled={blocked || setupDirty}><Icon name="upload" />Import test run</button>}
      <button type="button" className="button secondary" onClick={onReview}>Revision {project.revision} · {project.status === "closed" ? "Approved & closed" : "Review & approve"}</button>
    </div>
    {exportProgress && <p className="test-export-progress" role="status"><span className="spinner" />{exportProgress}</p>}
    {error && <p className="message error" role="alert">{error}</p>}
    {cacheError && <p className="message error" role="alert">{cacheError}</p>}
    {draft && <section className="card test-import-form" aria-label="Import test run">
      <h3>{draft.runVersion ? "Edit test run" : "Import a test run"}</h3>
      {draft.recovered && <p role="status">Recovered pending comments for {draft.name || "this test run"}, revision {draft.revision}. They remain unsaved until Save test run.</p>}
      {(readOnly || stale) && <p className="field-error" role="alert">This revision or test run was closed or changed. Your local preview is retained for review and copying. Discard this draft and reopen the current run before saving.</p>}
      {draft.recovered && draft.requiresFiles && !draft.data && <p role="status">Reselect the original source files to restore this import before saving: {draft.sources.map(source => source.name).join(", ") || "the files for this test run"}.</p>}
      <fieldset disabled={blocked || readOnly || stale}>
        <div className="test-metadata-grid">
          <label>Test run name<input value={draft.name} maxLength={160} onChange={event => updateDraft(previous => ({ ...previous, name: event.target.value }))} /></label>
          <label>Software name<input value={draft.software.name} maxLength={120} onChange={event => updateDraft(previous => ({ ...previous, software: { ...previous.software, name: event.target.value } }))} /></label>
          <label>Software version<input value={draft.software.version} placeholder="Version used for this test" maxLength={80} onChange={event => updateDraft(previous => ({ ...previous, software: { ...previous.software, version: event.target.value } }))} /></label>
          <label>Source clock / timezone<input value={draft.timeZone} maxLength={120} onChange={event => updateDraft(previous => ({ ...previous, timeZone: event.target.value }))} /></label>
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
        <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={discard}>Discard changes</button>
        <button type="button" className="button primary" disabled={!draft.data || blocked || readOnly || stale} onClick={save}>
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
      <label>Saved test run<select disabled={blocked || setupDirty} value={selectedRun?.id || ""} onChange={event => { setSelectedId(event.target.value); setConfirmDelete(null); }}>{runs.map(run => <option key={run.id} value={run.id}>{run.name}</option>)}</select></label>
      <div className="test-run-actions">
        {selectedRun && canEdit(selectedRun) && <>
          <button type="button" className="small-button" disabled={blocked || setupDirty} onClick={() => begin(selectedRun)}>Edit run</button>
          {confirmsRun(selectedRun) ? <>
            <span>Remove from this draft?</span><button className="small-button" type="button" disabled={blocked} onClick={() => setConfirmDelete(null)}>Cancel</button>
            <button className="small-button test-remove" type="button" disabled={blocked || setupDirty} onClick={() => remove(selectedRun)}>Confirm removal</button>
          </> : <button type="button" className="small-button test-remove" disabled={blocked || setupDirty} onClick={() => setConfirmDelete({ id: selectedRun.id, runVersion: selectedRun.runVersion, revision: project.revision, walkdownId: project.walkdownId })}>Remove run</button>}
        </>}
        <button type="button" className="button primary" disabled={blocked || project.status !== "closed"} onClick={() => onExport(selectedRun?.id)}><Icon name="download" />{exportProgress ? "Exporting…" : "Export test PDF"}</button>
      </div>
    </div>}
    {!draft && selectedRun && <TestSetupPhotos key={`${selectedRun.id}:${project.revision}`}
      run={selectedRun} revision={project.revision} readOnly={!canEdit(selectedRun)} pending={blocked}
      getPhotoUrl={getPhotoUrl} onAddPhoto={onAddSetupPhoto} onUpdatePhoto={onUpdateSetupPhoto}
      onRemovePhoto={onRemoveSetupPhoto} onDirtyChange={setSetupDirty} />}
    {preview && <section className="card test-preview"><header><h2>{preview.name}</h2><span>{draft ? "Unsaved preview" : `Revision ${project.revision}`}</span></header>
      <TestRunDetail key={preview.id || draft?.id} run={preview} onCommentChange={canComment ? changeComment : undefined}
        commentsDisabled={blocked || setupDirty} runId={previewRunId} timeRangeScope={rangeScope}
        rangeOverrides={timeRangeChanges[rangeScope]?.[previewRunId]} onTimeRangeChange={onTimeRangeChange} /></section>}
    {!preview && !draft && <div className="card test-empty"><Icon name="report" size={36} /><h3>No test runs in this revision</h3><p>{readOnly ? "Start a new revision to import a test run." : "Import the files for your test, review the devices and parameters, then save the run."}</p></div>}
  </section>;
}
