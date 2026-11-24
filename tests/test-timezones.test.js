import test from "node:test";
import assert from "node:assert/strict";
import { getLocalTimeZone, getTimeZoneOptions, UNKNOWN_TIME_ZONE } from "../src/test-timezones.js";

test("the local timezone comes from the computer's formatter and keeps its identifier", () => {
  const intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "Asia/Ho_Chi_Minh" }) }) };
  assert.equal(getLocalTimeZone(intl), "Asia/Ho_Chi_Minh");
  assert.equal(getLocalTimeZone(), Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("unavailable or invalid timezone detection stays unknown instead of guessing UTC", () => {
  for (const intl of [null, {}, { DateTimeFormat() { throw new Error("Unavailable"); } },
    { DateTimeFormat: () => ({}) }]) assert.equal(getLocalTimeZone(intl), "");
  for (const timeZone of [undefined, null, 42, "", "   ", " Europe/Paris ", "Europe/Paris\n", "x".repeat(121)]) {
    const intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }) };
    assert.equal(getLocalTimeZone(intl), "");
  }
});

test("the dropdown includes runtime zones, UTC, unknown, local aliases, and saved labels exactly once", () => {
  const keys = [];
  const intl = { supportedValuesOf(key) {
    keys.push(key);
    return ["Europe/Paris", "America/Chicago", "Asia/Saigon", "Europe/Paris", "UTC", null, "", 7];
  } };
  const saved = "America/Chicago (Central Time)";
  const local = "Asia/Ho_Chi_Minh";
  const options = getTimeZoneOptions(saved, local, intl);
  assert.deepEqual(keys, ["timeZone"]);
  assert.deepEqual(options, ["America/Chicago", saved, local, "Asia/Saigon", "Europe/Paris", UNKNOWN_TIME_ZONE, "UTC"]);
  assert.equal(options.length, new Set(options).size);
  assert.equal(options.filter(zone => zone === saved).length, 1);
  assert.equal(options.filter(zone => zone === "UTC").length, 1);
});

test("browsers without timezone enumeration retain a comprehensive manual selection", () => {
  const unavailable = [null, {}, { supportedValuesOf() { throw new RangeError("Unsupported key"); } },
    { supportedValuesOf: () => [] }, { supportedValuesOf: () => [undefined, null, "", 4] },
    { supportedValuesOf: () => "Europe/Paris" }];
  for (const intl of unavailable) {
    const options = getTimeZoneOptions("Plant local clock", "Asia/Ho_Chi_Minh", intl);
    assert.ok(options.length > 300, "fallback must cover world timezones, not just this computer and UTC");
    for (const zone of ["Africa/Johannesburg", "America/Chicago", "Asia/Tokyo", "Australia/Sydney",
      "Europe/Paris", "Pacific/Auckland", "UTC", UNKNOWN_TIME_ZONE, "Plant local clock", "Asia/Ho_Chi_Minh"]) {
      assert.ok(options.includes(zone), `${zone} remains selectable`);
    }
    assert.equal(new Set(options).size, options.length);
    assert.deepEqual(options, [...options].sort((left, right) => left.localeCompare(right, "en")));
  }
});

test("saved source-clock labels are not trimmed, replaced, or interpreted as timezones", () => {
  const saved = "  Test bench source clock (unspecified)  ";
  const options = getTimeZoneOptions(saved, "UTC", { supportedValuesOf: () => ["UTC"] });
  assert.ok(options.includes(saved));
  assert.equal(options.includes(saved.trim()), false);
  assert.equal(getTimeZoneOptions(undefined, "", { supportedValuesOf: () => ["UTC"] }).includes(""), false);
});
