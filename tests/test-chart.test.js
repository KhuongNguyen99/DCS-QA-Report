import test from "node:test";
import assert from "node:assert/strict";
import { buildTestChart, deviceChartTimeRange, formatSourceTime, formatTestValue, isTestTimeRange } from "../src/test-chart.js";

const startMs = Date.UTC(2026, 10, 19, 19, 17);
const clock = { startMs, endMs: startMs + 392_000 };
const point = (offset, value, extra = {}) => ({ timeMs: startMs + offset, value, valid: true, ...extra });
const timeRange = (start, end) => ({ startMs: startMs + start, endMs: startMs + end });
const yFor = (chart, value) => chart.plot.top + (chart.domain.max - value) / (chart.domain.max - chart.domain.min) * chart.plot.height;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} is close to ${expected}`);

function assertBounded(chart) {
  const coordinates = [...chart.points, ...chart.invalidPoints.filter(point => point.x !== null),
    ...chart.connections.flatMap(line => [line.from, line.to]), ...(chart.extension ? [chart.extension.from, chart.extension.to] : [])];
  for (const point of coordinates) {
    assert.ok(point.x >= chart.plot.left, `${point.x} is inside the left edge`);
    assert.ok(point.x <= chart.plot.left + chart.plot.width, `${point.x} is inside the right edge`);
  }
}

test("positioner and pressure current graphs default to 0–25 mA and Celsius to 20–30", () => {
  for (const name of ["V-3511-POS", "V-3511_POS", "PD-3511", "DP-3511", " pd-3511 "]) {
    const chart = buildTestChart({ name, kind: "analog", unit: "mA", points: [point(0, 4), point(1000, 20)] }, clock);
    assert.equal(chart.domain.min, 0, name);
    assert.equal(chart.domain.max, 25, name);
    assert.equal(chart.yTicks[0].value, 0);
    assert.equal(chart.yTicks.at(-1).value, 25);
  }
  const temperature = buildTestChart({ kind: "analog", unit: "°C", points: [point(0, 21), point(1000, 29)] }, clock);
  assert.equal(temperature.domain.min, 20);
  assert.equal(temperature.domain.max, 30);
  const voltage = buildTestChart({ name: "PD-3511", kind: "analog", unit: "V", points: [point(0, 4), point(1000, 5)] }, clock);
  assert.ok(voltage.domain.min > 3 && voltage.domain.max < 6, "other units keep their observed range");
  const otherCurrent = buildTestChart({ name: "Other signal", kind: "analog", unit: "mA", points: [point(0, 4), point(1000, 5)] }, clock);
  assert.ok(otherCurrent.domain.min > 3 && otherCurrent.domain.max < 6, "other current devices keep their existing range");
});

test("standard graph frames expand only where valid readings exceed the defaults", () => {
  for (const [name, unit, value, expectedMin, expectedMax] of [
    ["V-3511-POS", "mA", 27, 0, 25], ["PD-3511", "mA", -2, 0, 25],
    ["TH-3511", "°C", 33, 20, 30], ["TH-3511", "°C", 18, 20, 30],
  ]) {
    const chart = buildTestChart({ name, kind: "analog", unit, points: [point(0, value)] }, clock);
    if (value > expectedMax) {
      assert.equal(chart.domain.min, expectedMin);
      assert.ok(chart.domain.max > value);
    } else {
      assert.ok(chart.domain.min < value);
      assert.equal(chart.domain.max, expectedMax);
    }
    assert.ok(chart.points[0].y > chart.plot.top);
    assert.ok(chart.points[0].y < chart.plot.top + chart.plot.height);
  }
  const boundaries = buildTestChart({ name: "DP-3511", kind: "analog", unit: "mA", points: [point(0, 0), point(1000, 25)] }, clock);
  assert.equal(boundaries.domain.min, 0);
  assert.equal(boundaries.domain.max, 25);
});

test("default axes exclude invalid readings, handle empty series and preserve saved evidence", () => {
  for (const [name, unit, min, max] of [["DP-3511", "mA", 0, 25], ["TH-3511", "°C", 20, 30]]) {
    const series = { name, kind: "analog", unit, points: [point(0, 32767, { valid: false })] };
    const original = structuredClone(series);
    const chart = buildTestChart(series, clock);
    assert.equal(chart.domain.min, min);
    assert.equal(chart.domain.max, max);
    assert.equal(chart.invalidCount, 1);
    assert.deepEqual(series, original);
    const empty = buildTestChart({ ...series, points: [] }, clock);
    assert.equal(empty.domain.min, min);
    assert.equal(empty.domain.max, max);
  }
  const digital = buildTestChart({ name: "PD-3511", kind: "digital", unit: "mA", points: [point(0, 1)] }, clock);
  assert.equal(digital.domain.min, 0);
  assert.equal(digital.domain.max, 1);
});

test("different channel coverage automatically fits each graph inside the shared run clock", () => {
  const early = buildTestChart({ kind: "analog", unit: "mA", points: [point(0, 4), point(40_000, 20)] }, clock);
  const late = buildTestChart({ kind: "analog", unit: "°C", points: [point(310_000, 19.7), point(392_000, 20)] }, clock);
  assert.notDeepEqual(early.xTicks, late.xTicks);
  assert.equal(early.domain.startMs, clock.startMs);
  assert.ok(early.domain.endMs < startMs + 45_000, "an early series does not inherit another channel's long tail");
  assert.ok(late.domain.startMs > startMs + 300_000, "a later series zooms past the unused run start");
  assert.equal(late.domain.endMs, clock.endMs);
  assert.equal(early.points[0].x, early.plot.left);
  assert.equal(late.points[1].x, late.plot.left + late.plot.width);
  assert.equal(early.points.length, 2, "no synthetic endpoints or previous values");
  assert.ok(early.points[1].x > early.plot.left + early.plot.width * 0.9);
  assert.ok(late.points[0].x < late.plot.left + late.plot.width * 0.1);
  assert.equal(early.extension.to.x, late.points[1].x, "held values reach each graph's right edge");
  assert.equal(early.points[1].timeMs, startMs + 40_000);
  assert.equal(late.points[0].timeMs, startMs + 310_000);
});

test("a single timestamp gets a readable time window bounded by the original run", () => {
  const chart = buildTestChart({ kind: "analog", points: [point(150_000, 5)] }, clock);
  assert.equal(chart.domain.startMs, startMs + 149_000);
  assert.equal(chart.domain.endMs, startMs + 151_000);
  assert.equal(chart.points[0].x, chart.plot.left + chart.plot.width / 2);
  assert.equal(new Set(chart.xTicks.map(tick => tick.label)).size, chart.xTicks.length);
  const first = buildTestChart({ kind: "analog", points: [point(0, 5)] }, clock);
  const last = buildTestChart({ kind: "analog", points: [point(392_000, 5)] }, clock);
  assert.equal(first.domain.startMs, clock.startMs);
  assert.equal(last.domain.endMs, clock.endMs);
  assert.equal(last.extension, null, "no held reading extends past the test run");
});

test("digital outputs show the recorded starting state without adding an observation", () => {
  const series = { kind: "digital", points: [point(20_000, 1, { previousValue: 0 }), point(50_000, 0)] };
  const original = structuredClone(series);
  const chart = buildTestChart(series, clock, { showInitialState: true });
  assert.equal(chart.initialState, 0);
  assert.deepEqual(chart.leading.from, { x: chart.plot.left, y: yFor(chart, 0) });
  assert.deepEqual(chart.connections[0], {
    from: chart.leading.to, to: { x: chart.points[0].x, y: yFor(chart, 1) },
  });
  assert.equal(chart.observedCount, 2);
  const before = buildTestChart(series, clock, { showInitialState: true, timeRange: timeRange(1_000, 10_000) });
  assert.equal(before.leading.to.x, before.plot.left + before.plot.width);
  assert.equal(before.points.length, 0);
  for (const first of [{ ...series.points[0], previousValue: null }, { ...series.points[0], excluded: true }]) {
    assert.equal(buildTestChart({ ...series, points: [first, series.points[1]] }, clock, { showInitialState: true }).initialState, null);
  }
  assert.equal(buildTestChart(series, clock, { showInitialState: true, timeRange: timeRange(25_000, 35_000) }).leading, null);
  assert.deepEqual(series, original);
});

test("device slider bounds cover all populated automatic graph spans with outward millisecond rounding", () => {
  const series = [
    { kind: 'analog', points: [point(20_000, 4), point(80_007, 5)] },
    { kind: 'digital', points: [point(100_000, 1), point(160_003, 0)] },
  ];
  const device = { channels: [{ series: [...series, { points: [] }, { points: [point(392_000, 1, { excluded: true })] }] }] };
  const before = structuredClone(device);
  const charts = series.map(item => buildTestChart(item, clock));
  assert.deepEqual(deviceChartTimeRange(device, clock), {
    startMs: Math.floor(charts[0].domain.startMs), endMs: Math.ceil(charts[1].domain.endMs),
  });
  assert.deepEqual(device, before);
});

test("device time bounds update for removals and retain dated warnings while empty graphs fall back safely", () => {
  const points = [point(20_000, 1), point(60_000, null, { valid: false }), point(100_000, 1, { excluded: true })];
  const device = { channels: [{ series: [{ points }, { points: [{ value: null, valid: false }] }] }] };
  assert.deepEqual(deviceChartTimeRange(device, clock), timeRange(18_400, 61_600));
  points[1].excluded = true;
  assert.deepEqual(deviceChartTimeRange(device, clock), timeRange(19_000, 21_000));
  points[0].excluded = true;
  assert.deepEqual(deviceChartTimeRange(device, clock), clock);
  assert.deepEqual(deviceChartTimeRange({ channels: [] }, clock), clock);
  assert.deepEqual(deviceChartTimeRange({ channels: [{ series: [{ points: [point(-1, 1)] }] }] }, clock), clock);
  assert.deepEqual(deviceChartTimeRange({ channels: [] }, { startMs, endMs: startMs }), { startMs, endMs: startMs });
});

test("horizontal autoscaling keeps dated invalid events visible without changing evidence", () => {
  const series = { kind: "analog", points: [
    point(10_000, 4), point(20_000, null, { valid: false, rawValue: "overflow" }), { value: 1 },
  ] };
  const original = structuredClone(series);
  const chart = buildTestChart(series, clock);
  assert.ok(chart.domain.startMs < startMs + 10_000);
  assert.ok(chart.domain.endMs > startMs + 20_000);
  assert.ok(chart.invalidPoints[0].x > chart.points[0].x);
  assert.ok(chart.invalidPoints[0].x <= chart.plot.left + chart.plot.width);
  assert.equal(chart.invalidPoints[1].x, null);
  assert.equal(chart.extension, null);
  assert.deepEqual(series, original);
  const empty = buildTestChart({ points: [] }, clock);
  assert.equal(empty.domain.startMs, clock.startMs);
  assert.equal(empty.domain.endMs, clock.endMs);
  assert.throws(() => buildTestChart({ points: [point(-1, null, { valid: false })] }, clock), /outside/);
});

test("short time axes use distinct labels and preserve dates across midnight", () => {
  const short = buildTestChart({ points: [point(100, 4), point(200, 5)] }, { startMs, endMs: startMs + 500 });
  assert.equal(short.xTicks.length, 2);
  assert.deepEqual(short.xTicks.map(tick => tick.label), ["19:17:00.000", "19:17:00.500"]);
  const midnight = Date.UTC(2026, 10, 20);
  const acrossDays = buildTestChart({ points: [
    { timeMs: midnight - 1000, value: 4 }, { timeMs: midnight + 1000, value: 5 },
  ] }, { startMs: midnight - 60_000, endMs: midnight + 60_000 });
  assert.equal(acrossDays.xTicks[0].dateLabel, "2026-11-19");
  assert.equal(acrossDays.xTicks.at(-1).dateLabel, "2026-11-20");
});

test("invalid values do not distort the range and duplicate timestamp observations remain visible data", () => {
  const result = buildTestChart({ kind: "analog", points: [
    point(0, 19.7), point(1000, 19.8), point(1000, 19.9),
    point(2000, null, { valid: false, rawValue: "7FFFH" }),
    point(3000, 32767, { valid: false, rawValue: "overflow" }),
  ] }, clock);
  assert.equal(result.observedCount, 3);
  assert.equal(result.invalidCount, 2);
  assert.ok(result.domain.max < 21);
  assert.equal(result.points[1].x, result.points[2].x);
  assert.notEqual(result.points[1].y, result.points[2].y);
  assert.equal(result.invalidPoints[0].rawValue, "7FFFH");
  assert.equal(result.invalidPoints[1].value, 32767);
});

test("digital and constant signals have usable axes without adding measured samples", () => {
  const digital = buildTestChart({ kind: "digital", points: [point(1000, 1), point(2000, 0), point(3000, 3)] }, clock);
  assert.deepEqual(digital.yTicks.map((tick) => tick.value), [0, 1]);
  assert.equal(digital.invalidCount, 1);
  assert.equal(digital.points.length, 2);
  const constant = buildTestChart({ kind: "analog", points: [point(1000, 0), point(5000, 0)] }, clock);
  assert.ok(constant.domain.min < 0 && constant.domain.max > 0);
  const instant = buildTestChart({ kind: "analog", points: [point(0, 20)] }, { startMs, endMs: startMs });
  assert.equal(instant.xTicks.length, 1);
  assert.equal(instant.points[0].x, instant.plot.left + instant.plot.width / 2);
  assert.equal(instant.extension, null);
});

test("analog connections preserve same-second changes and hold the final value to the fitted right edge", () => {
  const series = { kind: "analog", points: [point(1000, 4), point(5000, 10), point(5000, 7)] };
  const original = structuredClone(series);
  const chart = buildTestChart(series, clock);
  const xy = point => ({ x: point.x, y: point.y });
  assert.deepEqual(chart.connections, [
    { from: xy(chart.points[0]), to: xy(chart.points[1]) },
    { from: xy(chart.points[1]), to: xy(chart.points[2]) },
  ]);
  assert.equal(chart.connections[1].from.x, chart.connections[1].to.x, "same-second transitions stay vertical");
  assert.deepEqual(chart.extension, {
    from: xy(chart.points[2]), to: { x: chart.plot.left + chart.plot.width, y: chart.points[2].y },
  });
  assert.equal(chart.observedCount, 3);
  assert.equal(chart.points.length, 3, "held endpoint is not counted as another observation");
  assert.deepEqual(series, original, "rendering does not change saved observations");
});

test("digital connections hold the previous state until each recorded transition", () => {
  const chart = buildTestChart({ kind: "digital", points: [point(1000, 0), point(2000, 1), point(3000, 0)] }, clock);
  const [first, second, third] = chart.points;
  assert.deepEqual(chart.connections, [
    { from: { x: first.x, y: first.y }, to: { x: second.x, y: first.y } },
    { from: { x: second.x, y: first.y }, to: { x: second.x, y: second.y } },
    { from: { x: second.x, y: second.y }, to: { x: third.x, y: second.y } },
    { from: { x: third.x, y: second.y }, to: { x: third.x, y: third.y } },
  ]);
  assert.ok(chart.connections.every(({ from, to }) => from.x === to.x || from.y === to.y));
  assert.equal(chart.extension.from.y, third.y);
  assert.equal(chart.extension.to.y, third.y);
});

test("invalid observations break connections and stop a trailing held value", () => {
  const chart = buildTestChart({ kind: "analog", points: [
    point(0, 4), point(1000, null, { valid: false }), point(2000, 8), point(3000, 10),
    point(4000, null, { valid: false }),
  ] }, clock);
  assert.equal(chart.connections.length, 1, "no line crosses an invalid reading");
  assert.equal(chart.connections[0].from.x, chart.points[1].x);
  assert.equal(chart.connections[0].to.x, chart.points[2].x);
  assert.equal(chart.extension, null, "an invalid final event cannot imply the old reading stayed valid");
  const unknownTime = buildTestChart({ kind: "analog", points: [point(0, 4), { value: 7 }] }, clock);
  assert.equal(unknownTime.extension, null);
  assert.deepEqual(unknownTime.connections, []);
});

test("single-point and empty series have bounded tails without invented leading data", () => {
  const single = buildTestChart({ kind: "analog", points: [point(2000, 5)] }, clock);
  assert.deepEqual(single.connections, []);
  assert.equal(single.extension.from.x, single.points[0].x);
  assert.ok(single.extension.from.x > single.plot.left, "nothing is drawn before the first reading");
  assert.equal(single.extension.to.x, single.plot.left + single.plot.width);
  const ended = buildTestChart({ kind: "analog", points: [point(392_000, 5)] }, clock);
  assert.equal(ended.extension, null);
  const empty = buildTestChart({ kind: "analog", points: [] }, clock);
  assert.deepEqual(empty.connections, []);
  assert.equal(empty.extension, null);
  assert.throws(() => buildTestChart({ points: [point(2000, 5), point(1000, 4)] }, clock), /ordered by time/);
});

test("wall-clock display is timezone-independent and incomplete or out-of-range observations cannot be hidden", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/Chicago";
    assert.equal(formatSourceTime(startMs, true), "2026-11-19 19:17:00");
    process.env.TZ = "Asia/Ho_Chi_Minh";
    assert.equal(formatSourceTime(startMs, true), "2026-11-19 19:17:00");
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
  assert.equal(formatTestValue(19.900000000001), "19.9");
  assert.throws(() => buildTestChart({ points: [] }, {}), /shared test-run/);
  assert.throws(() => buildTestChart({ points: [point(-1, 4)] }, clock), /outside/);
  assert.throws(() => buildTestChart({ points: [point(393_000, 4)] }, clock), /outside/);
  const empty = buildTestChart({ points: [point(0, null, { valid: false }), { value: 1 }] }, clock);
  assert.equal(empty.observedCount, 0);
  assert.equal(empty.invalidCount, 2);
});

test("a shared manual range aligns analog and digital timestamps while preserving source counts and Y scale", () => {
  const range = timeRange(5000, 15000);
  const analogSeries = { kind: "analog", unit: "°C", points: [point(0, 33), point(10000, 25), point(20000, 21)] };
  const digitalSeries = { kind: "digital", points: [point(5000, 0), point(10000, 1), point(30000, 0)] };
  const original = structuredClone({ analogSeries, digitalSeries, range, clock });
  const analog = buildTestChart(analogSeries, clock, { timeRange: range });
  const digital = buildTestChart(digitalSeries, clock, { timeRange: range });
  assert.equal(analog.manualTimeRange, true);
  assert.deepEqual(analog.xTicks, digital.xTicks);
  assert.equal(analog.domain.startMs, range.startMs);
  assert.equal(analog.domain.endMs, range.endMs);
  assert.equal(analog.points[0].x, digital.points[1].x);
  assert.equal(analog.points[0].x, analog.plot.left + analog.plot.width / 2);
  assert.equal(analog.observedCount, 3);
  assert.equal(digital.observedCount, 3);
  assert.equal(analog.visibleObservedCount, 1);
  assert.equal(digital.visibleObservedCount, 2);
  const automatic = buildTestChart(analogSeries, clock);
  assert.equal(analog.domain.min, automatic.domain.min);
  assert.equal(analog.domain.max, automatic.domain.max);
  assert.ok(analog.domain.max > 33, "a hidden valid reading still expands the standard temperature frame");
  assertBounded(analog); assertBounded(digital);
  assert.deepEqual({ analogSeries, digitalSeries, range, clock }, original);
});

test("manual analog windows interpolate both crossing edges without inventing observation dots", () => {
  const chart = buildTestChart({ kind: "analog", points: [point(0, 0), point(20000, 20)] }, clock,
    { timeRange: timeRange(5000, 15000) });
  assert.deepEqual(chart.points, []);
  assert.equal(chart.visibleObservedCount, 0);
  assert.equal(chart.observedCount, 2);
  assert.equal(chart.connections.length, 1);
  assert.equal(chart.connections[0].from.x, chart.plot.left);
  assert.equal(chart.connections[0].to.x, chart.plot.left + chart.plot.width);
  close(chart.connections[0].from.y, yFor(chart, 5));
  close(chart.connections[0].to.y, yFor(chart, 15));
  assert.equal(chart.extension, null);
  assertBounded(chart);
  const instantChange = buildTestChart({ kind: "analog", points: [point(5000, 4), point(5000, 10), point(20000, 7)] }, clock,
    { timeRange: timeRange(5000, 10000) });
  assert.equal(instantChange.points.length, 2);
  assert.equal(instantChange.connections[0].from.x, instantChange.plot.left);
  assert.equal(instantChange.connections[0].to.x, instantChange.plot.left);
  assert.notEqual(instantChange.connections[0].from.y, instantChange.connections[0].to.y);
  assertBounded(instantChange);
});

test("manual digital windows carry in the prior state and retain equal-time edge transitions as steps", () => {
  const series = { kind: "digital", points: [point(0, 0), point(10000, 1), point(10000, 0), point(20000, 1)] };
  const right = buildTestChart(series, clock, { timeRange: timeRange(5000, 10000) });
  const leftX = right.plot.left, rightX = leftX + right.plot.width;
  const low = yFor(right, 0), high = yFor(right, 1);
  assert.deepEqual(right.connections, [
    { from: { x: leftX, y: low }, to: { x: rightX, y: low } },
    { from: { x: rightX, y: low }, to: { x: rightX, y: high } },
    { from: { x: rightX, y: high }, to: { x: rightX, y: low } },
  ]);
  assert.deepEqual(right.points.map(point => point.x), [rightX, rightX]);
  const left = buildTestChart(series, clock, { timeRange: timeRange(10000, 15000) });
  assert.deepEqual(left.connections, [
    { from: { x: leftX, y: low }, to: { x: leftX, y: high } },
    { from: { x: leftX, y: high }, to: { x: leftX, y: low } },
    { from: { x: leftX, y: low }, to: { x: rightX, y: low } },
  ]);
  const between = buildTestChart(series, clock, { timeRange: timeRange(11000, 15000) });
  assert.deepEqual(between.points, []);
  assert.deepEqual(between.connections, [{ from: { x: leftX, y: low }, to: { x: rightX, y: low } }]);
  for (const chart of [right, left, between]) {
    assert.equal(chart.observedCount, 4);
    assert.ok(chart.connections.every(({ from, to }) => from.x === to.x || from.y === to.y));
    assertBounded(chart);
  }
});

test("manual views preserve invalid gaps and unknown-time breaks even beyond the visible window", () => {
  const chart = buildTestChart({ kind: "analog", points: [
    point(0, 4), point(5000, null, { valid: false }), point(10000, 8),
    point(15000, null, { valid: false }), point(20000, 10), point(25000, null, { valid: false }), { value: 7 },
  ] }, clock, { timeRange: timeRange(8000, 18000) });
  assert.equal(chart.observedCount, 3);
  assert.equal(chart.visibleObservedCount, 1);
  assert.equal(chart.invalidCount, 4);
  assert.deepEqual(chart.invalidPoints.map(point => point.timeMs), [startMs + 15000, undefined]);
  assert.equal(chart.invalidPoints[1].x, null);
  assert.deepEqual(chart.connections, []);
  assert.equal(chart.extension, null);
  assertBounded(chart);
  const unknown = buildTestChart({ points: [point(0, 4), { value: 7 }, point(20000, 8), point(30000, 10)] }, clock,
    { timeRange: timeRange(5000, 15000) });
  assert.deepEqual(unknown.connections, [], "an undated break cannot be removed to connect across the window");
  assert.equal(unknown.invalidCount, 1);
  assert.equal(unknown.invalidPoints[0].x, null);
  for (const final of [point(3000, null, { valid: false }), { value: 8 }]) {
    const stopped = buildTestChart({ points: [point(2000, 5), final] }, clock, { timeRange: timeRange(4000, 8000) });
    assert.equal(stopped.extension, null, "an invalid final event prevents a carry-in tail");
  }
});

test("manual views before first data stay empty and views after final data contain only a bounded held tail", () => {
  for (const kind of ["analog", "digital"]) {
    const series = { kind, points: [point(10000, 0), point(20000, 1)] };
    const before = buildTestChart(series, clock, { timeRange: timeRange(0, 5000) });
    assert.deepEqual(before.points, []);
    assert.deepEqual(before.connections, []);
    assert.equal(before.extension, null);
    const after = buildTestChart(series, clock, { timeRange: timeRange(30000, 392000) });
    assert.deepEqual(after.points, []);
    assert.deepEqual(after.connections, []);
    assert.deepEqual(after.extension, {
      from: { x: after.plot.left, y: yFor(after, 1) },
      to: { x: after.plot.left + after.plot.width, y: yFor(after, 1) },
    });
    assert.equal(after.domain.endMs, clock.endMs);
    assertBounded(after);
    const empty = buildTestChart({ kind, points: [] }, clock, { timeRange: timeRange(5000, 10000) });
    assert.deepEqual(empty.points, []);
    assert.deepEqual(empty.connections, []);
    assert.equal(empty.extension, null);
    assert.equal(empty.visibleObservedCount, 0);
  }
});

test("manual range validation rejects unsafe windows without weakening validation of hidden source evidence", () => {
  const series = { points: [point(10000, 4), point(20000, 5)] };
  const valid = timeRange(5000, 15000);
  assert.equal(isTestTimeRange(valid, clock), true);
  assert.equal(isTestTimeRange(clock, clock), true);
  for (const range of [undefined, null, [], true, {}, { startMs }, timeRange(15000, 5000), timeRange(5000, 5000),
    timeRange(-1, 5000), timeRange(5000, 392001), timeRange(5000.5, 10000),
    { ...valid, startMs: String(valid.startMs) }, { ...valid, endMs: Infinity }, { ...valid, startMs: NaN }]) {
    assert.equal(isTestTimeRange(range, clock), false);
    if (range != null) assert.throws(() => buildTestChart(series, clock, { timeRange: range }), /time range within/);
  }
  assert.equal(isTestTimeRange(valid, {}), false);
  assert.equal(isTestTimeRange(valid, { startMs, endMs: startMs }), false);
  assert.throws(() => buildTestChart(series, { startMs, endMs: startMs }, { timeRange: valid }), /time range within/);
  for (const bad of [point(-1, 4), point(393000, null, { valid: false })])
    assert.throws(() => buildTestChart({ points: [bad] }, clock, { timeRange: valid }), /outside/);
  assert.throws(() => buildTestChart({ points: [point(30000, 4), point(20000, 5)] }, clock,
    { timeRange: valid }), /ordered by time/);
  const invalidHidden = buildTestChart({ kind: "digital", points: [point(0, 3), point(10000, 1)] }, clock, { timeRange: valid });
  assert.equal(invalidHidden.invalidCount, 1);
  assert.deepEqual(invalidHidden.invalidPoints, []);
  const automatic = buildTestChart(series, clock);
  assert.deepEqual(buildTestChart(series, clock, { timeRange: null }), automatic);
  assert.equal(automatic.manualTimeRange, false);
  assert.equal(automatic.visibleObservedCount, automatic.observedCount);
});

test("excluded rows leave active chart ranges and geometry equivalent to their active neighbors without changing source evidence", () => {
  const series = { kind: "analog", unit: "°C", points: [
    point(0, 1000, { excluded: true, rawValue: "1000", sourceRow: 2 }),
    point(10000, 24, { excluded: false, sourceRow: 3 }), point(20000, 26, { sourceRow: 4 }),
    point(300000, -1000, { excluded: true, sourceRow: 5 }),
  ] };
  const original = structuredClone(series);
  for (const options of [{}, { timeRange: timeRange(12000, 25000) }]) {
    const chart = buildTestChart(series, clock, options);
    const active = buildTestChart({ ...series, points: series.points.filter(point => point.excluded !== true) }, clock, options);
    assert.deepEqual(chart, { ...active, excludedCount: 2 });
    assert.equal(chart.observedCount, 2);
    assert.equal(chart.domain.min, 20);
    assert.equal(chart.domain.max, 30);
    assertBounded(chart);
  }
  const restored = structuredClone(series);
  restored.points[0].excluded = false;
  const chart = buildTestChart(restored, clock);
  assert.equal(chart.excludedCount, 1);
  assert.equal(chart.observedCount, 3);
  assert.ok(chart.domain.max > 1000);
  assert.equal(chart.domain.startMs, clock.startMs);
  assert.deepEqual(series, original, "rendering never removes or rewrites original evidence");
});

test("excluding invalid gaps reconnects active neighbors and excluding the final event updates the held tail", () => {
  for (const kind of ["analog", "digital"]) {
    const series = { kind, points: [point(0, 0), point(5000, null, { valid: false, excluded: true }),
      { value: 3, excluded: true }, point(10000, 1), point(20000, 0, { excluded: true })] };
    for (const options of [{}, { timeRange: timeRange(2000, 15000) }]) {
      const chart = buildTestChart(series, clock, options);
      const active = buildTestChart({ kind, points: [series.points[0], series.points[3]] }, clock, options);
      assert.deepEqual(chart, { ...active, excludedCount: 3 });
      assert.equal(chart.invalidCount, 0);
      assert.equal(chart.extension.from.y, yFor(chart, 1));
      assertBounded(chart);
    }
    series.points[1].excluded = false;
    const restoredGap = buildTestChart(series, clock);
    assert.equal(restoredGap.invalidCount, 1);
    assert.deepEqual(restoredGap.connections, []);
    const excludedFinalInvalid = buildTestChart({ kind, points: [point(10000, 1),
      point(20000, null, { valid: false, excluded: true })] }, clock);
    assert.ok(excludedFinalInvalid.extension);
    assert.equal(excludedFinalInvalid.invalidCount, 0);
  }
});

test("all excluded rows produce empty active charts while exclusion cannot hide malformed flags or invalid source timing", () => {
  const chart = buildTestChart({ points: [point(1000, 4, { excluded: true }),
    point(2000, null, { valid: false, excluded: true }), { value: 7, excluded: true }] }, clock);
  assert.equal(chart.excludedCount, 3);
  assert.equal(chart.observedCount, 0);
  assert.equal(chart.invalidCount, 0);
  assert.equal(chart.visibleObservedCount, 0);
  assert.equal(chart.domain.startMs, clock.startMs);
  assert.equal(chart.domain.endMs, clock.endMs);
  assert.deepEqual(chart.points, []);
  assert.deepEqual(chart.connections, []);
  assert.deepEqual(chart.invalidPoints, []);
  assert.equal(chart.extension, null);
  for (const excluded of [undefined, null, 1, "true", [], {}])
    assert.throws(() => buildTestChart({ points: [point(0, 4, { excluded })] }, clock,
      { timeRange: timeRange(10000, 20000) }), /excluded flag.*true or false/);
  for (const offset of [-1, 393000])
    assert.throws(() => buildTestChart({ points: [point(offset, 4, { excluded: true })] }, clock), /outside/);
  for (const points of [
    [point(20000, 4, { excluded: true }), point(10000, 5)],
    [point(20000, 4), point(10000, 5, { excluded: true })],
    [point(20000, 4, { excluded: true }), point(10000, 5, { excluded: true })],
  ]) assert.throws(() => buildTestChart({ points }, clock, { timeRange: timeRange(30000, 40000) }), /ordered by time/);
});
