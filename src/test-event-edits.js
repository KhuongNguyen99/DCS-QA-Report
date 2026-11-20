const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => typeof value === "string" && value.length <= max && !value.includes("\u0000");
const index = (value, max) => Number.isSafeInteger(value) && value >= 0 && value < max;
const FIELDS = ["deviceId", "channelId", "seriesIndex", "pointIndex", "excluded", "identity"];
const INVALID = "The pending event changes are invalid or exceed the supported limit.";
const MISMATCH = "The recorded events no longer match these pending changes. Reselect the original source files or discard these changes before editing.";

const targetKey = edit => JSON.stringify([edit.deviceId, edit.channelId, edit.seriesIndex, edit.pointIndex]);
const validTarget = edit => object(edit) && text(edit.deviceId, 160) && edit.deviceId
  && text(edit.channelId, 220) && edit.channelId && index(edit.seriesIndex, 32) && index(edit.pointIndex, 10000);

export function validTestEventEdits(edits) {
  if (!Array.isArray(edits) || edits.length > 10000) return false;
  const targets = new Set();
  for (const edit of edits) {
    if (!validTarget(edit) || typeof edit.excluded !== "boolean" || !text(edit.identity, 16384) || !edit.identity
      || Object.keys(edit).length !== FIELDS.length || Object.keys(edit).some(key => !FIELDS.includes(key))) return false;
    const key = targetKey(edit);
    if (targets.has(key)) return false;
    targets.add(key);
  }
  return true;
}

function eventAt(data, target) {
  const device = data?.devices?.find(item => item.id === target.deviceId);
  const channel = device?.channels?.find(item => item.id === target.channelId);
  const series = channel?.series?.[target.seriesIndex];
  const point = series?.points?.[target.pointIndex];
  if (!object(point)) throw new Error(MISMATCH);
  return { series, point };
}

function eventIdentity(data, { series, point }) {
  const sources = data.sources ?? [];
  if (!Array.isArray(sources)) throw new Error(MISMATCH);
  const matching = point.sourceId == null ? sources : sources.filter(source => source?.id === point.sourceId);
  const source = matching[0];
  if ((point.sourceId != null || sources.length) && (matching.length !== 1
    || typeof source?.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(source.sha256))) throw new Error(MISMATCH);
  // Exclusion is deliberately absent so a restore still targets the original event.
  return JSON.stringify([series.id, series.kind, series.unit, point.sourceId, point.sourceRow,
    point.timeMs, point.time, point.rawValue, point.previousRawValue, point.value, point.previousValue,
    point.valid, point.previousValid, point.previousUnit, source?.sha256.toLowerCase()]);
}

export function createTestEventEdit(data, target, excluded) {
  if (!validTarget(target) || typeof excluded !== "boolean") throw new Error(INVALID);
  const { deviceId, channelId, seriesIndex, pointIndex } = target;
  const edit = { deviceId, channelId, seriesIndex, pointIndex, excluded, identity: eventIdentity(data, eventAt(data, target)) };
  if (!validTestEventEdits([edit])) throw new Error(INVALID);
  return edit;
}

export function setTestEventEdit(edits, edit) {
  if (!validTestEventEdits(edits) || !validTestEventEdits([edit])) throw new Error(INVALID);
  const position = edits.findIndex(previous => targetKey(previous) === targetKey(edit));
  if (position < 0) {
    if (edits.length === 10000) throw new Error(INVALID);
    return [...edits, { ...edit }];
  }
  if (edits[position].identity !== edit.identity) throw new Error(MISMATCH);
  return edits.map((previous, offset) => offset === position ? { ...previous, excluded: edit.excluded } : previous);
}

export function applyTestEventEdits(data, edits = []) {
  if (!validTestEventEdits(edits)) throw new Error(INVALID);
  for (const edit of edits) {
    if (eventIdentity(data, eventAt(data, edit)) !== edit.identity) throw new Error(MISMATCH);
  }
  const result = structuredClone(data);
  for (const edit of edits) eventAt(result, edit).point.excluded = edit.excluded;
  return result;
}
