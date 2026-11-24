import { deviceGraphEntries } from "./test-graph-order.js";
import { formatTestValue } from "./test-chart.js";

const STYLES = new Set(["auto", "line", "step", "smooth"]);
const UNITS = { s: 1000, min: 60_000, h: 3_600_000 };
const OPERATORS = new Set([">", ">=", "<", "<="]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value === value.trim() && value.length >= 1
  && Array.from(value).length <= 160 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const timestamp = value => Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
const keys = (value, required, optional = []) => object(value)
  && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const own = (value, key) => Object.hasOwn(value, key);

function validEndpoint(value) {
  if (!object(value)) return false;
  if (value.kind === "time") return keys(value, ["kind", "timeMs"]) && timestamp(value.timeMs);
  if (value.kind === "point") return keys(value,
    ["kind", "deviceId", "graphKey", "pointIndex", "timeMs", "value"], ["sourceId", "sourceRow"])
    && text(value.deviceId) && text(value.graphKey)
    && Number.isSafeInteger(value.pointIndex) && value.pointIndex >= 0 && value.pointIndex < 10_000
    && timestamp(value.timeMs) && Number.isFinite(value.value)
    && (!own(value, "sourceId") || text(value.sourceId))
    && (!own(value, "sourceRow") || (Number.isSafeInteger(value.sourceRow) && value.sourceRow >= 1));
  if (value.kind === "trigger") return keys(value, ["kind", "deviceId", "graphKey", "operator", "threshold"])
    && text(value.deviceId) && text(value.graphKey) && OPERATORS.has(value.operator) && Number.isFinite(value.threshold);
  return false;
}

function validMeasurement(value) {
  return keys(value, ["id", "name", "unit", "start", "end"]) && text(value.id) && text(value.name)
    && typeof value.unit === "string" && own(UNITS, value.unit) && validEndpoint(value.start) && validEndpoint(value.end);
}

export const emptyGraphTools = () => ({ version: 1, deviceNames: [], graphs: [] });

export function validGraphTools(value) {
  if (!keys(value, ["version", "deviceNames", "graphs"]) || value.version !== 1
    || !Array.isArray(value.deviceNames) || value.deviceNames.length > 250
    || !Array.isArray(value.graphs) || value.graphs.length > 1000) return false;
  const devices = new Set(), graphs = new Set();
  let measurementCount = 0;
  for (const alias of value.deviceNames) {
    if (!keys(alias, ["deviceId", "name"]) || !text(alias.deviceId) || !text(alias.name) || devices.has(alias.deviceId)) return false;
    devices.add(alias.deviceId);
  }
  for (const graph of value.graphs) {
    if (!keys(graph, ["deviceId", "graphKey"], ["name", "style", "measurements"])
      || !text(graph.deviceId) || !text(graph.graphKey)
      || (own(graph, "name") && !text(graph.name)) || (own(graph, "style") && !STYLES.has(graph.style))) return false;
    const key = JSON.stringify([graph.deviceId, graph.graphKey]);
    if (graphs.has(key)) return false;
    graphs.add(key);
    if (!own(graph, "measurements")) continue;
    if (!Array.isArray(graph.measurements) || graph.measurements.length > 20) return false;
    measurementCount += graph.measurements.length;
    if (measurementCount > 500) return false;
    const ids = new Set();
    for (const measurement of graph.measurements) {
      if (!validMeasurement(measurement) || ids.has(measurement.id)) return false;
      ids.add(measurement.id);
    }
  }
  return true;
}

export function assertGraphTools(value) {
  if (!validGraphTools(value)) throw new Error("The graph names, styles, or duration calculations are invalid or exceed the supported limits.");
  return value;
}

export function getDeviceDisplayName(device, tools) {
  return tools?.deviceNames?.find(item => item.deviceId === device?.id)?.name || device?.name || "Unnamed device";
}

export function getGraphSettings(tools, deviceId, graphKey) {
  return tools?.graphs?.find(item => item.deviceId === deviceId && item.graphKey === graphKey)
    || { style: "auto", measurements: [] };
}

export function runGraphEntries(run, tools = run?.graphTools) {
  if (tools !== undefined) assertGraphTools(tools);
  const aliases = new Map((tools?.deviceNames || []).map(item => [item.deviceId, item.name]));
  const settings = new Map((tools?.graphs || []).map(item => [JSON.stringify([item.deviceId, item.graphKey]), item]));
  return (Array.isArray(run?.devices) ? run.devices : []).flatMap((device, deviceIndex) => deviceGraphEntries(device).map(entry => {
    const config = settings.get(JSON.stringify([device.id, entry.key])) || { style: "auto", measurements: [] };
    return { ...entry, device, deviceIndex, deviceId: device.id, graphKey: entry.key,
      deviceName: aliases.get(device.id) || device.name || "Unnamed device",
      name: config.name || entry.series.name || entry.channel.symbolicName || "Recorded signal", settings: config };
  }));
}

const validClock = clock => timestamp(clock?.startMs) && timestamp(clock?.endMs) && clock.startMs <= clock.endMs;
const inClock = (timeMs, clock) => timestamp(timeMs) && timeMs >= clock.startMs && timeMs <= clock.endMs;
const validObservation = (point, series) => object(point) && point.excluded !== true && point.valid !== false
  && timestamp(point.timeMs) && Number.isFinite(point.value)
  && (series.kind !== "digital" || point.value === 0 || point.value === 1);

function sourceEvents(series, clock) {
  if (!Array.isArray(series?.points)) throw new Error("The referenced graph has no original observation list.");
  let latest = -Infinity;
  const events = [];
  for (const [pointIndex, point] of series.points.entries()) {
    if (!object(point)) throw new Error("The referenced graph contains a malformed observation.");
    if (own(point, "excluded") && typeof point.excluded !== "boolean") throw new Error("A referenced event's removed flag must be true or false.");
    if (Number.isFinite(point.timeMs)) {
      if (!inClock(point.timeMs, clock)) throw new Error("A referenced observation falls outside the test run or has an invalid timestamp.");
      if (point.timeMs < latest) throw new Error("The referenced observations must be ordered by time.");
      latest = point.timeMs;
    }
    if (validObservation(point, series)) events.push({ point, pointIndex });
  }
  return events;
}

function findGraph(entries, deviceId, graphKey) {
  const matches = entries.filter(entry => entry.deviceId === deviceId && entry.graphKey === graphKey);
  return matches.length === 1 ? matches[0] : null;
}

export function createPointEndpoint(run, deviceId, graphKey, pointIndex) {
  if (!validClock(run?.clock)) throw new Error("A valid test-run time span is required to select a graph point.");
  const entry = findGraph(runGraphEntries(run), deviceId, graphKey);
  if (!entry) throw new Error("The selected graph is no longer available in this test run.");
  const event = sourceEvents(entry.series, run.clock).find(item => item.pointIndex === pointIndex);
  if (!event) throw new Error("Choose an original valid graph point that has not been removed.");
  const { point } = event;
  const endpoint = { kind: "point", deviceId, graphKey, pointIndex, timeMs: point.timeMs, value: point.value };
  if (point.sourceId != null) endpoint.sourceId = point.sourceId;
  if (point.sourceRow != null) endpoint.sourceRow = point.sourceRow;
  if (!validEndpoint(endpoint)) throw new Error("The selected point's source reference is invalid.");
  return endpoint;
}

export function formatSourceTimeInput(timeMs) {
  return timestamp(timeMs) ? new Date(timeMs).toISOString().replace(/Z$/, "") : "";
}

export function parseSourceTimeInput(value, clock) {
  if (!validClock(clock)) throw new Error("A valid test-run time span is required for a manual time.");
  const match = typeof value === "string" && /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value.trim());
  if (!match) throw new Error("Enter a full source date and time, including the year, month, day, hour, and minute.");
  const [, year, month, day, hour, minute, second = "0", fraction = ""] = match;
  const parts = [year, month, day, hour, minute, second, fraction.padEnd(3, "0")].map(Number);
  const date = new Date(0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  date.setUTCHours(parts[3], parts[4], parts[5], parts[6]);
  const timeMs = date.getTime();
  const actual = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()];
  if (!timestamp(timeMs) || parts.some((part, index) => part !== actual[index])) throw new Error("Enter a valid source date and time.");
  if (!inClock(timeMs, clock)) throw new Error("The selected source time must be within this test run.");
  return timeMs;
}

const compare = (value, operator, threshold) => operator === ">" ? value > threshold
  : operator === ">=" ? value >= threshold : operator === "<" ? value < threshold : value <= threshold;

export function resolveGraphMeasurement(run, measurement, tools = run?.graphTools) {
  const base = { status: "invalid", reason: "The duration calculation is invalid.", start: null, end: null,
    durationMs: null, value: null, unit: typeof measurement?.unit === "string" && own(UNITS, measurement.unit) ? measurement.unit : "s" };
  if (!validMeasurement(measurement)) return base;
  if (!validClock(run?.clock)) return { ...base, reason: "This test run has no valid time span for a duration calculation." };
  let entries;
  try { entries = runGraphEntries(run, tools); }
  catch (error) { return { ...base, reason: error.message }; }
  const eventCache = new Map();
  function resolve(endpoint, lowerBound = null, needsStart = false) {
    const result = { ...endpoint, status: "unresolved", reason: "", timeMs: null, detail: "" };
    if (endpoint.kind === "time") return inClock(endpoint.timeMs, run.clock)
      ? { ...result, status: "resolved", timeMs: endpoint.timeMs, detail: "Manual source time" }
      : { ...result, status: "invalid", reason: "The manual source time is outside this test run.", detail: "Manual source time" };
    const entry = findGraph(entries, endpoint.deviceId, endpoint.graphKey);
    if (!entry) return { ...result, reason: "The referenced graph is no longer available in this test run.",
      detail: endpoint.kind === "point" ? "Selected graph point" : `Graph trigger: value ${endpoint.operator} ${String(endpoint.threshold)}; referenced graph unavailable` };
    const label = entry.deviceName === entry.name ? entry.name : `${entry.deviceName} / ${entry.name}`;
    const unit = entry.series.unit ? ` ${entry.series.unit}` : "";
    result.sourceGraphName = entry.series.name || entry.channel.symbolicName || "Recorded signal";
    result.sourceDeviceName = entry.device.name || "Unnamed device";
    result.detail = endpoint.kind === "point" ? `Selected point on ${label}`
      : `First recorded ${label} value ${endpoint.operator} ${String(endpoint.threshold)}${unit}${needsStart ? " at or after the start" : ""}`;
    let events;
    try {
      if (!eventCache.has(entry.series)) eventCache.set(entry.series, sourceEvents(entry.series, run.clock));
      events = eventCache.get(entry.series);
    } catch (error) { return { ...result, status: "invalid", reason: error.message }; }
    let event;
    if (endpoint.kind === "point") {
      const point = entry.series.points[endpoint.pointIndex];
      if (!point || point.timeMs !== endpoint.timeMs || point.value !== endpoint.value
        || (own(endpoint, "sourceId") && point.sourceId !== endpoint.sourceId)
        || (own(endpoint, "sourceRow") && point.sourceRow !== endpoint.sourceRow))
        return { ...result, reason: "The selected point no longer matches its original source observation. Select it again." };
      event = events.find(item => item.pointIndex === endpoint.pointIndex);
      if (!event) return { ...result, reason: "The selected point is removed or no longer a valid observation." };
    } else {
      if (needsStart && lowerBound === null) return { ...result, reason: "Resolve the start time before finding an end trigger." };
      event = events.find(({ point }) => (lowerBound === null || point.timeMs >= lowerBound)
        && compare(point.value, endpoint.operator, endpoint.threshold));
      if (!event) return { ...result, reason: needsStart
        ? "No retained valid observation matches the trigger at or after the start."
        : "No retained valid observation matches the trigger." };
    }
    const { point, pointIndex } = event;
    return { ...result, status: "resolved", timeMs: point.timeMs, pointIndex, value: point.value,
      sourceId: point.sourceId, sourceRow: point.sourceRow, graphName: entry.name, deviceName: entry.deviceName, sourceUnit: entry.series.unit || "",
      detail: `${result.detail}; recorded ${formatTestValue(point.value)}${unit}${point.sourceRow != null ? `, source row ${point.sourceRow}` : ""}` };
  }
  const start = resolve(measurement.start);
  const end = resolve(measurement.end, start.status === "resolved" ? start.timeMs : null, measurement.end.kind === "trigger");
  if (start.status !== "resolved" || end.status !== "resolved") return { ...base, start, end,
    status: start.status === "invalid" || end.status === "invalid" ? "invalid" : "unresolved",
    reason: start.status === "invalid" ? `Start: ${start.reason}` : end.status === "invalid" ? `End: ${end.reason}`
      : start.status !== "resolved" ? `Start: ${start.reason}` : `End: ${end.reason}` };
  const durationMs = end.timeMs - start.timeMs;
  if (durationMs < 0) return { ...base, start, end, reason: "The end time must be at or after the start time." };
  if (!Number.isSafeInteger(durationMs)) return { ...base, start, end, reason: "The duration exceeds the supported whole-millisecond range." };
  return { ...base, status: "resolved", reason: "", start, end, durationMs, value: durationMs / UNITS[measurement.unit] };
}
