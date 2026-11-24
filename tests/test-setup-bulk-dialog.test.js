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
  directory = await mkdtemp(join(tmpdir(), "qa-test-setup-bulk-"));
  const output = join(directory, "dialog.js");
  await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "jsx",
      contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import TestSetupBulkDialog from './src/TestSetupBulkDialog.jsx';
        function Harness() {
          const [open, setOpen] = useState(true);
          const [settings, setSettings] = useState({
            readOnly: false, pending: false, remainingSlots: 30,
            scopeKey: 'walkdown:run:revision-1', ...window.initialProps,
          });
          window.configure = (next) => setSettings((previous) => ({ ...previous, ...next }));
          function onPhoto(photo) {
            setSettings((previous) => ({ ...previous, pending: true }));
            return new Promise((resolve, reject) => {
              window.saves.push({
                ...photo,
                resolve() {
                  setSettings((previous) => ({ ...previous, pending: false,
                    remainingSlots: previous.remainingSlots - (window.syncCapacity ? 1 : 0) }));
                  resolve({ id: 'saved-' + window.saves.length });
                },
                reject(error) {
                  setSettings((previous) => ({ ...previous, pending: false }));
                  reject(error);
                },
              });
            });
          }
          return open
            ? <TestSetupBulkDialog runName="Commissioning run" skidName="Skid 7"
                {...settings} onPhoto={onPhoto} onClose={() => setOpen(false)}
                onDirtyChange={(dirty) => window.dirtyChanges.push(dirty)} />
            : <p>Bulk upload closed.</p>;
        }
        window.act = React.act;
        window.root = createRoot(document.getElementById('root'));
        window.mount = () => window.root.render(<React.StrictMode><Harness /></React.StrictMode>);
      `,
    },
    bundle: true, format: "iife", outfile: output,
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "without-css", setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
    } }],
    logLevel: "silent",
  });
  bundle = await readFile(output, "utf8");
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function setup(t, initialProps = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  virtualConsole.on("error", (error) => errors.push(String(error)));
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url: "http://localhost/", runScripts: "outside-only",
    pretendToBeVisual: true, virtualConsole,
  });
  const window = dom.window;
  const document = window.document;
  Object.assign(window, {
    IS_REACT_ACT_ENVIRONMENT: true, initialProps,
    saves: [], dirtyChanges: [], confirmations: [], confirmResult: true,
    objectUrls: new Set(), decoded: 0, closedBitmaps: 0,
    deferDecode: false, decodeJobs: [], syncCapacity: true,
  });
  window.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) };
    }
  };
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  let nextUrl = 0;
  window.URL.createObjectURL = () => {
    const url = `blob:setup-bulk-${++nextUrl}`;
    window.objectUrls.add(url);
    return url;
  };
  window.URL.revokeObjectURL = (url) => window.objectUrls.delete(url);
  const bitmap = () => ({ width: 1200, height: 800, close() { window.closedBitmaps += 1; } });
  window.createImageBitmap = async (file) => {
    window.decoded += 1;
    if (!window.deferDecode) return bitmap();
    return new Promise((resolve) => window.decodeJobs.push({ file, resolve: () => resolve(bitmap()) }));
  };
  window.HTMLCanvasElement.prototype.getContext = () => ({
    drawImage() {}, save() {}, translate() {}, rotate() {}, restore() {},
  });
  window.HTMLCanvasElement.prototype.toBlob = (callback, type) =>
    callback(new window.Blob(["normalized-jpeg"], { type }));
  window.confirm = (message) => {
    window.confirmations.push(message);
    return window.confirmResult;
  };
  window.eval(bundle);
  await window.act(async () => window.mount());
  t.after(async () => {
    await window.act(async () => window.root.unmount());
    dom.window.close();
    assert.deepEqual(errors, [], "no React or DOM errors");
    assert.equal(window.objectUrls.size, 0, "preview object URLs are released");
  });

  const query = (selector) => document.querySelector(selector);
  const input = () => query("textarea");
  function createFile(value) {
    if (typeof value !== "string") return value;
    return new window.File(["image"], value, {
      type: value.endsWith(".pdf") ? "application/pdf" : "image/png",
    });
  }
  return {
    window, document, query, input,
    text: () => document.body.textContent.replace(/\s+/g, " "),
    button: (name) => [...document.querySelectorAll("button")].find((button) =>
      button.textContent.trim() === name || button.getAttribute("aria-label") === name),
    async click(button) {
      assert.ok(button, "button exists");
      await window.act(async () => button.click());
    },
    async configure(settings) { await window.act(async () => window.configure(settings)); },
    async files(names) {
      const picker = query('input[type="file"]');
      await window.act(async () => {
        Object.defineProperty(picker, "files", { configurable: true, value: names.map(createFile) });
        picker.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    },
    async drop(names) {
      await window.act(async () => {
        const event = new window.Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: { files: names.map(createFile) } });
        query(".bulk-content").dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
      });
    },
    async fill(value) {
      await window.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(input(), value);
        input().dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    },
    async key(key, options = {}) {
      let event;
      await window.act(async () => {
        event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
        input().dispatchEvent(event);
      });
      return event;
    },
    async composition(type) {
      await window.act(async () => input().dispatchEvent(new window.CompositionEvent(type, { bubbles: true })));
    },
    async finishDecode(index = window.decodeJobs.length - 1) {
      await window.act(async () => window.decodeJobs[index].resolve());
    },
    async settleSave(error = null) {
      await window.act(async () => {
        const save = window.saves.at(-1);
        if (error) save.reject(new Error(error));
        else save.resolve();
      });
    },
  };
}

test("bulk setup photos save explicit multiline captions, decode lazily, and complete while parent pending changes", async (t) => {
  const h = await setup(t);
  await h.files(["first.png", "second.png"]);
  assert.equal(h.window.decoded, 1, "only the current image is decoded");
  assert.equal(h.window.objectUrls.size, 1);
  assert.equal(h.window.dirtyChanges.at(-1), true);
  await h.fill("  Power supply connected\nFront of panel  ");
  assert.equal((await h.key("Enter")).defaultPrevented, false, "ordinary Enter belongs to the multiline caption");
  assert.equal(h.window.saves.length, 0);
  await h.key("Enter", { ctrlKey: true });
  await h.key("Enter", { ctrlKey: true, repeat: true });
  assert.equal(h.window.saves.length, 1);
  assert.equal(h.window.saves[0].caption, "Power supply connected\nFront of panel");
  assert.equal(h.window.saves[0].name, "first.jpg");
  assert.equal(h.window.saves[0].blob.type, "image/jpeg");
  assert.equal(h.button("Close bulk upload").disabled, true);
  await h.settleSave();
  assert.equal(h.window.decoded, 2);
  assert.equal(h.window.objectUrls.size, 1, "previous preview released before the next image");
  assert.equal(h.input().value, "");
  assert.equal(h.document.activeElement, h.input());
  await h.key("Enter", { metaKey: true });
  assert.equal(h.window.saves[1].caption, "", "caption is optional");
  await h.settleSave();
  assert.match(h.text(), /All photos reviewed/);
  assert.match(h.text(), /2 photos saved to Commissioning run/);
  assert.equal(h.window.objectUrls.size, 0);
  assert.equal(h.window.closedBitmaps, 2);
  assert.equal(h.window.dirtyChanges.at(-1), false);
  await h.click(h.button("Done"));
  assert.equal(h.window.confirmations.length, 0);
  assert.match(h.text(), /Bulk upload closed/);
});

test("failed saves keep the same image and caption for retry and cannot be submitted twice", async (t) => {
  const h = await setup(t);
  await h.files(["panel.png"]);
  await h.fill("Top connector after wiring");
  await h.click(h.button("Save & next"));
  await h.key("Enter", { ctrlKey: true });
  assert.equal(h.window.saves.length, 1);
  await h.settleSave("Connection interrupted. Retry this photo.");
  assert.match(h.text(), /Connection interrupted/);
  assert.equal(h.input().value, "Top connector after wiring");
  assert.equal(h.window.dirtyChanges.at(-1), true);
  await h.click(h.button("Save & next"));
  assert.equal(h.window.saves.length, 2);
  assert.equal(h.window.saves[1].blob, h.window.saves[0].blob, "retry reuses the reviewed pixels");
  assert.equal(h.window.saves[1].caption, h.window.saves[0].caption);
  assert.equal(h.window.decoded, 1);
  await h.settleSave();
  assert.match(h.text(), /1 photo saved to Commissioning run/);
});

test("skipped photos retain captions and rotation and remain guarded against accidental discard", async (t) => {
  const h = await setup(t);
  await h.files(["first.png", "second.png"]);
  await h.fill("Rotated panel view");
  await h.click(h.button("Rotate photo right"));
  await h.click(h.button("Skip for now"));
  await h.fill("Second setup view");
  await h.click(h.button("Skip for now"));
  assert.match(h.text(), /2 photos skipped and still unsaved/);
  assert.equal(h.window.dirtyChanges.at(-1), true);
  const unload = new h.window.Event("beforeunload", { cancelable: true });
  h.window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  h.window.confirmResult = false;
  await h.click(h.button("Close upload"));
  assert.match(h.window.confirmations[0], /Discard 2 photos.*skipped photos and captions/);
  assert.ok(h.query("dialog"), "canceling discard keeps the review queue");
  await h.click(h.button("Review skipped photos"));
  assert.equal(h.input().value, "Rotated panel view");
  await h.click(h.button("Save & next"));
  assert.equal(h.window.saves[0].width, 800);
  assert.equal(h.window.saves[0].height, 1200);
  await h.settleSave();
  assert.equal(h.input().value, "Second setup view");
  h.window.confirmResult = true;
  await h.click(h.button("Close bulk upload"));
  assert.match(h.window.confirmations.at(-1), /Discard 1 photo/);
  assert.equal(h.window.saves.length, 1, "closing never uploads skipped or pending photos");
  assert.equal(h.window.objectUrls.size, 0);
  assert.equal(h.window.dirtyChanges.at(-1), false);
});

test("rotation invalidates prepared pixels immediately and composition cannot trigger a save", async (t) => {
  const h = await setup(t);
  await h.files(["panel.png"]);
  await h.fill("Keep this caption through rotation");
  h.window.deferDecode = true;
  await h.key(">", { ctrlKey: true });
  await h.key("Enter", { ctrlKey: true });
  assert.equal(h.window.saves.length, 0, "cannot save stale pixels while rotation is preparing");
  assert.equal(h.input().value, "Keep this caption through rotation");
  await h.finishDecode();
  await h.composition("compositionstart");
  await h.key("Enter", { ctrlKey: true });
  await h.key("<", { ctrlKey: true });
  assert.equal(h.window.saves.length, 0);
  assert.equal(h.window.decoded, 2, "IME key events cannot rotate the image");
  await h.composition("compositionend");
  await h.key("Enter", { ctrlKey: true, repeat: true });
  assert.equal(h.window.saves.length, 0);
  await h.key("Enter", { ctrlKey: true });
  assert.equal(h.window.saves[0].width, 800);
  assert.equal(h.window.saves[0].height, 1200);
  assert.equal(h.window.saves[0].caption, "Keep this caption through rotation");
  await h.settleSave();
});

test("validation and live capacity allow only available photos without double-counting completed saves", async (t) => {
  const h = await setup(t, { remainingSlots: 3 });
  const large = new h.window.File(["image"], "oversized.png", { type: "image/png" });
  Object.defineProperty(large, "size", { value: 20 * 1024 * 1024 + 1 });
  const empty = new h.window.File([], "empty.png", { type: "image/png" });
  await h.drop(["unsupported.pdf", large, empty, "first.png", "second.png"]);
  assert.match(h.text(), /3 photos could not be added/);
  assert.match(h.text(), /under 20 MB/);
  assert.match(h.text(), /This photo is empty/);
  assert.match(h.text(), /0 saved · 2 awaiting review/);
  assert.equal(h.window.decoded, 1);
  await h.click(h.button("Save & next"));
  await h.settleSave();
  assert.equal(h.button("Add more photos").disabled, false, "parent live capacity already accounts for the completed save");
  await h.files(["third.png", "over-capacity.png"]);
  assert.match(h.text(), /1 photo could not be added/);
  assert.match(h.text(), /No more spaces in this batch/);
  assert.equal(h.button("Add more photos").disabled, true);
  await h.click(h.button("Save & next"));
  await h.settleSave();
  assert.equal(h.button("Save & next").disabled, false, "the final reserved slot remains usable");
  await h.click(h.button("Save & next"));
  await h.settleSave();
  assert.equal(h.window.saves.length, 3);
  assert.match(h.text(), /3 photos saved to Commissioning run/);
  assert.match(h.text(), /No photo slots remain/);
});

test("local completion still enforces the limit when the parent refresh is delayed", async (t) => {
  const h = await setup(t, { remainingSlots: 2 });
  h.window.syncCapacity = false;
  await h.files(["first.png", "second.png"]);
  await h.click(h.button("Save & next"));
  await h.settleSave();
  assert.equal(h.button("Add more photos").disabled, true);
  await h.drop(["third.png"]);
  assert.match(h.text(), /No more spaces in this batch/);
  await h.click(h.button("Save & next"));
  await h.settleSave();
  assert.equal(h.window.saves.length, 2);
  assert.equal(h.button("Add more photos").disabled, true);
});

test("read-only, pending and changed report scopes block writes without losing the caption", async (t) => {
  const h = await setup(t);
  h.window.deferDecode = true;
  await h.files(["first.png"]);
  await h.fill("Pending setup caption");
  await h.configure({ readOnly: true });
  await h.finishDecode();
  await h.key("Enter", { ctrlKey: true });
  await h.drop(["rejected-while-locked.png"]);
  assert.equal(h.window.saves.length, 0);
  assert.equal(h.input().readOnly, true);
  assert.match(h.text(), /1 awaiting review/);
  await h.configure({ readOnly: false, pending: true });
  assert.equal(h.input().disabled, true);
  await h.key("Enter", { ctrlKey: true });
  assert.equal(h.window.saves.length, 0);
  await h.configure({ pending: false, scopeKey: "walkdown:another-run:revision-1" });
  await h.key("Enter", { ctrlKey: true });
  assert.equal(h.window.saves.length, 0);
  assert.match(h.text(), /selected test report or revision changed/);
  assert.equal(h.input().value, "Pending setup caption");
  assert.equal(h.window.dirtyChanges.at(-1), true);
});

test("preview failure can be retried and a late decode after closing releases its resources", async (t) => {
  const h = await setup(t);
  const encode = h.window.HTMLCanvasElement.prototype.toBlob;
  h.window.HTMLCanvasElement.prototype.toBlob = (callback) => callback(null);
  await h.files(["first.png"]);
  await h.fill("Caption remains after preview error");
  assert.ok(h.button("Retry preview"));
  assert.equal(h.button("Save & next").disabled, true);
  h.window.HTMLCanvasElement.prototype.toBlob = encode;
  h.window.deferDecode = true;
  await h.click(h.button("Retry preview"));
  assert.equal(h.input().value, "Caption remains after preview error");
  await h.click(h.button("Close bulk upload"));
  await h.finishDecode();
  assert.match(h.text(), /Bulk upload closed/);
  assert.equal(h.window.saves.length, 0);
  assert.equal(h.window.objectUrls.size, 0);
  assert.equal(h.window.closedBitmaps, 2);
});
