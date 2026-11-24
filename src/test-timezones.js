export const UNKNOWN_TIME_ZONE = "Source clock (timezone not recorded)";

function formatOffset(minutes) {
  if (!Number.isSafeInteger(minutes) || minutes < -12 * 60 || minutes > 14 * 60) return "";
  const absolute = Math.abs(minutes);
  return `UTC${minutes < 0 ? "-" : "+"}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

const OFFSET_OPTIONS = [
  ...Array.from({ length: 27 }, (_, index) => (index - 12) * 60),
  -570, -210, -150, 210, 270, 330, 345, 390, 525, 570, 630, 765, 825,
].sort((left, right) => left - right).map(formatOffset);

function offsetMinutes(value) {
  const match = /^UTC([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[3]) > 59) return null;
  const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "-" ? -1 : 1);
  return formatOffset(minutes) ? minutes : null;
}

/** Capture the computer's current UTC offset without changing recorded timestamps. */
export function getLocalTimeZone(date) {
  try {
    const offset = (date === undefined ? new Date() : date).getTimezoneOffset();
    // Date reports UTC minus local time; displayed UTC offsets use the opposite sign.
    return Number.isSafeInteger(offset) ? formatOffset(-offset) : "";
  } catch { return ""; }
}

/** These values describe the source clock; selecting one never converts timestamps. */
export function getTimeZoneOptions(selectedTimeZone, localTimeZone) {
  const options = new Set(OFFSET_OPTIONS);
  if (typeof localTimeZone === "string" && offsetMinutes(localTimeZone) !== null) options.add(localTimeZone);
  // Retain only this report's legacy value. Converting a saved zone using today's
  // offset could mislabel a historical run recorded on the other side of DST.
  if (typeof selectedTimeZone === "string" && selectedTimeZone.length) options.add(selectedTimeZone);
  return [...options].sort((left, right) => {
    const a = offsetMinutes(left), b = offsetMinutes(right);
    return a === null ? b === null ? 0 : 1 : b === null ? -1 : a - b;
  });
}
