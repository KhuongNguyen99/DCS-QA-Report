import React, { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icons.jsx";
import TestSetupPhotos from "./TestSetupPhotos.jsx";
import { parsePronetaFiles } from "./proneta-parser.js";
import { importNoteClarification } from "./proneta-notes.js";
import { buildDeviceTestChart, formatSourceTime, formatTestValue } from "./test-chart.js";
import "./test-reports.css";

const statusClass = (status) => status === "Passed" ? "passed" : status === "Failed" ? "failed" : "untested";
const describeTime = (clock) => Number.isFinite(clock?.startMs) && Number.isFinite(clock?.endMs)
  ? `${formatSourceTime(clock.startMs, true)} – ${formatSourceTime(clock.endMs, true)}${clock.basis === "absolute" ? " UTC" : ""}`
  : "No timestamped events in this run";
const EMPTY_SOFTWARE = { name: "Siemens PRONETA Basic", version: "" };

function TestStatus({ status }) {
  return <span className={`test-status ${statusClass(status)}`}>{status || "Not tested"}</span>;
}

export function TestDeviceChart({ device, clock, stations }) {
  let chart;
  try { chart = buildDeviceTestChart(device, clock, { stations }); }
  catch (e) { return <p className="field-error">{e.message}</p>; }
  if (!chart) return null;
  const { plot } = chart;
  const graphClock = { ...clock, startMs: chart.domain.startMs, endMs: chart.domain.endMs };
  const eventCount = chart.traces.reduce((sum, trace) => sum + trace.series.points.length, 0);
  return (
    <figure className="test-chart">
      <figcaption><strong>{device.name}</strong><span>{chart.traces.length} signal{chart.traces.length === 1 ? "" : "s"}</span></figcaption>
      <ul className="test-chart-legend" aria-label="Signal legend">
        {chart.traces.map(trace => <li key={trace.id}>
          <svg className="test-legend-key" viewBox="0 0 32 10" aria-hidden="true">
            <line x1={1} y1={5} x2={31} y2={5} stroke={trace.color} strokeWidth={2} strokeDasharray={trace.dash.join(" ")} />
          </svg><span>{trace.label}</span>
        </li>)}
      </ul>
      <div className="test-chart-scroll">
        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img"
          aria-label={`${device.name}: ${chart.traces.length} signals, ${chart.observedCount} recorded values, ${describeTime(graphClock)}`}
          data-time-start={chart.domain.startMs} data-time-end={chart.domain.endMs}>
          {chart.axes[0].yTicks.map((tick, index) => <line key={`grid-${index}`}
            x1={plot.left} y1={tick.y} x2={plot.left + plot.width} y2={tick.y} className="test-gridline" />)}
          {chart.axes.map(axis => <g key={axis.id} className="test-value-axis" data-unit={axis.unit}>
            <line x1={axis.x} y1={plot.top} x2={axis.x} y2={plot.top + plot.height} className="test-axis-line" />
            <text x={axis.x + (axis.side === "left" ? -8 : 8)} y={plot.top - 8}
              textAnchor={axis.side === "left" ? "end" : "start"}>{axis.unit}</text>
            {axis.yTicks.map((tick, index) => <text key={index}
              x={axis.x + (axis.side === "left" ? -8 : 8)} y={tick.y + 4}
              textAnchor={axis.side === "left" ? "end" : "start"}>{tick.label}</text>)}
          </g>)}
          {chart.xTicks.map((tick, index) => <g key={`x-${index}`}>
            <line x1={tick.x} y1={plot.top} x2={tick.x} y2={plot.top + plot.height} className="test-gridline" />
            <text x={tick.x} y={plot.top + plot.height + 21} textAnchor="middle">{tick.label}</text>
            {tick.dateLabel && <text x={tick.x} y={plot.top + plot.height + 37} textAnchor="middle">{tick.dateLabel}</text>}
          </g>)}
          {chart.traces.map(trace => <g key={trace.id} className="test-signal" data-signal={trace.label}
            style={{ "--test-trace-color": trace.color }}>
            {trace.connections.map((segment, index) => <line key={`trace-${index}`}
              x1={segment.from.x} y1={segment.from.y} x2={segment.to.x} y2={segment.to.y}
              className="test-trace" strokeDasharray={trace.dash.join(" ")} />)}
            {trace.extension && <line x1={trace.extension.from.x} y1={trace.extension.from.y}
              x2={trace.extension.to.x} y2={trace.extension.to.y} className="test-held-value">
              <title>{trace.label}: last recorded value held to the end of the graph</title>
            </line>}
            {trace.points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={3} className="test-observation">
              <title>{trace.label}: {formatSourceTime(point.timeMs, true)}: {formatTestValue(point.value)} {trace.unit} · source row {point.sourceRow}</title>
            </circle>)}
            {trace.invalidPoints.filter(point => point.x !== null).map((point, index) =>
              <path key={`invalid-${index}`} d={`M${point.x - 4} ${plot.top + plot.height - 4}l8 8m-8 0l8 -8`} className="test-invalid-observation">
                <title>{trace.label}: {point.time || formatSourceTime(point.timeMs, true)}: invalid reading {point.rawValue}</title>
              </path>)}
          </g>)}
        </svg>
      </div>
      <p>{chart.observedCount} recorded change values{chart.invalidCount ? ` · ${chart.invalidCount} invalid readings` : ""}. Lines connect analog readings; steps connect digital states. Dashed tails hold final values to the graph end. Signals share this device's time axis{clock.basis === "absolute" ? " in UTC" : ""}; different units use separate vertical scales.</p>
      <details className="test-events"><summary>View recorded events ({eventCount})</summary>
        <div className="test-table-scroll"><table>
          <thead><tr><th>Signal</th><th>Source time</th><th>Previous</th><th>Recorded value</th><th>Source row</th></tr></thead>
          <tbody>{chart.traces.flatMap(trace => trace.series.points.map((point, index) => <tr key={`${trace.id}:${index}`}>
            <td>{trace.label}</td>
            <td>{point.time || formatSourceTime(point.timeMs, true)}</td>
            <td>{point.previousRawValue ?? formatTestValue(point.previousValue)}</td>
            <td>{point.rawValue ?? formatTestValue(point.value)}{point.valid === false && " (invalid)"}</td>
            <td>{point.sourceRow}</td>
          </tr>))}</tbody>
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

export function TestRunDetail({ run }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const devices = run.devices || [];
  const shown = useMemo(() => devices.filter(device => `${device.name} ${device.status}`.toLowerCase().includes(search.toLowerCase())), [devices, search]);
  const device = shown.find(item => item.id === selected) || shown[0];
  const counts = devices.reduce((result, item) => ({ ...result, [item.status]: (result[item.status] || 0) + 1 }), {});
  const noteClarification = importNoteClarification(run.warnings);
  return <div className="test-run-detail">
    <div className="test-run-facts">
      <div><span>Software</span><strong>{run.software?.name} {run.software?.version || "— version required"}</strong></div>
      <div><span>Run time span</span><strong>{describeTime(run.clock)}</strong><small>{run.clock?.basis === "absolute" ? "Graphs use UTC. Original event timestamps retain their source offsets." : run.clock?.timeZone || "Source clock, timezone not recorded"}</small></div>
      <div><span>Device results</span><strong>{counts.Passed || 0} passed · {counts.Failed || 0} failed · {counts["Not tested"] || 0} not tested</strong></div>
    </div>
    <p className="test-meaning">Passed/Failed comes from the recorded PRONETA wiring result. Graphs show logged signal changes in their original units.</p>
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
          <TestDeviceChart device={device} clock={run.clock} stations={run.stations} />
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
              <Parameters parameters={channel.parameters} />
              {module?.parameters?.length > 0 && <Parameters parameters={module.parameters} title="Shared module parameters" />}
            </section>;
          })}
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

export default function TestReportsPanel({
  project, runs = [], inspector, readOnly = false, pending = false, exportProgress = "",
  onSave, onDelete, onExport, onReview, onDirtyChange,
  getPhotoUrl, onAddSetupPhoto, onUpdateSetupPhoto, onRemoveSetupPhoto,
}) {
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
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
  const stale = draft && (draft.revision !== project.revision || draft.walkdownId !== project.walkdownId);
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

  function begin(run = null) {
    if (readOnly || blocked || setupDirty || draft || (run && !canEdit(run))) return;
    setError(""); setFiles([]); setAssignments({}); setConfirmDelete(null);
    setDraft({
      revision: project.revision, walkdownId: project.walkdownId,
      id: run?.id || crypto.randomUUID(), runVersion: run?.runVersion ?? null,
      name: run?.name || "Control box I/O test", software: { ...(run?.software || EMPTY_SOFTWARE) },
      timeZone: run?.clock?.timeZone || "Source clock (timezone not recorded)",
      data: run ? structuredClone(run) : null,
    });
  }
  function discard() {
    if (busyRef.current) return;
    ++parseRef.current; setDraft(null); setFiles([]); setAssignments({}); setError("");
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
      if (run === parseRef.current) setDraft(previous => previous && ({ ...previous, data: parsed }));
    } catch (e) {
      if (run === parseRef.current) { setError(e.message); setDraft(previous => previous && ({ ...previous, data: null })); }
    } finally {
      if (run === parseRef.current) { busyRef.current = false; setBusy(""); }
    }
  }
  async function chooseFiles(event) {
    const chosen = Array.from(event.target.files || []); event.target.value = "";
    if (!chosen.length) return;
    setFiles(chosen); setAssignments({});
    await parseFiles(chosen, {});
  }
  async function save() {
    if (!draft?.data || blocked || busyRef.current || readOnly || stale) return;
    if (!draft.name.trim() || !draft.software.name.trim() || !draft.software.version.trim()) {
      setError("Enter the test run name, software name, and software version before saving."); return;
    }
    const payload = { ...draft.data, id: draft.id, runVersion: draft.runVersion,
      name: draft.name.trim(), software: { name: draft.software.name.trim(), version: draft.software.version.trim() },
      clock: { ...draft.data.clock, timeZone: draft.timeZone.trim() || "Source clock (timezone not recorded)" },
    };
    busyRef.current = true; setBusy("save"); setError("");
    try {
      if (access.current.readOnly || access.current.revision !== draft.revision || access.current.walkdownId !== draft.walkdownId)
        throw new Error("This draft belongs to an earlier revision. Discard it and reopen the current report.");
      const saved = await onSave(payload, draft.revision);
      setSelectedId(saved?.id || draft.id); setDraft(null); setFiles([]); setAssignments({});
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
    clock: { ...draft.data.clock, timeZone: draft.timeZone } } : null) : selectedRun;
  return <section className="test-reports" aria-label="I/O test reports">
    <div className="card test-intro">
      <div><span className="eyebrow">SOFTWARE TEST EVIDENCE</span><h2>I/O test reports</h2>
        <p>Import all PRONETA CSV results, event logs, and .mpr parameter files from one run together.</p></div>
      {!readOnly && !draft && <button className="button primary" type="button" onClick={() => begin()} disabled={blocked || setupDirty}><Icon name="upload" />Import test run</button>}
      <button type="button" className="button secondary" onClick={onReview}>Revision {project.revision} · {project.status === "closed" ? "Approved & closed" : "Review & approve"}</button>
    </div>
    {exportProgress && <p className="test-export-progress" role="status"><span className="spinner" />{exportProgress}</p>}
    {error && <p className="message error" role="alert">{error}</p>}
    {draft && <section className="card test-import-form" aria-label="Import test run">
      <h3>{draft.runVersion ? "Edit test run" : "Import a test run"}</h3>
      {(readOnly || stale) && <p className="field-error" role="alert">This revision was closed or changed. Your local preview is retained. Discard this import and start again in the current draft to save it.</p>}
      <fieldset disabled={blocked || readOnly || stale}>
        <div className="test-metadata-grid">
          <label>Test run name<input value={draft.name} maxLength={160} onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} /></label>
          <label>Software name<input value={draft.software.name} maxLength={120} onChange={event => setDraft(previous => ({ ...previous, software: { ...previous.software, name: event.target.value } }))} /></label>
          <label>Software version<input value={draft.software.version} placeholder="Version used for this test" maxLength={80} onChange={event => setDraft(previous => ({ ...previous, software: { ...previous.software, version: event.target.value } }))} /></label>
          <label>Source clock / timezone<input value={draft.timeZone} maxLength={120} onChange={event => setDraft(previous => ({ ...previous, timeZone: event.target.value }))} /></label>
        </div>
        <p className="test-muted">Use the software version you ran. Module firmware versions in the files are recorded separately. Times stay as recorded by the source computer.</p>
        <label className="test-file-choice">{draft.data ? "Replace source files" : "Source files"}<input type="file" multiple accept=".csv,.mpr,text/csv,application/xml,text/xml" onChange={chooseFiles} /></label>
        {files.length > 0 && <div className="test-file-list">
          <p>Station names are matched automatically. For renamed files, enter their station name below, then read the files again.</p>
          {files.map((file, index) => <label key={`${file.name}:${index}`}><span>{file.name}</span>
            <input aria-label={`Station for ${file.name}`} placeholder="Auto-detect station" value={assignments[file.name] || ""}
              onChange={event => { setAssignments(previous => ({ ...previous, [file.name]: event.target.value })); setDraft(previous => ({ ...previous, data: null })); }} /></label>)}
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
    {preview && <section className="card test-preview"><header><h2>{preview.name}</h2><span>{draft ? "Unsaved preview" : `Revision ${project.revision}`}</span></header><TestRunDetail key={preview.id || draft?.id} run={preview} /></section>}
    {!preview && !draft && <div className="card test-empty"><Icon name="report" size={36} /><h3>No test runs in this revision</h3><p>{readOnly ? "Start a new revision to import a test run." : "Import the files for your test, review the devices and parameters, then save the run."}</p></div>}
  </section>;
}
