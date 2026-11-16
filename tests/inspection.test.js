import test from "node:test";
import assert from "node:assert/strict";
import {
  recordStatus,
  terminalProgress,
  inspectionProgress,
} from "../src/inspection.js";

const devices = [
  { id: "V-3541", terminal: "B" },
  { id: "TH-3511", terminal: "B" },
];
const blank = () => ({ records: [], photos: [], comments: [] });
test("completion requires evidence, not just a flag", () => {
  const state = blank();
  state.records.push({ key: "device:V-3541", complete: true });
  assert.equal(recordStatus("device:V-3541", state), "not-started");
  state.photos.push({ recordKey: "device:V-3541" });
  assert.equal(recordStatus("device:V-3541", state), "complete");
});
test("notes or photos are in progress until manually completed", () => {
  const state = blank();
  state.comments.push({ recordKey: "device:V-3541", text: "Check this" });
  assert.equal(recordStatus("device:V-3541", state), "in-progress");
});
test("terminal goes green only with all devices and its own evidence reviewed", () => {
  const state = blank();
  for (const key of ["device:V-3541", "device:TH-3511", "terminal:B"]) {
    state.records.push({ key, complete: true });
    state.photos.push({ recordKey: key });
  }
  assert.equal(terminalProgress("B", devices, state).done, true);
  state.records[0].complete = false;
  assert.equal(terminalProgress("B", devices, state).done, false);
  assert.deepEqual(inspectionProgress(devices, [{ id: "B" }], state), {
    devices: 1,
    terminals: 0,
    photos: 3,
  });
});
