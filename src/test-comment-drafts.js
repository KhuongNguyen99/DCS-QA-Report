import { validTestEventEdits } from "./test-event-edits.js";
import { validGraphTools } from "./test-graph-tools.js";
import { validManualStatuses } from "./test-device-results.js";

const PREFIX = "jeevy-qa-test-comments:v1:";
const MAX_RECORD_LENGTH = 2_200_000;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => typeof value === "string" && Array.from(value).length <= max && !value.includes("\u0000");
const version = value => Number.isSafeInteger(value) && value > 0;

export function testCommentDraftScope(url, inspectorId, walkdownId) {
  try {
    const backend = new URL(url);
    if (!/^https?:$/.test(backend.protocol) || !text(inspectorId, 160) || !inspectorId || !text(walkdownId, 160) || !walkdownId) return null;
    return PREFIX + encodeURIComponent(JSON.stringify([backend.origin, inspectorId, walkdownId])) + ":";
  } catch { return null; }
}

export const testCommentDraftKey = (scope, draft) => `${scope}${draft.revision}:${encodeURIComponent(draft.id)}`;

function valid(record) {
  return object(record) && record.v === 1 && text(record.id, 160) && record.id && version(record.revision)
    && (record.runVersion === null || version(record.runVersion)) && Number.isFinite(record.updatedAt)
    && text(record.name, 160) && object(record.software) && text(record.software.name, 120) && text(record.software.version, 80)
    && text(record.timeZone, 120) && text(record.comment, 4000) && typeof record.requiresFiles === "boolean"
    && (record.eventEdits === undefined || validTestEventEdits(record.eventEdits))
    && (record.graphTools === undefined || validGraphTools(record.graphTools))
    && (record.manualStatuses === undefined || validManualStatuses(record.manualStatuses))
    && (record.manualStatusesReset === undefined || typeof record.manualStatusesReset === "boolean")
    && object(record.deviceComments) && Object.keys(record.deviceComments).length <= 250
    && Object.entries(record.deviceComments).every(([id, value]) => id && text(id, 160) && text(value, 4000))
    && object(record.deviceNames) && Object.keys(record.deviceNames).length <= 250
    && Object.entries(record.deviceNames).every(([id, value]) => id && text(id, 160) && text(value, 160))
    && Array.isArray(record.sources) && record.sources.length <= 20
    && record.sources.every(source => object(source) && text(source.name, 260)
      && typeof source.sha256 === "string" && /^[0-9a-f]{64}$/i.test(source.sha256));
}

export function readTestCommentDrafts(scope) {
  const drafts = [];
  if (!scope) return { drafts, error: "Local test draft recovery is unavailable until the project and inspector are identified." };
  let error = "";
  try {
    const storage = globalThis.localStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(scope)) continue;
      try {
        const raw = storage.getItem(key);
        if (!raw || raw.length > MAX_RECORD_LENGTH) throw new Error();
        const record = JSON.parse(raw);
        if (!valid(record) || testCommentDraftKey(scope, record) !== key) throw new Error();
        drafts.push(record);
      } catch { error = "A local test draft could not be read. Its stored data has been left untouched."; }
    }
  } catch { error = "Local test draft recovery is blocked by this browser. Keep this tab open until you save the test run."; }
  return { drafts: drafts.sort((a, b) => b.updatedAt - a.updatedAt), error };
}

export function writeTestCommentDraft(scope, draft) {
  try {
    if (!scope) throw new Error();
    const record = {
      v: 1, id: draft.id, revision: draft.revision, runVersion: draft.runVersion, updatedAt: Date.now(),
      name: draft.name, software: draft.software, timeZone: draft.timeZone,
      comment: draft.comment, deviceComments: draft.deviceComments, deviceNames: draft.deviceNames,
      sources: draft.sources, requiresFiles: draft.requiresFiles,
      eventEdits: draft.eventEdits === undefined ? [] : draft.eventEdits,
      ...(draft.graphTools === undefined ? {} : { graphTools: draft.graphTools }),
      ...(draft.manualStatuses === undefined ? {} : { manualStatuses: draft.manualStatuses }),
      ...(draft.manualStatusesReset === undefined ? {} : { manualStatusesReset: draft.manualStatusesReset }),
    };
    const serialized = JSON.stringify(record);
    if (!valid(record) || serialized.length > MAX_RECORD_LENGTH) throw new Error();
    globalThis.localStorage.setItem(testCommentDraftKey(scope, record), serialized);
    return "";
  } catch { return "Your pending test changes could not be cached locally. Keep this tab open until Save test run succeeds."; }
}

export function removeTestCommentDraft(scope, draft) {
  try {
    if (!scope) return "";
    globalThis.localStorage.removeItem(testCommentDraftKey(scope, draft));
    return "";
  } catch { return "The local test draft cache could not be cleared. It may reappear after a refresh; no pending test changes were sent automatically."; }
}
