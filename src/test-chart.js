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

export function isTestTimeRange(range, clock) {
  return Boolean(range && typeof range === "object" && !Array.isArray(range)
    && Number.isSafeInteger(range.startMs) && Number.isSafeInteger(range.endMs)
    && Number.isFinite(clock?.startMs) && Number.isFinite(clock?.endMs)
    && range.startMs < range.endMs && range.startMs >= clock.startMs && range.endMs <= clock.endMs);
}

function isDeviceTimeRange(range, clock) {
  return Boolean(range && typeof range === "object" && !Array.isArray(range)
    && Number.isSafeInteger(range.startMs) && Number.isSafeInteger(range.endMs)
    && Number.isFinite(clock?.startMs) && Number.isFinite(clock?.endMs)
    && (range.startMs < range.endMs || (range.startMs === range.endMs && clock.startMs === clock.endMs))
    && range.startMs >= clock.startMs && range.endMs <= clock.endMs);
}

export const isDigitalOutputChannel = channel => /(?:^|\s)(?:command|output)$/i.test(channel.role || "");

function automaticTimeRange(series, clock) {
  const runStartMs = clock?.startMs;
  const runEndMs = clock?.endMs;
  if (!Number.isFinite(runStartMs) || !Number.isFinite(runEndMs) || runEndMs < runStartMs)
    throw new Error("A valid shared test-run time span is required for the graph.");
  if (!Array.isArray(series?.points)) throw new Error("The graph series has no observation list.");
  let firstMs = Infinity, lastMs = -Infinity;
  for (const point of series.points) {
    if (Object.hasOwn(point, "excluded") && typeof point.excluded !== "boolean")
      throw new Error("A recorded event's excluded flag must be true or false.");
    if (!Number.isFinite(point.timeMs)) continue;
    if (point.timeMs < runStartMs || point.timeMs > runEndMs)
      throw new Error("An observation falls outside the shared test-run time span.");
    if (point.excluded === true) continue;
    firstMs = Math.min(firstMs, point.timeMs);
    lastMs = Math.max(lastMs, point.timeMs);
  }
  if (firstMs === Infinity) return null;
  const margin = Math.max((lastMs - firstMs) * 0.04, 1000);
  return { startMs: Math.max(runStartMs, firstMs - margin), endMs: Math.min(runEndMs, lastMs + margin) };
}

export function deviceChartTimeRange(device, clock) {
  let startMs = Infinity, endMs = -Infinity;
  for (const channel of device?.channels || []) for (const series of channel.series || []) {
    let range;
    try { range = automaticTimeRange(series, clock); }
    catch { continue; } // Invalid series display their own graph error.
    if (!range) continue;
    startMs = Math.min(startMs, range.startMs);
    endMs = Math.max(endMs, range.endMs);
  }
  return startMs === Infinity ? { startMs: clock?.startMs, endMs: clock?.endMs }
    : { startMs: Math.floor(startMs), endMs: Math.ceil(endMs) };
}

/**
 * Geometry shared by the SVG preview and vector PDF chart. The run-wide clock
 * validates timestamps; a device range aligns its graphs unless a manual range
 * overrides it. Standalone series still fit their own observations. Dots stay
 * tied to observed after-values. Connections and the held value are display-only
 * geometry, so no synthetic readings enter the saved evidence or event count.
 */
export function buildTestChart(series, clock, {
  width = 700, height = 220,
  padding = { left: 62, right: 22, top: 20, bottom: 48 },
  tickCount = 5, timeRange = null, deviceTimeRange = null, showInitialState = false,
} = {}) {
  const manualTimeRange = timeRange !== null;
  if (manualTimeRange && !isTestTimeRange(timeRange, clock))
    throw new Error("Choose an increasing whole-millisecond time range within the test run.");
  if (!manualTimeRange && deviceTimeRange !== null && !isDeviceTimeRange(deviceTimeRange, clock))
    throw new Error("A valid whole-millisecond device time range within the test run is required for the graph.");
  const suppliedRange = manualTimeRange ? timeRange : deviceTimeRange;
  const clipToRange = suppliedRange !== null;
  const automaticRange = automaticTimeRange(series, clock);
  const { startMs, endMs } = suppliedRange || automaticRange || clock;
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
  let latestTime = -Infinity, excludedCount = 0;
  for (const point of series.points) {
    if (Number.isFinite(point.timeMs)) {
      if (point.timeMs < latestTime)
        throw new Error("Observations must be ordered by time before connecting the graph.");
      latestTime = point.timeMs;
    }
    if (point.excluded === true) { excludedCount += 1; continue; }
    if (!Number.isFinite(point.timeMs)) {
      invalid.push({ ...point, x: null });
      sequence.push(null);
      continue;
    }
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
  let min;
  let max;
  const unit = String(series.unit || "").replace(/\s+/g, "").toLowerCase();
  const signalName = String(series.name || "").replace(/\s+/g, "");
  // Feedback tags hold their measured value until the next recorded change.
  // This affects connections only; voltage/current values retain their own scale.
  const feedback = /_FB$/i.test(signalName);
  const interpolation = series.kind === "digital" || feedback ? "step" : "linear";
  // The requested zero-voltage start is display-only. A leading invalid or
  // undated retained event leaves the earlier state unknown instead.
  const feedbackInitialPoint = feedback && series.kind === "analog" && ["v", "mv"].includes(unit)
    ? sequence[0] : null;
  const defaultRange = unit === "ma" && /(?:[-_]POS$|^(?:PD|DP)-)/i.test(signalName)
    ? [0, 25] : unit === "°c" ? [20, 30] : null;
  if (series.kind === "digital") {
    min = 0; max = 1;
  } else if (valid.length || defaultRange) {
    min = defaultRange?.[0] ?? Infinity; max = defaultRange?.[1] ?? -Infinity;
    for (const point of valid) {
      min = Math.min(min, point.value);
      max = Math.max(max, point.value);
    }
    if (feedbackInitialPoint) { min = Math.min(min, 0); max = Math.max(max, 0); }
    const margin = min === max ? Math.max(Math.abs(min) * 0.05, 0.1) : (max - min) * 0.08;
    // Keep the standard frame unless a valid observation needs more room.
    if (!defaultRange || min < defaultRange[0]) min -= margin;
    if (!defaultRange || max > defaultRange[1]) max += margin;
  } else {
    min = 0; max = 1;
  }
  const yFor = (value) => top + (max - value) / (max - min) * plot.height;
  const visible = point => !clipToRange || (point.timeMs >= startMs && point.timeMs <= endMs);
  const points = valid.filter(visible).map((point) => ({ ...point, y: yFor(point.value) }));
  const connections = [];
  const coordinate = (point) => ({ x: point.x, y: yFor(point.value) });
  const segment = (from, to) => {
    if (clipToRange) {
      const rightEdge = plot.left + plot.width;
      if (to.x < plot.left || from.x > rightEdge) return null;
      if (from.x !== to.x) {
        const yAt = x => from.y + (to.y - from.y) * ((x - from.x) / (to.x - from.x));
        const startX = Math.max(plot.left, from.x), endX = Math.min(rightEdge, to.x);
        const clippedFrom = { x: startX, y: startX === from.x ? from.y : yAt(startX) };
        const clippedTo = { x: endX, y: endX === to.x ? to.y : yAt(endX) };
        from = clippedFrom; to = clippedTo;
      }
    }
    return from.x !== to.x || from.y !== to.y ? { from, to } : null;
  };
  const connect = (from, to) => {
    const clipped = segment(from, to);
    if (clipped) connections.push(clipped);
  };
  const digitalInitialPoint = showInitialState && series.kind === "digital" && series.points[0]?.excluded !== true ? sequence[0] : null;
  const first = feedbackInitialPoint || digitalInitialPoint;
  let initialState = null;
  if (first && first.timeMs >= startMs) {
    if (feedbackInitialPoint) initialState = 0;
    else if (first.previousValid !== false && (first.previousValue === 0 || first.previousValue === 1))
      initialState = first.previousValue;
  }
  const initialCoordinate = initialState === null ? null : { x: first.x, y: yFor(initialState) };
  const leading = initialCoordinate ? segment({ x: plot.left, y: initialCoordinate.y }, initialCoordinate) : null;
  const initialTransition = initialCoordinate ? segment(initialCoordinate, coordinate(first)) : null;
  if (initialTransition) connections.push(initialTransition);
  const initialLabel = leading || initialTransition
    ? feedbackInitialPoint ? `Initial value 0.0 ${unit === "mv" ? "mV" : "V"}` : `Initial state ${initialState}`
    : null;
  let previous = null;
  for (const point of sequence) {
    if (previous && point) {
      const from = coordinate(previous);
      const to = coordinate(point);
      if (interpolation === "step") {
        const corner = { x: to.x, y: from.y };
        connect(from, corner);
        connect(corner, to);
      } else connect(from, to);
    }
    // An invalid observation breaks the trace, including a held final value.
    previous = point;
  }
  const extension = previous && previous.timeMs < endMs
    ? segment(coordinate(previous), { x: plot.left + plot.width, y: yFor(previous.value) })
    : null;
  const count = Math.max(2, Math.min(9, Math.floor(tickCount) || 5, Math.floor((endMs - startMs) / 1000) + 1));
  const milliseconds = endMs > startMs && (endMs - startMs) / (count - 1) < 1000;
  const spanningDays = formatSourceTime(startMs, true).slice(0, 10) !== formatSourceTime(endMs, true).slice(0, 10);
  const ticks = startMs === endMs ? [startMs]
    : Array.from({ length: count }, (_, index) => startMs + (endMs - startMs) * index / (count - 1));
  const yValues = series.kind === "digital" ? [0, 1]
    : Array.from({ length: 5 }, (_, index) => min + (max - min) * index / 4);
  return {
    width, height, plot, interpolation,
    domain: { startMs, endMs, min, max },
    unit: series.unit || (series.kind === "digital" ? "State" : "Recorded value"),
    xTicks: ticks.map((timeMs) => ({
      timeMs, x: xFor(timeMs), label: formatSourceTime(timeMs, false, milliseconds),
      dateLabel: spanningDays ? formatSourceTime(timeMs, true).slice(0, 10) : "",
      fullLabel: formatSourceTime(timeMs, true, milliseconds),
    })),
    yTicks: yValues.map((value) => ({ value, y: yFor(value), label: formatTestValue(value) })),
    points, connections, extension, initialState, initialLabel, leading,
    invalidPoints: invalid.filter(point => point.x === null || visible(point)),
    observedCount: valid.length,
    visibleObservedCount: points.length,
    invalidCount: invalid.length,
    excludedCount,
    manualTimeRange,
  };
}
