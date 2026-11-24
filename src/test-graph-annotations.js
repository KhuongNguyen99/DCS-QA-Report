import { buildTestChart, deviceChartTimeRange, formatTestValue } from "./test-chart.js";
import { resolveGraphMeasurement, runGraphEntries } from "./test-graph-tools.js";

const UNITS = new Set(["s", "min", "h"]);
const timestamp = value => Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
const segment = (from, to) => ({ from, to });
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Compact graph labels; endpoint provenance stays in the calculation details. */
export function formatGraphMeasurementResult(result) {
  if (result?.unavailable || result?.status === "unavailable") return "Unavailable";
  if (result?.status === "invalid") return "Invalid interval";
  if (result?.status !== "resolved") return "Unresolved";
  if (!Number.isFinite(result.value) || result.value < 0 || !UNITS.has(result.unit)) return "Invalid interval";
  return `${formatTestValue(result.value)} ${result.unit}`;
}

function resolvedBounds(result, clock) {
  if (result?.status !== "resolved" || result.unavailable
    || !timestamp(clock?.startMs) || !timestamp(clock?.endMs) || clock.startMs > clock.endMs
    || !timestamp(result.start?.timeMs) || !timestamp(result.end?.timeMs)
    || result.start.timeMs < clock.startMs || result.end.timeMs > clock.endMs
    || result.start.timeMs > result.end.timeMs
    || !Number.isFinite(result.value) || result.value < 0 || !UNITS.has(result.unit)) return null;
  return { startMs: result.start.timeMs, endMs: result.end.timeMs };
}

/**
 * Keep every graph of a device on the same automatic axis, including durations
 * whose original trigger/point is recorded on another device. PDF callers may
 * supply resolved measurements from their original, unfiltered graph entries.
 */
export function deviceCalculationTimeRange(device, run, resolvedMeasurements) {
  const range = deviceChartTimeRange(device, run?.clock);
  const measurements = resolvedMeasurements === undefined
    ? runGraphEntries({ ...run, devices: device ? [device] : [] }).flatMap(entry =>
      (entry.settings.measurements || []).map(measurement => ({ measurement, result: resolveGraphMeasurement(run, measurement) })))
    : resolvedMeasurements;
  if (!Array.isArray(measurements)) throw new Error("Graph calculations must be supplied as a list.");
  let { startMs, endMs } = range;
  for (const item of measurements) {
    const bounds = resolvedBounds(item?.result, run?.clock);
    if (!bounds) continue;
    startMs = Math.min(startMs, bounds.startMs);
    endMs = Math.max(endMs, bounds.endMs);
  }
  return { startMs, endMs };
}

function wrapLabel(label, width, measure) {
  const lines = [];
  let line = "";
  for (const word of label.split(/\s+/u).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= width) { line = candidate; continue; }
    if (line) { lines.push(line); line = ""; }
    if (measure(word) <= width) { line = word; continue; }
    // Long tags and names have no natural word boundary. Split by code point,
    // preserving every character rather than truncating a saved calculation.
    for (const character of word) {
      if (measure(character) > width) throw new Error("The graph is too narrow for its calculation labels.");
      if (line && measure(line + character) > width) { lines.push(line); line = ""; }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function moveChart(chart, offset) {
  const move = point => ({ ...point, y: point.y + offset });
  const moveSegment = line => line ? segment(move(line.from), move(line.to)) : null;
  return {
    ...chart, height: chart.height + offset, plot: { ...chart.plot, top: chart.plot.top + offset },
    points: chart.points.map(move), yTicks: chart.yTicks.map(move),
    connections: chart.connections.map(moveSegment),
    curves: chart.curves.map(curve => Object.fromEntries(Object.entries(curve).map(([key, point]) => [key, move(point)]))),
    leading: moveSegment(chart.leading), extension: moveSegment(chart.extension),
  };
}

function chevrons(x, y, direction, size, availableWidth) {
  const length = Math.min(size, availableWidth / 3);
  const inward = direction === "left" ? 1 : -1;
  return [0, length * 1.4].flatMap(offset => {
    const tip = { x: x + inward * offset, y };
    return [-1, 1].map(side => segment(tip, { x: tip.x + inward * length, y: y + side * length * 0.65 }));
  });
}

/**
 * Reserve a separate lane for every calculation without rescaling the signal
 * plot. All returned coordinates use the same SVG/PDF chart coordinate system;
 * labelLines use centered X and baseline Y. Draw all dashed guides first, then
 * solid vectors, then each white labelBox and its text to mask guide crossings.
 */
export function buildAnnotatedTestChart(series, clock, {
  measurements = [], annotationFontSize = 12, annotationLineHeight = 16, measureAnnotationText,
  ...chartOptions
} = {}) {
  const base = buildTestChart(series, clock, chartOptions);
  if (!Array.isArray(measurements)) throw new Error("Graph calculations must be supplied as a list.");
  if (!Number.isFinite(annotationFontSize) || annotationFontSize <= 0
    || !Number.isFinite(annotationLineHeight) || annotationLineHeight < annotationFontSize
    || (measureAnnotationText !== undefined && typeof measureAnnotationText !== "function"))
    throw new Error("The graph calculation label dimensions are invalid.");
  // A fallback must overestimate rather than clip a long label. Bundled Noto
  // Sans ASCII advances fit within 1 em; its widest Unicode glyph (U+2E3B)
  // occupies 2.84 em. PDF callers supply precise font measurements instead.
  const fallbackMeasure = text => Array.from(text).reduce((width, character) => width + annotationFontSize
    * (character.codePointAt(0) <= 0x7f ? 1 : 3), 0);
  const measure = text => {
    const width = (measureAnnotationText || fallbackMeasure)(text);
    if (!Number.isFinite(width) || width < 0) throw new Error("Graph calculation text measurement must return a finite width.");
    return width;
  };
  const left = base.plot.left, right = left + base.plot.width;
  const inset = Math.min(4, base.plot.width / 8);
  const headSize = Math.max(3, Math.min(6, annotationFontSize * 0.4));
  const arrowGap = Math.max(4, annotationFontSize * 0.4), laneGap = Math.max(4, annotationFontSize * 0.5);
  const xFor = time => base.domain.startMs === base.domain.endMs ? left + base.plot.width / 2
    : left + (time - base.domain.startMs) / (base.domain.endMs - base.domain.startMs) * base.plot.width;
  let height = 0;
  const annotations = measurements.map((item, index) => {
    const measurement = item?.measurement, result = item?.result;
    const bounds = resolvedBounds(result, clock);
    const status = result?.unavailable || result?.status === "unavailable" ? "unavailable"
      : result?.status === "resolved" ? bounds ? "resolved" : "invalid"
        : result?.status === "invalid" ? "invalid" : "unresolved";
    const name = typeof measurement?.name === "string" && measurement.name ? measurement.name : "Duration";
    const label = `${name}: ${formatGraphMeasurementResult({ ...result, status })}`;
    const lines = wrapLabel(label, base.plot.width - inset * 2, measure);
    const laneTop = base.plot.top + height;
    const labelHeight = lines.length * annotationLineHeight;
    const arrowY = laneTop + labelHeight + arrowGap + headSize;
    const laneHeight = labelHeight + arrowGap + headSize * 2 + laneGap;
    const boxWidth = Math.max(...lines.map(measure)) + inset * 2;
    const midpoint = bounds ? bounds.startMs + (bounds.endMs - bounds.startMs) / 2 : null;
    const labelX = clamp(midpoint === null ? left + base.plot.width / 2 : xFor(midpoint),
      left + boxWidth / 2, right - boxWidth / 2);
    const annotation = {
      id: measurement?.id ?? `calculation-${index}`, name, label, status,
      labelLines: lines.map((text, lineIndex) => ({ text, x: labelX,
        y: laneTop + (annotationLineHeight - annotationFontSize) / 2 + annotationFontSize * 0.8 + lineIndex * annotationLineHeight })),
      labelBox: { left: labelX - boxWidth / 2, top: laneTop, width: boxWidth, height: labelHeight },
      lane: { top: laneTop, height: laneHeight },
      startMs: bounds?.startMs ?? null, endMs: bounds?.endMs ?? null,
      clippedStart: false, clippedEnd: false, outside: null, zeroDuration: false,
      arrow: null, arrowheads: [], guides: [], continuations: [], marker: null,
    };
    height += laneHeight;
    if (!bounds) return annotation;
    const { startMs, endMs } = bounds;
    annotation.zeroDuration = startMs === endMs;
    annotation.clippedStart = startMs < base.domain.startMs;
    annotation.clippedEnd = endMs > base.domain.endMs;
    annotation.outside = endMs < base.domain.startMs ? "left" : startMs > base.domain.endMs ? "right" : null;
    if (annotation.outside) {
      annotation.continuations = chevrons(annotation.outside === "left" ? left : right, arrowY,
        annotation.outside, headSize, base.plot.width);
      return annotation;
    }
    const startX = clamp(xFor(startMs), left, right), endX = clamp(xFor(endMs), left, right);
    if (startX === endX) annotation.marker = segment({ x: startX, y: arrowY - headSize }, { x: startX, y: arrowY + headSize });
    else {
      annotation.arrow = segment({ x: startX, y: arrowY }, { x: endX, y: arrowY });
      const length = Math.min(headSize, (endX - startX) / 3);
      for (const [x, inward, clipped] of [[startX, 1, annotation.clippedStart], [endX, -1, annotation.clippedEnd]])
        if (!clipped) annotation.arrowheads.push(...[-1, 1].map(side => segment({ x, y: arrowY },
          { x: x + inward * length, y: arrowY + side * length * 0.65 })));
    }
    if (annotation.clippedStart) annotation.continuations.push(...chevrons(left, arrowY, "left", headSize, base.plot.width));
    if (annotation.clippedEnd) annotation.continuations.push(...chevrons(right, arrowY, "right", headSize, base.plot.width));
    for (const timeMs of new Set([startMs, endMs]))
      if (timeMs >= base.domain.startMs && timeMs <= base.domain.endMs)
        annotation.guides.push(segment({ x: xFor(timeMs), y: arrowY }, { x: xFor(timeMs), y: 0 }));
    return annotation;
  });
  const chart = height ? moveChart(base, height) : base;
  for (const annotation of annotations)
    for (const guide of annotation.guides) guide.to.y = chart.plot.top + chart.plot.height;
  return { ...chart, annotations,
    annotationLayout: { top: base.plot.top, height, bottom: chart.plot.top, fontSize: annotationFontSize, lineHeight: annotationLineHeight } };
}
