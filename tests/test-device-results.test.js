import test from "node:test";
import assert from "node:assert/strict";
import { isManualTestStatus, hasManualTestStatus, getDeviceTestStatus,
  assertManualTestStatuses, validManualStatuses } from "../src/test-device-results.js";

test("manual device results take precedence without changing recorded wiring evidence", () => {
  const recorded = { id: "PD-3500", status: "Failed", channels: [{ status: "Failed", rawStatus: "Error" }] };
  const before = structuredClone(recorded);
  assert.equal(getDeviceTestStatus(recorded), "Failed");
  assert.equal(hasManualTestStatus(recorded), false);
  for (const manualStatus of ["Passed", "Failed"]) {
    const assessed = { ...recorded, manualStatus };
    assert.equal(isManualTestStatus(manualStatus), true);
    assert.equal(hasManualTestStatus(assessed), true);
    assert.equal(getDeviceTestStatus(assessed), manualStatus);
    const devices = [assessed];
    assert.equal(assertManualTestStatuses(devices), devices);
    assert.deepEqual(assessed.channels, before.channels);
    assert.equal(assessed.status, before.status);
    delete assessed.manualStatus;
    assert.equal(getDeviceTestStatus(assessed), "Failed", "reset restores the original result");
  }
  assert.deepEqual(recorded, before);
  for (const status of ["Passed", "Failed", "Not tested"]) assert.equal(getDeviceTestStatus({ status }), status);
  assert.equal(getDeviceTestStatus(), "Not tested");
  assert.equal(getDeviceTestStatus({ status: "unrecognized" }), "Not tested");
  const inherited = Object.create({ manualStatus: "Passed" }); inherited.status = "Failed";
  assert.equal(hasManualTestStatus(inherited), false);
  assert.equal(getDeviceTestStatus(inherited), "Failed");
});

test("persisted manual results reject malformed values while legacy devices remain valid", () => {
  assert.deepEqual(assertManualTestStatuses([]), []);
  assert.deepEqual(assertManualTestStatuses([{ id: "sensor", status: "Not tested" }]), [{ id: "sensor", status: "Not tested" }]);
  for (const manualStatus of [undefined, null, "", "Not tested", "passed", "Failed ", true, 1, [], {}, { status: "Passed" }]) {
    assert.equal(isManualTestStatus(manualStatus), false);
    assert.throws(() => assertManualTestStatuses([{ id: "sensor", manualStatus }]), /manual device result.*Passed or Failed/);
  }
  for (const invalid of [undefined, null, {}, "devices"]) assert.throws(() => assertManualTestStatuses(invalid), /device list/);
});

test("manual-result drafts bound device IDs and count and distinguish a pending reset from omission", () => {
  for (const value of [{}, { valve: "Passed", sensor: "Failed", cleared: null }, { ["😀".repeat(160)]: "Passed" },
    Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`d${index}`, index % 2 ? "Passed" : null]))])
    assert.equal(validManualStatuses(value), true);
  for (const value of [null, undefined, [], "Passed", new Date(), { "": "Passed" }, { " ": "Passed" },
    { "bad\nidentifier": "Passed" }, { ["😀".repeat(161)]: "Passed" }, { valve: undefined }, { valve: "Not tested" },
    { valve: "passed" }, { valve: false }, { valve: { status: "Passed" } },
    Object.fromEntries(Array.from({ length: 251 }, (_, index) => [`d${index}`, "Passed"]))])
    assert.equal(validManualStatuses(value), false);
});
