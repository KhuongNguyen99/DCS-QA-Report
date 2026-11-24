import test from "node:test";
import assert from "node:assert/strict";
import { getLocalTimeZone, getTimeZoneOptions, UNKNOWN_TIME_ZONE } from "../src/test-timezones.js";

test("the local UTC offset reverses Date's sign and preserves half and quarter hours", () => {
  for (const [minutes, expected] of [
    [360, "UTC-06:00"], [-420, "UTC+07:00"], [210, "UTC-03:30"], [570, "UTC-09:30"],
    [-330, "UTC+05:30"], [-345, "UTC+05:45"], [-765, "UTC+12:45"], [0, "UTC+00:00"],
    [720, "UTC-12:00"], [-840, "UTC+14:00"],
  ]) assert.equal(getLocalTimeZone({ getTimezoneOffset: () => minutes }), expected);
  assert.equal(getLocalTimeZone(), getLocalTimeZone(new Date()));
});

test("unavailable or invalid computer offsets stay unknown instead of defaulting to UTC", () => {
  for (const date of [null, {}, new Date("invalid"), { getTimezoneOffset() { throw new Error("Unavailable"); } }]) {
    assert.equal(getLocalTimeZone(date), "");
  }
  for (const minutes of [undefined, null, "-330", NaN, Infinity, 1.5, 721, -841]) {
    assert.equal(getLocalTimeZone({ getTimezoneOffset: () => minutes }), "");
  }
});

test("the normal dropdown has 40 numeric UTC offsets covering whole hours and practical fractions", () => {
  const options = getTimeZoneOptions("UTC+05:45", "UTC-06:00");
  assert.equal(options.length, 40);
  assert.equal(new Set(options).size, 40);
  assert.equal(options[0], "UTC-12:00");
  assert.equal(options.at(-1), "UTC+14:00");
  for (const fraction of ["UTC-09:30", "UTC-03:30", "UTC-02:30", "UTC+03:30", "UTC+04:30", "UTC+05:30",
    "UTC+05:45", "UTC+06:30", "UTC+08:45", "UTC+09:30", "UTC+10:30", "UTC+12:45", "UTC+13:45"]) {
    assert.ok(options.includes(fraction), `${fraction} remains selectable`);
  }
  const minutes = options.map(value => {
    const [, sign, hours, minutes] = /^UTC([+-])(\d{2}):(\d{2})$/.exec(value);
    return (Number(hours) * 60 + Number(minutes)) * (sign === "-" ? -1 : 1);
  });
  assert.deepEqual(minutes, [...minutes].sort((left, right) => left - right));
  for (let hour = -12; hour <= 14; hour++) assert.ok(minutes.includes(hour * 60));
});

test("only the current saved legacy timezone is retained, exactly, alongside the offset choices", () => {
  for (const saved of ["America/Chicago", "UTC", UNKNOWN_TIME_ZONE, "  Test bench source clock (unspecified)  "]) {
    const options = getTimeZoneOptions(saved, "UTC+07:00");
    assert.equal(options.length, 41);
    assert.equal(options.at(-1), saved);
    assert.equal(options.filter(value => value === saved).length, 1);
    if (saved !== saved.trim()) assert.equal(options.includes(saved.trim()), false);
  }
  assert.equal(getTimeZoneOptions(undefined, "").length, 40);
  assert.equal(getTimeZoneOptions(undefined, "America/Chicago").includes("America/Chicago"), false);
});

test("an uncommon computer offset remains selectable in numeric order", () => {
  const local = getLocalTimeZone({ getTimezoneOffset: () => -45 });
  const options = getTimeZoneOptions(local, local);
  assert.equal(options.length, 41);
  const index = options.indexOf("UTC+00:45");
  assert.deepEqual(options.slice(index - 1, index + 2), ["UTC+00:00", "UTC+00:45", "UTC+01:00"]);
});
