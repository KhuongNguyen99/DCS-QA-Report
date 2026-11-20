import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { testCommentDraftScope, testCommentDraftKey } from "../src/test-comment-drafts.js";

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
            onExport={id => window.exports.push(id)} onReview={() => window.reviews.push(true)} onDirtyChange={dirty} />;
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

async function setup(t, props = {}, { stored = {}, storageBlocked = false } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => errors.push(error.message));
  virtualConsole.on("error", error => errors.push(String(error)));
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  Object.assign(window, {
    IS_REACT_ACT_ENVIRONMENT: true, structuredClone, calls: [], parses: [], dirty: [], exports: [], reviews: [],
    initialProps: { project, runs: [], inspector: { id: "inspector-1", isAdmin: false }, storageScope: "https://example.supabase.co", ...props },
  });
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
    button: name => [...document.querySelectorAll("button")].find(button => button.textContent.trim() === name),
    field: name => [...document.querySelectorAll("label")].find(label => label.textContent.trim() === name)?.querySelector("input"),
    async click(button) { assert.ok(button, "button exists"); await window.act(async () => button.click()); },
    async configure(changes) { await window.act(async () => window.configure(changes)); },
    async fill(input, value) {
      assert.ok(input, "field exists");
      await window.act(async () => {
        const prototype = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
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

test("multi-file preview leaves the software version blank and combines the device signals before an explicit save", async t => {
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
  const charts = [...h.document.querySelectorAll("svg[data-time-start]")];
  assert.equal(charts.length, 1);
  assert.equal(charts[0].dataset.timeStart, String(startMs));
  assert.equal(charts[0].dataset.timeEnd, String(startMs + 392_000));
  assert.equal(charts[0].querySelectorAll("circle.test-observation").length, 2, "no invented endpoints");
  assert.equal(charts[0].querySelectorAll(".test-signal").length, 2);
  assert.equal(charts[0].querySelectorAll(".test-held-value").length, 1, "an early final reading extends to the common device graph end");
  assert.equal(h.document.querySelectorAll('.test-chart-legend li').length, 2);
  await h.click(h.button("Save test run"));
  assert.equal(h.window.calls.length, 0);
  assert.match(h.text(), /software version before saving/);
  await h.fill(h.field("Test run name"), "  Reviewed run  ");
  await h.fill(h.field("Software name"), "  Siemens PRONETA Basic  ");
  await h.fill(h.field("Software version"), "  Tester-entered 8.4  ");
  await h.fill(h.field("Source clock / timezone"), "Source computer clock");
  const save = h.button("Save test run");
  await h.window.act(async () => { save.click(); save.click(); });
  assert.equal(h.window.calls.length, 1, "rapid duplicate clicks cannot submit twice");
  const call = h.window.calls[0];
  assert.equal(call.revision, 4);
  assert.equal(call.payload.runVersion, null);
  assert.equal(call.payload.name, "Reviewed run");
  assert.equal(call.payload.software.version, "Tester-entered 8.4");
  assert.equal(call.payload.clock.timeZone, "Source computer clock");
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
  await h.click(h.button("Save test run"));
  const initialPayload = structuredClone(h.window.calls[0].payload);
  await h.settle("Network interrupted; retry the save.");
  assert.match(h.text(), /Network interrupted/);
  assert.match(h.text(), /Unsaved preview/);
  assert.equal(h.field("Software version").value, "Retained version");
  assert.equal(h.field("Test run name").value, "Retained run");
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
  const h = await setup(t, { runs: [savedRun()] });
  await h.click(h.button("Edit run"));
  assert.equal(h.field("Software version").value, "Entered 1.0");
  await h.fill(h.field("Software version"), "Corrected 1.1");
  await h.click(h.button("Save test run"));
  assert.equal(h.window.parses.length, 0, "metadata edits reuse the normalized saved evidence");
  assert.equal(h.window.calls[0].payload.id, "run-1");
  assert.equal(h.window.calls[0].payload.runVersion, 7);
  assert.equal(h.window.calls[0].payload.software.version, "Corrected 1.1");
  assert.equal(h.window.calls[0].revision, 4);
  await h.settle();
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
  assert.equal(h.document.querySelectorAll("svg[data-time-start]").length, 1);
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
  assert.equal(chart.querySelectorAll(".test-signal").length, 2);
  assert.equal(chart.querySelectorAll("circle.test-observation").length, 3);
  const signal = chart.querySelector(".test-signal");
  const dots = signal.querySelectorAll("circle.test-observation");
  const trace = signal.querySelector(".test-trace");
  const tail = signal.querySelector(".test-held-value");
  assert.equal(dots.length, 2);
  assert.equal(trace.getAttribute("x1"), dots[0].getAttribute("cx"));
  assert.equal(trace.getAttribute("y1"), dots[0].getAttribute("cy"));
  assert.equal(trace.getAttribute("x2"), dots[1].getAttribute("cx"));
  assert.equal(trace.getAttribute("y2"), dots[1].getAttribute("cy"));
  assert.equal(tail.getAttribute("x1"), dots[1].getAttribute("cx"));
  assert.equal(tail.getAttribute("y1"), tail.getAttribute("y2"));
  assert.ok(Number(tail.getAttribute("x2")) > Number(tail.getAttribute("x1")));
  assert.match(h.text(), /Dashed tails hold final values to the graph end/);
  assert.equal(series.points.length, 2);
});

test("a device shows one mixed-unit plot with matching legend colors and aligned signal times", async t => {
  const run = savedRun();
  const [current, feedback] = run.devices[0].channels.map(channel => channel.series[0]);
  Object.assign(current, { name: "V-3511-POS", kind: "analog", unit: "mA" });
  current.points[0].value = 20;
  current.points[0].rawValue = "20 mA";
  feedback.points[0].timeMs = current.points[0].timeMs;
  const before = structuredClone(run);
  const h = await setup(t, { runs: [run] });
  const plots = h.document.querySelectorAll("svg[data-time-start]");
  assert.equal(plots.length, 1);
  const axes = plots[0].querySelectorAll(".test-value-axis");
  assert.deepEqual(Array.from(axes, axis => axis.dataset.unit), ["mA", "State"]);
  assert.deepEqual(Array.from(axes[0].querySelectorAll("text"), label => label.textContent), ["mA", "0", "6.25", "12.5", "18.75", "25"]);
  const signals = plots[0].querySelectorAll(".test-signal");
  const legend = h.document.querySelectorAll(".test-chart-legend li");
  assert.equal(legend.length, 2);
  assert.equal(signals[0].querySelector("circle").getAttribute("cx"), signals[1].querySelector("circle").getAttribute("cx"));
  for (let index = 0; index < signals.length; index++) {
    assert.equal(legend[index].textContent, signals[index].dataset.signal);
    assert.equal(legend[index].querySelector("line").getAttribute("stroke"), signals[index].style.getPropertyValue("--test-trace-color"));
  }
  assert.notEqual(legend[0].querySelector("line").getAttribute("stroke"), legend[1].querySelector("line").getAttribute("stroke"));
  assert.equal(h.window.calls.length, 0);
  assert.deepEqual(run, before, "displaying combined graphs preserves saved evidence");
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
