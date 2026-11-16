import test from "node:test";
import assert from "node:assert/strict";
import {
  fitPhotoDimensions,
  normalizePhoto,
  validatePhotoMetadata,
} from "../src/photos.js";

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
