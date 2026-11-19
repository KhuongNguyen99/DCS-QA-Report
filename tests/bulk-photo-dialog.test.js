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

// Keep OCR and network completion under test control. Image normalization and
// the real component still run, without loading WASM or writing shared evidence.
const mockOcr = `
export function createOcrSession(onProgress = () => {}) {
  window.ocrSessions += 1;
  const pending = new Set();
  let disposed = false;
  const cancel = () => {
    for (const job of pending) {
      if (!window.keepCancelledOcr.has(job.name))
        job.reject(new DOMException('Cancelled', 'AbortError'));
    }
  };
  return {
    async recognize(file) {
      let job;
      const result = new Promise((resolve, reject) => {
        job = { name: file.name, resolve, reject };
        pending.add(job);
        window.ocrCalls.push(job);
      });
      onProgress({ status: 'recognizing text', progress: 0.5 });
      try { return await result; } finally { pending.delete(job); }
    },
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      window.ocrDisposed += 1;
      cancel();
    },
  };
}
`;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "qa-bulk-photo-test-"));
  const output = join(directory, "dialog.js");
  await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      loader: "jsx",
      contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import BulkPhotoDialog from './src/BulkPhotoDialog.jsx';
        import { inspectionTargets } from './src/domain.js';
        import schedule from './src/data/schedule.json';
        const targets = inspectionTargets(schedule);
        function Harness() {
          const [open, setOpen] = useState(true);
          function onPhoto(key, photo) {
            return new Promise((resolve, reject) => {
              window.saves.push({
                key, name: photo.name, width: photo.width, height: photo.height,
                bytes: photo.blob.size, resolve, reject,
              });
            });
          }
          return open
            ? <BulkPhotoDialog targets={targets} skidName="Test skid"
                onPhoto={onPhoto} onClose={() => setOpen(false)} />
            : <p>Bulk upload closed.</p>;
        }
        window.act = React.act;
        window.root = createRoot(document.getElementById('root'));
        window.mount = () => window.root.render(
          <React.StrictMode><Harness /></React.StrictMode>
        );
      `,
    },
    bundle: true,
    format: "iife",
    outfile: output,
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{
      name: "isolated-dialog",
      setup(builder) {
        builder.onResolve({ filter: /[\\/]ocr\.js$/ }, () => ({
          path: "ocr", namespace: "test",
        }));
        builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents: mockOcr, loader: "js",
        }));
        builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      },
    }],
    logLevel: "silent",
  });
  bundle = await readFile(output, "utf8");
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function setup(t) {
  const errors = [];
  const console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error.message));
  console.on("error", (error) => errors.push(String(error)));
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url: "http://localhost/", runScripts: "outside-only",
    pretendToBeVisual: true, virtualConsole: console,
  });
  const window = dom.window;
  const document = window.document;
  Object.assign(window, {
    IS_REACT_ACT_ENVIRONMENT: true,
    ocrCalls: [], ocrSessions: 0, ocrDisposed: 0, keepCancelledOcr: new Set(),
    saves: [], objectUrls: new Set(), decoded: 0, closedBitmaps: 0,
  });
  // React's browser act scheduler needs MessageChannel; jsdom omits it.
  window.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) };
    }
  };
  window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  let nextUrl = 0;
  window.URL.createObjectURL = () => {
    const url = `blob:test-${++nextUrl}`;
    window.objectUrls.add(url);
    return url;
  };
  window.URL.revokeObjectURL = (url) => window.objectUrls.delete(url);
  window.createImageBitmap = async () => {
    window.decoded += 1;
    return { width: 1200, height: 800, close: () => { window.closedBitmaps += 1; } };
  };
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  window.HTMLCanvasElement.prototype.toBlob = (callback, type) =>
    callback(new window.Blob(["normalized-jpeg"], { type }));
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.confirm = () => true;
  window.eval(bundle);
  await window.act(async () => window.mount());
  t.after(async () => {
    await window.act(async () => window.root.unmount());
    dom.window.close();
    assert.deepEqual(errors, [], "no React or DOM errors");
  });

  const query = (selector) => document.querySelector(selector);
  const input = () => query('[role="combobox"]');
  return {
    window, document, query, input,
    text: () => document.body.textContent.replace(/\s+/g, " "),
    button: (name) => [...document.querySelectorAll("button")].find((button) =>
      button.textContent.trim() === name || button.getAttribute("aria-label") === name),
    async click(button) {
      assert.ok(button, "button exists");
      await window.act(async () => button.click());
    },
    async files(names) {
      const picker = query('input[type="file"]');
      const files = names.map((name) => new window.File(["photo"], name, {
        type: name.endsWith(".pdf") ? "application/pdf" : "image/png",
      }));
      await window.act(async () => {
        Object.defineProperty(picker, "files", { configurable: true, value: files });
        picker.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    },
    async fill(value) {
      await window.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
          .set.call(input(), value);
        input().dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    },
    async key(key, options = {}) {
      let event;
      await window.act(async () => {
        event = new window.KeyboardEvent("keydown", {
          key, bubbles: true, cancelable: true, ...options,
        });
        input().dispatchEvent(event);
      });
      return event;
    },
    async read(text, index = window.ocrCalls.length - 1) {
      await window.act(async () => window.ocrCalls[index].resolve(text));
    },
    async ocrFailure() {
      await window.act(async () => window.ocrCalls.at(-1).reject(new Error("OCR failed")));
    },
    async settleSave(error = null) {
      await window.act(async () => {
        const save = window.saves.at(-1);
        if (error) save.reject(new Error(error));
        else save.resolve({ id: `saved-${window.saves.length}` });
      });
    },
  };
}

test("bulk naming requires explicit acceptance, saves once, and clears/focuses the next image", async (t) => {
  const h = await setup(t);
  await h.files(["first.png", "second.png"]);
  await h.read("V-3541");
  assert.equal(h.input().value, "");
  assert.equal(h.input().placeholder, "V-3541");
  await h.key("Enter");
  assert.equal(h.window.saves.length, 0);
  assert.match(h.text(), /Press Tab/);
  assert.equal((await h.key("Tab", { shiftKey: true })).defaultPrevented, false);
  assert.equal(h.input().value, "");
  await h.key("Tab");
  assert.equal(h.input().value, "V-3541");
  await h.key("Enter");
  await h.key("Enter");
  await h.key("Enter", { repeat: true });
  assert.equal(h.window.saves.length, 1);
  assert.equal(h.window.saves[0].key, "device:V-3541");
  await h.settleSave();
  assert.equal(h.input().value, "");
  assert.equal(h.document.activeElement, h.input());
  await h.fill("C");
  await h.key("Enter");
  assert.equal(h.window.saves[1].key, "terminal:C");
  await h.settleSave();
  assert.match(h.text(), /All photos reviewed/);
  assert.match(h.text(), /2 photos saved/);
  assert.equal(h.window.objectUrls.size, 0);
});

test("late OCR cannot replace a browsed option or a typed canonical name", async (t) => {
  const h = await setup(t);
  await h.files(["first.png", "second.png"]);
  await h.key("ArrowDown");
  assert.match(h.query('[role="option"][aria-selected="true"]').textContent, /Control Box/);
  await h.read("V-3541");
  assert.match(h.query('[role="option"][aria-selected="true"]').textContent, /Control Box/);
  await h.key("Enter");
  assert.equal(h.window.saves[0].key, "equipment:control-box");
  await h.settleSave();
  await h.fill("V-3511-Y");
  await h.read("V-3541");
  assert.equal(h.input().value, "V-3511-Y");
  await h.key("Enter");
  assert.equal(h.window.saves[1].key, "device:V-3511-Y");
  await h.settleSave();
});

test("failed saves retain the image and name, restore focus, and allow a deliberate retry", async (t) => {
  const h = await setup(t);
  await h.files(["first.png", "second.png"]);
  await h.fill("Terminal B");
  const save = h.button("Save & next");
  save.focus();
  await h.click(save);
  await h.settleSave("Upload interrupted");
  assert.match(h.text(), /Upload interrupted/);
  assert.match(h.text(), /0 saved · 2 remaining/);
  assert.match(h.text(), /Photo 1 of 2/);
  assert.equal(h.input().value, "Terminal B");
  assert.equal(h.document.activeElement, h.input());
  assert.equal(h.window.objectUrls.size, 1);
  await h.key("Enter");
  await h.key("Enter");
  assert.equal(h.window.saves.length, 2, "only one additional upload for the retry");
  assert.equal(h.window.saves[1].name, "first.jpg");
  assert.equal(h.window.saves[1].key, "terminal:B");
  await h.settleSave();
  assert.match(h.text(), /1 saved · 1 remaining/);
});

test("skipped photos remain reviewable and stale OCR cannot affect the next photo", async (t) => {
  const h = await setup(t);
  h.window.keepCancelledOcr.add("first.png");
  await h.files(["first.png", "second.png"]);
  await h.click(h.button("Skip photo"));
  await h.read("Terminal B", 1);
  await h.read("V-3541", 0);
  assert.equal(h.input().placeholder, "Terminal B");
  assert.equal(h.input().value, "");
  await h.key("Tab");
  await h.key("Enter");
  assert.equal(h.window.saves[0].name, "second.jpg");
  await h.settleSave();
  assert.match(h.text(), /1 skipped and not uploaded/);
  await h.click(h.button("Review skipped photos"));
  await h.fill("Control Box");
  await h.key("Enter");
  assert.equal(h.window.saves[1].name, "first.jpg");
  await h.settleSave();
  assert.equal(h.window.objectUrls.size, 0);
});

test("ambiguous labels and unknown names do not save; IME and held Enter cannot submit", async (t) => {
  const h = await setup(t);
  await h.files(["first.png"]);
  await h.read("PD-3500");
  assert.equal(h.document.querySelectorAll('[role="option"]').length, 3);
  assert.match(h.input().placeholder, /^e\.g\./);
  await h.key("Tab");
  await h.key("Enter");
  assert.equal(h.window.saves.length, 0);
  await h.fill("V-9999");
  await h.key("Enter");
  assert.equal(h.window.saves.length, 0);
  assert.match(h.text(), /No matching name/);
  await h.fill("PD-3500#2");
  await h.key("Enter", { isComposing: true });
  await h.key("Enter", { repeat: true });
  assert.equal(h.window.saves.length, 0);
  await h.key("Enter");
  assert.equal(h.window.saves[0].key, "device:PD-3500#2");
  await h.settleSave();
});

test("large mixed batches decode lazily and closing releases previews and OCR", async (t) => {
  const h = await setup(t);
  const names = Array.from({ length: 120 }, (_, index) => `photo-${index}.png`);
  h.window.keepCancelledOcr.add(names[0]);
  await h.files(["invalid.pdf", ...names]);
  assert.match(h.text(), /1 photo could not be added/);
  assert.match(h.text(), /120 remaining/);
  assert.equal(h.window.decoded, 1);
  assert.equal(h.window.closedBitmaps, 1);
  assert.equal(h.window.ocrCalls.length, 1);
  assert.equal(h.window.objectUrls.size, 1);
  h.window.confirm = () => false;
  await h.click(h.button("Close bulk upload"));
  assert.ok(h.query("dialog"));
  h.window.confirm = () => true;
  await h.click(h.button("Close bulk upload"));
  assert.equal(h.query("dialog"), null);
  assert.equal(h.window.objectUrls.size, 0);
  assert.equal(h.window.ocrDisposed, h.window.ocrSessions);
  await h.read("V-3541");
  assert.equal(h.window.saves.length, 0);
  assert.match(h.text(), /Bulk upload closed/);
});

test("OCR failure leaves manual assignment available", async (t) => {
  const h = await setup(t);
  await h.files(["first.png"]);
  await h.ocrFailure();
  assert.match(h.text(), /Label reading unavailable/);
  await h.fill("Transducer Panel");
  await h.key("Enter");
  assert.equal(h.window.saves[0].key, "equipment:transducer-panel");
  await h.settleSave();
  assert.match(h.text(), /All photos reviewed/);
});
