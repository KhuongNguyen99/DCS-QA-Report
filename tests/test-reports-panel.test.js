import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { testCommentDraftScope, testCommentDraftKey } from "../src/test-comment-drafts.js";
import { testTimeRangeScope, readTestTimeRanges } from "../src/test-time-ranges.js";

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
    button: name => [...document.querySelectorAll("button")].find(button => button.textContent.trim() === name || button.getAttribute('aria-label') === name),
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
  const charts = [...h.document.querySelectorAll("svg[data-time-start]")];
  assert.equal(charts.length, 2);
  assert.equal(charts[0].dataset.timeStart, String(startMs));
  assert.equal(charts[0].dataset.timeEnd, String(startMs + 1000));
  assert.equal(charts[1].dataset.timeStart, String(startMs + 391_000));
  assert.equal(charts[1].dataset.timeEnd, String(startMs + 392_000));
  assert.ok(charts.every(chart => chart.querySelectorAll("circle.test-observation").length === 1), "no invented endpoints");
  assert.equal(charts[0].querySelectorAll(".test-held-value").length, 1, "the final reading extends only to its own fitted graph end");
  assert.equal(h.document.querySelectorAll('.test-device-content .test-comment').length, 1);
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
  assert.ok(Number(plots[0].dataset.timeEnd) < Number(plots[1].dataset.timeStart), "each graph fits only its own signal's observations");
  const comments = h.document.querySelectorAll('.test-device-content .test-comment');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].querySelector('textarea').value, "One comment for the entire device");
  assert.equal(h.document.querySelectorAll('[aria-label="Overall test run comment"]').length, 1);
  assert.equal(h.window.calls.length, 0);
  assert.deepEqual(run, before, "splitting the graphs preserves saved evidence and comments");
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
  await h.click(h.button('Remove event from PD-EXAMPLE, source row 4'));
  assert.deepEqual(bounds(), [[19_000, 61_000, 19_000], [19_000, 61_000, 61_000]]);
  await h.click(h.button('Restore event from PD-EXAMPLE, source row 4'));
  assert.deepEqual(bounds(), [[17_600, 82_400, 17_600], [17_600, 82_400, 82_400]]);
  await h.click(h.button('Remove event from feedback state, source row 2'));
  assert.deepEqual(bounds(), [[17_600, 82_400, 17_600], [17_600, 82_400, 82_400]], 'an empty graph does not force the run-wide span');
  await h.click(h.button('OTHERPassed'));
  assert.equal(Number(h.query('input[name="rangeEnd"]').max), run.clock.endMs);
  await h.click(h.button('VALVE-EXAMPLEPassed'));
  assert.deepEqual(bounds(), [[17_600, 82_400, 17_600], [17_600, 82_400, 82_400]]);
  const stored = h.stored(); await h.unmount();
  const reopened = await setup(t, { runs: [run] }, { stored });
  assert.equal(reopened.query('input[name="rangeEnd"]').valueAsNumber, startMs + 82_400);
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
  await applyRange(h, 10_000, 60_000);
  assert.equal(h.query('input[name="rangeStart"]').valueAsNumber, startMs + 10_000);
  assert.equal(h.query('input[name="rangeEnd"]').valueAsNumber, startMs + 60_000);
  assert.equal(h.document.querySelectorAll('.test-time-slider input[type="range"]').length, 2);
  assert.equal(h.query('input[type="datetime-local"]'), null);
  const plots = h.document.querySelectorAll('svg[data-time-start]');
  assert.equal(plots.length, 2);
  for (const plot of plots) {
    assert.equal(plot.dataset.timeStart, String(startMs + 10_000));
    assert.equal(plot.dataset.timeEnd, String(startMs + 60_000));
  }
  assert.equal(plots[0].querySelector('circle').getAttribute('cx'), plots[1].querySelectorAll('circle')[1].getAttribute('cx'));
  assert.match(h.text(), /1 of 2 recorded change values shown/);
  assert.match(h.text(), /2 of 3 recorded change values shown/);
  assert.equal(h.query('.test-import-form'), null);
  assert.equal(h.window.calls.length, 0);
  assert.equal(h.window.dirty.at(-1), false);
  assert.deepEqual(run, before);
  await h.click(h.button('SECONDPassed'));
  assert.notEqual(h.query('svg[data-time-start]').dataset.timeStart, String(startMs + 10_000));
  await h.click(h.button('VALVE-EXAMPLEPassed'));
  assert.equal(h.query('svg[data-time-start]').dataset.timeStart, String(startMs + 10_000));
  const stored = h.stored();
  await h.unmount();
  const reopened = await setup(t, { runs: [run] }, { stored });
  assert.equal(reopened.query('svg[data-time-start]').dataset.timeStart, String(startMs + 10_000));
  assert.equal(reopened.query('input[name="rangeStart"]').valueAsNumber, startMs + 10_000, 'source-clock coordinates are not shifted by the browser timezone');
  await reopened.fill(reopened.query('input[name="rangeStart"]'), rangeInput(70_000));
  assert.equal(reopened.query('input[name="rangeStart"]').valueAsNumber, startMs + 60_000 - 1, 'start handle cannot cross the end handle');
  await reopened.fill(reopened.query('input[name="rangeEnd"]'), rangeInput(0));
  assert.equal(reopened.query('input[name="rangeEnd"]').valueAsNumber, startMs + 60_000, 'end handle cannot cross the start handle');
  assert.equal(reopened.query('svg[data-time-start]').dataset.timeStart, String(startMs + 10_000));
  await reopened.click(reopened.button('Reset to auto'));
  assert.equal(reopened.query('svg[data-time-start]').dataset.timeStart, String(startMs));
  assert.deepEqual(reopened.stored(), {});
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
