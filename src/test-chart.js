/** PRONETA timestamps have no UTC offset. UTC is only a wall-clock coordinate. */
export function formatSourceTime(timeMs, includeDate = false, includeMilliseconds = false) {
  if (!Number.isFinite(timeMs)) return "Unknown time";
  const value = new Date(timeMs);
  if (!Number.isFinite(value.getTime())) return "Unknown time";
  const iso = value.toISOString();
  const time = iso.slice(11, includeMilliseconds ? 23 : 19);
  return includeDate ? `${iso.slice(0, 10)} ${time}` : time;
}

export function formatTestValue(value) {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e7 || magnitude < 0.0001) return value.toExponential(3);
  return Number(value.toPrecision(7)).toString();
}

function defaultValueRange(series) {
  const unit = String(series.unit || "").replace(/\s+/g, "").toLowerCase();
  const signalName = String(series.name || "").replace(/\s+/g, "");
  return unit === "ma" && /(?:[-_]POS$|^(?:PD|DP)-)/i.test(signalName)
    ? [0, 25] : unit === "°c" ? [20, 30] : null;
}

function valueRange(kind, points, defaultRange) {
  if (kind === "digital") return { min: 0, max: 1 };
  if (!points.length && !defaultRange) return { min: 0, max: 1 };
  let min = defaultRange?.[0] ?? Infinity;
  let max = defaultRange?.[1] ?? -Infinity;
  for (const point of points) {
    min = Math.min(min, point.value);
    max = Math.max(max, point.value);
  }
  const margin = min === max ? Math.max(Math.abs(min) * 0.05, 0.1) : (max - min) * 0.08;
  // Keep the standard frame unless a valid observation needs more room.
  if (!defaultRange || min < defaultRange[0]) min -= margin;
  if (!defaultRange || max > defaultRange[1]) max += margin;
  return { min, max };
}

/**
 * Geometry shared by the SVG preview and vector PDF chart. The run-wide clock
 * validates timestamps; each graph fits its own dated observations. Dots stay
 * tied to observed after-values. Connections and the held value are display-only
 * geometry, so no synthetic readings enter the saved evidence or event count.
 */
export function buildTestChart(series, clock, {
  width = 700, height = 220,
  padding = { left: 62, right: 22, top: 20, bottom: 48 },
  tickCount = 5,
  sharedDomain = null,
} = {}) {
  const runStartMs = clock?.startMs;
  const runEndMs = clock?.endMs;
  if (!Number.isFinite(runStartMs) || !Number.isFinite(runEndMs) || runEndMs < runStartMs)
    throw new Error("A valid shared test-run time span is required for the graph.");
  if (!Array.isArray(series?.points)) throw new Error("The graph series has no observation list.");
  let firstMs = Infinity, lastMs = -Infinity;
  for (const point of series.points) {
    if (!Number.isFinite(point.timeMs)) continue;
    if (point.timeMs < runStartMs || point.timeMs > runEndMs)
      throw new Error("An observation falls outside the shared test-run time span.");
    firstMs = Math.min(firstMs, point.timeMs);
    lastMs = Math.max(lastMs, point.timeMs);
  }
  let startMs = runStartMs, endMs = runEndMs;
  if (firstMs !== Infinity) {
    const margin = Math.max((lastMs - firstMs) * 0.04, 1000);
    startMs = Math.max(runStartMs, firstMs - margin);
    endMs = Math.min(runEndMs, lastMs + margin);
  }
  if (sharedDomain) {
    const { startMs: start, endMs: end } = sharedDomain;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start
      || start < runStartMs || end > runEndMs || start > firstMs || end < lastMs)
      throw new Error("A shared graph time range must contain every dated observation within the run.");
    startMs = start; endMs = end;
  }
  const { left, right, top, bottom } = padding;
  if (![width, height, left, right, top, bottom].every(Number.isFinite)
    || width <= left + right || height <= top + bottom
    || Math.min(left, right, top, bottom) < 0)
    throw new Error("The graph dimensions are invalid.");
  const plot = { left, top, width: width - left - right, height: height - top - bottom };
  const xFor = (time) => startMs === endMs ? left + plot.width / 2
    : left + (time - startMs) / (endMs - startMs) * plot.width;
  const valid = [];
  const invalid = [];
  const sequence = [];
  let latestTime = -Infinity;
  for (const point of series.points) {
    if (!Number.isFinite(point.timeMs)) {
      invalid.push({ ...point, x: null });
      sequence.push(null);
      continue;
    }
    if (point.timeMs < latestTime)
      throw new Error("Observations must be ordered by time before connecting the graph.");
    latestTime = point.timeMs;
    const candidate = { ...point, x: xFor(point.timeMs) };
    if (point.valid === false || !Number.isFinite(point.value)
      || (series.kind === "digital" && point.value !== 0 && point.value !== 1)) {
      invalid.push(candidate);
      sequence.push(null);
    } else {
      valid.push(candidate);
      sequence.push(candidate);
    }
  }
  let { min, max } = valueRange(series.kind, valid, defaultValueRange(series));
  if (sharedDomain) {
    const { min: lower, max: upper } = sharedDomain;
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower
      || valid.some(point => point.value < lower || point.value > upper))
      throw new Error("A shared graph value range must contain every valid observation.");
    min = lower; max = upper;
  }
  const yFor = (value) => top + (max - value) / (max - min) * plot.height;
  const points = valid.map((point) => ({ ...point, y: yFor(point.value) }));
  const connections = [];
  const coordinate = (point) => ({ x: point.x, y: yFor(point.value) });
  const connect = (from, to) => {
    if (from.x !== to.x || from.y !== to.y) connections.push({ from, to });
  };
  let previous = null;
  for (const point of sequence) {
    if (previous && point) {
      const from = coordinate(previous);
      const to = coordinate(point);
      if (series.kind === "digital") {
        const corner = { x: to.x, y: from.y };
        connect(from, corner);
        connect(corner, to);
      } else connect(from, to);
    }
    // An invalid observation breaks the trace, including a held final value.
    previous = point;
  }
  const extension = previous && previous.timeMs < endMs
    ? { from: coordinate(previous), to: { x: plot.left + plot.width, y: yFor(previous.value) } }
    : null;
  const count = Math.max(2, Math.min(9, Math.floor(tickCount) || 5, Math.floor((endMs - startMs) / 1000) + 1));
  const milliseconds = endMs > startMs && (endMs - startMs) / (count - 1) < 1000;
  const spanningDays = formatSourceTime(startMs, true).slice(0, 10) !== formatSourceTime(endMs, true).slice(0, 10);
  const ticks = startMs === endMs ? [startMs]
    : Array.from({ length: count }, (_, index) => startMs + (endMs - startMs) * index / (count - 1));
  const yValues = series.kind === "digital" ? [0, 1]
    : Array.from({ length: 5 }, (_, index) => min + (max - min) * index / 4);
  return {
    width, height, plot,
    domain: { startMs, endMs, min, max },
    unit: series.unit || (series.kind === "digital" ? "State" : "Recorded value"),
    xTicks: ticks.map((timeMs) => ({
      timeMs, x: xFor(timeMs), label: formatSourceTime(timeMs, false, milliseconds),
      dateLabel: spanningDays ? formatSourceTime(timeMs, true).slice(0, 10) : "",
      fullLabel: formatSourceTime(timeMs, true, milliseconds),
    })),
    yTicks: yValues.map((value) => ({ value, y: yFor(value), label: formatTestValue(value) })),
    points, connections, extension,
    invalidPoints: invalid,
    observedCount: valid.length,
    invalidCount: invalid.length,
  };
}

/** Combine display geometry only; channel records and source series stay intact. */
export function buildDeviceTestChart(device, clock, options = {}) {
  const entries = (device.channels || []).flatMap(channel => (channel.series || [])
    .filter(series => series.points?.length).map(series => ({ channel, series })));
  if (!entries.length) return null;
  const groups = new Map();
  for (const entry of entries) {
    const kind = entry.series.kind === "digital" ? "digital" : "analog";
    const unit = kind === "digital" ? "State" : String(entry.series.unit || "").trim() || "Recorded value";
    const key = `${kind}:${unit.replace(/\s+/g, "")}`;
    if (!groups.has(key)) groups.set(key, { id: key, kind, unit, points: [], defaultRange: null });
    entry.axisId = key;
  }
  const axes = [...groups.values()].sort((a, b) => (a.kind === "digital") - (b.kind === "digital"));
  const width = options.width ?? 700;
  const padding = options.padding ?? { left: 62, right: 22, top: 20, bottom: 48 };
  const axisGap = Math.max(0, Math.min(64, (width - padding.left - padding.right - 200) / Math.max(1, axes.length - 1)));
  const layout = { ...options, padding: { ...padding, right: padding.right + axisGap * (axes.length - 1) } };
  let startMs = Infinity, endMs = -Infinity;
  for (const entry of entries) {
    const chart = buildTestChart(entry.series, clock, layout);
    const axis = groups.get(entry.axisId);
    for (const point of chart.points) axis.points.push(point);
    axis.defaultRange ||= defaultValueRange(entry.series);
    if (entry.series.points.some(point => Number.isFinite(point.timeMs))) {
      startMs = Math.min(startMs, chart.domain.startMs);
      endMs = Math.max(endMs, chart.domain.endMs);
    }
    entry.name = entry.series.name || entry.channel.symbolicName || "Recorded values";
    entry.label = `${entry.name} (${axis.unit})`;
  }
  for (const axis of axes) Object.assign(axis, valueRange(axis.kind, axis.points, axis.defaultRange));
  if (startMs === Infinity) { startMs = clock.startMs; endMs = clock.endMs; }
  const shared = buildTestChart({ points: [] }, { ...clock, startMs, endMs }, layout);
  const labels = new Map();
  for (const entry of entries) labels.set(entry.label, (labels.get(entry.label) || 0) + 1);
  const colors = ["#186ca1", "#1f6939", "#8c4aa5", "#b66b08", "#00818a", "#a33f61", "#596b28", "#66524a"];
  const patterns = [[], [8, 3], [2, 3], [8, 3, 2, 3]];
  const traces = entries.map((entry, index) => {
    const axis = groups.get(entry.axisId);
    const chart = buildTestChart(entry.series, clock, { ...layout, sharedDomain: { startMs, endMs, min: axis.min, max: axis.max } });
    const { channel } = entry;
    const station = options.stations?.find(item => item.id === channel.stationId)?.name || channel.stationId || "Station unspecified";
    const label = labels.get(entry.label) > 1
      ? `${entry.label} · ${station}, slot ${channel.slot ?? "?"}, channel ${channel.channel ?? "?"}`
      : entry.label;
    return { ...chart, ...entry, label, unit: axis.unit, kind: axis.kind,
      id: `${channel.id || "channel"}:${entry.series.id || "series"}:${index}`,
      color: colors[index % colors.length], dash: patterns[Math.floor(index / colors.length) % patterns.length] };
  });
  const chartAxes = axes.map((axis, index) => {
    const values = axis.kind === "digital" ? [0, 1]
      : Array.from({ length: 5 }, (_, tick) => axis.min + (axis.max - axis.min) * tick / 4);
    return { id: axis.id, kind: axis.kind, unit: axis.unit, min: axis.min, max: axis.max,
      side: index === 0 ? "left" : "right",
      x: index === 0 ? shared.plot.left : shared.plot.left + shared.plot.width + (index - 1) * axisGap,
      yTicks: values.map(value => ({ value, label: formatTestValue(value),
        y: shared.plot.top + (axis.max - value) / (axis.max - axis.min) * shared.plot.height })) };
  });
  return { width: shared.width, height: shared.height, plot: shared.plot, domain: { startMs, endMs },
    xTicks: shared.xTicks, axes: chartAxes, traces,
    observedCount: traces.reduce((sum, trace) => sum + trace.observedCount, 0),
    invalidCount: traces.reduce((sum, trace) => sum + trace.invalidCount, 0) };
}
