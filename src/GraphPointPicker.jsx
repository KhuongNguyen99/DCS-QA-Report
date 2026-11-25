import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { buildTestChart, formatSourceTime, formatTestValue, isDigitalOutputChannel, isTestTimeRange } from "./test-chart.js";
import { createPointEndpoint } from "./test-graph-tools.js";
import "./graph-point-picker.css";

export default function GraphPointPicker({ run, entry, label, timeRange, disabled = false, onChoose, onCancel }) {
  const id = useId();
  const container = useRef(null);
  const [selectedIndex, setSelectedIndex] = useState("");
  const [error, setError] = useState("");
  const field = label.toLowerCase();
  const graphName = entry ? `${entry.deviceName} / ${entry.name}` : "the selected graph";
  const { chart, chartError } = useMemo(() => {
    try {
      if (!entry) throw new Error("The selected graph is unavailable. Choose another graph.");
      const instant = Number.isSafeInteger(timeRange?.startMs) && timeRange.startMs === timeRange.endMs
        && timeRange.startMs === run?.clock?.startMs && timeRange.endMs === run?.clock?.endMs;
      if (!instant && !isTestTimeRange(timeRange, run?.clock))
        throw new Error("Choose a valid Device time axis before selecting a recorded point.");
      return { chart: buildTestChart(entry.series, run.clock, {
        width: 640, height: 240, style: entry.settings?.style || "auto",
        showInitialState: isDigitalOutputChannel(entry.channel),
        ...(instant ? { deviceTimeRange: timeRange } : { timeRange }),
      }), chartError: "" };
    } catch (failure) { return { chart: null, chartError: failure.message }; }
  }, [run, entry, timeRange]);
  useEffect(() => {
    setSelectedIndex(""); setError("");
    if (!disabled) container.current?.querySelector('.test-observation[role="button"]')?.focus();
  }, [entry?.deviceId, entry?.graphKey, timeRange?.startMs, timeRange?.endMs, disabled]);
  function describePoint(point) {
    const source = run.sources?.find(item => item.id === point.sourceId)?.name || point.sourceId;
    return `${formatSourceTime(point.timeMs, true, true)} · ${formatTestValue(point.value)} ${chart.unit}`
      + `${source ? ` · ${source}` : ""}${point.sourceRow != null ? ` · source row ${point.sourceRow}` : ""} · event ${point.pointIndex + 1}`;
  }
  function choose(pointIndex) {
    if (disabled || !chart) return;
    try {
      const point = chart.points.find(item => item.pointIndex === pointIndex);
      if (!point) throw new Error("Choose a retained recorded point within the Device time axis.");
      const endpoint = createPointEndpoint(run, entry.deviceId, entry.graphKey, pointIndex);
      if (endpoint.timeMs < timeRange.startMs || endpoint.timeMs > timeRange.endMs)
        throw new Error("The selected point is outside the Device time axis. Choose another point.");
      if (["timeMs", "value", "sourceId", "sourceRow"].some(key => endpoint[key] !== point[key]))
        throw new Error("This recorded point changed. Reopen the picker and select it again.");
      setError(""); onChoose(endpoint);
    } catch (failure) { setError(failure.message); }
  }
  const selectedPoint = chart?.points.find(point => String(point.pointIndex) === selectedIndex);
  return <section ref={container} className="test-graph-point-picker" aria-label={`Pick ${field} point from ${graphName}`}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <div className="test-graph-point-picker-heading"><strong>Pick {field} point from {graphName}</strong>
      <button type="button" className="small-button" onClick={onCancel}>Cancel point picking</button></div>
    {entry && entry.name !== entry.series.name && <p>Source: {entry.series.name}</p>}
    {chartError ? <p className="field-error" role="alert">{chartError}</p> : <>
      <p id={`${id}-help`}>Choose a recorded dot or use the list below. The list identifies overlapping readings by source row and event number.</p>
      <p className="test-graph-point-picker-range">Device time axis: {formatSourceTime(timeRange.startMs, true, true)} – {formatSourceTime(timeRange.endMs, true, true)}{run.clock.basis === "absolute" && " UTC"}.</p>
      <div className="test-graph-point-picker-scroll"><svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="group"
        aria-label={`${graphName}: choose a recorded ${field} point within the Device time axis`}
        data-picker-time-start={chart.domain.startMs} data-picker-time-end={chart.domain.endMs}>
        {chart.yTicks.map((tick, index) => <g key={`y-${index}`}>
          <line x1={chart.plot.left} y1={tick.y} x2={chart.plot.left + chart.plot.width} y2={tick.y} className="test-gridline" />
          <text x={chart.plot.left - 8} y={tick.y + 4} textAnchor="end">{tick.label}</text>
        </g>)}
        {chart.xTicks.map((tick, index) => <g key={`x-${index}`}>
          <line x1={tick.x} y1={chart.plot.top} x2={tick.x} y2={chart.plot.top + chart.plot.height} className="test-gridline" />
          <text x={tick.x} y={chart.plot.top + chart.plot.height + 21} textAnchor="middle">{tick.label}</text>
          {tick.dateLabel && <text x={tick.x} y={chart.plot.top + chart.plot.height + 37} textAnchor="middle">{tick.dateLabel}</text>}
        </g>)}
        {chart.connections.map((line, index) => <line key={`line-${index}`} className="test-trace"
          x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y} />)}
        {chart.curves.map((curve, index) => <path key={`curve-${index}`} className="test-trace test-smooth-trace"
          d={`M ${curve.from.x} ${curve.from.y} C ${curve.control1.x} ${curve.control1.y} ${curve.control2.x} ${curve.control2.y} ${curve.to.x} ${curve.to.y}`} />)}
        {[chart.leading, chart.extension].filter(Boolean).map((line, index) => <line key={`held-${index}`} className="test-held-value"
          x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y} />)}
        {chart.points.map(point => <circle key={point.pointIndex} cx={point.x} cy={point.y} r={6}
          className={`test-observation${disabled ? "" : " is-pickable"}${selectedIndex === String(point.pointIndex) ? " is-selected" : ""}`}
          data-point-index={point.pointIndex} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined}
          aria-label={`Choose ${field}: ${describePoint(point)}`} onClick={() => choose(point.pointIndex)}
          onKeyDown={event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); choose(point.pointIndex); } }}>
          <title>{describePoint(point)}</title>
        </circle>)}
        {chart.invalidPoints.filter(point => point.x !== null).map(point => <path key={`invalid-${point.pointIndex}`}
          d={`M${point.x - 4} ${chart.plot.top + chart.plot.height - 4}l8 8m-8 0l8 -8`} className="test-invalid-observation">
          <title>Invalid reading: {formatSourceTime(point.timeMs, true, true)}</title>
        </path>)}
      </svg></div>
      {!chart.points.length && <p role="status">No retained valid readings are available within this Device time axis. Adjust the device interval or choose another graph.</p>}
      <label htmlFor={`${id}-point`}>{label} recorded point</label>
      <select id={`${id}-point`} value={selectedPoint ? selectedIndex : ""} disabled={disabled || !chart.points.length}
        aria-describedby={`${id}-help`} onChange={event => { setSelectedIndex(event.target.value); setError(""); }}>
        <option value="">Choose a recorded point</option>
        {chart.points.map(point => <option key={point.pointIndex} value={point.pointIndex}>{describePoint(point)}</option>)}
      </select>
      <button type="button" className="small-button test-graph-point-picker-use" disabled={disabled || !selectedPoint}
        onClick={() => choose(selectedPoint.pointIndex)}>Use selected {field} point</button>
    </>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
