const MAX_GRAPHS = 10_000;
const MAX_KEY_LENGTH = 2048;
const MAX_CACHE_LENGTH = 2_000_000;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const identifier = value => typeof value === "string" && value.length > 0;
const scalar = value => ["string", "number", "boolean"].includes(typeof value) ? value : null;

// Keep source identities compact without depending on browser crypto or array
// positions. An occurrence suffix below also preserves indistinguishable copies.
function fingerprint(value) {
  const text = JSON.stringify(value);
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x5bd1e995);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function graphIdentity(channel, series) {
  const channelId = identifier(channel.id) ? channel.id : null;
  const seriesId = identifier(series.id) ? series.id : null;
  const location = [channel.stationId, channel.slot, channel.channel, channel.sourceChannel].map(scalar);
  const signal = [series.kind, series.unit].map(scalar);
  if (channelId && seriesId) return [channelId, seriesId, location, signal];
  // Older records without IDs use the first original source event as an anchor.
  // Appended readings and mutable comments/status/exclusions do not change it.
  const point = series.points[0];
  const source = identifier(point?.sourceId) && point?.sourceRow != null
    ? [point.sourceId, scalar(point.sourceRow)]
    : [point?.sourceId, point?.sourceRow, point?.timeMs, point?.time,
      point?.value, point?.rawValue, point?.previousValue, point?.previousRawValue].map(scalar);
  return [channelId, seriesId, location, signal,
    channelId ? null : scalar(channel.symbolicName), seriesId ? null : scalar(series.name), source];
}

export function deviceGraphEntries(device) {
  const entries = [];
  const occurrences = new Map();
  for (const [channelIndex, channel] of (Array.isArray(device?.channels) ? device.channels : []).entries()) {
    for (const [seriesIndex, series] of (Array.isArray(channel?.series) ? channel.series : []).entries()) {
      if (!Array.isArray(series?.points) || !series.points.length) continue;
      const identity = fingerprint(graphIdentity(channel, series));
      const occurrence = occurrences.get(identity) || 0;
      occurrences.set(identity, occurrence + 1);
      const key = `graph:v1:${identity}:${occurrence}`;
      entries.push({ key, channel, channelIndex, series, seriesIndex });
    }
  }
  return entries;
}

export function isGraphOrder(value) {
  if (!Array.isArray(value) || value.length > MAX_GRAPHS) return false;
  for (const key of value)
    if (typeof key !== "string" || !key.length || key.length > MAX_KEY_LENGTH || key.includes("\u0000")) return false;
  return true;
}

function orderedEntries(entries, order) {
  const remaining = new Map(entries.map(entry => [entry.key, entry]));
  const result = [];
  for (const key of isGraphOrder(order) ? order : []) {
    const entry = remaining.get(key);
    if (!entry) continue;
    result.push(entry);
    remaining.delete(key);
  }
  return [...result, ...remaining.values()];
}

export function normalizeGraphOrder(device, order) {
  return orderedEntries(deviceGraphEntries(device), order).map(entry => entry.key);
}

export function orderDeviceGraphs(device, order) {
  return orderedEntries(deviceGraphEntries(device), order);
}

export function testGraphOrderScope(url, inspectorId, walkdownId, revision) {
  try {
    const backend = new URL(url);
    if (!/^https?:$/.test(backend.protocol) || !identifier(inspectorId) || !identifier(walkdownId)
      || !Number.isSafeInteger(revision) || revision < 1) return null;
    return `jeevy-qa-test-graph-orders:v1:${encodeURIComponent(JSON.stringify([backend.origin, inspectorId, walkdownId, revision]))}:`;
  } catch { return null; }
}

const orderKey = (scope, runId, deviceId) => `${scope}${encodeURIComponent(JSON.stringify([runId, deviceId]))}`;

export function readDeviceGraphOrder(scope, runId, device) {
  if (!scope || !identifier(runId) || !identifier(device?.id)) return { order: null, error: "" };
  try {
    const raw = globalThis.localStorage.getItem(orderKey(scope, runId, device.id));
    if (raw === null) return { order: null, error: "" };
    if (raw.length > MAX_CACHE_LENGTH) throw new Error();
    const order = JSON.parse(raw);
    if (!isGraphOrder(order)) return { order: null, error: "The saved graph order is invalid. Original order is active." };
    return { order: normalizeGraphOrder(device, order), error: "" };
  } catch { return { order: null, error: "The saved graph order could not be read. Original order is active." }; }
}

export function saveDeviceGraphOrder(scope, runId, device, order) {
  try {
    if (!scope || !identifier(runId) || !identifier(device?.id) || !isGraphOrder(order)) throw new Error();
    const serialized = JSON.stringify(normalizeGraphOrder(device, order));
    if (serialized.length > MAX_CACHE_LENGTH) throw new Error();
    globalThis.localStorage.setItem(orderKey(scope, runId, device.id), serialized);
    return "";
  } catch { return "This graph order applies in this tab but could not be saved locally."; }
}

export function resetDeviceGraphOrder(scope, runId, deviceId) {
  try {
    if (scope && identifier(runId) && identifier(deviceId)) globalThis.localStorage.removeItem(orderKey(scope, runId, deviceId));
    return "";
  } catch { return "Original order is active, but the saved graph order could not be cleared from this browser."; }
}

export function readTestGraphOrders(scope, runs, overrides = {}) {
  const orders = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!identifier(run?.id)) continue;
    const runOverrides = object(overrides) && Object.hasOwn(overrides, run.id) ? overrides[run.id] : null;
    const deviceOrders = [];
    for (const device of Array.isArray(run.devices) ? run.devices : []) {
      if (!identifier(device?.id)) continue;
      const order = object(runOverrides) && Object.hasOwn(runOverrides, device.id)
        ? runOverrides[device.id] : readDeviceGraphOrder(scope, run.id, device).order;
      // Explicit null overrides a cached preference after a reset, including
      // when localStorage is blocked and the old cache cannot be removed.
      if (isGraphOrder(order)) deviceOrders.push([device.id, normalizeGraphOrder(device, order)]);
    }
    if (deviceOrders.length) orders.push([run.id, Object.fromEntries(deviceOrders)]);
  }
  return Object.fromEntries(orders);
}

export function inheritTestGraphOrders(url, { inspector, project, revisions, testRuns }) {
  if (project?.status !== "draft" || !testRuns?.length
    || !revisions?.some(item => item.revision === project.revision - 1)) return;
  const scope = testGraphOrderScope(url, inspector?.id, project.walkdownId, project.revision);
  if (!scope) return;
  const previous = testGraphOrderScope(url, inspector.id, project.walkdownId, project.revision - 1);
  try {
    const storage = globalThis.localStorage;
    const inherited = `${scope}inherited`;
    if (storage.getItem(inherited) !== null) return;
    for (const [runId, devices] of Object.entries(readTestGraphOrders(previous, testRuns))) {
      for (const [deviceId, order] of Object.entries(devices)) {
        const key = orderKey(scope, runId, deviceId);
        if (storage.getItem(key) === null) storage.setItem(key, JSON.stringify(order));
      }
    }
    storage.setItem(inherited, "1");
  } catch { /* Browser storage may be unavailable. */ }
}
