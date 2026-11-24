import test from "node:test";
import assert from "node:assert/strict";
import {
  deviceGraphEntries, normalizeGraphOrder, orderDeviceGraphs, isGraphOrder,
  testGraphOrderScope, readDeviceGraphOrder, saveDeviceGraphOrder, resetDeviceGraphOrder,
  readTestGraphOrders, inheritTestGraphOrders,
} from "../src/test-graph-order.js";

const url = "https://example.supabase.co";
const scope = testGraphOrderScope(url, "inspector-1", "skid-1", 1);
const observed = (sourceRow, value) => ({ sourceId: "events-1", sourceRow, timeMs: 1000 * sourceRow, value, valid: true });

function deviceFixture(id = "valve") {
  return { id, name: "V-3501", channels: [
    { id: "command", stationId: "station-1", slot: 1, channel: 0, symbolicName: "V-3501_OPEN", role: "Open command",
      series: [{ id: "command:states", name: "V-3501_OPEN", kind: "digital", unit: "", points: [observed(1, 1), observed(2, 0)] }] },
    { id: "feedback", stationId: "station-1", slot: 2, channel: 0, symbolicName: "V-3501_FB", role: "Feedback",
      series: [
        { id: "feedback:voltage", name: "V-3501_FB", kind: "analog", unit: "V", points: [observed(3, 0.3), observed(4, 0.1)] },
        { id: "feedback:current", name: "V-3501-POS", kind: "analog", unit: "mA", points: [observed(5, 4)] },
      ] },
  ] };
}

function storageFor(t, initial = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const stored = new Map(Object.entries(initial));
  const storage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: key => stored.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  });
  return { stored, storage };
}

test("graph entries retain original indices and references while keys survive filtering, annotation edits and appended readings", () => {
  const device = deviceFixture();
  device.channels.unshift({ id: "not-applicable", symbolicName: "N/A", series: [
    { id: "na:values", kind: "analog", points: [observed(20, 5)] },
    { id: "empty", points: [] }, { id: "malformed", points: "not a list" },
  ] });
  const original = structuredClone(device);
  const entries = deviceGraphEntries(device);
  assert.equal(entries.length, 4);
  assert.equal(new Set(entries.map(entry => entry.key)).size, 4);
  assert.equal(entries[3].channel, device.channels[2]);
  assert.equal(entries[3].series, device.channels[2].series[1]);
  assert.deepEqual(entries.map(({ channelIndex, seriesIndex }) => [channelIndex, seriesIndex]), [[0, 0], [1, 0], [2, 0], [2, 1]]);
  const filtered = { ...device, channels: device.channels.slice(1) };
  const keys = deviceGraphEntries(filtered).map(entry => entry.key);
  assert.deepEqual(keys, entries.slice(1).map(entry => entry.key), "removing N/A channels cannot renumber graph identities");
  assert.deepEqual(deviceGraphEntries(structuredClone(filtered)).map(entry => entry.key), keys);
  assert.deepEqual(device, original, "enumeration never mutates source arrays or records");

  const order = [...keys].reverse();
  for (const channel of filtered.channels) {
    channel.status = "Failed";
    channel.comment = "Checked again";
    for (const series of channel.series) {
      series.name += " display label";
      series.points[0].excluded = true;
      series.points.push(observed(30, 0.2));
    }
  }
  assert.deepEqual(deviceGraphEntries(filtered).map(entry => entry.key), keys, "identified graphs keep their keys when readings are appended");
  assert.deepEqual(normalizeGraphOrder(filtered, order), order);
  assert.deepEqual(orderDeviceGraphs(filtered, order).map(entry => entry.series.id), ["feedback:current", "feedback:voltage", "command:states"]);
  assert.deepEqual(deviceGraphEntries(undefined), []);
  assert.deepEqual(deviceGraphEntries({ channels: [null, { series: null }] }), []);
});

test("missing and duplicate IDs produce deterministic unique keys without losing populated invalid or excluded graphs", () => {
  const device = deviceFixture();
  const missing = structuredClone(device.channels[0]);
  delete missing.id;
  delete missing.series[0].id;
  missing.slot = 3;
  missing.series[0].points[0].valid = false;
  missing.series[0].points[1].excluded = true;
  const duplicate = structuredClone(device.channels[0]);
  duplicate.slot = 4;
  const identicalCopy = structuredClone(device.channels[0]);
  device.channels.push(missing, duplicate, identicalCopy);
  const entries = deviceGraphEntries(device);
  const keys = entries.map(entry => entry.key);
  assert.equal(entries.length, 6);
  assert.equal(new Set(keys).size, 6, "even indistinguishable copies get separate entries");
  assert.deepEqual(deviceGraphEntries(structuredClone(device)).map(entry => entry.key), keys);
  assert.equal(orderDeviceGraphs(device, [...keys].reverse()).length, 6);
  const missingKey = entries.find(entry => entry.channel === missing).key;
  missing.comment = "A local note";
  missing.series[0].points[0].excluded = true;
  missing.series[0].points.push(observed(50, 1));
  assert.equal(deviceGraphEntries({ channels: [missing] })[0].key, missingKey,
    "missing-ID fallback uses stable source evidence rather than array positions or exclusion flags");
  const distinct = { channels: [duplicate, missing] };
  assert.deepEqual(deviceGraphEntries(distinct).map(entry => entry.key), [
    entries.find(entry => entry.channel === duplicate).key, missingKey,
  ]);
});

test("normalization ignores stale and repeated keys, appends new graphs and never changes original source order", () => {
  const device = deviceFixture();
  const keys = normalizeGraphOrder(device, null);
  const requested = [keys[2], "missing-graph", keys[2], keys[0]];
  const original = structuredClone(device);
  assert.deepEqual(normalizeGraphOrder(device, requested), [keys[2], keys[0], keys[1]]);
  assert.deepEqual(orderDeviceGraphs(device, requested).map(entry => entry.key), [keys[2], keys[0], keys[1]]);
  assert.deepEqual(normalizeGraphOrder(device, undefined), keys);
  assert.deepEqual(normalizeGraphOrder(device, {}), keys);
  assert.deepEqual(normalizeGraphOrder(device, []), keys);
  assert.deepEqual(device, original);
  assert.deepEqual(requested, [keys[2], "missing-graph", keys[2], keys[0]]);
  device.channels[1].series.push({ id: "feedback:new", name: "Extra", kind: "analog", unit: "V", points: [observed(10, 0.2)] });
  const newKey = deviceGraphEntries(device).at(-1).key;
  assert.deepEqual(normalizeGraphOrder(device, requested), [keys[2], keys[0], keys[1], newKey]);
  device.channels[0].series = [];
  assert.deepEqual(normalizeGraphOrder(device, requested), [keys[2], keys[1], newKey]);
  assert.deepEqual(normalizeGraphOrder({ channels: [] }, requested), []);
});

test("graph-order validation accepts bounded string arrays and rejects malformed, sparse or excessive input", () => {
  for (const order of [[], ["one"], ["one", "one", "stale-key"]]) assert.equal(isGraphOrder(order), true);
  for (const order of [undefined, null, {}, "one", false, [null], [1], [""], ["bad\u0000key"],
    ["x".repeat(2049)], new Array(1), [...Array(10_001)].map(() => "key")]) {
    assert.equal(isGraphOrder(order), false);
  }
});

test("graph-order storage isolates origin, inspector, skid, revision, run and device while normalizing saved keys", t => {
  storageFor(t);
  const device = deviceFixture();
  const keys = normalizeGraphOrder(device, null);
  assert.equal(saveDeviceGraphOrder(scope, "run-1", device, [keys[2], "stale", keys[2]]), "");
  assert.deepEqual(readDeviceGraphOrder(scope, "run-1", device), { order: [keys[2], keys[0], keys[1]], error: "" });
  assert.equal(testGraphOrderScope(`${url}/different/path`, "inspector-1", "skid-1", 1), scope, "the backend origin defines the scope");
  const otherScopes = [
    testGraphOrderScope("https://other.supabase.co", "inspector-1", "skid-1", 1),
    testGraphOrderScope(url, "inspector-2", "skid-1", 1),
    testGraphOrderScope(url, "inspector-1", "skid-2", 1),
    testGraphOrderScope(url, "inspector-1", "skid-1", 2),
  ];
  for (const isolated of otherScopes) assert.deepEqual(readDeviceGraphOrder(isolated, "run-1", device), { order: null, error: "" });
  assert.deepEqual(readDeviceGraphOrder(scope, "run-2", device), { order: null, error: "" });
  assert.deepEqual(readDeviceGraphOrder(scope, "run-1", { ...device, id: "other-device" }), { order: null, error: "" });
  assert.equal(resetDeviceGraphOrder(scope, "run-1", device.id), "");
  assert.deepEqual(readDeviceGraphOrder(scope, "run-1", device), { order: null, error: "" });
  for (const args of [["not a URL", "inspector", "skid", 1], ["file:///tmp", "inspector", "skid", 1],
    [url, "", "skid", 1], [url, "inspector", "", 1], [url, "inspector", "skid", 0],
    [url, "inspector", "skid", 1.5], [url, "inspector", "skid", Number.MAX_SAFE_INTEGER + 1]]) {
    assert.equal(testGraphOrderScope(...args), null);
  }
});

test("invalid cache data falls back clearly and valid stale orders reconcile with current graphs", t => {
  const { stored } = storageFor(t);
  const device = deviceFixture();
  const keys = normalizeGraphOrder(device, null);
  saveDeviceGraphOrder(scope, "run-1", device, [...keys].reverse());
  const [cacheKey] = stored.keys();
  for (const raw of ["{broken", "", "x".repeat(2_000_001)]) {
    stored.set(cacheKey, raw);
    const result = readDeviceGraphOrder(scope, "run-1", device);
    assert.equal(result.order, null);
    assert.match(result.error, /could not be read.*Original order/);
  }
  for (const raw of ["null", "{}", "[1]", '[""]']) {
    stored.set(cacheKey, raw);
    const result = readDeviceGraphOrder(scope, "run-1", device);
    assert.equal(result.order, null);
    assert.match(result.error, /invalid.*Original order/);
  }
  stored.set(cacheKey, JSON.stringify([keys[2], "old-graph", keys[2]]));
  assert.deepEqual(readDeviceGraphOrder(scope, "run-1", device), { order: [keys[2], keys[0], keys[1]], error: "" });
  device.channels[1].series.pop();
  assert.deepEqual(readDeviceGraphOrder(scope, "run-1", device), { order: keys.slice(0, 2), error: "" });
  assert.match(saveDeviceGraphOrder(scope, "run-1", device, null), /could not be saved locally/);
  assert.equal(stored.get(cacheKey), JSON.stringify([keys[2], "old-graph", keys[2]]), "invalid writes do not replace a saved preference");
});

test("export collection respects in-memory order and explicit reset overrides without changing source records", t => {
  storageFor(t);
  const device = deviceFixture(), second = deviceFixture("second");
  const runs = [{ id: "run-1", devices: [device, second] }, { id: "run-2", devices: [device] }];
  const original = structuredClone(runs);
  const keys = normalizeGraphOrder(device, null);
  const reversed = [...keys].reverse();
  saveDeviceGraphOrder(scope, "run-1", device, reversed);
  saveDeviceGraphOrder(scope, "run-1", second, reversed);
  saveDeviceGraphOrder(scope, "run-2", device, reversed);
  const overrides = { "run-1": { valve: null, second: [keys[1], "unknown", keys[1]] },
    "unknown-run": { valve: keys }, "run-2": { "unknown-device": keys } };
  assert.deepEqual(readTestGraphOrders(scope, runs, overrides), {
    "run-1": { second: [keys[1], keys[0], keys[2]] }, "run-2": { valve: reversed },
  });
  assert.deepEqual(readTestGraphOrders(scope, runs, { "run-1": { valve: { invalid: true }, second: null }, "run-2": { valve: null } }), {});
  assert.deepEqual(readTestGraphOrders(null, runs, { "run-1": { valve: reversed } }), { "run-1": { valve: reversed } });
  const inheritedOverrides = Object.create({ "run-1": { valve: keys } });
  assert.deepEqual(readTestGraphOrders(scope, [runs[0]], inheritedOverrides), { "run-1": { valve: reversed, second: reversed } });
  assert.deepEqual(runs, original);
  assert.deepEqual(readTestGraphOrders(scope, undefined), {});
});

test("blocked storage preserves usable tab overrides and safe absent-device reads", t => {
  const { storage } = storageFor(t);
  const device = deviceFixture();
  const reversed = normalizeGraphOrder(device, null).reverse();
  const failure = () => { throw new Error("Storage blocked"); };
  storage.getItem = failure;
  storage.setItem = failure;
  storage.removeItem = failure;
  assert.match(readDeviceGraphOrder(scope, "run-1", device).error, /could not be read/);
  assert.match(saveDeviceGraphOrder(scope, "run-1", device, reversed), /applies in this tab.*could not be saved locally/);
  assert.match(resetDeviceGraphOrder(scope, "run-1", device.id), /Original order.*could not be cleared/);
  const runs = [{ id: "run-1", devices: [device] }];
  assert.deepEqual(readTestGraphOrders(scope, runs, { "run-1": { valve: reversed } }), { "run-1": { valve: reversed } });
  assert.deepEqual(readTestGraphOrders(scope, runs, { "run-1": { valve: null } }), {});
  for (const args of [[null, "run-1", device], [scope, null, device], [scope, "run-1", undefined]]) {
    assert.deepEqual(readDeviceGraphOrder(...args), { order: null, error: "" });
  }
  assert.equal(resetDeviceGraphOrder(null, "run-1", device.id), "");
  assert.doesNotThrow(() => inheritTestGraphOrders(url, { inspector: { id: "inspector-1" },
    project: { status: "draft", walkdownId: "skid-1", revision: 2 }, revisions: [{ revision: 1 }], testRuns: runs }));
});

test("a new draft inherits graph orders once without overwriting current choices or reviving reset preferences", t => {
  storageFor(t);
  const device = deviceFixture(), second = deviceFixture("second");
  const run = { id: "run-1", devices: [device, second] };
  const keys = normalizeGraphOrder(device, null), reversed = [...keys].reverse();
  const nextScope = testGraphOrderScope(url, "inspector-1", "skid-1", 2);
  const report = { inspector: { id: "inspector-1" }, project: { status: "draft", walkdownId: "skid-1", revision: 2 },
    revisions: [{ revision: 1 }], testRuns: [run] };
  const original = structuredClone(report);
  saveDeviceGraphOrder(scope, run.id, device, reversed);
  saveDeviceGraphOrder(scope, run.id, second, reversed);
  saveDeviceGraphOrder(nextScope, run.id, second, [keys[1], keys[0], keys[2]]);
  inheritTestGraphOrders(url, report);
  assert.deepEqual(readTestGraphOrders(nextScope, [run]), { "run-1": {
    valve: reversed, second: [keys[1], keys[0], keys[2]],
  } });
  resetDeviceGraphOrder(nextScope, run.id, device.id);
  inheritTestGraphOrders(url, report);
  assert.equal(readDeviceGraphOrder(nextScope, run.id, device).order, null, "inheritance cannot undo a user's later reset");
  assert.deepEqual(readDeviceGraphOrder(scope, run.id, device).order, reversed, "the approved revision remains unchanged");
  assert.deepEqual(report, original);
});

test("inheritance requires the next draft revision and matching identity, and reconciles removed graphs", t => {
  const { stored } = storageFor(t);
  const device = deviceFixture();
  const keys = normalizeGraphOrder(device, null);
  saveDeviceGraphOrder(scope, "run-1", device, [...keys].reverse());
  const report = { inspector: { id: "inspector-1" }, project: { status: "draft", walkdownId: "skid-1", revision: 2 },
    revisions: [{ revision: 1 }], testRuns: [{ id: "run-1", devices: [device] }] };
  const before = new Map(stored);
  for (const changed of [
    { ...report, project: { ...report.project, status: "closed" } },
    { ...report, project: { ...report.project, revision: 3 } },
    { ...report, revisions: [] }, { ...report, testRuns: [] }, { ...report, inspector: null },
  ]) inheritTestGraphOrders(url, changed);
  assert.deepEqual(stored, before, "ineligible contexts do not write an inheritance marker or preference");
  device.channels[1].series.pop();
  inheritTestGraphOrders(url, report);
  const nextScope = testGraphOrderScope(url, "inspector-1", "skid-1", 2);
  assert.deepEqual(readDeviceGraphOrder(nextScope, "run-1", device), { order: [keys[1], keys[0]], error: "" });
  const otherScope = testGraphOrderScope(url, "other-inspector", "skid-1", 2);
  inheritTestGraphOrders(url, { ...report, inspector: { id: "other-inspector" } });
  assert.equal(readDeviceGraphOrder(otherScope, "run-1", device).order, null);
});
