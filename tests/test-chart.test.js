import test from "node:test";
import assert from "node:assert/strict";
import { buildTestChart, formatSourceTime, formatTestValue } from "../src/test-chart.js";

const startMs = Date.UTC(2026, 10, 19, 19, 17);
const clock = { startMs, endMs: startMs + 392_000 };
const point = (offset, value, extra = {}) => ({ timeMs: startMs + offset, value, valid: true, ...extra });

test("different channel coverage retains identical shared time ticks and graph bounds", () => {
  const early = buildTestChart({ kind: "analog", unit: "mA", points: [point(0, 4), point(40_000, 20)] }, clock);
  const late = buildTestChart({ kind: "analog", unit: "°C", points: [point(310_000, 19.7), point(392_000, 20)] }, clock);
  assert.deepEqual(early.xTicks, late.xTicks);
  assert.equal(early.domain.startMs, clock.startMs);
  assert.equal(late.domain.endMs, clock.endMs);
  assert.equal(early.points[0].x, early.plot.left);
  assert.equal(late.points[1].x, late.plot.left + late.plot.width);
  assert.equal(early.points.length, 2, "no synthetic endpoints or previous values");
  assert.ok(early.points[1].x < late.points[0].x, "unobserved station intervals remain blank");
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

test("digital and constant signals have usable axes without extrapolated samples", () => {
  const digital = buildTestChart({ kind: "digital", points: [point(1000, 1), point(2000, 0), point(3000, 3)] }, clock);
  assert.deepEqual(digital.yTicks.map((tick) => tick.value), [0, 1]);
  assert.equal(digital.invalidCount, 1);
  assert.equal(digital.points.length, 2);
  const constant = buildTestChart({ kind: "analog", points: [point(1000, 0), point(5000, 0)] }, clock);
  assert.ok(constant.domain.min < 0 && constant.domain.max > 0);
  const instant = buildTestChart({ kind: "analog", points: [point(0, 20)] }, { startMs, endMs: startMs });
  assert.equal(instant.xTicks.length, 1);
  assert.equal(instant.points[0].x, instant.plot.left + instant.plot.width / 2);
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
