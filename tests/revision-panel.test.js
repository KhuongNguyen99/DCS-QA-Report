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
  directory = await mkdtemp(join(tmpdir(), "qc-revision-panel-test-"));
  const output = join(directory, "panel.js");
  await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "jsx",
      contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import RevisionPanel from './src/RevisionPanel.jsx';
        function Harness() {
          const [props, setProps] = useState(window.initialProps);
          window.configure = (changes) => setProps(previous => ({ ...previous, ...changes }));
          const call = (kind, value) => new Promise((resolve, reject) =>
            window.calls.push({ kind, value, resolve, reject }));
          return <RevisionPanel {...props} onApprove={value => call('approve', value)}
            onNewRevision={value => call('new', value)} onExport={value => call('export', value)}
            onExportTests={value => call('test-export', value)} />;
        }
        window.act = React.act;
        window.root = createRoot(document.getElementById('root'));
        window.mount = () => window.root.render(<React.StrictMode><Harness /></React.StrictMode>);
      `,
    },
    bundle: true, jsx: "automatic", format: "iife", outfile: output,
    define: { "process.env.NODE_ENV": '"development"' }, logLevel: "silent",
  });
  bundle = await readFile(output, "utf8");
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const draft = {
  walkdownId: "11111111-1111-4111-8111-111111111111", skidName: "Skid 2",
  revision: 4, contentVersion: 9, status: "draft",
};
const closed = {
  ...draft, status: "closed", closedAt: "2026-11-19T17:10:00Z", closedByName: "Kong",
};

async function setup(t, props = {}) {
  const errors = [];
  const console = new VirtualConsole();
  console.on("jsdomError", error => errors.push(error.message));
  console.on("error", error => errors.push(String(error)));
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: console,
  });
  const { window } = dom;
  Object.assign(window, {
    IS_REACT_ACT_ENVIRONMENT: true, calls: [],
    initialProps: {
      project: draft, revisions: [], photoCount: 6, commentCount: 2,
      completedCount: 3, targetCount: 39, ...props,
    },
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
    dom.window.close();
    assert.deepEqual(errors, [], "no React or DOM errors");
  });
  return {
    window, document: window.document,
    button(name) {
      return [...window.document.querySelectorAll("button")].find(button =>
        button.textContent.trim() === name || button.getAttribute("aria-label") === name);
    },
    async click(button) { assert.ok(button, "button exists"); await window.act(async () => button.click()); },
    async configure(changes) { await window.act(async () => window.configure(changes)); },
    async settle(error) {
      await window.act(async () => error ? window.calls.at(-1).reject(new Error(error)) : window.calls.at(-1).resolve());
    },
  };
}

test("approval captures the reviewed revision/version and rejects a changed review before submission", async t => {
  const h = await setup(t);
  assert.equal(h.button("New revision"), undefined);
  await h.click(h.button("Approve & close"));
  assert.equal(h.window.calls.length, 0, "reviewing is not approval");
  assert.match(h.document.querySelector('[aria-label="Confirm report approval"]').textContent, /6 photos, 2 comments, 3\/39 items reviewed/);
  await h.configure({ project: { ...draft, contentVersion: 10 }, photoCount: 7 });
  assert.equal(h.button("Confirm approval & close").disabled, true);
  assert.match(h.document.querySelector('[role="alert"]').textContent, /report changed/);
  await h.click(h.button("Confirm approval & close"));
  assert.equal(h.window.calls.length, 0);
  await h.click(h.button("Cancel"));
  await h.click(h.button("Approve & close"));
  const confirm = h.button("Confirm approval & close");
  await h.window.act(async () => { confirm.click(); confirm.click(); });
  assert.equal(h.window.calls.length, 1, "one approval for repeated clicks");
  assert.equal(h.window.calls[0].kind, "approve");
  assert.deepEqual(JSON.parse(JSON.stringify(h.window.calls[0].value)), {
    walkdownId: draft.walkdownId, revision: 4, contentVersion: 10, skidName: "Skid 2",
    photoCount: 7, commentCount: 2, completedCount: 3, testRunCount: 0,
  });
  await h.settle();
  assert.equal(h.document.querySelector('[aria-label="Confirm report approval"]'), null);
});

test("pending saves and unposted comments block approval, including an already open confirmation", async t => {
  const h = await setup(t, { hasDraftComments: true });
  assert.equal(h.button("Approve & close").disabled, true);
  assert.match(h.document.body.textContent, /Post or clear your draft comments/);
  await h.click(h.button("Approve & close"));
  assert.equal(h.document.querySelector('[aria-label="Confirm report approval"]'), null);
  await h.configure({ hasDraftComments: false, pending: true });
  assert.equal(h.button("Approve & close").disabled, true);
  await h.configure({ pending: false });
  await h.click(h.button("Approve & close"));
  await h.configure({ hasDraftComments: true });
  assert.equal(h.button("Confirm approval & close").disabled, true);
  await h.configure({ hasDraftComments: false, pending: true });
  assert.equal(h.button("Confirm approval & close").disabled, true);
  await h.configure({ pending: false });
  await h.click(h.button("Confirm approval & close"));
  await h.settle("Another inspector changed this report. Refresh and review again.");
  assert.match(h.document.querySelector('[role="alert"]').textContent, /Another inspector changed/);
  assert.equal(h.button("Confirm approval & close").disabled, false);
  assert.ok(h.document.querySelector('[aria-label="Confirm report approval"]'), "failure keeps review visible");
});

test("closed revisions allow an explicit new draft and export the requested historical number", async t => {
  const h = await setup(t, {
    project: closed,
    revisions: [{ ...closed, revision: 3, skidName: "Previous skid name" }, closed],
  });
  assert.equal(h.button("Approve & close"), undefined);
  assert.match(h.document.body.textContent, /Approved & closed/);
  assert.match(h.document.body.textContent, /Approved by Kong/);
  await h.click(h.button("Export revision 3"));
  assert.equal(h.window.calls[0].kind, "export");
  assert.equal(h.window.calls[0].value, 3);
  assert.equal(h.button("New revision").disabled, true);
  await h.settle();
  await h.click(h.button("New revision"));
  assert.equal(h.window.calls[1].kind, "new");
  assert.equal(h.window.calls[1].value, 4);
  await h.settle();
  await h.configure({ project: { ...draft, revision: 5, contentVersion: 1 } });
  assert.equal(h.button("New revision"), undefined);
  assert.equal(h.button("Approve & close").disabled, false);
  assert.ok(h.button("Export revision 3"), "earlier closed versions remain exportable while drafting");
});

test("unknown revision state never enables approval or a new revision", async t => {
  const h = await setup(t, { project: { ...draft, status: undefined } });
  assert.equal(h.button("Approve & close"), undefined);
  assert.equal(h.button("New revision"), undefined);
  assert.match(h.document.querySelector('[role="alert"]').textContent, /needs the report revision update/);
});

test("unsaved test imports block approval and closed test exports keep their revision", async t => {
  const h = await setup(t, { hasDraftTests: true, testRunCount: 2 });
  assert.equal(h.button("Approve & close").disabled, true);
  assert.match(h.document.body.textContent, /Save or discard your test run changes/);
  await h.configure({ hasDraftTests: false });
  await h.click(h.button("Approve & close"));
  assert.match(h.document.querySelector('[aria-label="Confirm report approval"]').textContent, /2 test runs/);
  await h.configure({ hasDraftTests: true });
  assert.equal(h.button("Confirm approval & close").disabled, true);
  await h.click(h.button("Cancel"));
  await h.configure({ project: closed, hasDraftTests: false, revisions: [{ ...closed, revision: 3, testRunCount: 1 }, { ...closed, testRunCount: 0 }] });
  assert.equal(h.button("Export test reports revision 4"), undefined);
  await h.click(h.button("Export test reports revision 3"));
  assert.equal(h.window.calls.at(-1).kind, "test-export");
  assert.equal(h.window.calls.at(-1).value, 3);
  await h.settle();
});
