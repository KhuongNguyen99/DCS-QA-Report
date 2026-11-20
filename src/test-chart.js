/** PRONETA timestamps have no UTC offset. UTC is only a wall-clock coordinate. */
export function formatSourceTime(timeMs, includeDate = false) {
  if (!Number.isFinite(timeMs)) return "Unknown time";
  const value = new Date(timeMs);
  if (!Number.isFinite(value.getTime())) return "Unknown time";
  const iso = value.toISOString();
  const time = iso.slice(11, 19);
  return includeDate ? `${iso.slice(0, 10)} ${time}` : time;
}

export function formatTestValue(value) {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e7 || magnitude < 0.0001) return value.toExponential(3);
  return Number(value.toPrecision(7)).toString();
}

/**
 * Geometry shared by the SVG preview and vector PDF chart. Every call requires
 * the run-wide clock, never a channel's first/last point. Only observed after-
 * values are plotted; event logs cannot establish a continuous sampled trace.
 */
export function buildTestChart(series, clock, {
  width = 700, height = 220,
  padding = { left: 62, right: 22, top: 20, bottom: 48 },
  tickCount = 5,
} = {}) {
  const startMs = clock?.startMs;
  const endMs = clock?.endMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
    throw new Error("A valid shared test-run time span is required for the graph.");
  if (!Array.isArray(series?.points)) throw new Error("The graph series has no observation list.");
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
  for (const point of series.points) {
    if (!Number.isFinite(point.timeMs)) {
      invalid.push({ ...point, x: null });
      continue;
    }
    if (point.timeMs < startMs || point.timeMs > endMs)
      throw new Error("An observation falls outside the shared test-run time span.");
    const candidate = { ...point, x: xFor(point.timeMs) };
    if (point.valid === false || !Number.isFinite(point.value)
      || (series.kind === "digital" && point.value !== 0 && point.value !== 1)) invalid.push(candidate);
    else valid.push(candidate);
  }
  let min;
  let max;
  if (series.kind === "digital") {
    min = 0; max = 1;
  } else if (valid.length) {
    min = Infinity; max = -Infinity;
    for (const point of valid) {
      min = Math.min(min, point.value);
      max = Math.max(max, point.value);
    }
    const margin = min === max ? Math.max(Math.abs(min) * 0.05, 0.1) : (max - min) * 0.08;
    min -= margin; max += margin;
  } else {
    min = 0; max = 1;
  }
  const yFor = (value) => top + (max - value) / (max - min) * plot.height;
  const count = Math.max(2, Math.min(9, Math.floor(tickCount) || 5));
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
      timeMs, x: xFor(timeMs), label: formatSourceTime(timeMs),
      dateLabel: spanningDays ? formatSourceTime(timeMs, true).slice(0, 10) : "",
      fullLabel: formatSourceTime(timeMs, true),
    })),
    yTicks: yValues.map((value) => ({ value, y: yFor(value), label: formatTestValue(value) })),
    points: valid.map((point) => ({ ...point, y: yFor(point.value) })),
    invalidPoints: invalid,
    observedCount: valid.length,
    invalidCount: invalid.length,
  };
}
