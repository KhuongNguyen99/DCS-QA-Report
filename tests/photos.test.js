import test from "node:test";
import assert from "node:assert/strict";
import {
  fitPhotoDimensions,
  normalizePhoto,
  validatePhotoMetadata,
} from "../src/photos.js";
import { normalizeQuarterTurns } from "../src/photo-orientation.js";

test("photo validation rejects unsupported, empty, and oversized inputs", () => {
  assert.throws(() => validatePhotoMetadata(null), /Choose an image/);
  assert.throws(
    () => validatePhotoMetadata(new Blob(["x"], { type: "application/pdf" })),
    /JPEG, PNG/,
  );
  assert.throws(
    () => validatePhotoMetadata(new Blob([], { type: "image/jpeg" })),
    /empty/,
  );
  const large = new Blob(["x"], { type: "image/jpeg" });
  Object.defineProperty(large, "size", { value: 20 * 1024 * 1024 + 1 });
  assert.throws(() => validatePhotoMetadata(large), /under 20 MB/);
});

test("photo dimensions preserve aspect ratio and cap the longest edge", () => {
  assert.deepEqual(fitPhotoDimensions(4000, 3000), {
    width: 1600,
    height: 1200,
  });
  assert.deepEqual(fitPhotoDimensions(750, 1500), { width: 750, height: 1500 });
  assert.deepEqual(fitPhotoDimensions(1, 2000), { width: 1, height: 1600 });
  assert.throws(() => fitPhotoDimensions(0, 100), /could not be decoded/);
});

test("normalization draws the decoded orientation, encodes JPEG, and releases the image", async () => {
  const originalBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  const calls = [];
  let closed = false;
  globalThis.createImageBitmap = async (_blob, options) => {
    assert.deepEqual(options, { imageOrientation: "from-image" });
    return {
      width: 3000,
      height: 4000,
      close: () => {
        closed = true;
      },
    };
  };
  globalThis.document = {
    createElement: (name) => {
      assert.equal(name, "canvas");
      return {
        getContext: () => ({ drawImage: (...args) => calls.push(args) }),
        toBlob: (callback, type, quality) => {
          assert.equal(type, "image/jpeg");
          calls.push(quality);
          callback(new Blob(["jpeg"], { type }));
        },
      };
    },
  };
  try {
    const result = await normalizePhoto(
      new Blob(["photo"], { type: "image/jpeg" }),
      "Cabinet B.png",
    );
    assert.deepEqual(
      { width: result.width, height: result.height, name: result.name },
      { width: 1200, height: 1600, name: "Cabinet-B.jpg" },
    );
    assert.equal(result.blob.type, "image/jpeg");
    assert.deepEqual(calls[0].slice(1), [0, 0, 1200, 1600]);
    assert.equal(calls[1], 0.86);
    assert.equal(closed, true);
  } finally {
    globalThis.createImageBitmap = originalBitmap;
    globalThis.document = originalDocument;
  }
});

test("quarter turns wrap both directions and reject fractional rotation", () => {
  assert.equal(normalizeQuarterTurns(-1), 3);
  assert.equal(normalizeQuarterTurns(-5), 3);
  assert.equal(normalizeQuarterTurns(4), 0);
  assert.equal(normalizeQuarterTurns(5), 1);
  assert.throws(() => normalizeQuarterTurns(0.5), /whole 90-degree/);
  assert.throws(() => normalizeQuarterTurns(Infinity), /whole 90-degree/);
});

test("saved rotations reprocess the original, swap dimensions, and keep every corner inside the photo", async () => {
  const originalBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  const original = new Blob(["original"], { type: "image/jpeg" });
  const decoded = [];
  const canvases = [];
  let closed = 0;
  let canvas;
  let angle;
  let translation;
  let drew;
  let restored;
  let encodedDimensions;
  const bitmap = { width: 4000, height: 3000, close: () => { closed += 1; } };
  globalThis.createImageBitmap = async (blob, options) => {
    decoded.push(blob);
    assert.deepEqual(options, { imageOrientation: "from-image" });
    return bitmap;
  };
  globalThis.document = {
    createElement: () => {
      angle = 0;
      translation = [0, 0];
      restored = false;
      canvas = {
        getContext: () => ({
          save() {},
          translate: (x, y) => { translation = [x, y]; },
          rotate: (value) => { angle = value; },
          drawImage: (...args) => { drew = args; },
          restore: () => { restored = true; },
        }),
        toBlob: (callback, type) => {
          encodedDimensions = [canvas.width, canvas.height];
          callback(new Blob(["rotated"], { type }));
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  try {
    for (const [quarterTurns, expectedAngle, expectedSize, expectedOrigin] of [
      [1, Math.PI / 2, [1200, 1600], [1200, 0]],
      [-1, 3 * Math.PI / 2, [1200, 1600], [0, 1600]],
      [2, Math.PI, [1600, 1200], [1600, 1200]],
      [4, 0, [1600, 1200], [0, 0]],
      [5, Math.PI / 2, [1200, 1600], [1200, 0]],
    ]) {
      const result = await normalizePhoto(original, "evidence.jpg", { quarterTurns });
      assert.deepEqual([result.width, result.height], expectedSize);
      assert.deepEqual(encodedDimensions, expectedSize);
      assert.equal(angle, expectedAngle);
      assert.deepEqual(translation, expectedOrigin);
      assert.deepEqual(drew, [bitmap, 0, 0, 1600, 1200]);
      assert.equal(restored, expectedAngle !== 0);
      const corners = [[0, 0], [1600, 0], [1600, 1200], [0, 1200]].map(([x, y]) => [
        Math.round(translation[0] + x * Math.cos(angle) - y * Math.sin(angle)) || 0,
        Math.round(translation[1] + x * Math.sin(angle) + y * Math.cos(angle)) || 0,
      ]);
      assert.deepEqual([
        Math.min(...corners.map(([x]) => x)), Math.min(...corners.map(([, y]) => y)),
        Math.max(...corners.map(([x]) => x)), Math.max(...corners.map(([, y]) => y)),
      ], [0, 0, ...expectedSize]);
    }
    assert.equal(decoded.length, 5);
    assert.ok(decoded.every((blob) => blob === original), "never rotate an already compressed result");
    assert.equal(closed, 5);
    assert.ok(canvases.every((item) => item.width === 0 && item.height === 0));
  } finally {
    globalThis.createImageBitmap = originalBitmap;
    globalThis.document = originalDocument;
  }
});
