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
  directory = await mkdtemp(join(tmpdir(), "qc-setup-photos-"));
  const output = join(directory, "setup.js");
  await build({
    stdin: { resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "jsx", contents: `
      import React, { useCallback, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import TestSetupPhotos from './src/PhotoGallery.jsx';
      function Harness() {
        const [props, setProps] = useState(window.initialProps);
        window.configure = changes => setProps(previous => ({ ...previous, ...changes }));
        const dirty = useCallback(value => window.dirty.push(value), []);
        const getPhotoUrl = useCallback(photo => {
          window.urlRequests.push(photo.id);
          return Promise.resolve('https://private.example/' + photo.id + '.jpg');
        }, []);
        const add = useCallback((run, normalized, revision) => new Promise((resolve, reject) => {
          window.calls.push({ kind: 'add', run, normalized, revision, resolve, reject });
        }).then(photo => {
          setProps(previous => previous.run.id === run.id && previous.revision === revision
            ? { ...previous, run: { ...previous.run, setupPhotos: [...(previous.run.setupPhotos || []), photo] } }
            : previous);
          return photo;
        }), []);
        const update = useCallback((run, photo, caption, revision) => new Promise((resolve, reject) => {
          window.calls.push({ kind: 'caption', run, photo, caption, revision, resolve, reject });
        }).then(saved => {
          setProps(previous => previous.run.id === run.id && previous.revision === revision
            ? { ...previous, run: { ...previous.run, setupPhotos: previous.run.setupPhotos.map(item => item.id === photo.id ? saved : item) } }
            : previous);
          return saved;
        }), []);
        const remove = useCallback((run, photo, revision) => new Promise((resolve, reject) => {
          window.calls.push({ kind: 'remove', run, photo, revision, resolve, reject });
        }).then(() => setProps(previous => previous.run.id === run.id && previous.revision === revision
          ? { ...previous, run: { ...previous.run, setupPhotos: previous.run.setupPhotos.filter(item => item.id !== photo.id) } }
          : previous)), []);
        const reorder = useCallback((run, orderedIds, expectedIds, revision) => new Promise((resolve, reject) => {
          window.calls.push({ kind: 'order', run, orderedIds, expectedIds, revision, resolve, reject });
        }).then(saved => {
          setProps(previous => previous.run.id === run.id && previous.revision === revision
            ? { ...previous, run: { ...previous.run, setupPhotos: saved } } : previous);
          return saved;
        }), []);
        return <TestSetupPhotos {...props} getPhotoUrl={getPhotoUrl} onDirtyChange={dirty}
          onAddPhoto={add} onUpdatePhoto={update} onRemovePhoto={remove} onReorderPhotos={reorder} />;
      }
      window.act = React.act;
      window.root = createRoot(document.getElementById('root'));
      window.mount = () => window.root.render(<React.StrictMode><Harness /></React.StrictMode>);
    ` },
    bundle: true, format: "iife", outfile: output, define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "styles", setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
    } }], logLevel: "silent",
  });
  bundle = await readFile(output, "utf8");
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const photo = (id, caption = "") => ({ id, walkdownId: "skid-1", testRunId: "run-1", path: `private/${id}.jpg`, name: `${id}.jpg`,
  width: 1200, height: 800, caption, createdBy: "inspector-1", createdAt: "2026-11-20T12:00:00Z" });
const run = photos => ({ id: "run-1", walkdownId: "skid-1", name: "Control box I/O test", setupPhotos: photos });

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
    IS_REACT_ACT_ENVIRONMENT: true, calls: [], dirty: [], urlRequests: [], decodeJobs: [], deferDecode: false, decoded: 0, closedBitmaps: 0,
    initialProps: { run: run([]), revision: 4, ...props },
  });
  window.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) };
    }
  };
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  let nextObjectUrl = 0;
  window.URL.createObjectURL = () => `blob:setup-preview-${++nextObjectUrl}`;
  window.URL.revokeObjectURL = () => {};
  const bitmap = () => ({ width: 1200, height: 800, close: () => { window.closedBitmaps += 1; } });
  window.createImageBitmap = async file => {
    window.decoded += 1;
    if (!window.deferDecode) return bitmap();
    return new Promise(resolve => window.decodeJobs.push({ file, resolve: () => resolve(bitmap()) }));
  };
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, save() {}, translate() {}, rotate() {}, restore() {} });
  window.HTMLCanvasElement.prototype.toBlob = (callback, type) => callback(new window.Blob(["normalized-jpeg"], { type }));
  window.eval(bundle);
  await window.act(async () => window.mount());
  t.after(async () => {
    await window.act(async () => window.root.unmount());
    window.close();
    assert.deepEqual(errors, [], "no React or DOM errors");
  });
  const document = window.document;
  return {
    window, document,
    query: selector => document.querySelector(selector),
    text: () => document.body.textContent.replace(/\s+/g, " "),
    button: label => [...document.querySelectorAll("button")].find(button => button.textContent.trim() === label || button.getAttribute('aria-label') === label),
    async click(button) { assert.ok(button, "button exists"); await window.act(async () => button.click()); },
    async configure(changes) { await window.act(async () => window.configure(changes)); },
    async fill(value) {
      const textarea = document.querySelector("textarea");
      assert.ok(textarea);
      await window.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(textarea, value);
        textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    },
    async choose(names) {
      const input = document.querySelector('dialog input[type="file"]') || document.querySelector('input[type="file"]');
      assert.ok(input);
      await window.act(async () => {
        Object.defineProperty(input, "files", { configurable: true, value: names.map(name => new window.File(["image"], name, { type: "image/jpeg" })) });
        input.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    },
    async settle(index, error = null) {
      const call = window.calls[index];
      assert.ok(call);
      const saved = call.kind === "add" ? { ...photo(`photo-${index + 1}`, call.normalized.caption || ""), name: call.normalized.name }
        : call.kind === "caption" ? { ...call.photo, caption: call.caption }
          : call.kind === 'order' ? call.orderedIds.map(id => call.run.setupPhotos.find(photo => photo.id === id)) : undefined;
      await window.act(async () => error ? call.reject(new Error(error)) : call.resolve(saved));
    },
  };
}

test("setup photos upload sequentially with progress, private previews, and an accessible full-image view", async t => {
  const h = await setup(t);
  assert.equal(h.query('input[type="file"]').multiple, true);
  await h.choose(["wiring.jpg", "pneumatics.jpg"]);
  assert.equal(h.window.calls.length, 1);
  assert.equal(h.window.calls[0].normalized.name, "wiring.jpg");
  assert.equal(h.window.calls[0].normalized.blob.type, "image/jpeg");
  assert.equal(h.window.calls[0].revision, 4);
  assert.equal(h.window.dirty.at(-1), true);
  assert.match(h.text(), /Uploading setup photo 1 of 2/);
  await h.configure({ pending: true });
  await h.settle(0);
  assert.equal(h.window.calls.length, 2, "parent pending during our own callback must not stop the batch");
  assert.equal(h.window.calls[1].normalized.name, "pneumatics.jpg");
  await h.configure({ pending: false });
  await h.settle(1);
  assert.equal(h.document.querySelectorAll(".test-setup-photo").length, 2);
  assert.match(h.text(), /2 setup photos saved/);
  assert.equal(h.window.dirty.at(-1), false);
  assert.equal(h.window.closedBitmaps, 2);
  assert.ok(h.window.urlRequests.includes("photo-1"));
  const thumbnail = h.query(".test-setup-thumbnail");
  thumbnail.focus();
  await h.click(thumbnail);
  assert.ok(h.query("dialog[open]"));
  assert.match(h.query("dialog").textContent, /Setup photo 1 of 2/);
  assert.equal(h.document.activeElement.getAttribute("aria-label"), "Close setup photo");
  await h.window.act(async () => h.query("dialog").dispatchEvent(new h.window.Event("cancel", { cancelable: true })));
  assert.equal(h.query("dialog"), null);
  assert.equal(h.document.activeElement, thumbnail);
});

test("a partial upload preserves successes and retries only the remaining files", async t => {
  const h = await setup(t);
  await h.choose(["first.jpg", "second.jpg", "third.jpg"]);
  await h.settle(0);
  await h.settle(1, "Upload offline");
  assert.equal(h.document.querySelectorAll(".test-setup-photo").length, 1);
  assert.equal(h.window.calls.length, 2);
  assert.match(h.text(), /1 photo was saved.*second.jpg: Upload offline/);
  assert.match(h.text(), /2 photos remain to upload: second.jpg, third.jpg/);
  assert.equal(h.window.dirty.at(-1), true);
  await h.click(h.button("Retry remaining photos"));
  assert.equal(h.window.calls[2].normalized.name, "second.jpg");
  await h.settle(2);
  assert.equal(h.window.calls[3].normalized.name, "third.jpg");
  await h.settle(3);
  assert.equal(h.document.querySelectorAll(".test-setup-photo").length, 3);
  assert.equal(h.window.dirty.at(-1), false);
  assert.equal(h.window.calls.filter(call => call.normalized.name === "first.jpg").length, 1);
});

test("caption edits preserve failed drafts and support removing a caption", async t => {
  const h = await setup(t, { run: run([photo("wiring", "Original caption")]) });
  await h.click(h.button("Edit caption"));
  assert.equal(h.query("textarea").maxLength, 1000);
  await h.fill("Updated test setup");
  assert.equal(h.window.dirty.at(-1), true);
  await h.click(h.button("Save caption"));
  assert.equal(h.window.calls[0].photo.caption, "Original caption", "expected caption must remain pinned for optimistic concurrency");
  await h.settle(0, "Photo changed since opening");
  assert.equal(h.query("textarea").value, "Updated test setup");
  assert.match(h.text(), /Photo changed since opening/);
  await h.fill("");
  await h.click(h.button("Save caption"));
  assert.equal(h.window.calls[1].caption, "");
  await h.settle(1);
  assert.equal(h.query("textarea"), null);
  assert.ok(h.button("Add caption"));
  assert.equal(h.window.dirty.at(-1), false);
  assert.equal(h.query(".test-setup-caption"), null);
});

test("removal is confirmed once, keeps evidence on failure, and is hidden in a closed revision", async t => {
  const h = await setup(t, { run: run([photo("wiring", "Setup")]) });
  await h.click(h.button("Remove photo"));
  const confirm = h.button("Confirm removal");
  await h.window.act(async () => { confirm.click(); confirm.click(); });
  assert.equal(h.window.calls.length, 1);
  assert.equal(h.window.calls[0].kind, "remove");
  await h.settle(0, "Could not remove photo");
  assert.equal(h.document.querySelectorAll(".test-setup-photo").length, 1);
  await h.click(h.button("Confirm removal"));
  await h.settle(1);
  assert.equal(h.document.querySelectorAll(".test-setup-photo").length, 0);
  await h.configure({ readOnly: true, run: run([photo("archived", "Approved setup")]) });
  assert.equal(h.button("Add setup photos"), undefined);
  assert.equal(h.button("Edit caption"), undefined);
  assert.equal(h.button("Remove photo"), undefined);
  assert.equal(h.query('input[type="file"]'), null);
  await h.click(h.query(".test-setup-thumbnail"));
  assert.match(h.query("dialog").textContent, /Approved setup/);
});

test("closing during normalization prevents a late upload and lets the user discard remaining local files", async t => {
  const h = await setup(t);
  h.window.deferDecode = true;
  await h.choose(["first.jpg", "second.jpg"]);
  assert.equal(h.window.decodeJobs.length, 1);
  await h.configure({ readOnly: true });
  await h.window.act(async () => h.window.decodeJobs[0].resolve());
  assert.equal(h.window.calls.length, 0);
  assert.match(h.text(), /revision is closed or changed/);
  assert.equal(h.button("Retry remaining photos").disabled, true);
  await h.click(h.button("Discard remaining photos"));
  assert.equal(h.window.dirty.at(-1), false);
});

test("a changed run or revision stops the old batch after its in-flight save", async t => {
  const h = await setup(t);
  await h.choose(["first.jpg", "second.jpg"]);
  await h.configure({ revision: 5, run: { ...run([]), id: "run-2" } });
  await h.settle(0);
  assert.equal(h.window.calls.length, 1, "no remaining image may be written into a new scope");
  assert.equal(h.document.querySelectorAll(".test-setup-photo").length, 0);
  assert.equal(h.window.dirty.at(-1), false);
  assert.equal(h.query(".test-setup-retry"), null);
});

test("the setup photo limit is checked before image processing or server writes", async t => {
  const h = await setup(t, { run: run(Array.from({ length: 29 }, (_, index) => photo(`saved-${index}`))) });
  await h.choose(["one.jpg", "two.jpg"]);
  assert.equal(h.window.calls.length, 0);
  assert.equal(h.window.decoded, 0);
  assert.match(h.text(), /Choose at most 1 more/);
  assert.equal(h.window.dirty.at(-1), false);
});

test("bulk review saves each image and caption together in the selected run, including while the parent refreshes", async t => {
  const h = await setup(t, { skidName: "Skid 101", run: run(Array.from({ length: 28 }, (_, index) => photo(`saved-${index}`))) });
  await h.click(h.button("Bulk upload photos"));
  assert.match(h.query("dialog").textContent, /Skid 101.*Control box I\/O test/);
  await h.choose(["wiring.jpg", "air-supply.jpg"]);
  assert.equal(h.window.calls.length, 0, "selecting files must not upload before review");
  assert.equal(h.window.dirty.at(-1), true);
  await h.fill("  Wiring checked before the test  ");
  await h.click(h.button("Save & next"));
  assert.equal(h.window.calls.length, 1);
  assert.equal(h.window.calls[0].normalized.name, "wiring.jpg");
  assert.equal(h.window.calls[0].normalized.caption, "Wiring checked before the test");
  assert.equal(h.window.calls[0].run.id, "run-1");
  assert.equal(h.window.calls[0].run.walkdownId, "skid-1");
  assert.equal(h.window.calls[0].revision, 4);
  await h.configure({ pending: true });
  await h.settle(0);
  assert.match(h.query("dialog").textContent, /1 saved.*1 awaiting review/);
  assert.equal(h.query("dialog textarea").value, "", "the next image has its own caption");
  assert.equal(h.button("Save & next").disabled, true);
  await h.configure({ pending: false });
  await h.fill("Air supply at the test bench");
  await h.click(h.button("Save & next"));
  assert.equal(h.window.calls[1].normalized.caption, "Air supply at the test bench");
  await h.settle(1);
  assert.match(h.query("dialog").textContent, /All photos reviewed/);
  assert.equal(h.document.querySelectorAll(".test-setup-photo").length, 30);
  assert.deepEqual(h.window.calls.map(call => call.kind), ["add", "add"], "captions need no follow-up mutation");
  assert.equal(h.window.dirty.at(-1), true, "the parent stays locked until the review dialog closes");
  await h.click(h.button("Done"));
  assert.equal(h.query("dialog"), null);
  assert.equal(h.window.dirty.at(-1), false);
  assert.equal(h.button("Bulk upload photos").disabled, true, "saved photos consume the remaining capacity");
  assert.match(h.text(), /Wiring checked before the test/);
  assert.match(h.text(), /Air supply at the test bench/);
});

test("a bulk upload failure keeps the reviewed caption and permits a single retry", async t => {
  const h = await setup(t);
  await h.click(h.button("Bulk upload photos"));
  await h.choose(["wiring.jpg"]);
  await h.fill("Connections verified");
  await h.click(h.button("Save & next"));
  await h.settle(0, "Connection lost");
  assert.match(h.query("dialog").textContent, /Connection lost/);
  assert.equal(h.query("dialog textarea").value, "Connections verified");
  assert.equal(h.document.querySelectorAll(".test-setup-photo").length, 0);
  const retry = h.button("Save & next");
  await h.window.act(async () => { retry.click(); retry.click(); });
  assert.equal(h.window.calls.length, 2, "rapid retry clicks must start one upload");
  assert.equal(h.window.calls[1].normalized.caption, "Connections verified");
  await h.settle(1);
  await h.click(h.button("Done"));
  assert.equal(h.document.querySelectorAll(".test-setup-photo").length, 1);
  assert.equal(h.window.dirty.at(-1), false);
});

test("bulk review cannot upload into a closed or changed revision and is not added to inspection evidence", async t => {
  const h = await setup(t);
  await h.click(h.button("Bulk upload photos"));
  await h.choose(["wiring.jpg", "air-supply.jpg"]);
  await h.fill("Pending review");
  await h.configure({ readOnly: true });
  assert.equal(h.button("Save & next").disabled, true);
  assert.equal(h.query("dialog textarea").value, "Pending review");
  await h.click(h.button("Save & next"));
  assert.equal(h.window.calls.length, 0);
  await h.configure({ readOnly: false, revision: 5, run: { ...run([]), id: "run-2" } });
  assert.equal(h.query("dialog"), null);
  assert.equal(h.window.calls.length, 0);
  assert.equal(h.window.dirty.at(-1), false);
  await h.configure({ kind: "inspection" });
  assert.equal(h.button("Bulk upload photos"), undefined);
});

const displayedNames = h => Array.from(h.document.querySelectorAll('.test-setup-photo-body > .test-setup-filename'), e => e.textContent);

async function dragPhoto(h, from, to) {
  const cards = h.document.querySelectorAll('.test-setup-photo');
  const transfer = { effectAllowed: '', dropEffect: '', setData() {} };
  await h.window.act(async () => {
    const thumbnail = cards[from].querySelector('.test-setup-thumbnail');
    assert.equal(thumbnail.draggable, true);
    for (const [target, name] of [[thumbnail, 'dragstart'], [cards[to], 'dragover'], [cards[to], 'drop']]) {
      const event = new h.window.Event(name, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
      target.dispatchEvent(event);
    }
  });
}

test('moving a photo saves immediately and a failed save restores the saved order', async t => {
  const original = run([photo('a', 'First caption'), photo('b'), photo('c')]);
  const h = await setup(t, { run: original });
  await dragPhoto(h, 0, 1);
  assert.deepEqual(displayedNames(h), ['b.jpg', 'a.jpg', 'c.jpg']);
  assert.equal(h.window.calls.length, 1);
  assert.equal(h.button('Add setup photos').disabled, true);
  const call = h.window.calls[0];
  assert.deepEqual(Array.from(call.expectedIds), ['a', 'b', 'c']);
  assert.deepEqual(Array.from(call.orderedIds), ['b', 'a', 'c']);
  assert.equal(call.revision, 4);
  assert.equal(h.query('.test-setup-thumbnail').draggable, false);
  await h.settle(0, 'Photo order changed on another device');
  assert.deepEqual(displayedNames(h), ['a.jpg', 'b.jpg', 'c.jpg']);
  assert.match(h.text(), /Photo order changed on another device/);
  await dragPhoto(h, 0, 1);
  await h.settle(1);
  assert.deepEqual(displayedNames(h), ['b.jpg', 'a.jpg', 'c.jpg']);
  assert.equal(h.window.dirty.at(-1), false);
  assert.deepEqual(original.setupPhotos.map(photo => photo.id), ['a', 'b', 'c']);
  assert.match(h.text(), /First caption/);
});

test('dropping a photo thumbnail onto another position saves the new order without confirmation', async t => {
  const h = await setup(t, { run: run([photo('a'), photo('b'), photo('c')]) });
  await dragPhoto(h, 0, 2);
  assert.deepEqual(displayedNames(h), ['b.jpg', 'c.jpg', 'a.jpg']);
  assert.equal(h.window.calls.length, 1);
  assert.deepEqual(Array.from(h.window.calls[0].orderedIds), ['b', 'c', 'a']);
  assert.equal(h.button('Save photo order'), undefined);
  assert.equal(h.button('Discard photo order'), undefined);
  assert.equal(h.query('.test-setup-order-controls'), null);
  await h.settle(0);
  assert.deepEqual(displayedNames(h), ['b.jpg', 'c.jpg', 'a.jpg']);
  assert.equal(h.window.dirty.at(-1), false);
});

test('a concurrently closed gallery shows the saved order while a move resolves', async t => {
  const original = run([photo('a'), photo('b'), photo('c')]);
  const h = await setup(t, { run: original });
  await dragPhoto(h, 0, 1);
  await h.configure({ run: original, readOnly: true });
  assert.deepEqual(displayedNames(h), ['a.jpg', 'b.jpg', 'c.jpg']);
  assert.equal(h.query('.test-setup-thumbnail').draggable, false);
  await h.settle(0, 'This revision is closed');
  assert.deepEqual(displayedNames(h), ['a.jpg', 'b.jpg', 'c.jpg']);
});

test('a late photo order save cannot reorder another revision', async t => {
  const original = run([photo('a'), photo('b')]);
  const h = await setup(t, { run: original });
  await dragPhoto(h, 0, 1);
  await h.configure({ revision: 5 });
  await h.settle(0);
  assert.deepEqual(displayedNames(h), ['a.jpg', 'b.jpg']);
  assert.equal(h.window.calls[0].revision, 4);
  assert.equal(h.window.dirty.at(-1), false);
});
