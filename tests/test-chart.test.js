import test from "node:test";
import assert from "node:assert/strict";
import { buildTestChart, buildDeviceTestChart, formatSourceTime, formatTestValue } from "../src/test-chart.js";

const startMs = Date.UTC(2026, 10, 19, 19, 17);
const clock = { startMs, endMs: startMs + 392_000 };
const point = (offset, value, extra = {}) => ({ timeMs: startMs + offset, value, valid: true, ...extra });

test("a device combines channels with shared time positions and separate unit scales", () => {
  const device = { name: "V-3511", channels: [
    { id: "current", series: [{ name: "V-3511-POS", kind: "analog", unit: "mA", points: [point(10_000, 4), point(20_000, 20)] }] },
    { id: "command", series: [{ name: "V-3511-OPEN", kind: "digital", points: [point(15_000, 0), point(20_000, 1)] }] },
    { id: "temperature", series: [{ name: "Temperature", kind: "analog", unit: "°C", points: [point(15_000, 21), point(20_000, 29)] }] },
  ] };
  const original = structuredClone(device);
  const chart = buildDeviceTestChart(device, clock);
  assert.equal(chart.traces.length, 3);
  assert.equal(chart.observedCount, 6);
  assert.deepEqual(chart.axes.map(axis => [axis.unit, axis.min, axis.max]), [["mA", 0, 25], ["°C", 20, 30], ["State", 0, 1]]);
  assert.ok(chart.domain.startMs > clock.startMs && chart.domain.endMs < clock.endMs);
  assert.equal(new Set(chart.traces.map(trace => trace.points.at(-1).x)).size, 1, "matching timestamps align across signals");
  assert.equal(new Set(chart.traces.map(trace => trace.color)).size, 3);
  assert.ok(chart.traces.every(trace => trace.connections.length > 0));
  assert.ok(chart.traces.every(trace => trace.extension.to.x === chart.plot.left + chart.plot.width));
  assert.deepEqual(device, original, "combining graphs never rewrites saved evidence");
});

test("same-unit traces share one expanded scale and duplicate legends identify channel provenance", () => {
  const device = { channels: [0, 1].map(channel => ({
    id: `input-${channel}`, stationId: "station-a", slot: 2, channel,
    series: [{ name: "PD-3511", kind: "analog", unit: "mA", points: [point(0, 10), point(1000, channel ? 28 : 20)] }],
  })) };
  const chart = buildDeviceTestChart(device, clock, { stations: [{ id: "station-a", name: "RIO A" }] });
  assert.equal(chart.axes.length, 1);
  assert.ok(chart.axes[0].max > 28);
  assert.equal(chart.axes[0].min, 0);
  assert.equal(chart.traces[0].points[0].y, chart.traces[1].points[0].y);
  assert.notEqual(chart.traces[0].label, chart.traces[1].label);
  assert.match(chart.traces[0].label, /RIO A, slot 2, channel 0/);
  assert.match(chart.traces[1].label, /RIO A, slot 2, channel 1/);
});

test("combining signals retains invalid gaps without connecting independent channels", () => {
  const device = { channels: [
    { id: "valid", series: [{ name: "DP-3511", kind: "analog", unit: "mA", points: [point(10_000, 4), point(20_000, 8)] }] },
    { id: "broken", series: [{ name: "Feedback", kind: "digital", points: [point(15_000, 1), point(30_000, null, { valid: false })] }] },
    { id: "unknown", series: [{ name: "Unknown", points: [{ value: 7 }] }] },
  ] };
  const chart = buildDeviceTestChart(device, clock);
  assert.equal(chart.traces[0].connections.length, 1);
  assert.deepEqual(chart.traces[1].connections, []);
  assert.equal(chart.traces[1].extension, null);
  assert.equal(chart.traces[1].invalidPoints.length, 1);
  assert.equal(chart.traces[2].invalidPoints[0].x, null);
  assert.ok(chart.domain.startMs > clock.startMs && chart.domain.endMs < startMs + 32_000, "undated values do not stretch the time axis");
  assert.equal(chart.invalidCount, 2);
  assert.equal(buildDeviceTestChart({ channels: [{ series: [] }] }, clock), null);
});

test("a shared unit keeps its default frame until an actual valid reading exceeds it", () => {
  const device = { channels: [{ series: [
    { name: "Other current", unit: "mA", points: [point(0, 0), point(1000, 25)] },
    { name: "PD-3511", unit: "mA", points: [point(0, 4)] },
    { name: "Invalid current", unit: "mA", points: [point(0, 32767, { valid: false })] },
  ] }] };
  const chart = buildDeviceTestChart(device, clock);
  assert.equal(chart.axes.length, 1);
  assert.equal(chart.axes[0].min, 0);
  assert.equal(chart.axes[0].max, 25);
  device.channels[0].series[0].points.push(point(2000, 28));
  const expanded = buildDeviceTestChart(device, clock);
  assert.equal(expanded.axes[0].min, 0);
  assert.ok(expanded.axes[0].max > 28 && expanded.axes[0].max < 31);
});

test("shared scales cannot hide observations and later signal colors also have line patterns", () => {
  const series = { points: [point(1000, 4), point(2000, 20)] };
  assert.throws(() => buildTestChart(series, clock, { sharedDomain: { startMs, endMs: startMs + 1500, min: 0, max: 25 } }), /every dated observation/);
  assert.throws(() => buildTestChart(series, clock, { sharedDomain: { ...clock, min: 0, max: 10 } }), /every valid observation/);
  const chart = buildDeviceTestChart({ channels: [{ series: Array.from({ length: 9 }, (_, index) => ({ ...series, name: `Signal ${index}` })) }] }, clock);
  assert.equal(chart.traces[0].color, chart.traces[8].color);
  assert.notDeepEqual(chart.traces[0].dash, chart.traces[8].dash);
});

test("case-sensitive unit prefixes retain independent axes and original legend units", () => {
  const chart = buildDeviceTestChart({ channels: [{ series: ["mPa", "MPa"].map(unit => ({
    name: "Pressure", unit, points: [point(0, 5)],
  })) }] }, clock);
  assert.deepEqual(chart.axes.map(axis => axis.unit), ["mPa", "MPa"]);
  assert.deepEqual(chart.traces.map(trace => trace.label), ["Pressure (mPa)", "Pressure (MPa)"]);
  assert.notEqual(chart.traces[0].axisId, chart.traces[1].axisId);
});

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
