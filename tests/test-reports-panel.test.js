import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";

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

async function setup(t, props = {}) {
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
    initialProps: { project, runs: [], inspector: { id: "inspector-1", isAdmin: false }, ...props },
  });
  window.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) };
    }
  };
  window.eval(bundle);
  await window.act(async () => window.mount());
  t.after(async () => {
    await window.act(async () => window.root.unmount());
    window.close();
    assert.deepEqual(errors, [], "no React or DOM errors");
  });
  const document = window.document;
  const h = {
    window, document,
    query: selector => document.querySelector(selector),
    text: () => document.body.textContent.replace(/\s+/g, " "),
    button: name => [...document.querySelectorAll("button")].find(button => button.textContent.trim() === name),
    field: name => [...document.querySelectorAll("label")].find(label => label.textContent.trim() === name)?.querySelector("input"),
    async click(button) { assert.ok(button, "button exists"); await window.act(async () => button.click()); },
    async configure(changes) { await window.act(async () => window.configure(changes)); },
    async fill(input, value) {
      assert.ok(input, "field exists");
      await window.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
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

test("multi-file preview leaves the software version blank and auto-fits each graph before an explicit save", async t => {
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
  assert.equal(charts.length, 2);
  for (const chart of charts) {
    assert.ok(Number(chart.dataset.timeStart) >= startMs);
    assert.ok(Number(chart.dataset.timeEnd) <= startMs + 392_000);
    assert.ok(Number(chart.dataset.timeEnd) - Number(chart.dataset.timeStart) <= 2000);
    assert.equal(chart.querySelectorAll("circle.test-observation").length, 1, "no invented endpoints");
  }
  assert.notEqual(charts[0].dataset.timeStart, charts[1].dataset.timeStart);
  assert.equal(charts[0].querySelectorAll(".test-held-value").length, 1, "an early final reading extends to its graph end");
  assert.equal(charts[1].querySelectorAll(".test-held-value").length, 0, "a reading at the run end needs no extra tail");
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
  assert.match(h.text(), /dashed tail holds the last value to the graph end/);
  assert.equal(series.points.length, 2);
});
