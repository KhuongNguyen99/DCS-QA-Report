import { FALLBACK_TIME_ZONES } from "./test-timezones-fallback.js";

export const UNKNOWN_TIME_ZONE = "Source clock (timezone not recorded)";

const usableRuntimeZone = value => typeof value === "string" && value.length > 0 && value.length <= 120
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);

/** Read this computer's timezone without guessing from its locale or UTC offset. */
export function getLocalTimeZone(intl = globalThis.Intl) {
  try {
    const zone = intl.DateTimeFormat().resolvedOptions().timeZone;
    return usableRuntimeZone(zone) ? zone : "";
  } catch {
    return "";
  }
}

/** These values describe the source clock; selecting one never converts timestamps. */
export function getTimeZoneOptions(selectedTimeZone, localTimeZone, intl = globalThis.Intl) {
  let zones = FALLBACK_TIME_ZONES;
  try {
    const supported = intl?.supportedValuesOf?.("timeZone");
    const usable = Array.isArray(supported) ? supported.filter(usableRuntimeZone) : [];
    if (usable.length) zones = usable;
  } catch {
    // Older browsers can still choose from the bundled named-timezone list.
  }
  const options = new Set([...zones, UNKNOWN_TIME_ZONE, "UTC"]);
  // Enumeration can omit accepted aliases and older reports' descriptive labels.
  // Preserve those exact values so a select never silently displays a different one.
  for (const zone of [selectedTimeZone, localTimeZone]) {
    if (typeof zone === "string" && zone.length) options.add(zone);
  }
  return [...options].sort((left, right) => left.localeCompare(right, "en"));
}
