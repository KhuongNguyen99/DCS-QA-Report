import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { testCommentDraftScope, testCommentDraftKey } from "../src/test-comment-drafts.js";
import { testTimeRangeScope, readTestTimeRanges, inheritTestTimeRanges, resetDeviceTimeRange } from "../src/test-time-ranges.js";
import { testGraphOrderScope, deviceGraphEntries } from "../src/test-graph-order.js";

let directory;
let bundle;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "qc-test-reports-panel-"));
  const output = join(directory, "panel.js");
  await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "jsx",
      contents: `
        import React, { useCallback, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import TestReportsPanel from './src/TestReportsPanel.jsx';
        function Harness() {
          const [props, setProps] = useState(window.initialProps);
          window.configure = changes => setProps(previous => ({ ...previous, ...changes }));
          const dirty = useCallback(value => window.dirty.push(value), []);
          const save = useCallback((payload, revision) => new Promise((resolve, reject) => {
            window.calls.push({ kind: 'save', payload, revision, resolve, reject });
          }).then(value => {
            const saved = { ...payload, createdBy: 'inspector-1', runVersion: (payload.runVersion || 0) + 1, ...value };
            setProps(previous => ({ ...previous, runs: [...previous.runs.filter(run => run.id !== saved.id), saved] }));
            return saved;
          }), []);
          const remove = useCallback((run, revision) => new Promise((resolve, reject) => {
            window.calls.push({ kind: 'delete', run, revision, resolve, reject });
          }).then(() => setProps(previous => ({ ...previous, runs: previous.runs.filter(item => item.id !== run.id) }))), []);
          return <TestReportsPanel {...props} onSave={save} onDelete={remove}
            onExport={id => window.exports.push(id)} onReview={() => window.reviews.push(true)} onDirtyChange={dirty}
            onGraphOrderChange={(scope, runId, deviceId, order) => window.graphOrders.push({ scope, runId, deviceId, order })} />;
        }
        window.act = React.act;
        window.root = createRoot(document.getElementById('root'));
        window.mount = () => window.root.render(<React.StrictMode><Harness /></React.StrictMode>);
      `,
    },
    bundle: true, format: "iife", outfile: output, define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "test-parser-boundary", setup(builder) {
      builder.onResolve({ filter: /[\\/]proneta-parser\.js$/ }, () => ({ path: "parser", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
        contents: `export const parsePronetaFiles = (files, options) => new Promise((resolve, reject) => window.parses.push({ files, options, resolve, reject }));`, loader: "js",
      }));
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
    } }], logLevel: "silent",
  });
  bundle = await readFile(output, "utf8");
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const project = { walkdownId: "skid-1", skidName: "Synthetic skid", revision: 4, status: "draft" };
const startMs = Date.UTC(2026, 10, 19, 12);
function parsedRun() {
  const channel = (id, offset, value) => ({
    id, stationId: "station-1", slot: 2, channel: id === "output" ? 0 : 1, sourceChannel: id === "output" ? 0 : 1,
    symbolicName: `VALVE-EXAMPLE-${id}`, role: "Digital input", status: "Passed", rawStatus: "OK",
    parameters: [{ name: "Input filter", value: "2", rawValue: "2", enumId: "FilterEnum", recordIndex: "128" }],
    series: [{ id: `${id}-series`, name: `${id} state`, kind: "digital", unit: "",
      points: [{ time: "2026-11-19 12:00:00", timeMs: startMs + offset, value, valid: true,
        previousValue: value ? 0 : 1, previousRawValue: value ? "0" : "1", rawValue: String(value), sourceRow: 2 }] }],
  });
  return {
    schemaVersion: 1, name: "Parser name", software: { name: "Siemens PRONETA Basic", version: "" },
    clock: { basis: "source-local", timeZone: "Source clock (unspecified)", startMs, endMs: startMs + 392_000 },
    stations: [{ id: "station-1", name: "Station Example", modules: [{ slot: 2, name: "Digital module", parameters: [] }] }],
    devices: [{ id: "valve", name: "VALVE-EXAMPLE", status: "Passed", channels: [channel("output", 0, 1), channel("feedback", 392_000, 0)] }],
    sources: [{ id: "source-1", name: "synthetic-results.csv", kind: "results", stationId: "station-1", sha256: "ab".repeat(32) }],
    unassignedChannels: [], warnings: [], unparsedEvents: [],
  };
}
function savedRun(overrides = {}) {
  return { ...parsedRun(), id: "run-1", name: "Saved synthetic run", createdBy: "inspector-1", walkdownId: "skid-1", runVersion: 7,
    software: { name: "Siemens PRONETA Basic", version: "Entered 1.0" }, ...overrides };
}

async function setup(t, props = {}, { stored = {}, storageBlocked = false, localOffset = 360 } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => errors.push(error.message));
  virtualConsole.on("error", error => errors.push(String(error)));
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  Object.assign(window, {
    IS_REACT_ACT_ENVIRONMENT: true, structuredClone, calls: [], parses: [], dirty: [], exports: [], reviews: [], graphOrders: [], localOffset,
    initialProps: { project, runs: [], inspector: { id: "inspector-1", isAdmin: false }, storageScope: "https://example.supabase.co", ...props },
  });
  window.Date.prototype.getTimezoneOffset = () => window.localOffset;
  for (const [key, value] of Object.entries(stored)) window.localStorage.setItem(key, value);
  if (storageBlocked) Object.defineProperty(window, "localStorage", { get() { throw new Error("Blocked"); } });
  window.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) };
    }
  };
  window.eval(bundle);
  await window.act(async () => window.mount());
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    await window.act(async () => window.root.unmount());
    unmounted = true;
  };
  t.after(async () => {
    await unmount();
    window.close();
    assert.deepEqual(errors, [], "no React or DOM errors");
  });
  const document = window.document;
  const h = {
    window, document, unmount,
    stored: () => Object.fromEntries(Object.keys(window.localStorage).map(key => [key, window.localStorage.getItem(key)])),
    query: selector => document.querySelector(selector),
    text: () => document.body.textContent.replace(/\s+/g, " "),
    button: name => [...document.querySelectorAll("button")].find(button => button.textContent.trim() === name || button.getAttribute('aria-label') === name),
    field: name => [...document.querySelectorAll("label")].find(label => label.textContent.trim() === name)?.control,
    async click(button) { assert.ok(button, "button exists"); await window.act(async () => button.click()); },
    async drag(source, target) {
      const values = new Map();
      const dataTransfer = { setData: (type, value) => values.set(type, value), getData: type => values.get(type) };
      for (const [element, type] of [[source, "dragstart"], [target, "dragover"], [target, "drop"], [source, "dragend"]]) {
        await window.act(async () => {
          const event = new window.Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
          element.dispatchEvent(event);
        });
      }
      return dataTransfer;
    },
    async configure(changes) { await window.act(async () => window.configure(changes)); },
    async fill(input, value) {
      assert.ok(input, "field exists");
      await window.act(async () => {
        const prototype = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    },
    async select(input, value) {
      assert.equal(input?.tagName, "SELECT", "field is a native select");
      assert.ok(Array.from(input.options, option => option.value).includes(value), "requested option is selectable");
      await window.act(async () => {
        input.value = value;
        input.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    },
    async choose(names = ["synthetic-results.csv", "synthetic-log.csv", "synthetic-parameters.mpr"]) {
      const input = document.querySelector('input[type="file"]');
      await window.act(async () => {
        Object.defineProperty(input, "files", { configurable: true, value: names.map(name => new window.File(["synthetic"], name)) });
        input.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    },
    async finishParse(result = parsedRun()) { await window.act(async () => window.parses.at(-1).resolve(result)); },
    async settle(error = null) { await window.act(async () => error ? window.calls.at(-1).reject(new Error(error)) : window.calls.at(-1).resolve({})); },
  };
  h.importPreview = async () => { await h.click(h.button("Import test run")); await h.choose(); await h.finishParse(); };
  return h;
}

function expectSharedAxis(h, start, end) {
  const plots = Array.from(h.document.querySelectorAll("svg[data-time-start]"));
  assert.ok(plots.length > 0, "the selected device has rendered graphs");
  const ticks = plot => Array.from(plot.querySelectorAll('text[text-anchor="middle"]'), label =>
    [label.getAttribute("x"), label.getAttribute("y"), label.textContent]);
  const expectedTicks = ticks(plots[0]);
  for (const plot of plots) {
    assert.equal(Number(plot.dataset.timeStart), start);
    assert.equal(Number(plot.dataset.timeEnd), end);
    assert.deepEqual(ticks(plot), expectedTicks, "every graph uses the same horizontal ticks and labels");
  }
  return plots;
}

test("multi-file preview leaves the software version blank and shows separate signal graphs before an explicit save", async t => {
  const h = await setup(t);
  await h.click(h.button("Import test run"));
  assert.equal(h.field("Software version").value, "");
  const picker = h.query('input[type="file"]');
  assert.equal(picker.multiple, true);
  assert.match(picker.accept, /\.csv.*\.mpr/);
  await h.choose();
  assert.deepEqual(Array.from(h.window.parses[0].files, file => file.name), ["synthetic-results.csv", "synthetic-log.csv", "synthetic-parameters.mpr"]);
  assert.equal(h.window.parses[0].options.softwareVersion, "");
  assert.equal(h.button("Reading files…").disabled, true);
  await h.finishParse();
  assert.match(h.text(), /Unsaved preview/);
  assert.equal(h.field("Software version").value, "");
  assert.equal(h.window.calls.length, 0);
  assert.match(h.text(), /Encoded selection/i);
  const charts = expectSharedAxis(h, startMs, startMs + 392_000);
  assert.equal(charts.length, 2);
  assert.match(h.query(".test-time-axis-heading").textContent, /Automatic/);
  assert.ok(charts.every(chart => chart.querySelectorAll("circle.test-observation").length === 1), "no invented endpoints");
  assert.equal(charts[0].querySelectorAll(".test-held-value").length, 1, "the final reading extends to the shared device graph end");
  assert.equal(h.document.querySelectorAll('.test-device-content .test-comment').length, 1);
  await h.click(h.button("Save test run"));
  assert.equal(h.window.calls.length, 0);
  assert.match(h.text(), /software version before saving/);
  await h.fill(h.field("Test run name"), "  Reviewed run  ");
  await h.fill(h.field("Software name"), "  Siemens PRONETA Basic  ");
  await h.fill(h.field("Software version"), "  Tester-entered 8.4  ");
  await h.select(h.field("Source clock / timezone"), "UTC+01:00");
  const save = h.button("Save test run");
  await h.window.act(async () => { save.click(); save.click(); });
  assert.equal(h.window.calls.length, 1, "rapid duplicate clicks cannot submit twice");
  const call = h.window.calls[0];
  assert.equal(call.revision, 4);
  assert.equal(call.payload.runVersion, null);
  assert.equal(call.payload.name, "Reviewed run");
  assert.equal(call.payload.software.version, "Tester-entered 8.4");
  assert.equal(call.payload.clock.timeZone, "UTC+01:00");
  assert.equal(call.payload.devices[0].channels.length, 2);
  await h.settle();
  assert.equal(h.query('[aria-label="Import test run"]'), null);
  assert.equal(h.window.dirty.at(-1), false);
  assert.match(h.text(), /Reviewed run/);
});

test("failed save retains the exact local preview and metadata for retry", async t => {
  const h = await setup(t);
  await h.importPreview();
  await h.fill(h.field("Software version"), "Retained version");
  await h.fill(h.field("Test run name"), "Retained run");
  await h.select(h.field("Source clock / timezone"), "UTC+09:00");
  await h.click(h.button("Save test run"));
  const initialPayload = structuredClone(h.window.calls[0].payload);
  await h.settle("Network interrupted; retry the save.");
  assert.match(h.text(), /Network interrupted/);
  assert.match(h.text(), /Unsaved preview/);
  assert.equal(h.field("Software version").value, "Retained version");
  assert.equal(h.field("Test run name").value, "Retained run");
  assert.equal(h.field("Source clock / timezone").value, "UTC+09:00");
  assert.equal(h.window.dirty.at(-1), true);
  const retry = h.button("Save test run");
  assert.equal(retry.disabled, false);
  await h.window.act(async () => { retry.click(); retry.click(); });
  assert.equal(h.window.calls.length, 2);
  assert.deepEqual(structuredClone(h.window.calls[1].payload), initialPayload);
  await h.settle();
  assert.equal(h.window.dirty.at(-1), false);
});

test("editing metadata preserves the saved run ID and optimistic run version", async t => {
  for (const legacy of ["America/Chicago", "  Plant source clock (timezone not recorded)  "]) {
    const run = savedRun(); run.clock.timeZone = legacy;
    const h = await setup(t, { runs: [run] }, { localOffset: -540 });
    await h.click(h.button("Edit run"));
    assert.equal(h.field("Software version").value, "Entered 1.0");
    const picker = h.field("Source clock / timezone");
    assert.equal(picker.value, legacy, "saved legacy labels remain selected");
    assert.equal(picker.options.length, 41, "only the current legacy value joins the 40 offset choices");
    assert.equal(picker.selectedOptions[0].textContent.trim(), legacy.trim(), "saved IANA zones are not relabeled using today's offset");
    await h.fill(h.field("Software version"), "Corrected 1.1");
    await h.click(h.button("Save test run"));
    assert.equal(h.window.parses.length, 0, "metadata edits reuse the normalized saved evidence");
    assert.equal(h.window.calls[0].payload.id, "run-1");
    assert.equal(h.window.calls[0].payload.runVersion, 7);
    assert.equal(h.window.calls[0].payload.software.version, "Corrected 1.1");
    assert.equal(h.window.calls[0].payload.clock.timeZone, legacy, "legacy metadata is preserved exactly, including surrounding spaces");
    assert.equal(h.window.calls[0].revision, 4);
    await h.settle();
  }
});

test("new imports select the current local UTC offset without replacing an existing draft after a clock setting change", async t => {
  const h = await setup(t, {}, { localOffset: 570 });
  await h.click(h.button("Import test run"));
  const picker = h.field("Source clock / timezone");
  assert.equal(picker.tagName, "SELECT");
  assert.equal(picker.value, "UTC-09:30", "a positive JavaScript offset selects the negative UTC offset");
  assert.equal(picker.options.length, 40);
  assert.ok(Array.from(picker.options, option => option.value).includes("UTC+00:00"));
  assert.match(picker.selectedOptions[0].textContent, /UTC-09:30 \(this computer\)/);
  assert.ok(h.document.getElementById(picker.getAttribute("aria-describedby")), "the select has associated guidance");
  h.window.localOffset = -345;
  await h.fill(h.field("Test run name"), "Draft started before the clock setting changed");
  assert.equal(picker.value, "UTC-09:30", "an existing draft is not silently changed when the location or DST offset changes");
  await h.click(h.button("Discard changes"));
  await h.click(h.button("Import test run"));
  assert.equal(h.field("Source clock / timezone").value, "UTC+05:45", "a new import uses the current quarter-hour computer offset");

  const unavailable = await setup(t, {}, { localOffset: NaN });
  await unavailable.click(unavailable.button("Import test run"));
  assert.equal(unavailable.field("Source clock / timezone").value, "Source clock (timezone not recorded)");
  assert.match(unavailable.text(), /local UTC offset could not be detected/i);
  assert.equal(unavailable.window.calls.length, 0);
});

for (const basis of ["source-local", "absolute"]) {
  test(`manual timezone selection survives file rereads without shifting ${basis} timestamps or graphs`, async t => {
    const h = await setup(t);
    const parsed = parsedRun();
    parsed.clock.basis = basis;
    const timestamps = run => run.devices.flatMap(device => device.channels.flatMap(channel =>
      channel.series.flatMap(series => series.points.map(point => [point.time, point.timeMs]))));
    const originalTimes = timestamps(parsed);
    await h.click(h.button("Import test run"));
    await h.select(h.field("Source clock / timezone"), "UTC+05:45");
    await h.fill(h.field("Software version"), "8.4");
    await h.choose();
    assert.equal(h.window.parses[0].options.timeZone, "UTC+05:45");
    await h.finishParse(parsed);
    const coordinates = () => Array.from(h.document.querySelectorAll("svg[data-time-start]"), chart => ({
      start: chart.dataset.timeStart, end: chart.dataset.timeEnd,
      points: Array.from(chart.querySelectorAll("circle.test-observation"), point => [point.getAttribute("cx"), point.getAttribute("cy")]),
    }));
    const originalGraphs = coordinates();
    await h.select(h.field("Source clock / timezone"), "UTC-03:30");
    assert.deepEqual(coordinates(), originalGraphs);
    if (basis === "absolute") assert.match(h.query(".test-run-facts").textContent, /Graphs use UTC/);
    await h.click(h.button("Read files again"));
    assert.equal(h.window.parses[1].options.timeZone, "UTC-03:30");
    await h.finishParse(parsed);
    assert.equal(h.field("Source clock / timezone").value, "UTC-03:30");
    assert.deepEqual(coordinates(), originalGraphs);
    await h.click(h.button("Save test run"));
    const payload = h.window.calls[0].payload;
    assert.equal(payload.clock.timeZone, "UTC-03:30");
    assert.equal(payload.clock.basis, basis);
    assert.equal(payload.clock.startMs, startMs);
    assert.equal(payload.clock.endMs, startMs + 392_000);
    assert.deepEqual(timestamps(payload), originalTimes, "timezone selection changes metadata only");
    await h.settle();
  });
}

test("reopening a draft keeps its selected timezone and shows an honest unknown value for empty legacy drafts", async t => {
  const run = savedRun();
  const h = await setup(t, { runs: [run] });
  await h.click(h.button("Edit run"));
  await h.select(h.field("Source clock / timezone"), "UTC+09:00");
  const stored = h.stored();
  await h.unmount();
  const reopened = await setup(t, { runs: [run] }, { stored, localOffset: 0 });
  assert.equal(reopened.field("Source clock / timezone").value, "UTC+09:00");
  assert.deepEqual(reopened.stored(), stored, "mounting does not overwrite a recovered selection");
  await reopened.click(reopened.button("Save test run"));
  assert.equal(reopened.window.calls[0].payload.clock.timeZone, "UTC+09:00");
  await reopened.settle();

  const key = Object.keys(stored)[0];
  for (const empty of ["", "   "]) {
    const legacy = { [key]: JSON.stringify({ ...JSON.parse(stored[key]), timeZone: empty }) };
    const recovered = await setup(t, { runs: [run] }, { stored: legacy, localOffset: 0 });
    assert.equal(recovered.field("Source clock / timezone").value, "Source clock (timezone not recorded)",
      "empty saved metadata must not visually select the first available timezone");
    await recovered.click(recovered.button("Save test run"));
    assert.equal(recovered.window.calls[0].payload.clock.timeZone, "Source clock (timezone not recorded)");
    await recovered.settle();
  }
});

test("a revision closing during parsing retains the preview but prevents writes in the closed or next revision", async t => {
  const h = await setup(t);
  await h.click(h.button("Import test run"));
  await h.fill(h.field("Software version"), "Saved locally");
  await h.choose();
  await h.configure({ readOnly: true, project: { ...project, status: "closed" } });
  await h.finishParse();
  assert.match(h.text(), /Your local preview is retained/);
  assert.match(h.text(), /VALVE-EXAMPLE/);
  assert.equal(h.button("Save test run").disabled, true);
  assert.equal(h.query("fieldset").disabled, true);
  await h.click(h.button("Save test run"));
  assert.equal(h.window.calls.length, 0);
  await h.configure({ readOnly: false, project: { ...project, revision: 5 } });
  assert.equal(h.button("Save test run").disabled, true);
  assert.equal(h.field("Software version").value, "Saved locally");
  await h.click(h.button("Save test run"));
  assert.equal(h.window.calls.length, 0);
  await h.click(h.button("Discard changes"));
  assert.equal(h.window.dirty.at(-1), false);
  await h.click(h.button("Import test run"));
  assert.equal(h.query("fieldset").disabled, false);
  assert.equal(h.field("Software version").value, "");
});

test("a missing checker pauses a pending test import without a discard instruction and resumes it after the name is saved", async t => {
  const h = await setup(t);
  await h.importPreview();
  await h.fill(h.field('Software version'), 'Retained software');
  await h.fill(h.query('[aria-label="Overall test run comment"] textarea'), 'Retained test notes');
  const stored = h.stored();
  await h.configure({ readOnly: true, checkerRequired: true });
  assert.equal(h.query('.test-import-form fieldset').disabled, true);
  assert.equal(h.button('Save test run').disabled, true);
  assert.match(h.text(), /Save Checked by to resume this test run/);
  assert.match(h.text(), /Retained test notes/);
  assert.doesNotMatch(h.text(), /Discard this draft|revision or test run was closed/);
  assert.deepEqual(h.stored(), stored);
  await h.configure({ readOnly: false, checkerRequired: false, project: { ...project, checkedByName: 'Manually entered checker' } });
  assert.equal(h.field('Software version').value, 'Retained software');
  assert.equal(h.query('[aria-label="Overall test run comment"] textarea').value, 'Retained test notes');
  assert.equal(h.button('Save test run').disabled, false);
  await h.click(h.button('Save test run'));
  assert.equal(h.window.calls[0].payload.comment, 'Retained test notes');
  await h.settle();
});

test("removal is limited to the creator/admin and requires a fresh revision/version-specific confirmation", async t => {
  const otherRun = savedRun({ createdBy: "another-inspector" });
  const h = await setup(t, { runs: [otherRun] });
  assert.equal(h.button("Edit run"), undefined);
  assert.equal(h.button("Remove run"), undefined);
  await h.configure({ inspector: { id: "inspector-1", isAdmin: true } });
  await h.click(h.button("Remove run"));
  assert.equal(h.window.calls.length, 0, "opening a review does not remove the run");
  assert.ok(h.button("Confirm removal"));
  await h.configure({ project: { ...project, revision: 5 } });
  assert.equal(h.button("Confirm removal"), undefined);
  await h.click(h.button("Remove run"));
  await h.configure({ runs: [{ ...otherRun, runVersion: 8 }] });
  assert.equal(h.button("Confirm removal"), undefined);
  await h.click(h.button("Remove run"));
  const confirm = h.button("Confirm removal");
  await h.window.act(async () => { confirm.click(); confirm.click(); });
  assert.equal(h.window.calls.length, 1);
  assert.equal(h.window.calls[0].kind, "delete");
  assert.equal(h.window.calls[0].run.runVersion, 8);
  assert.equal(h.window.calls[0].revision, 5);
  await h.settle();
  assert.match(h.text(), /No test runs in this revision/);
});

test("closed read-only runs remain reviewable and exportable with absolute graph times labeled UTC", async t => {
  const run = savedRun();
  run.clock.basis = "absolute";
  run.clock.timeZone = "Source clock (timezone not recorded)";
  const legacyNote = "synthetic-log.csv, line 10: duplicate I/O event retained; no observations were removed.";
  run.warnings = [legacyNote];
  const before = structuredClone(run);
  const h = await setup(t, { readOnly: true, project: { ...project, status: "closed" }, runs: [run] });
  assert.equal(h.button("Import test run"), undefined);
  assert.equal(h.button("Edit run"), undefined);
  assert.equal(h.button("Remove run"), undefined);
  assert.match(h.text(), /UTC/);
  assert.match(h.text(), /does not establish a duplicate physical event/);
  assert.equal(h.query(".test-import-notes li").textContent, legacyNote);
  assert.equal(h.document.querySelectorAll("svg[data-time-start]").length, 2);
  await h.click(h.button("Export test PDF"));
  assert.deepEqual(Array.from(h.window.exports), ["run-1"]);
  assert.equal(h.window.calls.length, 0);
  assert.deepEqual(run, before, "clarifying saved notes does not rewrite approved data");
});

test("SVG graphs connect observations and draw a separate horizontal final-value extension", async t => {
  const run = savedRun();
  const series = run.devices[0].channels[0].series[0];
  series.kind = "analog";
  series.unit = "mA";
  series.points = [
    { ...series.points[0], timeMs: startMs + 1000, value: 4, rawValue: "4 mA" },
    { ...series.points[0], timeMs: startMs + 5000, value: 20, rawValue: "20 mA" },
  ];
  const h = await setup(t, { runs: [run] });
  const chart = h.query("svg[data-time-start]");
  assert.equal(h.document.querySelectorAll("svg[data-time-start]").length, 2);
  assert.equal(h.document.querySelectorAll("circle.test-observation").length, 3);
  const dots = chart.querySelectorAll("circle.test-observation");
  const trace = chart.querySelector(".test-trace");
  const tail = chart.querySelector(".test-held-value");
  assert.equal(dots.length, 2);
  assert.equal(trace.getAttribute("x1"), dots[0].getAttribute("cx"));
  assert.equal(trace.getAttribute("y1"), dots[0].getAttribute("cy"));
  assert.equal(trace.getAttribute("x2"), dots[1].getAttribute("cx"));
  assert.equal(trace.getAttribute("y2"), dots[1].getAttribute("cy"));
  assert.equal(tail.getAttribute("x1"), dots[1].getAttribute("cx"));
  assert.equal(tail.getAttribute("y1"), tail.getAttribute("y2"));
  assert.ok(Number(tail.getAttribute("x2")) > Number(tail.getAttribute("x1")));
  assert.match(h.text(), /the dashed tail holds the last value to the graph end/);
  assert.equal(series.points.length, 2);
});

test("SVG feedback graphs keep automatic 0.0 V steps when a -FB source is renamed and support explicit styles without resetting later manual views", async t => {
  const run = savedRun();
  const [linear, feedback] = run.devices[0].channels.map(channel => channel.series[0]);
  const sample = linear.points[0];
  Object.assign(linear, { name: "V-3501-POS", kind: "analog", unit: "mA", points: [
    { ...sample, timeMs: startMs + 1000, value: 4, rawValue: "4 mA" },
    { ...sample, timeMs: startMs + 30_000, value: 20, rawValue: "20 mA" },
  ] });
  Object.assign(feedback, { name: "V-3511-Y-FB", kind: "analog", unit: "V", points: [
    { ...sample, timeMs: startMs + 10_000, value: 0.3, rawValue: "0.3 V" },
    { ...sample, timeMs: startMs + 20_000, value: 0.1, rawValue: "0.1 V", previousValue: 0.3, previousRawValue: "0.3 V" },
  ] });
  run.devices[0].channels[1].role = "Feedback";
  const before = structuredClone(run);
  const h = await setup(t, { runs: [run] });
  expectSharedAxis(h, startMs, startMs + 31_160);
  const figures = Array.from(h.document.querySelectorAll(".test-chart"));
  const figure = figures.find(item => item.querySelector("figcaption strong").textContent === "V-3511-Y-FB");
  const dots = figure.querySelectorAll(".test-observation");
  const traces = figure.querySelectorAll(".test-trace");
  assert.equal(figure.querySelector("figcaption span").textContent, "V");
  assert.equal(dots.length, 2, "fractional voltage readings stay valid analog observations");
  assert.equal(figure.querySelector(".test-invalid-observation"), null);
  const initial = figure.querySelector(".test-initial-state");
  assert.ok(initial, "the requested display baseline is drawn before the first measured value");
  assert.match(initial.textContent, /Initial value 0\.0 V/);
  assert.match(figure.querySelector("svg").getAttribute("aria-label"), /Initial value 0\.0 V/i);
  const zeroY = Number(dots[0].getAttribute("cy"))
    + (Number(dots[1].getAttribute("cy")) - Number(dots[0].getAttribute("cy"))) * (0 - 0.3) / (0.1 - 0.3);
  assert.ok(Math.abs(Number(initial.getAttribute("y1")) - zeroY) < 0.001, "the baseline represents exactly 0.0 V");
  assert.equal(initial.getAttribute("y1"), initial.getAttribute("y2"));
  assert.ok(Number(initial.getAttribute("x1")) < Number(initial.getAttribute("x2")));
  const gridY = Array.from(figure.querySelectorAll(".test-gridline"))
    .filter(line => line.getAttribute("y1") === line.getAttribute("y2"))
    .map(line => Number(line.getAttribute("y1")));
  assert.ok(zeroY >= Math.min(...gridY) && zeroY <= Math.max(...gridY), "the zero baseline fits inside the plot even when every measured voltage is positive");
  const horizontalGrid = Array.from(figure.querySelectorAll(".test-gridline"))
    .find(line => line.getAttribute("y1") === line.getAttribute("y2"));
  assert.equal(initial.getAttribute("x1"), horizontalGrid.getAttribute("x1"), "the zero baseline begins at the shared device interval");
  assert.equal(figure.querySelector('.test-held-value:not(.test-initial-state)').getAttribute("x2"), horizontalGrid.getAttribute("x2"),
    "the final feedback voltage holds through the shared device interval");
  assert.equal(traces.length, 3);
  const [firstJump, hold, jump] = traces;
  assert.equal(initial.getAttribute("x2"), dots[0].getAttribute("cx"));
  assert.equal(firstJump.getAttribute("x1"), dots[0].getAttribute("cx"));
  assert.equal(firstJump.getAttribute("x2"), dots[0].getAttribute("cx"));
  assert.equal(firstJump.getAttribute("y1"), initial.getAttribute("y2"));
  assert.equal(firstJump.getAttribute("y2"), dots[0].getAttribute("cy"));
  assert.equal(hold.getAttribute("x1"), dots[0].getAttribute("cx"));
  assert.equal(hold.getAttribute("x2"), dots[1].getAttribute("cx"));
  assert.equal(hold.getAttribute("y1"), dots[0].getAttribute("cy"));
  assert.equal(hold.getAttribute("y2"), dots[0].getAttribute("cy"));
  assert.equal(jump.getAttribute("x1"), dots[1].getAttribute("cx"));
  assert.equal(jump.getAttribute("x2"), dots[1].getAttribute("cx"));
  assert.equal(jump.getAttribute("y1"), dots[0].getAttribute("cy"));
  assert.equal(jump.getAttribute("y2"), dots[1].getAttribute("cy"));
  assert.match(figure.querySelector("p").textContent, /Steps/);
  const other = figures.find(item => item.querySelector("figcaption strong").textContent === "V-3501-POS");
  const diagonal = other.querySelector(".test-trace");
  assert.equal(other.querySelectorAll(".test-trace").length, 1);
  assert.notEqual(diagonal.getAttribute("x1"), diagonal.getAttribute("x2"));
  assert.notEqual(diagonal.getAttribute("y1"), diagonal.getAttribute("y2"));
  const coordinates = line => ["x1", "y1", "x2", "y2"].map(attribute => line.getAttribute(attribute));
  const automaticTrace = Array.from(traces, coordinates);
  const automaticBaseline = coordinates(initial);
  await h.click(figure.querySelector(".test-graph-tools-editor summary"));
  await h.fill(figure.querySelector(".test-display-name-editor input"), "V-3511-Y_FB");
  await h.click(figure.querySelector('form[aria-label="graph display name"] button[type="submit"]'));
  assert.equal(figure.querySelector("figcaption strong").textContent, "V-3511-Y_FB");
  assert.match(figure.querySelector("figcaption").textContent, /Source: V-3511-Y-FB/);
  const style = () => figure.querySelector(".test-graph-style select");
  assert.equal(style().value, "auto");
  assert.deepEqual(Array.from(figure.querySelectorAll(".test-trace"), coordinates), automaticTrace,
    "a display alias preserves the original -FB signal's automatic step geometry");
  assert.deepEqual(coordinates(figure.querySelector(".test-initial-state")), automaticBaseline);
  assert.match(figure.querySelector("svg").getAttribute("aria-label"), /Initial value 0\.0 V/);
  await h.select(style(), "line");
  assert.ok(Array.from(figure.querySelectorAll("line.test-trace")).some(line =>
    line.getAttribute("x1") !== line.getAttribute("x2") && line.getAttribute("y1") !== line.getAttribute("y2")),
  "an explicit line style overrides automatic steps for the feedback readings");
  assert.deepEqual(coordinates(figure.querySelector(".test-initial-state")), automaticBaseline,
    "the feedback zero baseline remains independent of the selected connection style");
  await h.select(style(), "auto");
  assert.deepEqual(Array.from(figure.querySelectorAll(".test-trace"), coordinates), automaticTrace);
  const firstVoltageY = dots[0].getAttribute("cy");
  await applyRange(h, 15_000, 18_000);
  expectSharedAxis(h, startMs + 15_000, startMs + 18_000);
  assert.equal(figure.querySelector(".test-initial-state"), null, "a later manual window must not restart feedback at zero");
  assert.doesNotMatch(figure.querySelector("svg").getAttribute("aria-label"), /Initial value/);
  const clipped = figure.querySelectorAll(".test-trace");
  assert.equal(clipped.length, 1);
  assert.equal(clipped[0].getAttribute("y1"), firstVoltageY);
  assert.equal(clipped[0].getAttribute("y2"), firstVoltageY, "the measured 0.3 V value is held across this later window");
  await h.click(h.button("Save test run"));
  const payload = structuredClone(h.window.calls[0].payload);
  assert.deepEqual(payload.devices[0].channels, before.devices[0].channels,
    "saved aliases and styles leave source tags and measured readings unchanged");
  assert.equal(payload.devices[0].name, before.devices[0].name);
  assert.equal(payload.graphTools.graphs[0].name, "V-3511-Y_FB");
  assert.equal(payload.graphTools.graphs[0].style, "auto");
  await h.settle();
  assert.deepEqual(run, before, "rendering steps leaves the saved measurements and timestamps unchanged");
});

test("a device shows separate mixed-unit graphs with individual scales and one shared device comment", async t => {
  const run = savedRun();
  const [current, feedback] = run.devices[0].channels.map(channel => channel.series[0]);
  Object.assign(current, { name: "V-3511-POS", kind: "analog", unit: "mA" });
  current.points[0].value = 20;
  current.points[0].rawValue = "20 mA";
  run.devices[0].comment = "One comment for the entire device";
  run.devices[0].channels[0].series.push({ id: "empty", name: "Empty sensor", kind: "analog", unit: "°C", points: [] });
  const before = structuredClone(run);
  const h = await setup(t, { runs: [run] });
  const plots = h.document.querySelectorAll("svg[data-time-start]");
  assert.equal(plots.length, 2, "each populated signal gets its own graph; empty series add none");
  assert.deepEqual(Array.from(h.document.querySelectorAll('.test-chart figcaption span'), label => label.textContent), ["mA", "State"]);
  assert.deepEqual(Array.from(plots[0].querySelectorAll("text"), label => label.textContent).slice(0, 5), ["0", "6.25", "12.5", "18.75", "25"]);
  assert.deepEqual(Array.from(plots[1].querySelectorAll("text"), label => label.textContent).slice(0, 2), ["0", "1"]);
  expectSharedAxis(h, startMs, startMs + 392_000);
  assert.match(plots[0].closest("figure").querySelector("p").textContent, /same automatic time axis/);
  assert.doesNotMatch(plots[0].closest("figure").querySelector("p").textContent, /recorded change values shown/);
  const comments = h.document.querySelectorAll('.test-device-content .test-comment');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].querySelector('textarea').value, "One comment for the entire device");
  assert.equal(h.document.querySelectorAll('[aria-label="Overall test run comment"]').length, 1);
  assert.equal(h.window.calls.length, 0);
  assert.deepEqual(run, before, "splitting the graphs preserves saved evidence and comments");
});

test("dated invalid observations extend the shared axis while empty, undated, and excluded peers do not", async t => {
  const run = savedRun();
  const channel = run.devices[0].channels[0];
  const sample = channel.series[0].points[0];
  const series = (id, points) => ({ id, name: id, kind: "analog", unit: "V", points });
  channel.series = [
    series("Measured signal", [10_000, 20_000].map((offset, index) => ({ ...sample, timeMs: startMs + offset,
      value: index + 1, sourceRow: index + 2 }))),
    series("Invalid signal", [{ ...sample, timeMs: startMs + 40_000, value: null, valid: false, rawValue: "Invalid", sourceRow: 5 }]),
    series("Excluded signal", [{ ...sample, timeMs: startMs + 200_000, excluded: true }]),
    series("Undated signal", [{ ...sample, timeMs: null, time: "Unrecognized source time" }]),
    series("Empty signal", []),
  ];
  run.devices[0].channels = [channel];
  const before = structuredClone(run);
  const h = await setup(t, { runs: [run] });
  const plots = expectSharedAxis(h, startMs + 9000, startMs + 41_000);
  assert.equal(plots.length, 4, "empty series do not add an empty graph");
  assert.equal(plots[1].querySelectorAll(".test-invalid-observation").length, 1);
  assert.equal(plots[2].querySelectorAll(".test-observation,.test-trace,.test-held-value").length, 0);
  assert.equal(plots[3].querySelectorAll(".test-observation,.test-trace,.test-held-value").length, 0);
  assert.equal(h.query(".field-error"), null);
  await h.click(h.button("Remove event from Invalid signal, source row 5"));
  expectSharedAxis(h, startMs + 9000, startMs + 21_000);
  assert.deepEqual(run, before, "shared display bounds do not mutate source evidence");
});

function eventRun() {
  const run = savedRun();
  const channel = run.devices[0].channels[0];
  const series = { ...channel.series[0], name: "PD-EXAMPLE", kind: "analog", unit: "mA" };
  series.points = [4, 100, 5].map((value, index) => ({ ...series.points[0], timeMs: startMs + index * 10_000,
    time: `2026-11-19 12:00:${String(index * 10).padStart(2, "0")}`, value, rawValue: `${value} mA`, sourceRow: index + 2 }));
  channel.series = [{ ...series, id: "empty-series", points: [] }, series];
  return run;
}

const firstGraph = h => h.query('.test-chart');
const graphButton = (h, name) => Array.from(firstGraph(h).querySelectorAll('button')).find(button =>
  button.textContent.trim() === name || button.getAttribute('aria-label') === name);
const sourceTimeInput = offset => new Date(startMs + offset).toISOString().replace(/Z$/, '');

test("device and graph display names and line, step, and smooth styles save without changing source names or readings", async t => {
  const run = eventRun(); run.devices[0].comment = '';
  const before = structuredClone(run);
  const h = await setup(t, { runs: [run] });
  await h.click(h.query('.test-device-name-tools summary'));
  await h.click(h.button('Apply device name'));
  assert.equal(h.window.dirty.at(-1), false, 'applying the current name is a no-op');
  await h.fill(h.field('Device display name'), 'Display valve');
  assert.equal(h.window.dirty.at(-1), true);
  assert.equal(h.query('.test-import-form'), null, 'an unapplied name is not yet a shared draft edit');
  await h.click(h.button('Apply device name'));
  assert.ok(h.button('Display valvePassed'));
  assert.match(h.query('.test-device-heading').textContent, /Source: VALVE-EXAMPLE/);
  await h.click(firstGraph(h).querySelector('.test-graph-tools-editor summary'));
  await h.fill(h.field('Graph display name'), 'V-3511-Y_FB');
  assert.equal(h.button('Save test run').disabled, true);
  await h.click(graphButton(h, 'Apply graph name'));
  assert.equal(firstGraph(h).querySelector('figcaption strong').textContent, 'V-3511-Y_FB');
  assert.match(firstGraph(h).querySelector('figcaption').textContent, /Source: PD-EXAMPLE/);
  assert.equal(h.query('.test-graph-order-label > strong').textContent, 'V-3511-Y_FB');
  const style = () => firstGraph(h).querySelector('.test-graph-style select');
  await h.select(style(), 'step');
  assert.ok(Array.from(firstGraph(h).querySelectorAll('line.test-trace')).every(line =>
    line.getAttribute('x1') === line.getAttribute('x2') || line.getAttribute('y1') === line.getAttribute('y2')));
  await h.select(style(), 'smooth');
  assert.equal(firstGraph(h).querySelectorAll('path.test-smooth-trace').length, 2);
  assert.match(firstGraph(h).querySelector('path.test-smooth-trace').getAttribute('d'), / C /);
  await h.select(style(), 'line');
  assert.equal(firstGraph(h).querySelectorAll('path.test-smooth-trace').length, 0);
  assert.ok(Array.from(firstGraph(h).querySelectorAll('line.test-trace')).some(line =>
    line.getAttribute('x1') !== line.getAttribute('x2') && line.getAttribute('y1') !== line.getAttribute('y2')));
  await h.select(style(), 'auto');
  assert.equal(firstGraph(h).querySelectorAll('line.test-trace').length, 2, 'the display alias does not change the source signal default');
  await h.select(style(), 'smooth');
  assert.equal(firstGraph(h).querySelectorAll('.test-observation').length, 3);
  expectSharedAxis(h, startMs, startMs + 392_000);
  await h.click(h.button('Save test run'));
  const payload = structuredClone(h.window.calls[0].payload);
  assert.deepEqual(payload.devices, before.devices);
  assert.deepEqual(payload.graphTools.deviceNames, [{ deviceId: 'valve', name: 'Display valve' }]);
  assert.equal(payload.graphTools.graphs[0].name, 'V-3511-Y_FB');
  assert.equal(payload.graphTools.graphs[0].style, 'smooth');
  await h.settle('Retry this save');
  assert.equal(firstGraph(h).querySelectorAll('path.test-smooth-trace').length, 2);
  await h.click(h.button('Save test run'));
  assert.deepEqual(structuredClone(h.window.calls[1].payload), payload);
  await h.settle();
  assert.equal(h.window.dirty.at(-1), false);
  assert.deepEqual(run, before);
});

test("named durations pick original point indices and mix cross-device thresholds, manual times, and duration units", async t => {
  const run = eventRun();
  run.devices[0].channels[0].series[1].points[0].excluded = true;
  const other = structuredClone(run.devices[0]); other.id = 'other'; other.name = 'OTHER';
  other.channels = [other.channels[0]];
  const trigger = other.channels[0].series[1];
  trigger.points = [0, 10, 20].map((value, index) => ({ ...trigger.points[index], excluded: false,
    value, timeMs: startMs + [5000, 15_000, 30_000][index], rawValue: `${value} mA` }));
  run.devices.push(other);
  const h = await setup(t, { runs: [run] });
  await h.click(firstGraph(h).querySelector('.test-graph-tools-editor summary'));
  await h.click(graphButton(h, 'Add duration calculation'));
  await h.fill(h.field('Calculation name'), 'Valve response');
  await h.select(h.field('Duration unit'), 'min');
  await h.click(h.button('Pick start point'));
  assert.match(firstGraph(h).querySelector('.test-point-picker').textContent, /Picking start point/);
  await h.click(h.button('Cancel point picking'));
  assert.equal(firstGraph(h).querySelector('.test-point-picker'), null);
  await h.click(h.button('Pick start point'));
  const point = firstGraph(h).querySelector('.test-observation[role="button"]');
  assert.equal(point.dataset.pointIndex, '1');
  assert.equal(h.document.activeElement, point);
  await h.window.act(async () => point.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(firstGraph(h).querySelector('.test-point-picker'), null);
  await h.select(h.field('End time source'), 'trigger');
  const choices = h.field('End threshold graph');
  const otherChoice = Array.from(choices.options).find(option => option.textContent.includes('OTHER / PD-EXAMPLE'));
  assert.ok(otherChoice, 'thresholds can reference a graph on another device in this run');
  await h.select(choices, otherChoice.value);
  await h.select(h.field('End comparison'), '>');
  await h.fill(h.field('End threshold'), '15');
  assert.match(firstGraph(h).querySelector('.test-duration-editor').textContent, /First matching recorded reading at or after/);
  await h.click(h.button('Add calculation'));
  assert.match(firstGraph(h).querySelector('.test-duration-list').textContent, /0.3333333 minutes/);
  await h.click(h.button('Edit calculation Valve response'));
  await h.select(h.field('Duration unit'), 'h');
  await h.click(h.button('Update calculation'));
  assert.match(firstGraph(h).querySelector('.test-duration-list').textContent, /0.005555556 hours/);
  await h.click(graphButton(h, 'Add duration calculation'));
  await h.fill(h.field('Calculation name'), 'Manual finish');
  await h.select(h.field('Start time source'), 'trigger');
  await h.select(h.field('Start threshold graph'), otherChoice.value);
  await h.select(h.field('Start comparison'), '>=');
  await h.fill(h.field('Start threshold'), '10');
  await h.select(h.field('End time source'), 'time');
  await h.fill(h.field('End source time'), sourceTimeInput(21_000));
  await h.click(h.button('Add calculation'));
  assert.match(firstGraph(h).querySelector('.test-duration-list').textContent, /6 seconds/);
  await h.click(h.button('Remove event from PD-EXAMPLE, source row 3'));
  assert.match(firstGraph(h).querySelector('.test-duration-list').textContent, /selected point is removed/);
  await h.click(h.button('Save test run'));
  const tools = structuredClone(h.window.calls[0].payload.graphTools);
  const [picked, manual] = tools.graphs[0].measurements;
  assert.equal(picked.name, 'Valve response');
  assert.equal(picked.start.kind, 'point');
  assert.equal(picked.start.pointIndex, 1, 'cropping/exclusion never changes the original point index');
  assert.equal(picked.start.timeMs, startMs + 10_000);
  assert.equal(picked.start.value, 100);
  assert.equal(picked.end.deviceId, 'other');
  assert.equal(picked.end.operator, '>');
  assert.equal(manual.start.kind, 'trigger');
  assert.equal(manual.end.kind, 'time');
  assert.equal(manual.end.timeMs, startMs + 21_000, 'manual source coordinates have no browser-timezone shift');
  await h.settle();
});

test("manual intervals reject out-of-run and reversed times, allow zero, and retain unmatched trigger status on approved reports", async t => {
  const run = eventRun();
  const h = await setup(t, { runs: [run] });
  await h.click(firstGraph(h).querySelector('.test-graph-tools-editor summary'));
  await h.click(graphButton(h, 'Add duration calculation'));
  await h.fill(h.field('Calculation name'), 'Zero interval');
  await h.select(h.field('Start time source'), 'time');
  await h.select(h.field('End time source'), 'time');
  await h.fill(h.field('Start source time'), sourceTimeInput(10_000));
  await h.fill(h.field('End source time'), sourceTimeInput(393_000));
  await h.click(h.button('Add calculation'));
  assert.match(firstGraph(h).querySelector('.field-error').textContent, /within this test run/);
  await h.fill(h.field('End source time'), sourceTimeInput(5000));
  await h.click(h.button('Add calculation'));
  assert.match(firstGraph(h).querySelector('.field-error').textContent, /end time must be at or after/);
  assert.equal(h.window.calls.length, 0);
  await h.fill(h.field('End source time'), sourceTimeInput(10_000));
  await h.click(h.button('Add calculation'));
  assert.match(firstGraph(h).querySelector('.test-duration-list').textContent, /0 seconds/);
  await h.click(graphButton(h, 'Add duration calculation'));
  await h.fill(h.field('Calculation name'), 'Unmatched threshold');
  await h.select(h.field('Start time source'), 'time');
  await h.fill(h.field('Start source time'), sourceTimeInput(0));
  await h.select(h.field('End time source'), 'trigger');
  await h.select(h.field('End threshold graph'), h.field('End threshold graph').options[1].value);
  await h.fill(h.field('End threshold'), '1000');
  await h.click(h.button('Add calculation'));
  assert.match(firstGraph(h).querySelector('.test-duration-list').textContent, /Unresolved: End: No retained valid observation/);
  await h.click(h.button('Save test run')); await h.settle();
  await h.configure({ readOnly: true, project: { ...project, status: 'closed' } });
  assert.equal(firstGraph(h).querySelector('.test-graph-style select'), null);
  assert.equal(h.button('Add duration calculation'), undefined);
  assert.equal(h.button('Edit calculation Zero interval'), undefined);
  assert.match(firstGraph(h).querySelector('.test-duration-list').textContent, /0 seconds/);
  assert.equal(h.button('Move PD-EXAMPLE down').disabled, false, 'approved reports keep view-only arrangement available');
  assert.equal(h.button('Reset to auto').disabled, false);
});

test("applied graph tools recover with the draft, survive source rereads, and remain visible as retained work when their graph disappears", async t => {
  const run = eventRun();
  const h = await setup(t, { runs: [run] });
  await h.select(firstGraph(h).querySelector('.test-graph-style select'), 'smooth');
  await h.fill(h.field('Graph display name'), 'Saved display graph');
  await h.click(graphButton(h, 'Apply graph name'));
  const stored = h.stored();
  const tools = JSON.parse(Object.values(stored)[0]).graphTools;
  await h.unmount();
  const reopened = await setup(t, { runs: [run] }, { stored });
  assert.equal(firstGraph(reopened).querySelector('figcaption strong').textContent, 'Saved display graph');
  assert.equal(firstGraph(reopened).querySelectorAll('.test-smooth-trace').length, 2);
  await reopened.choose();
  await reopened.finishParse(structuredClone(run));
  assert.equal(firstGraph(reopened).querySelector('figcaption strong').textContent, 'Saved display graph');
  const replacement = structuredClone(run);
  replacement.devices[0].channels[0].series[1].id = 'different-source-graph';
  await reopened.click(reopened.button('Read files again'));
  await reopened.finishParse(replacement);
  assert.match(reopened.query('.test-unmatched-graph-tools').textContent, /1 saved graph configuration has no matching graph/);
  assert.match(reopened.query('.test-unmatched-graph-tools').textContent, /Saved display graph/);
  await reopened.click(reopened.button('Save test run'));
  assert.deepEqual(structuredClone(reopened.window.calls[0].payload.graphTools), tools);
  assert.equal(reopened.window.calls[0].payload.devices[0].channels[0].series[1].id, 'different-source-graph');
  await reopened.settle();
});

test("unapplied graph editors block leaving, pause for a missing checker, and cannot retarget a changed run", async t => {
  const run = eventRun();
  const h = await setup(t, { runs: [run] });
  await h.click(graphButton(h, 'Add duration calculation'));
  await h.fill(h.field('Calculation name'), 'Keep this editor');
  assert.equal(h.window.dirty.at(-1), true);
  assert.deepEqual(h.stored(), {}, 'only applied graph tools enter the recovery cache');
  const event = new h.window.Event('beforeunload', { cancelable: true });
  h.window.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.query('.test-run-toolbar select').disabled, true);
  assert.equal(h.query('.test-device-list button').disabled, true);
  await h.click(h.button('Pick start point'));
  assert.ok(firstGraph(h).querySelector('.test-point-picker'));
  await h.configure({ readOnly: true, checkerRequired: true });
  assert.equal(firstGraph(h).querySelector('.test-point-picker'), null, 'paused authorship ends point-picking mode');
  assert.equal(h.field('Calculation name').value, 'Keep this editor');
  assert.equal(h.field('Calculation name').matches(':disabled'), true);
  await h.configure({ readOnly: false, checkerRequired: false });
  assert.equal(h.field('Calculation name').value, 'Keep this editor');
  await h.click(h.button('Cancel calculation'));
  assert.equal(h.window.dirty.at(-1), false);
  await h.fill(h.field('Graph display name'), 'Unapplied graph label');
  await h.configure({ runs: [{ ...run, runVersion: 8 }] });
  assert.equal(h.field('Graph display name').value, 'Unapplied graph label');
  assert.equal(graphButton(h, 'Apply graph name').disabled, true);
  assert.match(firstGraph(h).textContent, /This report changed/);
  await h.click(graphButton(h, 'Cancel graph name edit'));
  assert.equal(h.window.dirty.at(-1), false);
  assert.equal(h.window.calls.length, 0);
});

function graphOrderRun() {
  const run = eventRun();
  const channel = run.devices[0].channels[0];
  const temperature = structuredClone(channel.series[1]);
  Object.assign(temperature, { id: "temperature-series", name: "Temperature", unit: "°C" });
  temperature.points.forEach((point, index) => Object.assign(point, { value: 22 + index, rawValue: `${22 + index} °C` }));
  channel.series.push(temperature);
  run.devices[0].channels.splice(1, 0, { ...structuredClone(channel), id: "parameters-only", symbolicName: "Parameters only",
    series: [], parameters: [{ name: "Retained setting", value: "Enabled" }] });
  return run;
}

const graphNames = h => Array.from(h.document.querySelectorAll('.test-chart figcaption strong'), element => element.textContent);

test("graph move buttons reorder individual signals across channels and keep their metadata without creating a report edit", async t => {
  const run = graphOrderRun(), before = structuredClone(run);
  const h = await setup(t, { runs: [run] });
  const sourceOrder = ["PD-EXAMPLE", "Temperature", "feedback state"];
  assert.deepEqual(graphNames(h), sourceOrder);
  assert.equal(h.query('.test-graph-order').open, false);
  await h.click(h.query('.test-graph-order summary'));
  assert.equal(h.query('.test-graph-order').open, true);
  assert.deepEqual(Array.from(h.document.querySelectorAll('.test-graph-order-label > span'), item => item.textContent), ["mA", "°C", "State"]);
  assert.deepEqual(Array.from(h.document.querySelectorAll('.test-channel-heading h4'), item => item.textContent),
    ["VALVE-EXAMPLE-output", "Parameters only", "VALVE-EXAMPLE-feedback"], "source order preserves the existing channel layout");
  assert.equal(h.button('Move PD-EXAMPLE up').disabled, true);
  assert.equal(h.button('Move feedback state down').disabled, true);
  const geometryBefore = Array.from(h.document.querySelectorAll('.test-chart svg'), svg => svg.outerHTML);
  const move = h.button('Move Temperature down');
  move.focus();
  await h.click(move);
  assert.deepEqual(graphNames(h), ["PD-EXAMPLE", "feedback state", "Temperature"]);
  assert.equal(h.document.activeElement, h.button('Move Temperature up'), "keyboard focus stays with the moved graph when its button reaches a boundary");
  assert.equal(h.button('Move Temperature down').disabled, true);
  assert.match(h.query('.test-graph-order [role="status"]').textContent, /Temperature moved to position 3 of 3/);
  assert.equal(h.query('.test-graph-order [role="status"]').getAttribute('aria-live'), 'polite');
  const figures = Array.from(h.document.querySelectorAll('.test-chart'));
  assert.deepEqual(figures.map(figure => figure.closest('.test-channel').querySelector('h4').textContent),
    ["VALVE-EXAMPLE-output", "VALVE-EXAMPLE-feedback", "VALVE-EXAMPLE-output"]);
  assert.ok(figures.every(figure => figure.closest('.test-channel').textContent.includes('Input filter')), "channel parameters stay with their graphs");
  assert.equal(Array.from(h.document.querySelectorAll('.test-channel')).filter(channel => channel.textContent.includes('Retained setting')).length, 1);
  assert.deepEqual(figures.map(figure => figure.querySelector('svg').outerHTML), [geometryBefore[0], geometryBefore[2], geometryBefore[1]]);
  expectSharedAxis(h, startMs, startMs + 392_000);
  assert.equal(h.query('.test-import-form'), null);
  assert.equal(h.window.dirty.at(-1), false);
  assert.equal(h.window.calls.length, 0);
  assert.deepEqual(run, before);
  const change = structuredClone(h.window.graphOrders.at(-1));
  const keys = deviceGraphEntries(run.devices[0]).map(entry => entry.key);
  assert.deepEqual(change, { scope: testGraphOrderScope('https://example.supabase.co', 'inspector-1', project.walkdownId, 4),
    runId: run.id, deviceId: 'valve', order: [keys[0], keys[2], keys[1]] });
  assert.deepEqual(JSON.parse(Object.values(h.stored())[0]), change.order, "the viewing preference saves immediately");
});

test("dragged graph order persists across reopening, stays separate for each device and run, and resets", async t => {
  const run = graphOrderRun();
  run.devices.push({ ...structuredClone(run.devices[0]), id: 'second', name: 'SECOND' });
  const otherRun = graphOrderRun(); otherRun.id = 'other-run'; otherRun.name = 'Other run';
  const h = await setup(t, { runs: [run, otherRun] });
  await h.click(h.query('.test-graph-order summary'));
  const rows = h.document.querySelectorAll('.test-graph-order li');
  const transfer = await h.drag(rows[0], rows[2]);
  assert.equal(transfer.effectAllowed, 'move');
  assert.equal(transfer.dropEffect, 'move');
  assert.deepEqual(graphNames(h), ['Temperature', 'feedback state', 'PD-EXAMPLE']);
  assert.match(h.query('.test-graph-order [role="status"]').textContent, /PD-EXAMPLE moved to position 3 of 3/);
  await h.click(h.button('SECONDPassed'));
  assert.deepEqual(graphNames(h), ['PD-EXAMPLE', 'Temperature', 'feedback state']);
  await h.click(h.button('Move Temperature up'));
  assert.deepEqual(graphNames(h), ['Temperature', 'PD-EXAMPLE', 'feedback state']);
  await h.select(h.query('.test-run-toolbar select'), 'other-run');
  assert.deepEqual(graphNames(h), ['PD-EXAMPLE', 'Temperature', 'feedback state']);
  await h.select(h.query('.test-run-toolbar select'), 'run-1');
  await h.click(h.button('VALVE-EXAMPLEPassed'));
  assert.deepEqual(graphNames(h), ['Temperature', 'feedback state', 'PD-EXAMPLE']);
  const stored = h.stored(); await h.unmount();
  const reopened = await setup(t, { runs: [run, otherRun] }, { stored });
  assert.deepEqual(graphNames(reopened), ['Temperature', 'feedback state', 'PD-EXAMPLE']);
  await reopened.click(reopened.button('Reset graph order'));
  assert.deepEqual(graphNames(reopened), ['PD-EXAMPLE', 'Temperature', 'feedback state']);
  assert.equal(reopened.window.graphOrders.at(-1).order, null);
  assert.match(reopened.query('.test-graph-order [role="status"]').textContent, /reset to the original order/);
  await reopened.click(reopened.button('SECONDPassed'));
  assert.deepEqual(graphNames(reopened), ['Temperature', 'PD-EXAMPLE', 'feedback state']);
  assert.equal(reopened.window.calls.length, 0);
  assert.equal(reopened.window.dirty.at(-1), false);
});

test("approved read-only reports allow graph ordering and retain an in-memory export override when local storage is blocked", async t => {
  const run = graphOrderRun();
  const props = { runs: [run], readOnly: true, project: { ...project, status: 'closed' } };
  const h = await setup(t, props, { storageBlocked: true });
  assert.equal(h.button('Edit run'), undefined);
  assert.equal(h.button('Move feedback state up').disabled, false);
  await h.click(h.button('Move feedback state up'));
  assert.deepEqual(graphNames(h), ['PD-EXAMPLE', 'feedback state', 'Temperature']);
  assert.match(h.query('.test-graph-order .field-error').textContent, /could not be saved/);
  assert.equal(h.window.calls.length, 0);
  assert.equal(h.window.dirty.at(-1), false);
  const { scope, runId, deviceId, order } = structuredClone(h.window.graphOrders.at(-1));
  await h.click(h.button('Export test PDF'));
  assert.deepEqual(Array.from(h.window.exports), [run.id]);
  await h.unmount();
  const reopened = await setup(t, { ...props, graphOrderChanges: { [scope]: { [runId]: { [deviceId]: order } } } }, { storageBlocked: true });
  assert.deepEqual(graphNames(reopened), ['PD-EXAMPLE', 'feedback state', 'Temperature']);
  await reopened.click(reopened.button('Reset graph order'));
  assert.deepEqual(graphNames(reopened), ['PD-EXAMPLE', 'Temperature', 'feedback state']);
  assert.equal(reopened.window.graphOrders.at(-1).order, null);
});

test("event actions after graph reordering still address the original channel and series indices", async t => {
  const run = graphOrderRun(), before = structuredClone(run);
  const h = await setup(t, { runs: [run] });
  await h.click(h.button('Move PD-EXAMPLE down'));
  await h.click(h.button('Move PD-EXAMPLE down'));
  assert.deepEqual(graphNames(h), ['Temperature', 'feedback state', 'PD-EXAMPLE']);
  await h.click(h.button('Remove event from PD-EXAMPLE, source row 3'));
  await h.click(h.button('Remove event from feedback state, source row 2'));
  assert.deepEqual(graphNames(h), ['Temperature', 'feedback state', 'PD-EXAMPLE']);
  assert.deepEqual(Array.from(h.document.querySelectorAll('.test-chart'), figure => figure.querySelectorAll('.test-observation').length), [3, 0, 2]);
  assert.equal(h.window.dirty.at(-1), true);
  await h.click(h.button('Save test run'));
  const expected = structuredClone(before.devices);
  expected[0].comment = '';
  expected[0].channels[0].series[1].points[1].excluded = true;
  expected[0].channels[2].series[0].points[0].excluded = true;
  assert.deepEqual(structuredClone(h.window.calls[0].payload.devices), expected, 'only original evidence flags change; raw channel and series order stays intact');
  assert.deepEqual(run, before);
  await h.settle();
  assert.deepEqual(graphNames(h), ['Temperature', 'feedback state', 'PD-EXAMPLE']);
});

test("a device with one populated graph keeps channel details without showing arrangement controls", async t => {
  const run = savedRun(); run.devices[0].channels[0].series[0].points = [];
  const h = await setup(t, { runs: [run] });
  assert.equal(h.query('.test-graph-order'), null);
  assert.deepEqual(graphNames(h), ['feedback state']);
  assert.equal(h.document.querySelectorAll('.test-channel').length, 2);
  assert.match(h.query('.test-channel').textContent, /No signal changes.*Input filter/s);
});

test("repeated graph names have distinct move controls", async t => {
  const run = savedRun();
  for (const channel of run.devices[0].channels) channel.series[0].name = 'Repeated signal';
  const h = await setup(t, { runs: [run] });
  assert.equal(h.button('Move Repeated signal (graph 1 of 2) up').disabled, true);
  assert.equal(h.button('Move Repeated signal (graph 2 of 2) down').disabled, true);
  await h.click(h.button('Move Repeated signal (graph 2 of 2) up'));
  assert.equal(h.query('.test-chart').closest('.test-channel').querySelector('h4').textContent, 'VALVE-EXAMPLE-feedback');
  const labels = Array.from(h.document.querySelectorAll('.test-graph-order button[aria-label]'), button => button.getAttribute('aria-label'));
  assert.equal(new Set(labels).size, 4);
});

test("removing a recorded row updates graph geometry immediately and saves only an exclusion of its original evidence", async t => {
  const run = eventRun(), before = structuredClone(run);
  const h = await setup(t, { runs: [run] });
  const graph = () => h.query('svg[data-time-start]');
  assert.equal(graph().querySelectorAll('.test-observation').length, 3);
  assert.ok(Number(graph().querySelectorAll('text')[4].textContent) > 100);
  await h.click(h.button('Remove event from PD-EXAMPLE, source row 3'));
  assert.equal(graph().querySelectorAll('.test-observation').length, 2);
  assert.equal(graph().querySelectorAll('.test-trace').length, 1);
  assert.equal(graph().querySelectorAll('text')[4].textContent, '25', 'removed outlier no longer expands the current scale');
  assert.match(h.query('.test-removed-events').textContent, /100 mA/);
  assert.equal(h.window.dirty.at(-1), true);
  assert.equal(h.window.calls.length, 0);
  assert.deepEqual(run, before);
  await h.click(h.button('Save test run'));
  const payload = structuredClone(h.window.calls[0].payload);
  const points = payload.devices[0].channels[0].series[1].points;
  assert.deepEqual(points, before.devices[0].channels[0].series[1].points.map((point, index) => index === 1 ? { ...point, excluded: true } : point));
  assert.deepEqual(payload.devices[0].channels[0].series[0].points, [], 'original series index survives empty series');
  await h.settle('Network unavailable');
  assert.equal(graph().querySelectorAll('.test-observation').length, 2);
  assert.equal(Object.keys(h.stored()).length, 1);
  await h.click(h.button('Save test run'));
  assert.deepEqual(structuredClone(h.window.calls[1].payload), payload);
  await h.settle();
  assert.deepEqual(h.stored(), {});
  assert.equal(h.window.dirty.at(-1), false);
  assert.ok(h.button('Restore event from PD-EXAMPLE, source row 3'));
});

test("event removals recover with comments after reopening and can all be restored or discarded", async t => {
  const run = eventRun();
  const h = await setup(t, { runs: [run] });
  await h.fill(h.query('[aria-label="Overall test run comment"] textarea'), 'Pending conclusion');
  for (const row of [2, 3, 4]) await h.click(h.button(`Remove event from PD-EXAMPLE, source row ${row}`));
  assert.equal(h.query('svg[data-time-start]').querySelectorAll('.test-observation,.test-trace,.test-held-value').length, 0);
  const stored = h.stored();
  await h.unmount();
  const reopened = await setup(t, { runs: [run] }, { stored });
  assert.match(reopened.text(), /Recovered pending comments and event edits/);
  assert.equal(reopened.query('[aria-label="Overall test run comment"] textarea').value, 'Pending conclusion');
  assert.equal(reopened.query('svg[data-time-start]').querySelectorAll('.test-observation').length, 0);
  await reopened.click(reopened.button('Restore event from PD-EXAMPLE, source row 3'));
  assert.equal(reopened.query('svg[data-time-start]').querySelectorAll('.test-observation').length, 1);
  assert.equal(reopened.window.calls.length, 0);
  const cache = JSON.parse(Object.values(reopened.stored())[0]);
  assert.equal(cache.eventEdits.find(edit => edit.pointIndex === 1).excluded, false);
  await reopened.click(reopened.button('Discard changes'));
  assert.equal(reopened.query('svg[data-time-start]').querySelectorAll('.test-observation').length, 3);
  assert.deepEqual(reopened.stored(), {});
});

test("restoring a previously saved exclusion is pending and respects ownership and revision locks", async t => {
  const run = eventRun();
  run.devices[0].channels[0].series[1].points[1].excluded = true;
  const h = await setup(t, { runs: [run], inspector: { id: 'other-inspector', isAdmin: false } });
  assert.equal(h.button('Restore event from PD-EXAMPLE, source row 3'), undefined);
  assert.equal(h.button('Remove event from PD-EXAMPLE, source row 2'), undefined);
  await h.configure({ inspector: { id: 'other-inspector', isAdmin: true } });
  await h.click(h.button('Restore event from PD-EXAMPLE, source row 3'));
  assert.equal(h.query('svg[data-time-start]').querySelectorAll('.test-observation').length, 3);
  await h.configure({ pending: true });
  assert.equal(h.button('Remove event from PD-EXAMPLE, source row 2').disabled, true);
  await h.configure({ pending: false, runs: [{ ...run, runVersion: run.runVersion + 1 }] });
  assert.equal(h.button('Remove event from PD-EXAMPLE, source row 2'), undefined);
  assert.equal(h.button('Save test run').disabled, true);
  await h.configure({ readOnly: true, project: { ...project, status: 'closed' } });
  assert.equal(h.button('Remove event from PD-EXAMPLE, source row 2'), undefined);
  assert.equal(h.window.calls.length, 0);
  assert.equal(run.devices[0].channels[0].series[1].points[1].excluded, true);
});

test("recovered event edits require matching source files and original row identity before replay", async t => {
  const parsed = eventRun();
  const h = await setup(t);
  await h.click(h.button('Import test run'));
  await h.fill(h.field('Software version'), '1.0');
  await h.choose(); await h.finishParse(parsed);
  await h.click(h.button('Remove event from PD-EXAMPLE, source row 3'));
  const stored = h.stored();
  await h.unmount();
  const reopened = await setup(t, {}, { stored });
  assert.equal(reopened.button('Save test run').disabled, true);
  await reopened.choose();
  await reopened.finishParse({ ...parsed, sources: [{ ...parsed.sources[0], sha256: 'cd'.repeat(32) }] });
  assert.match(reopened.text(), /files do not match/);
  assert.equal(reopened.button('Save test run').disabled, true);
  const changed = structuredClone(parsed);
  changed.devices[0].channels[0].series[1].points[1].rawValue = 'different source evidence';
  await reopened.choose(); await reopened.finishParse(changed);
  assert.match(reopened.text(), /recorded events no longer match/);
  assert.equal(reopened.button('Save test run').disabled, true);
  await reopened.choose(); await reopened.finishParse(parsed);
  assert.equal(reopened.query('svg[data-time-start]').querySelectorAll('.test-observation').length, 2);
  assert.equal(reopened.button('Save test run').disabled, false);
  assert.equal(reopened.window.calls.length, 0);
});

test("a recovered saved-run event identity mismatch retains the cache and blocks saving", async t => {
  const run = eventRun();
  const h = await setup(t, { runs: [run] });
  await h.click(h.button('Remove event from PD-EXAMPLE, source row 3'));
  const stored = h.stored(); await h.unmount();
  const changed = structuredClone(run);
  changed.devices[0].channels[0].series[1].points[1].value = 99;
  const reopened = await setup(t, { runs: [changed] }, { stored });
  assert.match(reopened.text(), /recorded events no longer match/);
  assert.equal(reopened.button('Save test run').disabled, true);
  assert.deepEqual(reopened.stored(), stored);
  assert.equal(reopened.window.calls.length, 0);
});

test("rereading original files retains saved exclusions and honors pending removals and restores", async t => {
  const original = eventRun();
  const run = structuredClone(original);
  run.devices[0].channels[0].series[1].points[0].excluded = true;
  run.devices[0].channels[0].series[1].points[1].excluded = true;
  const h = await setup(t, { runs: [run] });
  await h.click(h.button('Restore event from PD-EXAMPLE, source row 3'));
  await h.click(h.button('Remove event from PD-EXAMPLE, source row 4'));
  await h.choose(); await h.finishParse(original);
  assert.equal(h.query('svg[data-time-start]').querySelectorAll('.test-observation').length, 1);
  assert.ok(h.button('Restore event from PD-EXAMPLE, source row 2'));
  assert.ok(h.button('Remove event from PD-EXAMPLE, source row 3'));
  assert.ok(h.button('Restore event from PD-EXAMPLE, source row 4'));
  const stored = h.stored(); await h.unmount();
  const reopened = await setup(t, { runs: [run] }, { stored });
  await reopened.choose(); await reopened.finishParse(original);
  await reopened.click(reopened.button('Save test run'));
  assert.deepEqual(Array.from(reopened.window.calls[0].payload.devices[0].channels[0].series[1].points, point => point.excluded), [true, false, true]);
  await reopened.settle();
});

test("saved diagnostic comments show Passed bullets and remain editable in the test run", async t => {
  const run = savedRun();
  const comment = "Wiring check passed.\n\n- Wire-break — Passed\n- Supply voltage — Passed";
  run.devices[0].comment = comment;
  const h = await setup(t, { runs: [run] });
  const region = '[aria-label="Device comment for VALVE-EXAMPLE"]';
  assert.equal(h.query(`${region} p`).textContent, "Wiring check passed.");
  const items = [...h.document.querySelectorAll(`${region} li`)];
  assert.deepEqual(items.map(item => item.textContent), ["Wire-break Passed", "Supply voltage Passed"]);
  assert.ok(items.every(item => item.querySelector('.test-status.passed')?.textContent === "Passed"));
  await h.click(h.button("Edit run"));
  assert.equal(h.query(`${region} textarea`).value, comment);
});

test("run and device comments start a pending edit, retain failed saves, and preserve imported evidence", async t => {
  const run = savedRun({ comment: "Original overall note" });
  run.devices[0].comment = "Original device note";
  run.devices[0].channels[0].comment = "Original tester comment";
  const second = structuredClone(run.devices[0]);
  second.id = "valve-2"; second.name = "VALVE-SECOND"; second.comment = "Second device note";
  run.devices.push(second);
  const before = structuredClone(run);
  const h = await setup(t, { runs: [run] });
  const overall = () => h.query('[aria-label="Overall test run comment"] textarea');
  const device = () => h.query('[aria-label="Device comment for VALVE-EXAMPLE"] textarea');
  assert.equal(overall().value, "Original overall note");
  await h.fill(device(), "Wiring checked.\nRetest required.");
  assert.match(h.text(), /Unsaved preview/);
  assert.equal(h.window.dirty.at(-1), true);
  assert.equal(h.window.calls.length, 0, "typing is pending until Save");
  await h.fill(overall(), "Overall observations\nSecond line");
  await h.click(h.button("VALVE-SECONDPassed"));
  assert.equal(h.query('[aria-label="Device comment for VALVE-SECOND"] textarea').value, "Second device note");
  await h.click(h.button("VALVE-EXAMPLEPassed"));
  assert.equal(device().value, "Wiring checked.\nRetest required.");
  await h.click(h.button("Save test run"));
  const payload = structuredClone(h.window.calls[0].payload);
  assert.equal(payload.id, run.id);
  assert.equal(payload.runVersion, run.runVersion);
  assert.equal(h.window.calls[0].revision, project.revision);
  assert.equal(payload.comment, "Overall observations\nSecond line");
  assert.equal(payload.devices[0].comment, "Wiring checked.\nRetest required.");
  assert.equal(payload.devices[1].comment, "Second device note");
  assert.deepEqual(payload.devices.map(item => item.channels), before.devices.map(item => item.channels));
  assert.equal(h.window.parses.length, 0, "comments do not reimport source files");
  await h.settle("Network interrupted");
  assert.equal(device().value, payload.devices[0].comment);
  await h.click(h.button("Save test run"));
  assert.deepEqual(structuredClone(h.window.calls[1].payload), payload);
  await h.settle();
  assert.equal(h.window.dirty.at(-1), false);
  assert.equal(overall().value, payload.comment);
  assert.deepEqual(run, before, "authoring comments never mutates the loaded snapshot");
});

test("comments survive source rereads and can be discarded or cleared explicitly", async t => {
  const run = savedRun({ comment: "Saved run note" });
  run.devices[0].comment = "Saved device note";
  const h = await setup(t, { runs: [run] });
  const overall = () => h.query('[aria-label="Overall test run comment"] textarea');
  const device = () => h.query('[aria-label="Device comment for VALVE-EXAMPLE"] textarea');
  await h.fill(overall(), "Unsaved run note");
  await h.fill(device(), "Unsaved device note");
  await h.choose();
  await h.finishParse();
  assert.equal(overall().value, "Unsaved run note");
  assert.equal(device().value, "Unsaved device note");
  await h.click(h.button("Discard changes"));
  assert.equal(overall().value, "Saved run note");
  assert.equal(device().value, "Saved device note");
  await h.fill(overall(), "");
  await h.fill(device(), "");
  await h.click(h.button("Save test run"));
  assert.equal(h.window.calls[0].payload.comment, "");
  assert.equal(h.window.calls[0].payload.devices[0].comment, "");
  await h.settle();
});

test("comment edits respect ownership and revision locks while retaining a stale local preview", async t => {
  const run = savedRun({ createdBy: "other-inspector", comment: "Approved overall note" });
  run.devices[0].comment = "Approved device note";
  const h = await setup(t, { runs: [run] });
  assert.equal(h.document.querySelectorAll('.test-comment textarea').length, 0);
  assert.match(h.text(), /Approved device note/);
  await h.configure({ inspector: { id: "inspector-1", isAdmin: true } });
  await h.fill(h.query('[aria-label="Overall test run comment"] textarea'), "Pending local note");
  await h.configure({ readOnly: true, project: { ...project, status: "closed" } });
  assert.equal(h.document.querySelectorAll('.test-comment textarea').length, 0);
  assert.match(h.text(), /Pending local note/);
  assert.equal(h.button("Save test run").disabled, true);
  await h.configure({ readOnly: false, project: { ...project, revision: 5 } });
  await h.click(h.button("Save test run"));
  assert.equal(h.window.calls.length, 0);
  await h.click(h.button("Discard changes"));
  assert.equal(h.query('[aria-label="Overall test run comment"] textarea').value, "Approved overall note");
});

test("overall comments stay with the selected run and support 4,000 Unicode characters", async t => {
  const first = savedRun({ comment: "First run note" });
  const second = savedRun({ id: "run-2", name: "Second run", comment: "Second run note" });
  const h = await setup(t, { runs: [first, second] });
  const select = h.query('.test-run-toolbar select');
  await h.window.act(async () => { select.value = second.id; select.dispatchEvent(new h.window.Event("change", { bubbles: true })); });
  const field = () => h.query('[aria-label="Overall test run comment"] textarea');
  assert.equal(field().value, "Second run note");
  await h.fill(field(), "😀".repeat(4001));
  assert.equal(Array.from(field().value).length, 4000);
  assert.match(h.text(), /4000\/4,000/);
  await h.click(h.button("Save test run"));
  assert.equal(h.window.calls[0].payload.id, "run-2");
  assert.equal(h.window.calls[0].payload.comment, "😀".repeat(4000));
  assert.equal(first.comment, "First run note");
  await h.settle();
});

test("pending comments recover after a new browser window and clear only on successful save or discard", async t => {
  const run = savedRun();
  const h = await setup(t, { runs: [run] });
  await h.fill(h.query('[aria-label="Overall test run comment"] textarea'), "Pending overall\nStill not approved");
  await h.fill(h.query('[aria-label="Device comment for VALVE-EXAMPLE"] textarea'), "Pending device note");
  const stored = h.stored();
  assert.equal(Object.keys(stored).length, 1);
  const cached = JSON.parse(Object.values(stored)[0]);
  assert.equal(cached.comment, "Pending overall\nStill not approved");
  assert.equal(cached.runVersion, run.runVersion);
  assert.equal(cached.data, undefined, "measurement evidence is not duplicated into the text cache");
  await h.unmount();
  assert.deepEqual(h.stored(), stored, "unmount does not clear a pending draft");
  const reopened = await setup(t, { runs: [run] }, { stored });
  assert.match(reopened.text(), /Recovered pending comments/);
  assert.equal(reopened.window.dirty.at(-1), true, "recovery locks approval and navigation immediately");
  assert.equal(reopened.query('[aria-label="Overall test run comment"] textarea').value, cached.comment);
  assert.equal(reopened.query('[aria-label="Device comment for VALVE-EXAMPLE"] textarea').value, "Pending device note");
  assert.equal(reopened.window.calls.length, 0);
  assert.deepEqual(reopened.stored(), stored, "mount never overwrites recovered text");
  await reopened.click(reopened.button("Save test run"));
  assert.equal(reopened.window.calls[0].payload.runVersion, run.runVersion);
  await reopened.settle("Network failure");
  assert.deepEqual(reopened.stored(), stored);
  await reopened.click(reopened.button("Save test run"));
  await reopened.settle();
  assert.deepEqual(reopened.stored(), {});
  assert.equal(reopened.window.dirty.at(-1), false);
  await reopened.unmount();
  assert.deepEqual(reopened.stored(), {}, "save cleanup cannot recreate a cache entry during effects");
  const discarded = await setup(t, { runs: [run] }, { stored });
  await discarded.click(discarded.button("Discard changes"));
  assert.deepEqual(discarded.stored(), {});
  assert.equal(discarded.window.dirty.at(-1), false);
});

test("local comment recovery is isolated by project, inspector, skid, and run", async t => {
  const first = savedRun(), second = savedRun({ id: "run-2", name: "Second saved run" });
  const h = await setup(t, { runs: [first, second] });
  const select = h.query('.test-run-toolbar select');
  await h.window.act(async () => { select.value = second.id; select.dispatchEvent(new h.window.Event("change", { bubbles: true })); });
  await h.fill(h.query('[aria-label="Overall test run comment"] textarea'), "Only the second run");
  const stored = h.stored();
  for (const props of [
    { storageScope: "https://another.supabase.co" },
    { inspector: { id: "inspector-2", isAdmin: true } },
    { project: { ...project, walkdownId: "skid-2" } },
  ]) {
    const isolated = await setup(t, { runs: [first, second], ...props }, { stored });
    assert.equal(isolated.query('[aria-label="Import test run"]'), null);
    assert.doesNotMatch(isolated.text(), /Only the second run/);
    assert.deepEqual(isolated.stored(), stored);
  }
  await h.configure({ inspector: { id: "inspector-2", isAdmin: true } });
  assert.doesNotMatch(h.text(), /Only the second run/);
  await h.configure({ inspector: { id: "inspector-1", isAdmin: false } });
  assert.equal(h.query('[aria-label="Overall test run comment"] textarea').value, "Only the second run");
  await h.click(h.button("Save test run"));
  assert.equal(h.window.calls[0].payload.id, second.id);
  await h.settle();
});

test("recovered stale, removed, closed, and prior-revision comments remain readable without retargeting", async t => {
  const run = savedRun();
  const h = await setup(t, { runs: [run] });
  await h.fill(h.query('[aria-label="Overall test run comment"] textarea'), "Recover this old run text");
  await h.fill(h.query('[aria-label="Device comment for VALVE-EXAMPLE"] textarea'), "Recover this device text");
  const stored = h.stored();
  await h.unmount();
  for (const props of [
    { runs: [{ ...run, runVersion: run.runVersion + 1 }] },
    { runs: [] },
    { runs: [run], readOnly: true, project: { ...project, status: "closed" } },
    { runs: [run], project: { ...project, revision: project.revision + 1 } },
  ]) {
    const reopened = await setup(t, props, { stored });
    assert.match(reopened.text(), /Recover this old run text/);
    assert.match(reopened.text(), /Recover this device text/);
    assert.match(reopened.text(), /closed or changed/);
    assert.equal(reopened.query('.test-comment textarea'), null);
    assert.equal(reopened.button("Save test run").disabled, true);
    assert.equal(reopened.window.dirty.at(-1), true);
    await reopened.click(reopened.button("Save test run"));
    assert.equal(reopened.window.calls.length, 0);
    assert.deepEqual(reopened.stored(), stored);
  }
});

test("new import comments survive reopen and require the matching original files before saving", async t => {
  const h = await setup(t);
  await h.importPreview();
  await h.fill(h.field("Software version"), "3.9");
  await h.fill(h.query('[aria-label="Overall test run comment"] textarea'), "New import note");
  await h.fill(h.query('[aria-label="Device comment for VALVE-EXAMPLE"] textarea'), "Keep this new device note");
  const stored = h.stored(), cached = JSON.parse(Object.values(stored)[0]);
  await h.unmount();
  const reopened = await setup(t, {}, { stored });
  assert.match(reopened.text(), /Reselect the original source files/);
  assert.equal(reopened.query('[aria-label="Overall test run comment"] textarea').value, "New import note");
  assert.equal(reopened.query('[aria-label="Device comment for VALVE-EXAMPLE"] textarea').value, "Keep this new device note");
  assert.equal(reopened.button("Save test run").disabled, true);
  await reopened.choose();
  const wrong = parsedRun(); wrong.sources[0].sha256 = "cd".repeat(32);
  await reopened.finishParse(wrong);
  assert.match(reopened.text(), /do not match the recovered import/);
  assert.equal(reopened.button("Save test run").disabled, true);
  await reopened.choose();
  await reopened.finishParse();
  await reopened.click(reopened.button("Save test run"));
  assert.equal(reopened.window.calls[0].payload.id, cached.id);
  assert.equal(reopened.window.calls[0].payload.runVersion, null);
  assert.equal(reopened.window.calls[0].payload.devices[0].comment, "Keep this new device note");
  await reopened.settle();
  assert.deepEqual(reopened.stored(), {});
});

test("malformed and blocked browser storage cannot erase in-memory comments or trigger a save", async t => {
  const run = savedRun();
  const scope = testCommentDraftScope("https://example.supabase.co", "inspector-1", project.walkdownId);
  const key = testCommentDraftKey(scope, { id: run.id, revision: project.revision });
  const seed = await setup(t, { runs: [run] });
  await seed.fill(seed.query('[aria-label="Overall test run comment"] textarea'), "Valid cached note");
  const valid = JSON.parse(seed.stored()[key]);
  for (const raw of ["{bad-json", JSON.stringify({ ...valid, comment: null }),
    JSON.stringify({ ...valid, comment: "x".repeat(4001) }), JSON.stringify({ ...valid, id: "another-run" })]) {
    const malformed = await setup(t, { runs: [run] }, { stored: { [key]: raw } });
    assert.match(malformed.text(), /draft could not be read/);
    assert.equal(malformed.window.dirty.at(-1), false);
    assert.equal(malformed.stored()[key], raw);
  }
  const blocked = await setup(t, { runs: [run] }, { storageBlocked: true });
  await blocked.fill(blocked.query('[aria-label="Overall test run comment"] textarea'), "Still editable in this tab");
  assert.match(blocked.text(), /could not be cached locally/);
  assert.equal(blocked.query('[aria-label="Overall test run comment"] textarea').value, "Still editable in this tab");
  assert.equal(blocked.window.calls.length, 0);
  await blocked.click(blocked.button("Save test run"));
  await blocked.settle();
  assert.equal(blocked.window.dirty.at(-1), false);
  const quota = await setup(t, { runs: [run] });
  quota.window.Storage.prototype.setItem = () => { throw new Error("Quota exceeded"); };
  await quota.fill(quota.query('[aria-label="Overall test run comment"] textarea'), "Quota-safe in memory");
  assert.match(quota.text(), /could not be cached locally/);
  assert.equal(quota.query('[aria-label="Overall test run comment"] textarea').value, "Quota-safe in memory");
  await quota.click(quota.button("Discard changes"));
  assert.equal(quota.window.dirty.at(-1), false);
});

const rangeInput = offset => String(startMs + offset);
async function applyRange(h, start, end) {
  await h.fill(h.query('input[name="rangeStart"]'), rangeInput(start));
  await h.fill(h.query('input[name="rangeEnd"]'), rangeInput(end));
  await h.click(h.button("Apply time range"));
}

test("slider bounds follow the selected device's longest graph coverage and refresh after pending event edits", async t => {
  const run = eventRun();
  const other = structuredClone(run.devices[0]); other.id = 'other'; other.name = 'OTHER';
  other.channels[0].series[1].points[2].timeMs = run.clock.endMs;
  run.devices.push(other);
  run.devices[0].channels[0].series[1].points.forEach((point, index) => { point.timeMs = startMs + [20_000, 40_000, 80_000][index]; });
  run.devices[0].channels[1].series[0].points[0].timeMs = startMs + 60_000;
  const h = await setup(t, { runs: [run] });
  const bounds = () => ['rangeStart', 'rangeEnd'].map(name => {
    const input = h.query(`input[name="${name}"]`);
    return [Number(input.min) - startMs, Number(input.max) - startMs, input.valueAsNumber - startMs];
  });
  assert.deepEqual(bounds(), [[17_600, 82_400, 17_600], [17_600, 82_400, 82_400]]);
  expectSharedAxis(h, startMs + 17_600, startMs + 82_400);
  await h.click(h.button('Remove event from PD-EXAMPLE, source row 4'));
  assert.deepEqual(bounds(), [[19_000, 61_000, 19_000], [19_000, 61_000, 61_000]]);
  expectSharedAxis(h, startMs + 19_000, startMs + 61_000);
  await h.click(h.button('Restore event from PD-EXAMPLE, source row 4'));
  assert.deepEqual(bounds(), [[17_600, 82_400, 17_600], [17_600, 82_400, 82_400]]);
  expectSharedAxis(h, startMs + 17_600, startMs + 82_400);
  await h.click(h.button('Remove event from feedback state, source row 2'));
  assert.deepEqual(bounds(), [[17_600, 82_400, 17_600], [17_600, 82_400, 82_400]], 'an empty graph does not force the run-wide span');
  expectSharedAxis(h, startMs + 17_600, startMs + 82_400);
  await h.click(h.button('OTHERPassed'));
  assert.equal(Number(h.query('input[name="rangeEnd"]').max), run.clock.endMs);
  expectSharedAxis(h, startMs, run.clock.endMs);
  await h.click(h.button('VALVE-EXAMPLEPassed'));
  assert.deepEqual(bounds(), [[17_600, 82_400, 17_600], [17_600, 82_400, 82_400]]);
  expectSharedAxis(h, startMs + 17_600, startMs + 82_400);
  const stored = h.stored(); await h.unmount();
  const reopened = await setup(t, { runs: [run] }, { stored });
  assert.equal(reopened.query('input[name="rangeEnd"]').valueAsNumber, startMs + 82_400);
  expectSharedAxis(reopened, startMs + 17_600, startMs + 82_400);
  assert.equal(reopened.window.calls.length, 0);
  assert.equal(reopened.window.dirty.at(-1), true);
});

test("saved manual intervals remain available beyond automatic bounds until Reset to auto", async t => {
  const run = savedRun();
  for (const channel of run.devices[0].channels) channel.series[0].points[0].timeMs = startMs + 40_000;
  const scope = testTimeRangeScope('https://example.supabase.co', 'inspector-1', project.walkdownId, project.revision);
  const range = { startMs: startMs + 5000, endMs: startMs + 100_000 };
  const key = scope + encodeURIComponent(JSON.stringify([run.id, 'valve']));
  const h = await setup(t, { runs: [run] }, { stored: { [key]: JSON.stringify(range) } });
  assert.equal(h.query('input[name="rangeStart"]').valueAsNumber, range.startMs);
  assert.equal(Number(h.query('input[name="rangeEnd"]').max), range.endMs);
  for (const plot of h.document.querySelectorAll('svg[data-time-start]')) {
    assert.equal(Number(plot.dataset.timeStart), range.startMs);
    assert.equal(Number(plot.dataset.timeEnd), range.endMs);
  }
  assert.equal(h.window.dirty.at(-1), false);
  await h.click(h.button('Reset to auto'));
  assert.equal(Number(h.query('input[name="rangeStart"]').min), startMs + 39_000);
  assert.equal(h.query('input[name="rangeEnd"]').valueAsNumber, startMs + 41_000);
  expectSharedAxis(h, startMs + 39_000, startMs + 41_000);
  assert.match(h.query('.test-time-axis-heading').textContent, /Automatic/);
  assert.deepEqual(h.stored(), {});
  assert.equal(h.window.calls.length, 0);
});

test("one manual device range aligns every graph without changing comments or creating a report edit", async t => {
  const run = savedRun({ comment: "Keep overall note" });
  run.devices[0].comment = "Keep device note";
  const second = structuredClone(run.devices[0]); second.id = "second"; second.name = "SECOND";
  run.devices.push(second);
  const [current, feedback] = run.devices[0].channels.map(channel => channel.series[0]);
  Object.assign(current, { name: "V-3511-POS", kind: "analog", unit: "mA",
    points: [0, 40_000].map((offset, index) => ({ ...current.points[0], timeMs: startMs + offset, value: index ? 20 : 4 })) });
  feedback.points = [20_000, 40_000, 80_000].map((offset, index) => ({ ...feedback.points[0], timeMs: startMs + offset, value: index % 2 }));
  const before = structuredClone(run);
  const h = await setup(t, { runs: [run] });
  expectSharedAxis(h, startMs, startMs + 82_400);
  await applyRange(h, 10_000, 60_000);
  assert.equal(h.query('input[name="rangeStart"]').valueAsNumber, startMs + 10_000);
  assert.equal(h.query('input[name="rangeEnd"]').valueAsNumber, startMs + 60_000);
  assert.equal(h.document.querySelectorAll('.test-time-slider input[type="range"]').length, 2);
  assert.equal(h.query('input[type="datetime-local"]'), null);
  const plots = expectSharedAxis(h, startMs + 10_000, startMs + 60_000);
  assert.equal(plots.length, 2);
  assert.match(h.query('.test-time-axis-heading').textContent, /Manual/);
  assert.equal(plots[0].querySelector('circle').getAttribute('cx'), plots[1].querySelectorAll('circle')[1].getAttribute('cx'));
  assert.match(h.text(), /1 of 2 recorded change values shown/);
  assert.match(h.text(), /2 of 3 recorded change values shown/);
  assert.equal(h.query('.test-import-form'), null);
  assert.equal(h.window.calls.length, 0);
  assert.equal(h.window.dirty.at(-1), false);
  assert.deepEqual(run, before);
  await h.click(h.button('SECONDPassed'));
  assert.notEqual(h.query('svg[data-time-start]').dataset.timeStart, String(startMs + 10_000));
  expectSharedAxis(h, startMs, startMs + 392_000);
  await h.click(h.button('VALVE-EXAMPLEPassed'));
  assert.equal(h.query('svg[data-time-start]').dataset.timeStart, String(startMs + 10_000));
  expectSharedAxis(h, startMs + 10_000, startMs + 60_000);
  const stored = h.stored();
  await h.unmount();
  const reopened = await setup(t, { runs: [run] }, { stored });
  assert.equal(reopened.query('svg[data-time-start]').dataset.timeStart, String(startMs + 10_000));
  expectSharedAxis(reopened, startMs + 10_000, startMs + 60_000);
  assert.equal(reopened.query('input[name="rangeStart"]').valueAsNumber, startMs + 10_000, 'source-clock coordinates are not shifted by the browser timezone');
  await reopened.fill(reopened.query('input[name="rangeStart"]'), rangeInput(70_000));
  assert.equal(reopened.query('input[name="rangeStart"]').valueAsNumber, startMs + 60_000 - 1, 'start handle cannot cross the end handle');
  await reopened.fill(reopened.query('input[name="rangeEnd"]'), rangeInput(0));
  assert.equal(reopened.query('input[name="rangeEnd"]').valueAsNumber, startMs + 60_000, 'end handle cannot cross the start handle');
  assert.equal(reopened.query('svg[data-time-start]').dataset.timeStart, String(startMs + 10_000));
  await reopened.click(reopened.button('Reset to auto'));
  assert.equal(reopened.query('svg[data-time-start]').dataset.timeStart, String(startMs));
  expectSharedAxis(reopened, startMs, startMs + 82_400);
  assert.match(reopened.query('.test-time-axis-heading').textContent, /Automatic/);
  assert.deepEqual(Object.values(reopened.stored()), [run.devices[0].id], 'reset clears the range and keeps the selected device');
  assert.equal(reopened.query('[aria-label="Device comment for VALVE-EXAMPLE"] textarea').value, before.devices[0].comment);
});

test("slider handles announce source-clock times and preserve millisecond precision across midnight", async t => {
  const midnight = Date.UTC(2026, 10, 20);
  const run = savedRun({ clock: { basis: 'absolute', timeZone: 'UTC', startMs: midnight - 2000, endMs: midnight + 2000 } });
  run.devices[0].channels.forEach(channel => { channel.series[0].points = [{ ...channel.series[0].points[0], timeMs: midnight, value: 1 }]; });
  const h = await setup(t, { runs: [run] });
  await h.fill(h.query('input[name="rangeStart"]'), String(midnight - 125));
  await h.fill(h.query('input[name="rangeEnd"]'), String(midnight + 250));
  assert.equal(h.query('input[name="rangeStart"]').getAttribute('aria-valuetext'), '2026-11-19 23:59:59.875');
  assert.equal(h.query('input[name="rangeEnd"]').getAttribute('aria-valuetext'), '2026-11-20 00:00:00.250');
  assert.match(h.query('.test-time-slider-labels').textContent, /2026-11-19 23:59:59.875/);
  assert.match(h.query('.test-time-slider-labels').textContent, /2026-11-20 00:00:00.250/);
  assert.equal(h.query('svg[data-time-start]').dataset.timeStart, String(midnight - 1000), 'dragging is a preview until Apply');
  await h.click(h.button('Apply time range'));
  assert.equal(h.query('svg[data-time-start]').dataset.timeStart, String(midnight - 125));
  assert.equal(h.query('svg[data-time-start]').dataset.timeEnd, String(midnight + 250));
  assert.equal(h.window.calls.length, 0);
});

test("manual time ranges and pending comment drafts recover independently", async t => {
  const run = savedRun();
  const h = await setup(t, { runs: [run] });
  await h.fill(h.query('[aria-label="Overall test run comment"] textarea'), 'Pending overall review');
  await h.fill(h.query('[aria-label="Device comment for VALVE-EXAMPLE"] textarea'), 'Pending device review');
  const comments = h.stored();
  await applyRange(h, 10_000, 60_000);
  const stored = h.stored();
  assert.equal(Object.keys(stored).length, 2);
  for (const [key, value] of Object.entries(comments)) assert.equal(stored[key], value);
  await h.unmount();
  const reopened = await setup(t, { runs: [run] }, { stored });
  assert.equal(reopened.query('[aria-label="Overall test run comment"] textarea').value, 'Pending overall review');
  assert.equal(reopened.query('[aria-label="Device comment for VALVE-EXAMPLE"] textarea').value, 'Pending device review');
  assert.equal(reopened.query('svg[data-time-start]').dataset.timeEnd, String(startMs + 60_000));
  await reopened.click(reopened.button('Reset to auto'));
  assert.deepEqual(reopened.stored(), comments, 'resetting the view cannot discard pending report comments');
  assert.equal(reopened.window.dirty.at(-1), true);
  assert.equal(reopened.window.calls.length, 0);
});

test("reopening a report restores its last run and device with the applied slider values", async t => {
  const first = savedRun(), second = savedRun({ id: "run-2", name: "Second run" });
  const device = { ...second.devices[0], id: "other", name: "Second device" };
  second.devices.push(device);
  const h = await setup(t, { runs: [first, second] });
  const select = h.query('.test-run-toolbar select');
  await h.window.act(async () => { select.value = second.id; select.dispatchEvent(new h.window.Event("change", { bubbles: true })); });
  await h.click(h.button("Second devicePassed"));
  await applyRange(h, 10_000, 60_000);
  const reopened = await setup(t, { runs: [first, second] }, { stored: h.stored() });
  assert.equal(reopened.query('.test-run-toolbar select').value, second.id);
  assert.equal(reopened.button("Second devicePassed").getAttribute("aria-pressed"), "true");
  assert.equal(reopened.query('input[name="rangeStart"]').valueAsNumber, startMs + 10_000);
  assert.equal(reopened.query('input[name="rangeEnd"]').valueAsNumber, startMs + 60_000);
});

test("a new draft inherits valid slider ranges once from the previous closed revision", async t => {
  const run = savedRun();
  const h = await setup(t, { runs: [run] });
  await applyRange(h, 10_000, 60_000);
  const stored = new Map(Object.entries(h.stored()));
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: key => stored.delete(key),
  };
  const url = 'https://example.supabase.co';
  const next = { ...project, revision: project.revision + 1 };
  const scope = testTimeRangeScope(url, 'inspector-1', next.walkdownId, next.revision);
  const previousScope = testTimeRangeScope(url, 'inspector-1', project.walkdownId, project.revision);
  const report = { inspector: { id: 'inspector-1' }, project: next, revisions: [{ revision: project.revision }], testRuns: [run] };
  try {
    inheritTestTimeRanges(url, report);
    assert.deepEqual(readTestTimeRanges(scope, [run]), readTestTimeRanges(previousScope, [run]));
    const reopened = await setup(t, { runs: [run], project: next }, { stored: Object.fromEntries(stored) });
    assert.equal(reopened.query('input[name="rangeEnd"]').valueAsNumber, startMs + 60_000);
    resetDeviceTimeRange(scope, run.id, 'valve');
    inheritTestTimeRanges(url, report);
    assert.deepEqual(readTestTimeRanges(scope, [run]), {});
    assert.equal(readTestTimeRanges(previousScope, [run])[run.id].valve.endMs, startMs + 60_000);
  } finally {
    if (originalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = originalStorage;
  }
});

test("time ranges remain local and available on approved reports with identity and revision isolation", async t => {
  const run = savedRun();
  const h = await setup(t, { runs: [run], readOnly: true, project: { ...project, status: 'closed' } });
  assert.equal(h.query('.test-comment textarea'), null);
  await applyRange(h, 10_000, 60_000);
  assert.equal(h.window.calls.length, 0);
  const stored = h.stored();
  for (const props of [
    { storageScope: 'https://other.supabase.co' },
    { inspector: { id: 'other-inspector', isAdmin: true } },
    { project: { ...project, walkdownId: 'other-skid' } },
    { project: { ...project, revision: 5 } },
    { runs: [{ ...run, id: 'other-run' }] },
  ]) {
    const isolated = await setup(t, { runs: [run], ...props }, { stored });
    assert.notEqual(isolated.query('svg[data-time-start]').dataset.timeStart, String(startMs + 10_000));
    assert.deepEqual(isolated.stored(), stored);
  }
  const scope = testTimeRangeScope('https://example.supabase.co', 'inspector-1', project.walkdownId, project.revision);
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => stored[key] || null };
  try {
    assert.deepEqual(readTestTimeRanges(scope, [run]), { [run.id]: { valve: { startMs: startMs + 10_000, endMs: startMs + 60_000 } } });
  } finally {
    if (originalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = originalStorage;
  }
});

test("invalid or blocked time-range storage leaves graphs usable and source evidence unchanged", async t => {
  const run = savedRun();
  const h = await setup(t, { runs: [run] });
  await applyRange(h, 10_000, 60_000);
  const stored = h.stored(), key = Object.keys(stored)[0];
  const malformed = await setup(t, { runs: [run] }, { stored: { [key]: '{invalid' } });
  assert.match(malformed.text(), /saved time range could not be read/);
  assert.equal(malformed.query('svg[data-time-start]').dataset.timeStart, String(startMs));
  const stale = await setup(t, { runs: [{ ...run, clock: { ...run.clock, startMs: startMs + 80_000, endMs: startMs + 90_000 },
    devices: [{ ...run.devices[0], channels: [] }] }] }, { stored });
  assert.match(stale.text(), /saved time range no longer matches this run/);
  const blocked = await setup(t, { runs: [run] }, { storageBlocked: true });
  await applyRange(blocked, 10_000, 60_000);
  assert.match(blocked.text(), /could not be saved locally/);
  assert.equal(blocked.query('svg[data-time-start]').dataset.timeStart, String(startMs + 10_000));
  assert.equal(blocked.window.calls.length, 0);
  await blocked.click(blocked.button('Reset to auto'));
  assert.equal(blocked.query('svg[data-time-start]').dataset.timeStart, String(startMs));
});
