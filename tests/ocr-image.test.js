import test from "node:test";
import assert from "node:assert/strict";
import { fitOcrDimensions, prepareOcrImage } from "../src/ocr-image.js";

test("OCR keeps high-resolution label detail with bounded image dimensions", () => {
  assert.deepEqual(fitOcrDimensions(4000, 3000), { width: 2800, height: 2100 });
  assert.deepEqual(fitOcrDimensions(3000, 4000), { width: 2100, height: 2800 });
  assert.deepEqual(fitOcrDimensions(1800, 1200), { width: 1800, height: 1200 });
  assert.deepEqual(fitOcrDimensions(600, 300), { width: 1200, height: 600 });
  assert.deepEqual(fitOcrDimensions(1, 4000), { width: 1, height: 2800 });
  assert.throws(() => fitOcrDimensions(Infinity, 100), /could not be decoded/);
});

test("OCR preparation honors orientation, fills transparency, and releases pixel buffers", async () => {
  const originalBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  const calls = [];
  let closed = false;
  const bitmap = { width: 3000, height: 4000, close: () => { closed = true; } };
  const context = {
    fillStyle: "",
    fillRect: (...args) => calls.push(["fill", ...args]),
    drawImage: (...args) => calls.push(["draw", ...args]),
  };
  const canvas = { getContext: () => context };
  globalThis.createImageBitmap = async (_blob, options) => {
    assert.equal(options.imageOrientation, "from-image");
    return bitmap;
  };
  globalThis.document = { createElement: () => canvas };
  try {
    const result = await prepareOcrImage(new Blob(["photo"], { type: "image/jpeg" }));
    assert.equal(result.image, canvas);
    assert.equal(context.fillStyle, "#fff");
    assert.deepEqual(calls, [
      ["fill", 0, 0, 2100, 2800],
      ["draw", bitmap, 0, 0, 2100, 2800],
    ]);
    assert.equal(closed, true);
    result.dispose();
    assert.equal(canvas.width, 0);
    assert.equal(canvas.height, 0);
  } finally {
    globalThis.createImageBitmap = originalBitmap;
    globalThis.document = originalDocument;
  }
});

test("a failed OCR canvas releases decoded and allocated image memory", async () => {
  const originalBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  let closed = false;
  const canvas = { getContext: () => null };
  globalThis.createImageBitmap = async () => ({
    width: 1000, height: 1000, close: () => { closed = true; },
  });
  globalThis.document = { createElement: () => canvas };
  try {
    await assert.rejects(
      prepareOcrImage(new Blob(["photo"], { type: "image/png" })),
      /unavailable in this browser/,
    );
    assert.equal(closed, true);
    assert.equal(canvas.width, 0);
    assert.equal(canvas.height, 0);
  } finally {
    globalThis.createImageBitmap = originalBitmap;
    globalThis.document = originalDocument;
  }
});
