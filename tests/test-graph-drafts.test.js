import test from "node:test";
import assert from "node:assert/strict";
import { readTestCommentDrafts, writeTestCommentDraft, testCommentDraftScope, testCommentDraftKey } from "../src/test-comment-drafts.js";

function cache(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const rows = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    get length() { return rows.size; }, key: index => [...rows.keys()][index] ?? null,
    getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, String(value)),
    removeItem: key => rows.delete(key),
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete globalThis.localStorage; });
  return rows;
}

const scope = testCommentDraftScope("https://example.supabase.co", "inspector-a", "skid-a");
const base = () => ({ id: "run-a", revision: 7, runVersion: 3, name: "Recorded test",
  software: { name: "PRONETA Basic", version: "3.9" }, timeZone: "UTC-06:00", comment: "Pending note",
  deviceComments: { valve: "Pending device note" }, deviceNames: { valve: "Original valve" },
  sources: [{ name: "events.csv", sha256: "a".repeat(64) }], requiresFiles: false, eventEdits: [],
});
const tools = () => ({ version: 1, deviceNames: [{ deviceId: "valve", name: "V-3511-Y_FB" }], graphs: [{
  deviceId: "valve", graphKey: "graph:v1:feedback:0", name: "Renamed feedback", style: "step", measurements: [{
    id: "delay", name: "Feedback response", unit: "min",
    start: { kind: "trigger", deviceId: "another-valve", graphKey: "graph:v1:command:0", operator: ">", threshold: 0.2 },
    end: { kind: "point", deviceId: "valve", graphKey: "graph:v1:feedback:0", pointIndex: 1,
      timeMs: 1764000000000, value: 0.3, sourceId: "source-a", sourceRow: 3 },
  }],
}] });

test("pending graph tools recover exactly with comments and original endpoint references", t => {
  cache(t);
  const draft = { ...base(), graphTools: tools() };
  assert.equal(writeTestCommentDraft(scope, draft), "");
  const saved = readTestCommentDrafts(scope);
  assert.equal(saved.error, "");
  assert.equal(saved.drafts.length, 1);
  assert.deepEqual(saved.drafts[0].graphTools, draft.graphTools);
  assert.equal(saved.drafts[0].comment, draft.comment);
  assert.deepEqual(saved.drafts[0].deviceComments, draft.deviceComments);
  assert.deepEqual(readTestCommentDrafts(testCommentDraftScope("https://example.supabase.co", "another-inspector", "skid-a")).drafts, []);
});

test("legacy pending drafts without graph settings remain readable", t => {
  cache(t);
  assert.equal(writeTestCommentDraft(scope, base()), "");
  const recovered = readTestCommentDrafts(scope);
  assert.equal(recovered.error, "");
  assert.equal(Object.hasOwn(recovered.drafts[0], "graphTools"), false);
  assert.equal(recovered.drafts[0].comment, "Pending note");
});

test("a malformed graph edit cannot replace a recoverable draft or be discarded silently on read", t => {
  const rows = cache(t), draft = { ...base(), graphTools: tools() };
  assert.equal(writeTestCommentDraft(scope, draft), "");
  const key = testCommentDraftKey(scope, draft), original = rows.get(key);
  draft.graphTools.graphs[0].measurements[0].end.pointIndex = -1;
  assert.match(writeTestCommentDraft(scope, draft), /could not be cached/);
  assert.equal(rows.get(key), original);
  const malformed = JSON.stringify({ ...JSON.parse(original), graphTools: draft.graphTools });
  rows.set(key, malformed);
  const result = readTestCommentDrafts(scope);
  assert.deepEqual(result.drafts, []);
  assert.match(result.error, /could not be read/);
  assert.equal(rows.get(key), malformed, "unreadable local work remains stored for recovery");
});
