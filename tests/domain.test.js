import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  groupDevices,
  matchDeviceLabels,
  recordKey,
  findManualDevices,
  inspectionTargets,
} from "../src/domain.js";

const schedule = JSON.parse(
  readFileSync(new URL("../src/data/schedule.json", import.meta.url), "utf8"),
);
const devices = schedule.devices;
const ids = (text, terminal = null) =>
  matchDeviceLabels(text, devices, terminal).map((match) => match.deviceId);

test("inspection catalog adds three equipment items without changing field-device identity", () => {
  const targets = inspectionTargets(schedule);
  assert.equal(targets.length, 39);
  assert.equal(new Set(targets.map((target) => target.key)).size, 39);
  assert.deepEqual(targets.filter((target) => target.kind === "equipment").map(
    ({ key, name, terminal, cables }) => ({ key, name, terminal, cables }),
  ), [
    { key: "equipment:control-box", name: "Control Box", terminal: null, cables: [] },
    { key: "equipment:solenoid-box", name: "Solenoid Box", terminal: null, cables: [] },
    { key: "equipment:transducer-panel", name: "Transducer Panel", terminal: null, cables: [] },
  ]);
  assert.equal(targets.filter((target) => target.kind === "device").length, 28);
  assert.equal(targets.filter((target) => target.kind === "terminal").length, 8);
  assert.deepEqual(findManualDevices("control box", devices), []);
  assert.equal(recordKey("equipment", "control-box"), "equipment:control-box");
});

test("manual device search accepts partial or old labels and keeps scheduled identities", () => {
  const found = (query) =>
    findManualDevices(query, devices).map((device) => device.id);
  assert.equal(findManualDevices("", devices).length, 28);
  assert.deepEqual(found("v3541").sort(), ["V-3541", "V-3541-Y"]);
  assert.deepEqual(found("OV-3541F"), ["V-3541"]);
  assert.deepEqual(found("V–3511-Y"), ["V-3511-Y"]);
  assert.deepEqual(found("3571#2"), ["V-3571#2"]);
  assert.deepEqual(found("UNKNOWN-9999"), []);
  assert.deepEqual(found("V-35411"), []);
});

test("latest schedule has 28 devices from 30 cable rows and preserves updated cable numbers", () => {
  assert.equal(devices.length, 28);
  assert.equal(devices.flatMap((device) => device.cables).length, 30);
  assert.equal(new Set(devices.map((device) => device.id)).size, 28);
  assert.deepEqual(devices.find((device) => device.id === "V-3541").cables, [
    { type: "1-pair", number: 21 },
    { type: "2-pairs", number: 21 },
  ]);
  assert.deepEqual(devices.find((device) => device.id === "V-3511").cables, [
    { type: "1-pair", number: 22 },
    { type: "2-pairs", number: 22 },
  ]);
  assert.deepEqual(
    schedule.groups.map((group) => group.id),
    [..."ABCDEFGH"],
  );
  assert.ok(
    schedule.groups.every(
      (group) => group.hotspot.x > 0 && group.hotspot.y > 0,
    ),
  );
});

test("every canonical device name is a unique exact match", () => {
  for (const device of devices) {
    assert.deepEqual(
      matchDeviceLabels(device.name, devices),
      [{ deviceId: device.id, matchedText: device.name, confidence: "exact" }],
      device.name,
    );
  }
});

test("case, spacing, and hyphen variants stay exact; multiple lines yield separate matches", () => {
  assert.deepEqual(matchDeviceLabels("v 3541\nTH3541\npd 3500 # 2", devices), [
    { deviceId: "V-3541", matchedText: "v 3541", confidence: "exact" },
    { deviceId: "TH-3541", matchedText: "TH3541", confidence: "exact" },
    { deviceId: "PD-3500#2", matchedText: "pd 3500 # 2", confidence: "exact" },
  ]);
});

test("stray OCR characters and digit substitutions are possible matches", () => {
  assert.deepEqual(matchDeviceLabels("*V-3541#", devices), [
    { deviceId: "V-3541", matchedText: "V-3541#", confidence: "possible" },
  ]);
  assert.deepEqual(matchDeviceLabels("OV-3541F", devices), [
    { deviceId: "V-3541", matchedText: "OV-3541F", confidence: "possible" },
  ]);
  assert.deepEqual(
    matchDeviceLabels("*V-3541# OV-3541F V-35I1 V-35O1", devices),
    [
      { deviceId: "V-3541", matchedText: "V-3541#", confidence: "possible" },
      { deviceId: "V-3511", matchedText: "V-35I1", confidence: "possible" },
      { deviceId: "V-3501", matchedText: "V-35O1", confidence: "possible" },
    ],
  );
  assert.deepEqual(ids("0V-3541"), ["V-3541"]);
});

test("tags embedded in surrounding letters require review and keep suffix and prefix identity", () => {
  assert.deepEqual(matchDeviceLabels("XV-3541F", devices), [
    { deviceId: "V-3541", matchedText: "XV-3541F", confidence: "possible" },
  ]);
  assert.deepEqual(matchDeviceLabels("abcV-3541xyz", devices), [
    { deviceId: "V-3541", matchedText: "abcV-3541xyz", confidence: "possible" },
  ]);
  assert.deepEqual(matchDeviceLabels("abcV-3541xyz V-3541", devices), [
    { deviceId: "V-3541", matchedText: "V-3541", confidence: "exact" },
  ]);
  assert.deepEqual(matchDeviceLabels("V-3541", devices), [
    { deviceId: "V-3541", matchedText: "V-3541", confidence: "exact" },
  ]);
  assert.deepEqual(ids("abcV-3541-Yxyz"), ["V-3541-Y"]);
  assert.deepEqual(ids("abcV-3571#1xyz"), ["V-3571#1"]);
  assert.deepEqual(ids("abcPD-3500#2xyz"), ["PD-3500#2"]);
  assert.deepEqual(ids("abcDP-3500#2xyz"), ["DP-3500#2"]);
  assert.deepEqual(ids("abcTH-3541xyz"), ["TH-3541"]);
  assert.deepEqual(ids("abcV-35411xyz abcV-3541#11xyz"), []);
});

test("bare numbered family produces possible candidates but never a -Y device", () => {
  assert.deepEqual(ids("V-3571#1 V-3571#2"), ["V-3571#1", "V-3571#2"]);
  assert.deepEqual(matchDeviceLabels("V-3571", devices), [
    { deviceId: "V-3571#1", matchedText: "V-3571", confidence: "possible" },
    { deviceId: "V-3571#2", matchedText: "V-3571", confidence: "possible" },
  ]);
  assert.deepEqual(ids("PD-3500"), ["PD-3500#1", "PD-3500#2", "PD-3500#3"]);
  assert.deepEqual(ids("DP-3500"), ["DP-3500#1", "DP-3500#2", "DP-3500#3"]);
  assert.deepEqual(ids("V-3541-Y"), ["V-3541-Y"]);
  assert.deepEqual(ids("V-3541"), ["V-3541"]);
});

test("typographic dashes preserve Y identity and cannot expose a bare tag before an unknown suffix", () => {
  for (const dash of ["‐", "‑", "‒", "–", "—", "―", "−", "﹣", "－"]) {
    assert.deepEqual(
      ids(`V${dash}3511${dash}Y`),
      ["V-3511-Y"],
      `Y suffix via ${dash}`,
    );
    assert.deepEqual(
      ids(`V-3511${dash}Y`),
      ["V-3511-Y"],
      `bare valve blocked via ${dash}`,
    );
    assert.deepEqual(
      ids(`V-3511${dash}#1`),
      [],
      `unknown hash suffix via ${dash}`,
    );
    assert.deepEqual(
      ids(`V-3571${dash}#1`),
      [],
      `numbered family not bare via ${dash}`,
    );
  }
  assert.deepEqual(matchDeviceLabels("V-3511–Y", devices), [
    { deviceId: "V-3511-Y", matchedText: "V-3511–Y", confidence: "exact" },
  ]);
});

test("prefixes, extra digits, and unrelated label noise cannot become false matches", () => {
  assert.deepEqual(ids("TH-3541 V-35411 PD-3500#11 DP-3500#1"), [
    "TH-3541",
    "DP-3500#1",
  ]);
  assert.deepEqual(ids("PANEL 450K CABLE 29 TERMINAL B V-9999"), []);
  assert.deepEqual(matchDeviceLabels("XTH-3541", devices), [
    { deviceId: "TH-3541", matchedText: "XTH-3541", confidence: "possible" },
  ]);
  assert.deepEqual(ids("V-3541-Y1 V-3541-Z V-3541#4"), []);
  assert.deepEqual(ids("PD-3500#1"), ["PD-3500#1"]);
  assert.deepEqual(ids("DP-3500#1"), ["DP-3500#1"]);
});

test("terminal filtering and QA record keys use canonical identities", () => {
  assert.equal(groupDevices(devices, " b ").length, 5);
  assert.deepEqual(ids("V-3541\nV-3511", "B"), ["V-3541"]);
  assert.deepEqual(ids("V-3541\nV-3511", "C"), ["V-3511"]);
  assert.equal(recordKey("device", "V-3541"), "device:V-3541");
  assert.equal(recordKey("terminal", " b "), "terminal:B");
  assert.throws(() => recordKey("cable", "21"), RangeError);
});
