import test from "node:test";
import assert from "node:assert/strict";
import { buildTestChart } from "../src/test-chart.js";
import { emptyGraphTools, validGraphTools, assertGraphTools, getDeviceDisplayName, getGraphSettings,
  runGraphEntries, createPointEndpoint, parseSourceTimeInput, formatSourceTimeInput, resolveGraphMeasurement } from "../src/test-graph-tools.js";

const startMs = Date.UTC(2026, 10, 24, 10);
const time = offset => ({ kind: "time", timeMs: startMs + offset });
const point = (offset, value, extra = {}) => ({ timeMs: startMs + offset, value, valid: true,
  sourceId: "source-1", sourceRow: offset / 1000 + 1, ...extra });
const measurement = (start = time(0), end = time(30_000), unit = "s") => ({ id: "duration-1", name: "Valve response", unit, start, end });

function fixture() {
  return { id: "run-1", clock: { startMs, endMs: startMs + 3_600_000, basis: "source-local" }, devices: [
    { id: "valve", name: "V-3511-Y-FB", channels: [
      { id: "command", symbolicName: "V-3511-Y_OPEN", series: [{ id: "command:state", name: "V-3511-Y_OPEN", kind: "digital", unit: "",
        points: [point(0, 0), point(10_000, 1), point(20_000, 0)] }] },
      { id: "feedback", symbolicName: "V-3511-Y_FB", series: [{ id: "feedback:voltage", name: "V-3511-Y_FB", kind: "analog", unit: "V",
        points: [point(5000, 0.1), point(15_000, 0.3), point(30_000, 0.5)] }] },
    ] },
    { id: "pressure", name: "PD-3501", channels: [{ id: "pressure-input", series: [{ id: "pressure:current", name: "PD-3501", kind: "analog", unit: "mA",
      points: [point(0, 4), point(12_000, 12), point(25_000, 20)] }] }] },
  ] };
}

function configured(run = fixture()) {
  const graph = runGraphEntries(run)[1];
  return { version: 1, deviceNames: [{ deviceId: "valve", name: "V-3511-Y_FB" }], graphs: [
    { deviceId: graph.deviceId, graphKey: graph.graphKey, name: "Valve feedback", style: "smooth", measurements: [measurement()] },
  ] };
}

const trigger = (entry, operator, threshold) => ({ kind: "trigger", deviceId: entry.deviceId, graphKey: entry.graphKey, operator, threshold });
const range = (start, end) => ({ startMs: startMs + start, endMs: startMs + end });
const scopedTrigger = (entry, operator, threshold, start, end) => ({ ...trigger(entry, operator, threshold), timeRange: range(start, end) });

test("graph-tools validation is strict at every level while missing source references can remain saved", () => {
  const tools = configured();
  assert.equal(validGraphTools(tools), true);
  assert.equal(assertGraphTools(tools), tools);
  assert.equal(validGraphTools(emptyGraphTools()), true);
  assert.notEqual(emptyGraphTools().graphs, emptyGraphTools().graphs);
  for (const invalid of [undefined, null, [], {}, { version: 1, graphs: [] }, { ...tools, version: 2 }, { ...tools, extra: true }]) {
    assert.equal(validGraphTools(invalid), false);
    assert.throws(() => assertGraphTools(invalid), /invalid or exceed/);
  }
  for (const edit of [
    value => { value.deviceNames[0].extra = true; },
    value => { value.deviceNames[0].name = " leading"; },
    value => { value.deviceNames[0].name = " "; },
    value => { value.deviceNames[0].name = "Control\u0085name"; },
    value => { value.graphs[0].style = "linear"; },
    value => { value.graphs[0].style = undefined; },
    value => { value.graphs[0].measurements[0].unit = ["s"]; },
    value => { value.graphs[0].measurements[0].unit = "__proto__"; },
    value => { value.graphs[0].measurements[0].extra = true; },
    value => { value.graphs[0].measurements[0].start.extra = 1; },
    value => { value.graphs[0].measurements[0].start.timeMs += 0.5; },
    value => { value.graphs[0].measurements[0].start.timeMs = 8_640_000_000_000_001; },
    value => { value.graphs[0].measurements = new Array(1); },
    value => { value.graphs = new Array(1); },
    value => { value.deviceNames = new Array(1); },
    value => { value.graphs.push(structuredClone(value.graphs[0])); },
    value => { value.deviceNames.push(structuredClone(value.deviceNames[0])); },
    value => { value.graphs[0].measurements.push(structuredClone(value.graphs[0].measurements[0])); },
  ]) {
    const changed = structuredClone(tools); edit(changed);
    assert.equal(validGraphTools(changed), false);
  }
  const stale = configured();
  stale.graphs[0].measurements[0].start = { kind: "point", deviceId: "removed", graphKey: "old-graph", pointIndex: 9999,
    timeMs: startMs, value: -0.3, sourceId: "original-source", sourceRow: Number.MAX_SAFE_INTEGER };
  assert.equal(validGraphTools(stale), true, "reference existence is resolved separately from the persisted shape");
  for (const patch of [{ pointIndex: 10_000 }, { pointIndex: -1 }, { value: Infinity }, { sourceRow: 0 },
    { sourceRow: 1.5 }, { sourceId: "" }, { timeMs: NaN }, { extra: true }]) {
    const changed = structuredClone(stale);
    Object.assign(changed.graphs[0].measurements[0].start, patch);
    assert.equal(validGraphTools(changed), false);
  }
});

test("graph-tools limits count Unicode characters and enforce per-graph and total calculation caps", () => {
  const tools = emptyGraphTools();
  tools.deviceNames = Array.from({ length: 250 }, (_, index) => ({ deviceId: `device-${index}`, name: "😀".repeat(160) }));
  tools.graphs = Array.from({ length: 1000 }, (_, index) => ({ deviceId: "device-0", graphKey: `graph-${index}`, style: "auto" }));
  for (let index = 0; index < 25; index++) tools.graphs[index].measurements = Array.from({ length: 20 }, (_, offset) => ({ ...measurement(), id: `duration-${offset}` }));
  assert.equal(validGraphTools(tools), true, "500 calculations across 1000 graphs fit the version-one limits");
  const tooMany = structuredClone(tools);
  tooMany.graphs[25].measurements = [measurement()];
  assert.equal(validGraphTools(tooMany), false);
  tools.graphs[0].measurements.push({ ...measurement(), id: "extra" });
  assert.equal(validGraphTools(tools), false);
  tools.graphs[0].measurements.pop();
  tools.deviceNames[0].name += "😀";
  assert.equal(validGraphTools(tools), false);
  tools.deviceNames[0].name = "Valid";
  tools.deviceNames.push({ deviceId: "extra", name: "Extra" });
  assert.equal(validGraphTools(tools), false);
  tools.deviceNames.pop();
  tools.graphs.push({ deviceId: "device-0", graphKey: "extra" });
  assert.equal(validGraphTools(tools), false);
});

test("trigger time ranges have a strict optional shape and never extend point or manual-time endpoints", () => {
  const run = fixture(), entry = runGraphEntries(run)[1], tools = configured(run);
  tools.graphs[0].measurements = [measurement(scopedTrigger(entry, ">", 0.25, 1000, 20_000))];
  assert.equal(validGraphTools(tools), true);
  for (const timeRange of [range(2000, 2000), { startMs: -8_640_000_000_000_000, endMs: 8_640_000_000_000_000 }]) {
    const changed = structuredClone(tools);
    changed.graphs[0].measurements[0].start.timeRange = timeRange;
    assert.equal(validGraphTools(changed), true, "structural validation accepts ordered Date-safe bounds, including a single instant");
  }
  for (const timeRange of [undefined, null, [], {}, { startMs }, { endMs: startMs },
    { ...range(1000, 2000), extra: true }, { startMs: String(startMs), endMs: startMs + 2000 },
    range(2000, 1000), range(1000.5, 2000), { startMs: -Infinity, endMs: startMs },
    { startMs, endMs: NaN }, { startMs, endMs: 8_640_000_000_000_001 }]) {
    const changed = structuredClone(tools);
    changed.graphs[0].measurements[0].start.timeRange = timeRange;
    assert.equal(validGraphTools(changed), false);
    assert.equal(resolveGraphMeasurement(run, changed.graphs[0].measurements[0]).status, "invalid");
  }
  for (const endpoint of [time(1000), createPointEndpoint(run, entry.deviceId, entry.graphKey, 0)]) {
    const changed = structuredClone(tools);
    changed.graphs[0].measurements[0].start = { ...endpoint, timeRange: range(0, 20_000) };
    assert.equal(validGraphTools(changed), false, "a selected axis bounds threshold searches only");
  }
  const legacy = structuredClone(tools);
  delete legacy.graphs[0].measurements[0].start.timeRange;
  assert.equal(validGraphTools(legacy), true);
});

test("display aliases and styles resolve independently from immutable device, channel and series identities", () => {
  const run = fixture(), tools = configured(run), original = structuredClone(run);
  const entries = runGraphEntries(run, tools);
  assert.equal(entries[0].deviceName, "V-3511-Y_FB");
  assert.equal(entries[1].name, "Valve feedback");
  assert.equal(entries[1].series, run.devices[0].channels[1].series[0]);
  assert.equal(entries[1].device, run.devices[0]);
  assert.equal(entries[1].deviceIndex, 0);
  assert.equal(entries[1].channelIndex, 1);
  assert.equal(entries[1].seriesIndex, 0);
  assert.equal(entries[1].settings, tools.graphs[0]);
  assert.equal(getDeviceDisplayName(run.devices[0], tools), "V-3511-Y_FB");
  assert.equal(getDeviceDisplayName(run.devices[1], tools), "PD-3501");
  assert.equal(getGraphSettings(tools, "valve", entries[1].graphKey), tools.graphs[0]);
  assert.deepEqual(getGraphSettings(tools, "unknown", "missing"), { style: "auto", measurements: [] });
  assert.equal(buildTestChart(entries[1].series, run.clock).interpolation, "step", "aliases never alter raw _FB semantics");
  assert.deepEqual(run, original);
  assert.throws(() => runGraphEntries(run, null), /invalid/);
});

test("clicked point references retain original array indices and reject replaced, excluded or invalid evidence", () => {
  const run = fixture(), entry = runGraphEntries(run)[1];
  entry.series.points.splice(1, 0, point(10_000, null, { valid: false }));
  const endpoint = createPointEndpoint(run, entry.deviceId, entry.graphKey, 2);
  assert.equal(endpoint.pointIndex, 2);
  assert.equal(endpoint.timeMs, startMs + 15_000);
  assert.equal(endpoint.value, 0.3);
  assert.equal(endpoint.sourceRow, 16);
  assert.equal(resolveGraphMeasurement(run, measurement(endpoint, time(30_000))).value, 15);
  assert.throws(() => createPointEndpoint(run, entry.deviceId, entry.graphKey, 1), /valid graph point/);
  assert.throws(() => createPointEndpoint(run, "missing", entry.graphKey, 0), /no longer available/);
  const original = structuredClone(entry.series.points[2]);
  for (const change of [{ value: 0.31 }, { sourceId: "replacement" }, { sourceRow: 17 }, { timeMs: startMs + 16_000 }]) {
    entry.series.points[2] = { ...original, ...change };
    const result = resolveGraphMeasurement(run, measurement(endpoint, time(30_000)));
    assert.equal(result.status, "unresolved");
    assert.match(result.reason, /no longer matches/);
  }
  for (const change of [{ excluded: true }, { valid: false }]) {
    entry.series.points[2] = { ...original, ...change };
    assert.equal(resolveGraphMeasurement(run, measurement(endpoint, time(30_000))).status, "unresolved");
    assert.throws(() => createPointEndpoint(run, entry.deviceId, entry.graphKey, 2), /valid graph point/);
  }
  entry.series.points[2] = original;
  entry.series.points.push(point(40_000, 0.6));
  assert.equal(resolveGraphMeasurement(run, measurement(endpoint, time(30_000))).status, "resolved", "appending evidence does not invalidate earlier clicks");
});

test("manual source datetime parsing is strict, preserves milliseconds and never applies the computer timezone", () => {
  const clock = fixture().clock, previousZone = process.env.TZ;
  try {
    for (const zone of ["America/Chicago", "Asia/Ho_Chi_Minh"]) {
      process.env.TZ = zone;
      assert.equal(formatSourceTimeInput(startMs + 1234), "2026-11-24T10:00:01.234");
      assert.equal(parseSourceTimeInput("2026-11-24T10:00:01.234", clock), startMs + 1234);
      assert.equal(parseSourceTimeInput("2026-11-24 10:00", clock), startMs);
      assert.equal(parseSourceTimeInput("2026-11-24 10:00:01.2", clock), startMs + 1200);
    }
  } finally {
    if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
  }
  for (const input of ["10:00:01", "2026-02-30T10:00", "2026-11-24T24:00", "2026-11-24T10:61", "2026-11-24T10:00:60",
    "2026-11-24T10:00:00Z", "2026-11-24T10:00:00-06:00", "2026-11-24T10:00:01.1234", "2026-11-24T09:59:59.999", null])
    assert.throws(() => parseSourceTimeInput(input, clock), /source|valid/);
  assert.equal(formatSourceTimeInput(null), "");
  assert.throws(() => parseSourceTimeInput("2026-11-24T10:00", {}), /valid test-run/);
});

test("duration calculations independently combine clicked points, manual times and cross-device original-value triggers", () => {
  const run = fixture(), [command, feedback, pressure] = runGraphEntries(run);
  const start = createPointEndpoint(run, command.deviceId, command.graphKey, 1);
  const original = structuredClone(run);
  const result = resolveGraphMeasurement(run, measurement(start, trigger(pressure, ">=", 20)));
  assert.equal(result.status, "resolved");
  assert.equal(result.start.timeMs, startMs + 10_000);
  assert.equal(result.end.timeMs, startMs + 25_000);
  assert.equal(result.durationMs, 15_000);
  assert.equal(result.value, 15);
  assert.equal(result.unit, "s");
  assert.match(result.end.detail, /PD-3501.*>= 20 mA.*source row 26/);
  assert.equal(result.end.sourceGraphName, "PD-3501");
  assert.equal(resolveGraphMeasurement(run, measurement(trigger(feedback, ">", 0.1), time(30_000))).value, 15);
  assert.equal(resolveGraphMeasurement(run, measurement(time(0), time(3_600_000), "min")).value, 60);
  assert.equal(resolveGraphMeasurement(run, measurement(time(0), time(3_600_000), "h")).value, 1);
  assert.equal(resolveGraphMeasurement(run, measurement(time(123), time(1123))).value, 1);
  assert.deepEqual(run, original);
});

test("trigger boundaries, equal timestamps and end-after-start searches use deterministic retained sample order", () => {
  const run = fixture(), entry = runGraphEntries(run)[1];
  entry.series.points = [point(1000, 0.3), point(2000, 0.4), point(2000, 0.3), point(3000, 0.2), point(4000, 0.5)];
  for (const [operator, threshold, offset, index] of [[">", 0.3, 2000, 1], [">=", 0.3, 1000, 0], ["<", 0.3, 3000, 3], ["<=", 0.3, 1000, 0]]) {
    const result = resolveGraphMeasurement(run, measurement(trigger(entry, operator, threshold), time(5000)));
    assert.equal(result.start.timeMs, startMs + offset);
    assert.equal(result.start.pointIndex, index);
  }
  const end = resolveGraphMeasurement(run, measurement(time(2500), trigger(entry, ">=", 0.3)));
  assert.equal(end.end.timeMs, startMs + 4000, "an end trigger ignores earlier satisfying events");
  const zero = resolveGraphMeasurement(run, measurement(time(2000), trigger(entry, ">=", 0.3)));
  assert.equal(zero.durationMs, 0);
  assert.equal(zero.end.pointIndex, 1, "equal timestamps use their original recorded order");
  const exact = resolveGraphMeasurement(run, measurement(time(0), trigger(entry, ">", 0.30000001)));
  assert.match(exact.end.detail, /> 0\.30000001 V/, "formula text must retain the exact threshold used by the comparison");
});

test("captured device ranges choose the matching pulse inclusively without changing legacy full-run thresholds", () => {
  const run = fixture(), entry = runGraphEntries(run)[1];
  entry.series.points = [point(1000, 0.31), point(3000, 0), point(10_000, 0.3), point(12_000, 0.01), point(20_000, 0.31)];
  const calculation = measurement(scopedTrigger(entry, ">", 0.25, 10_000, 12_000), scopedTrigger(entry, "<", 0.2, 10_000, 12_000));
  const original = structuredClone({ run, calculation });
  const result = resolveGraphMeasurement(run, calculation);
  assert.equal(result.status, "resolved");
  assert.equal(result.start.timeMs, startMs + 10_000, "the event exactly on the lower boundary is included");
  assert.equal(result.end.timeMs, startMs + 12_000, "the event exactly on the upper boundary is included");
  assert.equal(result.start.pointIndex, 2);
  assert.equal(result.end.pointIndex, 3);
  assert.equal(result.value, 2);
  assert.match(result.start.detail, /selected device time range 2026-11-24 10:00:10\.000 to 2026-11-24 10:00:12\.000/);
  const legacy = resolveGraphMeasurement(run, measurement(trigger(entry, ">", 0.25), trigger(entry, "<", 0.2)));
  assert.equal(legacy.start.timeMs, startMs + 1000);
  assert.equal(legacy.end.timeMs, startMs + 3000);
  assert.doesNotMatch(legacy.start.detail, /selected device time range/);
  const separateRanges = resolveGraphMeasurement(run, measurement(scopedTrigger(entry, ">", 0.25, 1000, 3000),
    scopedTrigger(entry, "<", 0.2, 10_000, 12_000)));
  assert.equal(separateRanges.start.timeMs, startMs + 1000);
  assert.equal(separateRanges.end.timeMs, startMs + 12_000, "each endpoint applies its own captured bounds to the original event list");
  assert.equal(separateRanges.value, 11);
  assert.deepEqual({ run, calculation }, original);
  const crossDevice = runGraphEntries(run)[2];
  const cross = resolveGraphMeasurement(run, measurement(scopedTrigger(crossDevice, ">", 0, 10_000, 20_000), time(30_000)));
  assert.equal(cross.start.timeMs, startMs + 12_000, "supplied owner-axis bounds apply equally to another device's graph");
});

test("bounded end thresholds intersect the selected range with the resolved start and allow a single recorded instant", () => {
  const run = fixture(), entry = runGraphEntries(run)[1];
  entry.series.points = [point(1000, 0.1), point(2000, 0.3), point(2000, 0.4, { sourceRow: 4 }),
    point(3500, 0.5, { sourceRow: 5 }), point(4000, 0.6)];
  const afterStart = resolveGraphMeasurement(run, measurement(time(2500), scopedTrigger(entry, ">", 0.2, 2000, 4000)));
  assert.equal(afterStart.end.timeMs, startMs + 3500);
  assert.equal(afterStart.end.pointIndex, 3);
  assert.match(afterStart.end.detail, /at or after the start.*selected device time range/);
  const emptyIntersection = resolveGraphMeasurement(run, measurement(time(3500), scopedTrigger(entry, ">", 0.2, 1000, 3000)));
  assert.equal(emptyIntersection.status, "unresolved");
  assert.equal(emptyIntersection.end.timeMs, null);
  assert.equal(emptyIntersection.durationMs, null);
  assert.match(emptyIntersection.end.reason, /at or after the start within the selected device time range/);
  const zero = resolveGraphMeasurement(run, measurement(time(2000), scopedTrigger(entry, ">=", 0.3, 2000, 2000)));
  assert.equal(zero.durationMs, 0);
  assert.equal(zero.end.pointIndex, 1, "same-time matches retain original source order");
  const noSample = resolveGraphMeasurement(run, measurement(time(2000), scopedTrigger(entry, ">=", 0.3, 2001, 2001)));
  assert.equal(noSample.status, "unresolved", "a singleton range does not create or shift an observation");
  const instant = fixture(), instantEntry = runGraphEntries(instant)[1];
  instant.clock.endMs = instant.clock.startMs;
  instantEntry.series.points = [point(0, 0.3)];
  assert.equal(resolveGraphMeasurement(instant, measurement(scopedTrigger(instantEntry, ">", 0.25, 0, 0), time(0))).value, 0);
});

test("bounded thresholds never match synthetic baselines, interpolated crossings, held tails or removed readings", () => {
  const run = fixture(), entry = runGraphEntries(run)[1];
  entry.series.points = [point(10_000, 0.1), point(20_000, 0.5)];
  const interpolation = buildTestChart(entry.series, run.clock, { style: "smooth", timeRange: range(12_000, 18_000) });
  assert.equal(interpolation.points.length, 0);
  assert.equal(interpolation.curves.length, 1);
  for (const start of [scopedTrigger(entry, "<=", 0, 0, 5000), scopedTrigger(entry, ">", 0.2, 12_000, 18_000),
    scopedTrigger(entry, ">", 0.3, 25_000, 30_000)]) {
    const result = resolveGraphMeasurement(run, measurement(start, time(40_000)));
    assert.equal(result.status, "unresolved");
    assert.equal(result.start.timeMs, null);
    assert.match(result.start.reason, /within the selected device time range/);
  }
  entry.series.points = [point(10_000, 0.1), point(12_000, 0.9, { excluded: true }),
    point(15_000, 0.7, { valid: false }), point(20_000, 0.5)];
  const result = resolveGraphMeasurement(run, measurement(scopedTrigger(entry, ">", 0.3, 12_000, 15_000), time(40_000)));
  assert.equal(result.status, "unresolved");
  assert.equal(result.durationMs, null);
});

test("captured trigger ranges outside the run are invalid and are never clamped or silently retargeted", () => {
  const run = fixture(), entry = runGraphEntries(run)[1];
  for (const timeRange of [range(-1, 20_000), range(0, 3_600_001), range(-2000, -1000)]) {
    const calculation = measurement({ ...trigger(entry, ">", 0), timeRange }, time(30_000));
    const original = structuredClone(calculation);
    const result = resolveGraphMeasurement(run, calculation);
    assert.equal(result.status, "invalid");
    assert.equal(result.start.timeMs, null);
    assert.match(result.reason, /selected device time range.*outside the test run/);
    assert.deepEqual(calculation, original);
  }
  const missing = resolveGraphMeasurement(run, measurement({ ...trigger(entry, ">", 0), graphKey: "unavailable", timeRange: range(1000, 2000) }));
  assert.equal(missing.status, "unresolved");
  assert.match(missing.start.detail, /selected device time range.*graph unavailable/);
});

test("triggers ignore synthetic baselines, curve crossings, held tails, removed rows and invalid samples", () => {
  const run = fixture(), entry = runGraphEntries(run)[1];
  run.graphTools = { ...emptyGraphTools(), graphs: [{ deviceId: entry.deviceId, graphKey: entry.graphKey, name: "Renamed feedback", style: "smooth" }] };
  entry.series.points = [point(1000, 0.1), point(2000, 0.9, { excluded: true }), point(3000, 4, { valid: false }),
    { value: 0.8, valid: true }, point(10_000, 0.5)];
  const original = structuredClone(run);
  assert.equal(resolveGraphMeasurement(run, measurement(time(0), trigger(entry, ">", 0.3))).end.timeMs, startMs + 10_000,
    "a visually interpolated crossing cannot replace an original observation timestamp");
  const noZero = resolveGraphMeasurement(run, measurement(trigger(entry, "<=", 0), time(20_000)));
  assert.equal(noZero.status, "unresolved", "the feedback's display-only initial zero cannot trigger");
  const noTail = resolveGraphMeasurement(run, measurement(time(20_000), trigger(entry, ">", 0.3)));
  assert.equal(noTail.status, "unresolved", "a held tail is not another recorded event");
  assert.match(noTail.end.detail, /Renamed feedback/);
  assert.equal(noTail.end.sourceGraphName, "V-3511-Y_FB");
  assert.deepEqual(run, original);
  const digital = runGraphEntries(run)[0];
  digital.series.points = [point(0, 3), point(1000, 1)];
  assert.equal(resolveGraphMeasurement(run, measurement(trigger(digital, ">", 1), time(2000))).status, "unresolved");
});

test("unavailable references, unmatched triggers and invalid durations return explicit statuses without fabricating values", () => {
  const run = fixture(), entry = runGraphEntries(run)[1];
  const missing = { kind: "trigger", deviceId: "missing", graphKey: "missing", operator: ">", threshold: 0 };
  for (const start of [missing, trigger(entry, ">", 999)]) {
    const result = resolveGraphMeasurement(run, measurement(start, trigger(entry, ">", 0)));
    assert.equal(result.status, "unresolved");
    assert.equal(result.durationMs, null);
    assert.equal(result.value, null);
    assert.match(result.end.reason, /Resolve the start/);
    if (start === missing) assert.match(result.start.detail, /value > 0.*graph unavailable/);
  }
  for (const calculation of [measurement(time(20_000), time(10_000)), measurement(time(-1), time(1000)),
    measurement(time(0), time(3_600_001)), { ...measurement(), unit: ["s"] }]) {
    const result = resolveGraphMeasurement(run, calculation);
    assert.equal(result.status, "invalid");
    assert.equal(result.durationMs, null);
  }
  const pointEndpoint = createPointEndpoint(run, entry.deviceId, entry.graphKey, 0);
  run.devices[0].channels.pop();
  assert.equal(resolveGraphMeasurement(run, measurement(pointEndpoint, time(20_000))).status, "unresolved");
  const instant = { ...fixture(), clock: { startMs, endMs: startMs } };
  assert.equal(resolveGraphMeasurement(instant, measurement(time(0), time(0))).durationMs, 0);
});

test("referenced source validation cannot be bypassed by hidden or excluded observations", () => {
  const run = fixture(), entry = runGraphEntries(run)[1];
  const calculations = [measurement(trigger(entry, ">", 0), time(60_000)),
    measurement(scopedTrigger(entry, ">", 0, 10_000, 20_000), time(60_000))];
  for (const points of [
    [point(-1, 1, { excluded: true })], [point(3_600_001, 1, { valid: false })],
    [point(10_000, 0.5), point(5000, 0.1)], [point(1000, 0.1, { excluded: "false" })], [null],
  ]) {
    entry.series.points = points;
    for (const calculation of calculations) {
      const result = resolveGraphMeasurement(run, calculation);
      assert.equal(result.status, "invalid");
      assert.equal(result.durationMs, null);
      assert.ok(result.reason);
    }
  }
});
