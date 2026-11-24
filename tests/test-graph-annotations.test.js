import test from "node:test";
import assert from "node:assert/strict";
import { buildTestChart, deviceChartTimeRange } from "../src/test-chart.js";
import { runGraphEntries, resolveGraphMeasurement } from "../src/test-graph-tools.js";
import { buildAnnotatedTestChart, deviceCalculationTimeRange, formatGraphMeasurementResult } from "../src/test-graph-annotations.js";

const startMs = Date.UTC(2026, 10, 25, 10);
const clock = { startMs, endMs: startMs + 300_000 };
const point = (offset, value, extra = {}) => ({ timeMs: startMs + offset, value, valid: true, ...extra });
const time = offset => ({ kind: "time", timeMs: startMs + offset });
const range = (start, end) => ({ startMs: startMs + start, endMs: startMs + end });
const calculation = (start = time(11_000), end = time(120_000), extra = {}) => ({
  id: "open-time", name: "Open Time", unit: "s", start, end, ...extra,
});
const annotated = (measurement = calculation(), run = { clock }) => ({ measurement, result: resolveGraphMeasurement(run, measurement) });
const series = { id: "feedback-voltage", name: "V-3511-Y-FB", kind: "analog", unit: "V",
  points: [point(100_000, 0.1), point(110_000, 0.3), point(120_000, 0.2)] };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} is close to ${expected}`);
const vectors = annotation => [annotation.arrow, annotation.marker,
  ...annotation.arrowheads, ...annotation.guides, ...annotation.continuations].filter(Boolean);

function fixture() {
  const run = { id: "run-1", clock, devices: [
    { id: "valve", name: "V-3511-Y-FB", channels: [
      { id: "feedback", series: [structuredClone(series)] },
      { id: "pressure", series: [{ id: "pressure-current", name: "PD-3501", kind: "analog", unit: "mA",
        points: [point(105_000, 4), point(115_000, 12)] }] },
    ] },
    { id: "command", name: "V-3511-Y_OPEN", channels: [
      { id: "output", series: [{ id: "output-state", name: "V-3511-Y_OPEN", kind: "digital", unit: "",
        points: [point(11_000, 1), point(20_000, 0), point(290_000, 0)] }] },
    ] },
  ] };
  const entries = runGraphEntries(run);
  const trigger = { kind: "trigger", deviceId: entries[2].deviceId, graphKey: entries[2].graphKey, operator: ">", threshold: 0 };
  run.graphTools = { version: 1, deviceNames: [], graphs: [
    { deviceId: "valve", graphKey: entries[0].graphKey, measurements: [calculation(trigger)] },
    { deviceId: "valve", graphKey: entries[1].graphKey,
      measurements: [calculation(time(120_000), time(250_000), { id: "later", name: "Later interval" })] },
  ] };
  return run;
}

test("compact duration results preserve the selected unit and distinguish unresolved or unavailable intervals", () => {
  for (const [value, unit, label] of [[109, "s", "109 s"], [0.5, "min", "0.5 min"], [2, "h", "2 h"], [0, "s", "0 s"]])
    assert.equal(formatGraphMeasurementResult({ status: "resolved", value, unit }), label);
  assert.equal(formatGraphMeasurementResult({ status: "unresolved", reason: "No trigger", value: null }), "Unresolved");
  assert.equal(formatGraphMeasurementResult({ status: "invalid", value: 3, unit: "s" }), "Invalid interval");
  assert.equal(formatGraphMeasurementResult({ status: "unresolved", unavailable: true }), "Unavailable");
  assert.equal(formatGraphMeasurementResult({ status: "unavailable" }), "Unavailable");
  for (const result of [{ value: -1, unit: "s" }, { value: Infinity, unit: "s" }, { value: 1, unit: "days" }])
    assert.equal(formatGraphMeasurementResult({ ...result, status: "resolved" }), "Invalid interval");
});

test("automatic device ranges include calculations on actual graphs and resolve earlier triggers against the original run", () => {
  const run = fixture(), device = run.devices[0];
  const entries = runGraphEntries(run);
  run.graphTools.graphs[0].measurements.push(calculation(time(0), time(-1), { id: "invalid" }));
  run.graphTools.graphs[1].measurements.push(calculation({ kind: "trigger", deviceId: "missing", graphKey: "missing", operator: ">", threshold: 0 }, time(300_000), { id: "unresolved" }));
  run.graphTools.graphs.push({ deviceId: "valve", graphKey: "missing-owner",
    measurements: [calculation(time(0), time(300_000))] });
  const original = structuredClone(run);
  const automatic = deviceCalculationTimeRange(device, run);
  assert.deepEqual(automatic, range(11_000, 250_000));
  const first = resolveGraphMeasurement(run, run.graphTools.graphs[0].measurements[0]);
  assert.equal(first.durationMs, 109_000);
  const charts = entries.filter(entry => entry.deviceId === "valve").map(entry =>
    buildAnnotatedTestChart(entry.series, clock, { deviceTimeRange: automatic,
      measurements: entry.settings.measurements.map(measurement => annotated(measurement, run)) }));
  assert.deepEqual(charts[0].xTicks, charts[1].xTicks, "all device graphs share the expanded automatic time axis");
  assert.equal(charts[0].annotations[0].arrow.from.x, charts[0].plot.left);
  assert.ok(charts[0].points[0].x > charts[0].plot.left, "the earlier trigger is visible before the owning graph's first reading");
  assert.deepEqual(run, original);
  const legacy = { ...run, graphTools: undefined };
  assert.deepEqual(deviceCalculationTimeRange(device, legacy), deviceChartTimeRange(device, clock));
});

test("PDF supplied calculations preserve original duplicate graph identities after channel filtering", () => {
  const first = { id: "same-channel", series: [{ ...structuredClone(series), id: "same-series" }] };
  const second = structuredClone(first);
  const device = { id: "valve", name: "Valve", channels: [first, second] };
  const run = { clock, devices: [device] }, entries = runGraphEntries(run);
  run.graphTools = { version: 1, deviceNames: [], graphs: [
    { deviceId: device.id, graphKey: entries[0].graphKey, measurements: [calculation(time(0), time(300_000))] },
    { deviceId: device.id, graphKey: entries[1].graphKey, measurements: [calculation()] },
  ] };
  const filtered = { ...device, channels: [second] };
  const resolved = run.graphTools.graphs[1].measurements.map(measurement => annotated(measurement, run));
  assert.deepEqual(deviceCalculationTimeRange(filtered, run, resolved), range(11_000, 121_000));
  assert.deepEqual(deviceCalculationTimeRange(filtered, run, []), deviceChartTimeRange(filtered, clock),
    "an explicit empty list does not rediscover calculations on filtered occurrence keys");
  const outside = annotated(calculation(time(0), time(300_000)));
  outside.result.end.timeMs += 1;
  assert.deepEqual(deviceCalculationTimeRange(filtered, run, [outside]), deviceChartTimeRange(filtered, clock));
});

test("interval arrows and guides map exact source times while every drawing style and source observation stay unchanged", () => {
  const measurements = [annotated()], originalSeries = structuredClone(series), originalMeasurements = structuredClone(measurements);
  for (const style of ["auto", "line", "step", "smooth"]) {
    const options = { style, deviceTimeRange: range(0, 250_000), width: 500, height: 180,
      padding: { left: 40, right: 20, top: 15, bottom: 35 } };
    const base = buildTestChart(series, clock, options);
    const chart = buildAnnotatedTestChart(series, clock, { ...options, measurements });
    const [annotation] = chart.annotations, offset = chart.annotationLayout.height;
    assert.equal(annotation.label, "Open Time: 109 s");
    assert.equal(annotation.status, "resolved");
    assert.equal(annotation.startMs, startMs + 11_000);
    assert.equal(annotation.endMs, startMs + 120_000);
    close(annotation.arrow.from.x, chart.plot.left + 11_000 / 250_000 * chart.plot.width);
    close(annotation.arrow.to.x, chart.plot.left + 120_000 / 250_000 * chart.plot.width);
    assert.equal(annotation.arrow.from.y, annotation.arrow.to.y);
    assert.equal(annotation.arrowheads.length, 4);
    assert.equal(annotation.guides.length, 2);
    assert.deepEqual(annotation.guides.map(guide => guide.from.x), [annotation.arrow.from.x, annotation.arrow.to.x]);
    assert.ok(annotation.guides.every(guide => guide.to.y === chart.plot.top + chart.plot.height));
    assert.ok(annotation.arrow.from.y < chart.plot.top);
    assert.equal(chart.height, base.height + offset);
    assert.deepEqual(chart.plot, { ...base.plot, top: base.plot.top + offset });
    assert.deepEqual(chart.domain, base.domain);
    assert.deepEqual(chart.xTicks, base.xTicks);
    assert.equal(chart.interpolation, base.interpolation);
    assert.equal(chart.initialLabel, base.initialLabel);
    assert.equal(chart.observedCount, base.observedCount);
    assert.equal(chart.excludedCount, base.excludedCount);
    assert.equal(chart.invalidCount, base.invalidCount);
    assert.deepEqual(chart.invalidPoints, base.invalidPoints);
    assert.deepEqual(chart.points, base.points.map(value => ({ ...value, y: value.y + offset })));
    assert.deepEqual(chart.yTicks, base.yTicks.map(value => ({ ...value, y: value.y + offset })));
    const shift = line => line && ({ from: { ...line.from, y: line.from.y + offset }, to: { ...line.to, y: line.to.y + offset } });
    assert.deepEqual(chart.connections, base.connections.map(shift));
    assert.deepEqual(chart.leading, shift(base.leading));
    assert.deepEqual(chart.extension, shift(base.extension));
    assert.deepEqual(chart.curves, base.curves.map(curve => Object.fromEntries(Object.entries(curve)
      .map(([key, value]) => [key, { ...value, y: value.y + offset }]))));
  }
  assert.deepEqual(series, originalSeries);
  assert.deepEqual(measurements, originalMeasurements);
});

test("manual windows keep their range and distinguish cropped sides from genuine endpoints", () => {
  const chart = buildAnnotatedTestChart(series, clock, { deviceTimeRange: range(0, 300_000), timeRange: range(40_000, 140_000),
    measurements: [annotated(), annotated(calculation(time(0), time(250_000), { id: "both" }))] });
  assert.equal(chart.domain.startMs, startMs + 40_000);
  assert.equal(chart.domain.endMs, startMs + 140_000);
  assert.equal(chart.manualTimeRange, true);
  const [left, both] = chart.annotations;
  assert.equal(left.label, "Open Time: 109 s", "cropping does not shorten the actual duration result");
  assert.equal(left.clippedStart, true);
  assert.equal(left.clippedEnd, false);
  assert.equal(left.outside, null);
  assert.equal(left.arrow.from.x, chart.plot.left);
  close(left.arrow.to.x, chart.plot.left + 0.8 * chart.plot.width);
  assert.equal(left.arrowheads.length, 2, "only the retained true endpoint receives an arrowhead");
  assert.equal(left.guides.length, 1);
  assert.equal(left.guides[0].from.x, left.arrow.to.x);
  assert.equal(left.continuations.length, 4);
  assert.equal(both.clippedStart, true);
  assert.equal(both.clippedEnd, true);
  assert.equal(both.arrow.from.x, chart.plot.left);
  assert.equal(both.arrow.to.x, chart.plot.left + chart.plot.width);
  assert.deepEqual(both.arrowheads, []);
  assert.deepEqual(both.guides, []);
  assert.equal(both.continuations.length, 8);
});

test("wholly outside intervals retain their labels and side indicators without fake spanning arrows", () => {
  const chart = buildAnnotatedTestChart(series, clock, { timeRange: range(40_000, 140_000), measurements: [
    annotated(calculation(time(0), time(10_000), { name: "Before view" })),
    annotated(calculation(time(200_000), time(250_000), { id: "later", name: "After view" })),
  ] });
  assert.deepEqual(chart.annotations.map(annotation => annotation.outside), ["left", "right"]);
  assert.deepEqual(chart.annotations.map(annotation => annotation.label), ["Before view: 10 s", "After view: 50 s"]);
  for (const annotation of chart.annotations) {
    assert.equal(annotation.arrow, null);
    assert.equal(annotation.marker, null);
    assert.deepEqual(annotation.arrowheads, []);
    assert.deepEqual(annotation.guides, []);
    assert.equal(annotation.continuations.length, 4);
    assert.ok(annotation.labelBox.left >= chart.plot.left);
    assert.ok(annotation.labelBox.left + annotation.labelBox.width <= chart.plot.left + chart.plot.width);
    for (const line of vectors(annotation)) for (const coordinate of [line.from, line.to])
      assert.ok(coordinate.x >= chart.plot.left && coordinate.x <= chart.plot.left + chart.plot.width);
  }
});

test("zero durations use one real-time marker and guide, including a zero-duration run", () => {
  for (const [runClock, value, reading] of [[clock, 110_000, series],
    [{ startMs, endMs: startMs }, 0, { ...series, points: [point(0, 0.3)] }]]) {
    const item = annotated(calculation(time(value), time(value)), { clock: runClock });
    const chart = buildAnnotatedTestChart(reading, runClock, { measurements: [item] });
    const [annotation] = chart.annotations;
    assert.equal(annotation.label, "Open Time: 0 s");
    assert.equal(annotation.zeroDuration, true);
    assert.equal(annotation.arrow, null);
    assert.deepEqual(annotation.arrowheads, []);
    assert.equal(annotation.guides.length, 1);
    assert.equal(annotation.marker.from.x, annotation.marker.to.x);
    assert.equal(annotation.guides[0].from.x, annotation.marker.from.x);
  }
  const edge = buildAnnotatedTestChart(series, clock, { timeRange: range(40_000, 140_000),
    measurements: [annotated(calculation(time(0), time(40_000)))] }).annotations[0];
  assert.equal(edge.zeroDuration, false);
  assert.equal(edge.label, "Open Time: 40 s");
  assert.ok(edge.marker);
  assert.equal(edge.guides.length, 1);
  assert.equal(edge.continuations.length, 4);
});

test("twenty overlapping calculations get separate wrapped lanes with complete long names and bounded labels", () => {
  const measurements = Array.from({ length: 20 }, (_, index) => annotated(calculation(time(100_000), time(120_000), {
    id: `interval-${index}`, name: index % 2 ? `Valve ${index} ${"Position check ".repeat(8)}`.trim() : `V${index}${"😀".repeat(80)}`,
  })));
  const measureAnnotationText = text => Array.from(text).length * 5;
  const chart = buildAnnotatedTestChart(series, clock, { width: 250, height: 150,
    padding: { left: 30, right: 10, top: 12, bottom: 25 },
    measurements, annotationFontSize: 9, annotationLineHeight: 12, measureAnnotationText });
  assert.equal(chart.annotations.length, 20, "the layout does not silently cap configured calculations");
  assert.equal(chart.plot.height, 113);
  let bottom = chart.annotationLayout.top;
  for (const annotation of chart.annotations) {
    assert.ok(annotation.labelLines.length > 1);
    close(annotation.lane.top, bottom);
    bottom = annotation.lane.top + annotation.lane.height;
    assert.equal(annotation.labelLines.map(line => line.text).join("").replace(/\s/g, ""), annotation.label.replace(/\s/g, ""));
    for (const line of annotation.labelLines) {
      assert.ok(measureAnnotationText(line.text) <= chart.plot.width - 8);
      assert.ok(line.y > annotation.labelBox.top && line.y < annotation.labelBox.top + annotation.labelBox.height);
      assert.ok(line.x - measureAnnotationText(line.text) / 2 >= chart.plot.left);
      assert.ok(line.x + measureAnnotationText(line.text) / 2 <= chart.plot.left + chart.plot.width);
    }
    assert.ok(annotation.labelBox.top + annotation.labelBox.height < annotation.arrow.from.y);
    assert.ok(annotation.arrow.from.y < bottom);
  }
  close(bottom, chart.plot.top);
  close(chart.annotationLayout.height, chart.height - 150);
  const subset = buildAnnotatedTestChart(series, clock, { measurements: measurements.slice(10, 12) });
  const all = buildAnnotatedTestChart(series, clock, { measurements });
  assert.deepEqual(subset.domain, all.domain, "PDF annotation subsets keep identical source geometry and time axes");
  assert.equal(subset.plot.height, all.plot.height);
  assert.deepEqual(subset.xTicks, all.xTicks);
});

test("fallback wrapping bounds long wide-letter and Unicode labels using bundled Noto Sans glyph advances", () => {
  // Advance widths from public/assets/NotoSans-Bold.ttf, normalized to em.
  // ASCII not listed here is conservatively bounded by 1 em as well.
  const advances = { O: 0.796, W: 0.967, m: 0.982, "\u2031": 1.661, "\u2e3b": 2.84 };
  for (const character of Object.keys(advances)) {
    const chart = buildAnnotatedTestChart(series, clock, {
      measurements: [annotated(calculation(time(100_000), time(120_000), { name: character.repeat(160) }))],
    });
    const [annotation] = chart.annotations;
    assert.ok(annotation.labelLines.length > 1);
    assert.equal(annotation.labelLines.map(line => line.text).join("").replace(/\s/g, ""), annotation.label.replace(/\s/g, ""));
    for (const line of annotation.labelLines) {
      const actualWidth = Array.from(line.text).reduce((width, glyph) => width + 12 * (advances[glyph] ?? 1), 0);
      assert.ok(actualWidth <= annotation.labelBox.width, `${character} fits its reserved label box`);
      assert.ok(line.x - actualWidth / 2 >= chart.plot.left, `${character} stays inside the left edge`);
      assert.ok(line.x + actualWidth / 2 <= chart.plot.left + chart.plot.width, `${character} stays inside the right edge`);
    }
  }
});

test("unresolved, invalid, unavailable and out-of-run intervals reserve text only without fabricated geometry", () => {
  const missing = { kind: "trigger", deviceId: "missing", graphKey: "missing", operator: ">", threshold: 1 };
  const unavailable = annotated();
  unavailable.result = { ...unavailable.result, unavailable: true };
  const outOfRun = annotated();
  outOfRun.result.end.timeMs = clock.endMs + 1;
  const chart = buildAnnotatedTestChart(series, clock, { measurements: [
    annotated(calculation(missing)), annotated(calculation(time(120_000), time(100_000))), unavailable, outOfRun,
  ] });
  assert.deepEqual(chart.annotations.map(annotation => annotation.label), [
    "Open Time: Unresolved", "Open Time: Invalid interval", "Open Time: Unavailable", "Open Time: Invalid interval",
  ]);
  for (const annotation of chart.annotations) {
    assert.equal(annotation.startMs, null);
    assert.equal(annotation.endMs, null);
    assert.equal(annotation.outside, null);
    assert.deepEqual(vectors(annotation), []);
  }
});

test("empty annotations preserve the original chart and cannot bypass source or layout validation", () => {
  const base = buildTestChart(series, clock);
  const { annotations, annotationLayout, ...chart } = buildAnnotatedTestChart(series, clock);
  assert.deepEqual(chart, base);
  assert.deepEqual(annotations, []);
  assert.equal(annotationLayout.height, 0);
  assert.throws(() => buildAnnotatedTestChart({ ...series, points: [point(-1, 0.3)] }, clock,
    { measurements: [annotated()], timeRange: range(100_000, 120_000) }), /outside/);
  for (const options of [{ annotationFontSize: 0 }, { annotationFontSize: 20, annotationLineHeight: 10 },
    { measureAnnotationText: () => NaN }, { measurements: null }])
    assert.throws(() => buildAnnotatedTestChart(series, clock, { measurements: [annotated()], ...options }), /calculation/i);
});
