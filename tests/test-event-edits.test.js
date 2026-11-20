import test from "node:test";
import assert from "node:assert/strict";
import { createTestEventEdit, setTestEventEdit, applyTestEventEdits, validTestEventEdits } from "../src/test-event-edits.js";
import { testCommentDraftScope, testCommentDraftKey, readTestCommentDrafts, writeTestCommentDraft,
  removeTestCommentDraft } from "../src/test-comment-drafts.js";
import { parsePronetaFiles } from "../src/proneta-parser.js";

const target = { deviceId: "valve", channelId: "output", seriesIndex: 0, pointIndex: 0 };
const scope = testCommentDraftScope("https://example.supabase.co", "inspector-1", "skid-1");
function run() {
  return { id: "run-1", runVersion: 7, sources: [{ id: "source-log", name: "log.csv", sha256: "ab".repeat(32) }],
    devices: [{ id: "valve", channels: [{ id: "output", series: [{ id: "output-series", kind: "digital", unit: "",
      points: [0, 1].map(value => ({ sourceId: "source-log", sourceRow: value + 2, timeMs: 1000 + value * 1000,
        time: `Recorded ${value}`, value, previousValue: 1 - value, rawValue: String(value),
        previousRawValue: String(1 - value), valid: true, previousValid: true, previousUnit: "" })) }] }] }] };
}
const points = data => data.devices[0].channels[0].series[0].points;
function draft(eventEdits = []) {
  return { id: "run-1", revision: 4, runVersion: 7, name: "Valve test", software: { name: "PRONETA", version: "3.9" },
    timeZone: "Source clock", comment: "Pending note", deviceComments: { valve: "Pending device note" },
    deviceNames: { valve: "Valve" }, sources: [{ name: "log.csv", sha256: "ab".repeat(32) }],
    requiresFiles: false, eventEdits, data: run() };
}
function storage(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map();
  const result = { values, get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key) };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: result });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  });
  return result;
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("event exclusion replay clones the source and retains the complete original row", () => {
  const source = freeze(run()), before = JSON.stringify(source);
  const edit = createTestEventEdit(source, target, true);
  const changes = freeze(setTestEventEdit([], edit));
  const result = applyTestEventEdits(source, changes);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(points(result)[0], { ...points(source)[0], excluded: true });
  assert.deepEqual(points(result)[1], points(source)[1]);
  assert.notEqual(points(result)[1], points(source)[1], "unedited evidence is also cloned");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].excluded, true);
  assert.deepEqual(Object.keys(edit).sort(), ["channelId", "deviceId", "excluded", "identity", "pointIndex", "seriesIndex"]);
  const noChanges = applyTestEventEdits(source);
  assert.deepEqual(noChanges, source);
  assert.notEqual(noChanges, source);
});

test("restoring a saved exclusion retains an explicit false delta and repeated toggles keep one identity", () => {
  const source = run(); points(source)[0].excluded = true;
  const restored = createTestEventEdit(source, target, false);
  let changes = setTestEventEdit([], restored);
  const preview = applyTestEventEdits(source, changes);
  assert.equal(points(source)[0].excluded, true);
  assert.equal(points(preview)[0].excluded, false);
  const removed = createTestEventEdit(preview, target, true);
  assert.equal(removed.identity, restored.identity);
  changes = setTestEventEdit(changes, removed);
  changes = setTestEventEdit(changes, restored);
  assert.deepEqual(changes, [restored]);
  assert.equal(JSON.parse(JSON.stringify(changes))[0].excluded, false);
  assert.throws(() => setTestEventEdit(changes, { ...restored, identity: "changed source" }), /no longer match/);
});

test("replay rejects changed evidence and source or series reordering before applying any changes", () => {
  const source = run();
  const edits = [createTestEventEdit(source, target, true),
    createTestEventEdit(source, { ...target, pointIndex: 1 }, true)];
  const changes = [
    data => points(data).reverse(),
    data => { points(data)[1].sourceId = "another-source"; },
    data => { data.sources[0].sha256 = "cd".repeat(32); },
    data => { points(data)[1].sourceRow += 1; },
    data => { points(data)[1].timeMs += 1; },
    data => { points(data)[1].rawValue = "01"; },
    data => { points(data)[1].previousRawValue = "01"; },
    data => { points(data)[1].value = 22; },
    data => { points(data)[1].previousValue = 22; },
    data => { data.devices[0].channels[0].series.unshift({ ...structuredClone(data.devices[0].channels[0].series[0]), id: "different-series" }); },
    data => { data.devices[0].channels[0].series[0].points.pop(); },
    data => { data.devices[0].id = "another-device"; },
    data => { data.devices[0].channels[0].id = "another-channel"; },
  ];
  for (const change of changes) {
    const changed = run(); change(changed); freeze(changed);
    const before = JSON.stringify(changed);
    assert.throws(() => applyTestEventEdits(changed, edits), /no longer match/);
    assert.equal(JSON.stringify(changed), before, "failed replay cannot partially mutate the source");
  }
});

test("event identity tolerates legacy missing optional source fields and channel display ordering", () => {
  const source = run(); delete points(source)[0].sourceId;
  const edit = createTestEventEdit(source, target, true);
  source.devices.unshift({ id: "other", channels: [] });
  source.devices[1].channels.unshift({ id: "other-channel", series: [] });
  const result = applyTestEventEdits(source, [edit]);
  assert.equal(result.devices[1].channels[1].series[0].points[0].excluded, true);
});

test("reselecting reordered source files cannot exclude the identical event from another file", async () => {
  const common = "2,AI 2xRTD,Analog input TH-1001 (0) was changed from 20 C to 20.1 C.,2026-01-20 12:00:00";
  const log = value => ["Slot,Module,Description,Time Stamp", common,
    `2,AI 2xRTD,Analog input TH-1001 (0) was changed from 20.1 C to ${value} C.,2026-01-20 12:00:02`].join("\r\n");
  const a = { name: "A-log.csv", text: log("20.2") }, b = { name: "B-log.csv", text: log("20.3") };
  const options = { stationAssignments: { "A-log.csv": "s", "B-log.csv": "s" } };
  const original = await parsePronetaFiles([a, b], options), reordered = await parsePronetaFiles([b, a], options);
  const eventTarget = { deviceId: original.devices[0].id, channelId: original.devices[0].channels[0].id,
    seriesIndex: 0, pointIndex: 0 };
  const edit = createTestEventEdit(original, eventTarget, true);
  assert.deepEqual(original.sources.map(source => source.sha256).sort(), reordered.sources.map(source => source.sha256).sort());
  assert.deepEqual(points(original)[0], points(reordered)[0], "positional source IDs and event fields alone are identical");
  const before = JSON.stringify(reordered);
  assert.throws(() => applyTestEventEdits(reordered, [edit]), /no longer match/);
  assert.equal(JSON.stringify(reordered), before);
});

test("source-backed events require an unambiguous valid hash for creation and replay", () => {
  const source = run(), edit = createTestEventEdit(source, target, true);
  const changes = [
    data => { delete data.sources[0].sha256; },
    data => { data.sources[0].sha256 = "not-a-hash"; },
    data => { data.sources[0].sha256 = null; },
    data => { data.sources[0].id = "other-source"; },
    data => { data.sources.push({ ...data.sources[0] }); },
    data => { delete data.sources; },
  ];
  for (const change of changes) {
    const changed = run(); change(changed);
    assert.throws(() => createTestEventEdit(changed, target, true), /no longer match/);
    assert.throws(() => applyTestEventEdits(changed, [edit]), /no longer match/);
  }
  source.sources[0].sha256 = source.sources[0].sha256.toUpperCase();
  assert.equal(points(applyTestEventEdits(source, [edit]))[0].excluded, true);
  const legacy = run(); delete points(legacy)[0].sourceId;
  const legacyEdit = createTestEventEdit(legacy, target, true);
  legacy.sources[0].sha256 = "cd".repeat(32);
  assert.throws(() => applyTestEventEdits(legacy, [legacyEdit]), /no longer match/);
  delete legacy.sources[0].sha256;
  assert.throws(() => createTestEventEdit(legacy, target, true), /no longer match/);
  legacy.sources = [{ id: "first", sha256: "ab".repeat(32) }, { id: "second", sha256: "cd".repeat(32) }];
  assert.throws(() => createTestEventEdit(legacy, target, true), /no longer match/);
  delete legacy.sources;
  const sourcelessEdit = createTestEventEdit(legacy, target, true);
  assert.equal(points(applyTestEventEdits(legacy, [sourcelessEdit]))[0].excluded, true);
});

test("event edits enforce bounds, boolean flags, bounded text identity, and unique targets", () => {
  const edit = createTestEventEdit(run(), target, true);
  const malformed = [null, {}, "edit", { ...edit, excluded: 1 }, { ...edit, identity: null },
    { ...edit, identity: "" }, { ...edit, identity: "x\u0000x" }, { ...edit, identity: "x".repeat(16385) },
    { ...edit, deviceId: "" }, { ...edit, deviceId: "x".repeat(161) }, { ...edit, channelId: "x".repeat(221) },
    { ...edit, seriesIndex: -1 }, { ...edit, seriesIndex: 32 }, { ...edit, pointIndex: 10000 },
    { ...edit, pointIndex: 0.5 }, { ...edit, pointIndex: "0" }, { ...edit, data: run() }];
  for (const value of malformed) {
    assert.equal(validTestEventEdits([value]), false);
    assert.throws(() => applyTestEventEdits(run(), [value]), /invalid|limit/);
  }
  assert.equal(validTestEventEdits([edit, edit]), false);
  assert.equal(validTestEventEdits(new Array(1)), false);
  assert.equal(validTestEventEdits([Object.create(edit)]), false);
  assert.throws(() => createTestEventEdit(run(), { ...target, pointIndex: -1 }, true), /invalid/);
  assert.throws(() => createTestEventEdit(run(), target, "true"), /invalid/);
  assert.throws(() => createTestEventEdit(run(), { ...target, pointIndex: 9 }, true), /no longer match/);
  const maximum = Array.from({ length: 10000 }, (_, pointIndex) => ({ ...edit, pointIndex }));
  assert.equal(validTestEventEdits(maximum), true);
  const extra = { ...edit, channelId: "another-channel" };
  assert.equal(validTestEventEdits([...maximum, extra]), false);
  assert.throws(() => setTestEventEdit(maximum, extra), /limit/);
  assert.equal(setTestEventEdit(maximum, { ...edit, excluded: false }).length, 10000);
});

test("pending cache round trips only exclusion deltas with baseline and original file hashes", t => {
  const local = storage(t), edit = createTestEventEdit(run(), target, false);
  const pending = draft([edit]); pending.requiresFiles = true;
  assert.equal(writeTestCommentDraft(scope, pending), "");
  const key = testCommentDraftKey(scope, pending), raw = local.getItem(key), stored = JSON.parse(raw);
  assert.deepEqual(stored.eventEdits, [edit]);
  assert.equal(stored.data, undefined);
  assert.equal(stored.runVersion, 7);
  assert.equal(stored.requiresFiles, true);
  assert.deepEqual(stored.sources, pending.sources);
  const recovered = readTestCommentDrafts(scope);
  assert.equal(recovered.error, "");
  assert.deepEqual(recovered.drafts[0], stored);
  assert.equal(local.getItem(key), raw, "reading does not rewrite the stored draft");
  assert.equal(readTestCommentDrafts(testCommentDraftScope("https://example.supabase.co", "other", "skid-1")).drafts.length, 0);
  assert.equal(removeTestCommentDraft(scope, pending), "");
  assert.equal(local.length, 0);
});

test("legacy v1 caches without event edits remain recoverable and are not rewritten", t => {
  const local = storage(t), pending = draft(); delete pending.eventEdits;
  assert.equal(writeTestCommentDraft(scope, pending), "");
  const key = testCommentDraftKey(scope, pending), legacy = JSON.parse(local.getItem(key));
  assert.deepEqual(legacy.eventEdits, []);
  delete legacy.eventEdits;
  const raw = JSON.stringify(legacy); local.setItem(key, raw);
  assert.deepEqual(readTestCommentDrafts(scope), { drafts: [legacy], error: "" });
  assert.equal(local.getItem(key), raw);
});

test("malformed event caches are left untouched and failed writes preserve the last valid record", t => {
  const local = storage(t), edit = createTestEventEdit(run(), target, true), pending = draft([edit]);
  writeTestCommentDraft(scope, pending);
  const key = testCommentDraftKey(scope, pending), valid = JSON.parse(local.getItem(key));
  for (const eventEdits of [null, {}, [null], [{ ...edit, excluded: "true" }], [edit, edit],
    [{ ...edit, identity: "x".repeat(16385) }], Array.from({ length: 10001 }, () => edit)]) {
    const raw = JSON.stringify({ ...valid, eventEdits }); local.setItem(key, raw);
    assert.match(readTestCommentDrafts(scope).error, /left untouched/);
    assert.equal(readTestCommentDrafts(scope).drafts.length, 0);
    assert.match(writeTestCommentDraft(scope, { ...pending, eventEdits }), /could not be cached locally/);
    assert.equal(local.getItem(key), raw);
  }
});

test("serialized cache size and blocked or full storage fail without changing pending edits", t => {
  const local = storage(t), edit = createTestEventEdit(run(), target, true), pending = draft([edit]);
  writeTestCommentDraft(scope, pending);
  const key = testCommentDraftKey(scope, pending), previous = local.getItem(key);
  const oversized = { ...pending, eventEdits: Array.from({ length: 150 }, (_, pointIndex) => ({ ...edit, pointIndex, identity: "x".repeat(16000) })) };
  assert.equal(validTestEventEdits(oversized.eventEdits), true);
  assert.match(writeTestCommentDraft(scope, oversized), /could not be cached locally/);
  assert.equal(local.getItem(key), previous);
  local.setItem = () => { throw new Error("Quota exceeded"); };
  const snapshot = JSON.stringify(pending);
  assert.match(writeTestCommentDraft(scope, pending), /could not be cached locally/);
  assert.equal(JSON.stringify(pending), snapshot);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Blocked"); } });
  assert.match(readTestCommentDrafts(scope).error, /blocked by this browser/);
  assert.match(writeTestCommentDraft(scope, pending), /could not be cached locally/);
  assert.equal(JSON.stringify(pending), snapshot);
});
