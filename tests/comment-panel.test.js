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
  directory = await mkdtemp(join(tmpdir(), "qc-comments-test-"));
  const output = join(directory, "comments.js");
  await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      loader: "jsx",
      contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import CommentPanel from './src/CommentPanel.jsx';
        import OverviewTable from './src/OverviewTable.jsx';
        import schedule from './src/data/schedule.json';
        function Harness() {
          const [options, setOptions] = useState(window.initialOptions);
          const [comments, setComments] = useState(window.initialComments);
          const [draft, setDraft] = useState('Unsaved draft');
          window.configure = (changes) => setOptions(previous => ({ ...previous, ...changes }));
          function onDelete(id) {
            return new Promise((resolve, reject) => window.removals.push({
              id, reject,
              resolve: () => { setComments(current => current.filter(item => item.id !== id)); resolve(); },
            }));
          }
          function onPost(text) {
            return new Promise((resolve, reject) => window.posts.push({ text, resolve, reject }));
          }
          return options.overview ? <OverviewTable schedule={schedule}
            state={{ records: [], photos: [], comments: [], project: { revision: 4 } }}
            connected={options.connected} readOnly={options.readOnly}
            onQuality={(...args) => window.quality.push(args)}
            onOpen={(...args) => window.opened.push(args)} onStart={(...args) => window.started.push(args)} />
            : <CommentPanel recordKey="device:V-3541" comments={comments}
                draft={draft} onDraft={setDraft} onPost={onPost} onDelete={onDelete}
                connected={options.connected} readOnly={options.readOnly} inspector={options.inspector} />;
        }
        window.act = React.act;
        window.root = createRoot(document.getElementById('root'));
        window.mount = () => window.root.render(<React.StrictMode><Harness /></React.StrictMode>);
      `,
    },
    bundle: true,
    jsx: "automatic",
    format: "iife",
    outfile: output,
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{
      name: "isolated-comments",
      setup(builder) {
        builder.onResolve({ filter: /[\\/]VoiceComment\.jsx$/ }, () => ({ path: "voice", namespace: "test" }));
        builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents: `import React from 'react'; export default function VoiceComment({ disabled }) {
            return <button type="button" disabled={disabled}>Record voice comment</button>;
          }`, loader: "jsx", resolveDir: fileURLToPath(new URL("..", import.meta.url)),
        }));
      },
    }],
    logLevel: "silent",
  });
  bundle = await readFile(output, "utf8");
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function setup(t, options = {}) {
  const errors = [];
  const console = new VirtualConsole();
  console.on("jsdomError", error => errors.push(error.message));
  console.on("error", error => errors.push(String(error)));
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: console,
  });
  const window = dom.window;
  const document = window.document;
  Object.assign(window, {
    IS_REACT_ACT_ENVIRONMENT: true,
    initialOptions: { connected: true, readOnly: false, inspector: { id: "me", isAdmin: false }, ...options },
    initialComments: [
      { id: "mine", createdBy: "me", authorName: "Kong", createdAt: "2026-11-19T16:00:00Z", text: "My inspection note" },
      { id: "other", createdBy: "someone-else", authorName: "Other inspector", createdAt: "2026-11-19T17:00:00Z", text: "Another inspector's note" },
    ],
    removals: [], posts: [], quality: [], opened: [], started: [],
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
    window, document,
    button: (name) => [...document.querySelectorAll("button")].find(button =>
      button.textContent.trim() === name || button.getAttribute("aria-label") === name),
    async click(button) {
      assert.ok(button, "button exists");
      await window.act(async () => button.click());
    },
    async configure(changes) { await window.act(async () => window.configure(changes)); },
    async settleRemoval(error) {
      await window.act(async () => error ? window.removals.at(-1).reject(new Error(error)) : window.removals.at(-1).resolve());
    },
  };
}

test("comment authors confirm removal once, retain their draft, and cannot remove another inspector's comment", async t => {
  const h = await setup(t);
  assert.ok(h.button("Remove comment by Kong"));
  assert.equal(h.button("Remove comment by Other inspector"), undefined);
  await h.click(h.button("Remove comment by Kong"));
  assert.equal(h.window.removals.length, 0);
  await h.click(h.button("Cancel"));
  assert.equal(h.window.removals.length, 0);
  await h.click(h.button("Remove comment by Kong"));
  const confirm = h.button("Remove comment");
  await h.window.act(async () => { confirm.click(); confirm.click(); });
  assert.equal(h.window.removals.length, 1, "double clicks cannot remove twice");
  assert.equal(h.window.removals[0].id, "mine");
  assert.equal(h.button("Removing…").disabled, true);
  assert.equal(h.button("Add comment").disabled, true);
  await h.settleRemoval();
  assert.doesNotMatch(h.document.body.textContent, /My inspection note/);
  assert.match(h.document.body.textContent, /Another inspector's note/);
  assert.equal(h.document.querySelector("textarea").value, "Unsaved draft");
});

test("administrators can remove comments, and failure retains the comment for an explicit retry", async t => {
  const h = await setup(t, { inspector: { id: "admin", isAdmin: true } });
  await h.click(h.button("Remove comment by Other inspector"));
  await h.click(h.button("Remove comment"));
  await h.settleRemoval("Revision changed. Refresh before editing.");
  assert.match(h.document.querySelector('[role="alert"]').textContent, /Revision changed/);
  assert.match(h.document.body.textContent, /Another inspector's note/);
  assert.equal(h.button("Remove comment").disabled, false);
  await h.click(h.button("Remove comment"));
  assert.equal(h.window.removals.length, 2);
  await h.settleRemoval();
  assert.doesNotMatch(h.document.body.textContent, /Another inspector's note/);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});

test("closing a revision cancels a pending confirmation and removes all comment editing controls", async t => {
  const h = await setup(t);
  await h.click(h.button("Remove comment by Kong"));
  await h.configure({ readOnly: true });
  assert.equal(h.document.querySelector("textarea"), null);
  assert.equal(h.document.querySelector("form"), null);
  assert.equal(h.document.querySelectorAll("button").length, 0);
  assert.equal(h.window.removals.length, 0);
  assert.equal(h.window.posts.length, 0);
  assert.match(h.document.body.textContent, /My inspection note/);
  await h.configure({ readOnly: false });
  assert.equal(h.document.querySelector('[aria-label="Remove comment confirmation"]'), null);
  assert.equal(h.document.querySelector("textarea").value, "Unsaved draft");
  await h.configure({ connected: false });
  assert.equal(h.button("Remove comment by Kong"), undefined);
  assert.equal(h.button("Add comment").disabled, true);
  await h.window.act(async () => h.document.querySelector("form").dispatchEvent(
    new h.window.Event("submit", { bubbles: true, cancelable: true }),
  ));
  assert.equal(h.window.posts.length, 0, "disconnected submission is guarded in the handler");
});

test("closed overview keeps records readable and disables quality and documentation actions", async t => {
  const h = await setup(t, { overview: true, readOnly: true });
  assert.match(h.document.body.textContent, /QC Revision 4/);
  assert.doesNotMatch(h.document.body.textContent, /QA|Start documenting/);
  assert.ok(h.document.querySelector('input[aria-label^="Passed quality for"]'));
  assert.ok(h.document.querySelector('input[aria-label^="Failed quality for"]'));
  const qualityInputs = [...h.document.querySelectorAll('input[type="checkbox"]')];
  assert.ok(qualityInputs.length > 0);
  assert.ok(qualityInputs.every(input => input.disabled));
  await h.click(h.button("Open record"));
  assert.equal(h.window.opened.length, 1);
  assert.equal(h.window.started.length, 0);
  assert.equal(h.window.quality.length, 0);
});
