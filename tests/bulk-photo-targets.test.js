import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspectionTargets } from "../src/domain.js";
import {
  findBulkTargets,
  resolveBulkTarget,
  suggestBulkTargets,
  getBulkSuggestion,
} from "../src/bulk-photo-targets.js";

const schedule = JSON.parse(
  readFileSync(new URL("../src/data/schedule.json", import.meta.url), "utf8"),
);
const targets = inspectionTargets(schedule);
const suggestions = (text) => suggestBulkTargets(text, targets);
const keys = (text) => suggestions(text).map((match) => match.target.key);
const chosen = (text) => getBulkSuggestion(suggestions(text))?.key ?? null;

test("bulk manual entry resolves all canonical targets and explicit terminal shortcuts", () => {
  for (const target of targets) {
    assert.equal(resolveBulkTarget(target.name, targets), target);
    assert.equal(
      resolveBulkTarget(target.name.toLowerCase().replaceAll("-", "–"), targets),
      target,
    );
    assert.equal(findBulkTargets(target.name, targets)[0], target);
  }
  assert.equal(resolveBulkTarget(" b ", targets)?.key, "terminal:B");
  assert.equal(resolveBulkTarget("terminal-b", targets)?.key, "terminal:B");
  assert.equal(resolveBulkTarget("v 3541", targets)?.key, "device:V-3541");
  assert.equal(resolveBulkTarget("controlbox", targets)?.key, "equipment:control-box");
});

test("bulk search offers partial and legacy names without silently accepting them", () => {
  assert.equal(findBulkTargets("", targets).length, 39);
  assert.equal(findBulkTargets("v3541", targets)[0].key, "device:V-3541");
  assert.deepEqual(
    findBulkTargets("OV-3541F", targets).map((target) => target.key),
    ["device:V-3541"],
  );
  assert.deepEqual(
    findBulkTargets("3571#2", targets).map((target) => target.key),
    ["device:V-3571#2"],
  );
  assert.equal(findBulkTargets("term", targets).length, 8);
  assert.equal(findBulkTargets("transducer", targets)[0].key, "equipment:transducer-panel");
  for (const query of ["", "3541", "V-3571", "OV-3541F", "V-35I1", "control", "UNKNOWN-9999"]) {
    assert.equal(resolveBulkTarget(query, targets), null, query);
  }
  assert.equal(resolveBulkTarget("A", [
    { kind: "terminal", id: "A", name: "Terminal A" },
    { kind: "equipment", id: "a", name: "A" },
  ]), null, "ambiguous aliases cannot choose by catalog order");
});

test("every complete label provides its own exact suggestion without changing identity", () => {
  for (const target of targets) {
    const found = suggestions(target.name);
    assert.equal(found.length, 1, target.name);
    assert.equal(found[0].target, target);
    assert.equal(found[0].confidence, "exact");
    assert.equal(getBulkSuggestion(found), target);
  }
  assert.deepEqual(keys("*V-3541*"), ["device:V-3541"]);
  assert.deepEqual(keys("V–3541–Y"), ["device:V-3541-Y"]);
  assert.deepEqual(keys("PD-3500 # 2"), ["device:PD-3500#2"]);
  assert.deepEqual(keys("DP-3500 # 2"), ["device:DP-3500#2"]);
  assert.deepEqual(keys("TH 3541"), ["device:TH-3541"]);
});

test("plausible OCR corrections remain review suggestions, with original label text", () => {
  for (const [text, key] of [
    ["V-35I1", "device:V-3511"],
    ["V-35O1", "device:V-3501"],
    ["OV-3541F", "device:V-3541"],
    ["TH-3S41", "device:TH-3541"],
    ["V-3S41-Y", "device:V-3541-Y"],
    ["PD-3SOO#2", "device:PD-3500#2"],
  ]) {
    const found = suggestions(text);
    assert.equal(found.length, 1, text);
    assert.equal(found[0].target.key, key);
    assert.equal(found[0].confidence, "possible");
    assert.equal(found[0].matchedText, text);
    assert.equal(chosen(text), key);
  }
});

test("multiple labels and incomplete numbered families never pick a tied candidate", () => {
  for (const text of [
    "V-3541\nTH-3541",
    "Terminal B V-3541",
    "Control Box and Solenoid Box",
    "V-3571",
    "V-3S71",
    "PD-3500",
    "DP-3500",
    "V-35I1 V-35O1",
  ]) {
    assert.ok(suggestions(text).length > 1, text);
    assert.equal(chosen(text), null, text);
  }
  assert.deepEqual(keys("V-3571"), ["device:V-3571#1", "device:V-3571#2"]);
  assert.equal(chosen("V-3541 V-3S11"), "device:V-3541", "exact evidence outranks a correction");
  assert.equal(chosen("V-3541 V-3541 *V-3541#"), "device:V-3541", "repeated same label is deduplicated");
  const ranked = suggestions("V-3S41 V-35I1 TH-3541");
  assert.deepEqual(ranked.map((match) => match.confidence), ["exact", "possible", "possible"]);
  assert.equal(getBulkSuggestion([...ranked].reverse())?.key, "device:TH-3541");
});

test("terminal and equipment OCR requires explicit bounded labels", () => {
  assert.equal(chosen("Layout TERMINAL–B inspected"), "terminal:B");
  assert.equal(chosen("TERMINAL BLOCK H"), "terminal:H");
  assert.equal(chosen("CONTROL\nBOX"), "equipment:control-box");
  assert.equal(chosen("solenoid-box"), "equipment:solenoid-box");
  for (const text of ["A", "B C D", "AB", "TERMINAL AB", "TERMINAL B1", "TERMINAL 8", "UNCONTROL BOX", "CONTROL BOXES", "TRANSDUCER", "CABLE 21"]) {
    assert.deepEqual(keys(text), [], text);
  }
});

test("unknown digits, suffixes and unrelated text cannot be shortened into a target", () => {
  for (const text of [
    "V-3542", "V-35411", "V-3S411", "V-3541#4", "V-3S41#4",
    "V-3541-Z", "V-3S41-Z", "V-3541-Y1", "V-3S41-Y1",
    "V-3571#11", "PD-3S00#11", "PD-3500#4", "V-3511–#1",
    "V-3S11–#1", "UNKNOWN-3541", "PANEL 450K CABLE 29", "V-9999",
    "V-3B41", "V-35S11", "TH-3S4111", "V-35S1-Z",
  ]) {
    assert.deepEqual(keys(text), [], text);
  }
  assert.deepEqual(suggestions(null), []);
  assert.equal(getBulkSuggestion([]), null);
});
