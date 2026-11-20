import { isTestTimeRange } from "./test-chart.js";

export function testTimeRangeScope(url, inspectorId, walkdownId, revision) {
  try {
    const backend = new URL(url);
    if (!/^https?:$/.test(backend.protocol) || typeof inspectorId !== "string" || !inspectorId
      || typeof walkdownId !== "string" || !walkdownId
      || !Number.isSafeInteger(revision) || revision < 1) return null;
    return `jeevy-qa-test-time-ranges:v1:${encodeURIComponent(JSON.stringify([backend.origin, inspectorId, walkdownId, revision]))}:`;
  } catch { return null; }
}

const rangeKey = (scope, runId, deviceId) => `${scope}${encodeURIComponent(JSON.stringify([runId, deviceId]))}`;

export function readDeviceTimeRange(scope, runId, deviceId, clock) {
  if (!scope || !runId || !deviceId) return { range: null, error: "" };
  try {
    const raw = globalThis.localStorage.getItem(rangeKey(scope, runId, deviceId));
    if (!raw) return { range: null, error: "" };
    if (raw.length > 200) throw new Error();
    const range = JSON.parse(raw);
    if (!isTestTimeRange(range, clock))
      return { range: null, error: "The saved time range no longer matches this run. Automatic scaling is active." };
    return { range, error: "" };
  } catch {
    return { range: null, error: "The saved time range could not be read. Automatic scaling is active." };
  }
}

export function saveDeviceTimeRange(scope, runId, deviceId, clock, range) {
  try {
    if (!scope || !runId || !deviceId || !isTestTimeRange(range, clock)) throw new Error();
    globalThis.localStorage.setItem(rangeKey(scope, runId, deviceId), JSON.stringify(range));
    return "";
  } catch { return "This time range applies in this tab but could not be saved locally."; }
}

export function resetDeviceTimeRange(scope, runId, deviceId) {
  try {
    if (scope && runId && deviceId) globalThis.localStorage.removeItem(rangeKey(scope, runId, deviceId));
    return "";
  } catch { return "Automatic scaling is active, but the saved range could not be cleared from this browser."; }
}

export function readTestTimeRanges(scope, runs, overrides = {}) {
  const ranges = [];
  for (const run of runs) {
    const deviceRanges = [];
    for (const device of run.devices || []) {
      const range = Object.hasOwn(overrides[run.id] || {}, device.id)
        ? overrides[run.id][device.id] : readDeviceTimeRange(scope, run.id, device.id, run.clock).range;
      if (isTestTimeRange(range, run.clock))
        deviceRanges.push([device.id, { startMs: range.startMs, endMs: range.endMs }]);
    }
    if (deviceRanges.length) ranges.push([run.id, Object.fromEntries(deviceRanges)]);
  }
  return Object.fromEntries(ranges);
}
