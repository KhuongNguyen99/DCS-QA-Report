import test from "node:test";
import assert from "node:assert/strict";
import { createOcrSession } from "../src/ocr.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fakeWorker(recognize = async () => ({ data: { text: "V-3541" } })) {
  return {
    worker: new EventTarget(),
    parameters: null,
    terminated: 0,
    async setParameters(parameters) { this.parameters = parameters; },
    recognize,
    async terminate() { this.terminated += 1; },
  };
}

test("label sessions reuse one worker and release every prepared image", async () => {
  const inputs = [];
  const worker = fakeWorker(async (image, options) => {
    inputs.push(image);
    assert.equal(options.rotateAuto, true);
    return { data: { text: image.text } };
  });
  let factories = 0;
  let released = 0;
  const session = createOcrSession(() => {}, {
    labelMode: true,
    workerFactory: async (_language, _engine, _options, config) => {
      factories += 1;
      assert.equal(config.load_system_dawg, "0");
      return worker;
    },
    prepareImage: async (text) => ({ image: { text }, dispose: () => { released += 1; } }),
  });
  try {
    assert.equal(await session.recognize("V-3541"), "V-3541");
    assert.equal(await session.recognize("Terminal A"), "Terminal A");
    assert.equal(factories, 1);
    assert.equal(worker.parameters.tessedit_pageseg_mode, "11");
    assert.equal(inputs.length, 2);
    assert.equal(released, 2);
  } finally {
    session.dispose();
    await tick();
  }
  assert.equal(worker.terminated, 1);
});

test("camera sessions still recognize the supplied image without label preprocessing", async () => {
  const image = new Blob(["photo"]);
  const worker = fakeWorker(async (input) => {
    assert.equal(input, image);
    return { data: { text: "PD-3500#2" } };
  });
  const session = createOcrSession(() => {}, {
    workerFactory: async () => worker,
    prepareImage: () => { throw new Error("Must not preprocess camera input"); },
  });
  try {
    assert.equal(await session.recognize(image), "PD-3500#2");
    assert.equal(worker.parameters, null);
  } finally { session.dispose(); }
});

test("empty sparse recognition gets one bounded alternate-layout pass", async () => {
  const calls = [];
  const worker = fakeWorker(async (_image, options) => {
    calls.push(options);
    return { data: { text: calls.length === 1 ? "\n" : "PD-3500#2" } };
  });
  let released = 0;
  const session = createOcrSession(() => {}, {
    labelMode: true,
    workerFactory: async () => worker,
    prepareImage: async () => ({ image: {}, dispose: () => { released += 1; } }),
  });
  try {
    assert.equal(await session.recognize("photo"), "PD-3500#2");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].tessedit_pageseg_mode, "3");
    assert.equal(calls[1].thresholding_method, "1");
    assert.equal(released, 1);
  } finally { session.dispose(); }
});

test("unrelated printed text does not prevent a catalog-aware alternate pass", async () => {
  const calls = [];
  const worker = fakeWorker(async (_image, options) => {
    calls.push(options);
    return { data: { text: calls.length === 1 ? "WARNING: HIGH VOLTAGE" : "V-3511-Y" } };
  });
  const checked = [];
  const session = createOcrSession(() => {}, {
    labelMode: true,
    hasLabelMatch: (text) => {
      checked.push(text);
      return text.includes("V-3511-Y");
    },
    workerFactory: async () => worker,
    prepareImage: async () => ({ image: {}, dispose() {} }),
  });
  try {
    assert.equal(await session.recognize("photo"), "V-3511-Y");
    assert.deepEqual(checked, ["WARNING: HIGH VOLTAGE"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].thresholding_method, "1");
  } finally { session.dispose(); }
});

test("cancel settles a hung recognition, frees its image, and permits the next photo", async () => {
  const hung = fakeWorker(() => new Promise(() => {}));
  const next = fakeWorker();
  let factories = 0;
  let released = 0;
  const session = createOcrSession(() => {}, {
    labelMode: true,
    workerFactory: async () => factories++ === 0 ? hung : next,
    prepareImage: async () => ({ image: {}, dispose: () => { released += 1; } }),
  });
  try {
    const reading = session.recognize("first");
    const rejected = assert.rejects(reading, { name: "AbortError" });
    await tick();
    session.cancel();
    await rejected;
    assert.equal(released, 1);
    await tick();
    assert.equal(hung.terminated, 1);
    assert.equal(await session.recognize("second"), "V-3541");
    assert.equal(factories, 2);
    assert.equal(released, 2);
  } finally { session.dispose(); }
});

test("dispose during startup settles immediately and terminates a late worker", async () => {
  const startup = deferred();
  let recognized = false;
  const worker = fakeWorker(async () => { recognized = true; });
  const session = createOcrSession(() => {}, { workerFactory: () => startup.promise });
  const reading = session.recognize("photo");
  const rejected = assert.rejects(reading, { name: "AbortError" });
  await tick();
  session.dispose();
  await rejected;
  startup.resolve(worker);
  await tick();
  assert.equal(worker.terminated, 1);
  assert.equal(recognized, false);
  await assert.rejects(session.recognize("later"), { name: "AbortError" });
});

test("a model-load error rejects even when the library startup promise stays pending", async () => {
  let options;
  const session = createOcrSession(() => {}, {
    workerFactory: (_language, _engine, input) => {
      options = input;
      return new Promise(() => {});
    },
  });
  try {
    const reading = session.recognize("photo");
    const rejected = assert.rejects(reading, /language data missing/);
    await tick();
    options.errorHandler("language data missing");
    await rejected;
  } finally { session.dispose(); }
});

test("worker crashes and recognition timeouts leave the UI free to enter a name", async () => {
  const worker = fakeWorker(() => new Promise(() => {}));
  const session = createOcrSession(() => {}, { workerFactory: async () => worker });
  const reading = session.recognize("photo");
  const rejected = assert.rejects(reading, /OCR worker crashed/);
  await tick();
  const event = new Event("error");
  Object.defineProperty(event, "message", { value: "OCR worker crashed" });
  worker.worker.dispatchEvent(event);
  await rejected;
  await tick();
  assert.equal(worker.terminated, 1);
  session.dispose();

  const slow = fakeWorker(() => new Promise(() => {}));
  const timedSession = createOcrSession(() => {}, {
    workerFactory: async () => slow, timeoutMs: 15,
  });
  await assert.rejects(timedSession.recognize("photo"), { name: "TimeoutError" });
  await tick();
  assert.equal(slow.terminated, 1);
  timedSession.dispose();
});

test("cancel during image decoding releases a late result without recognizing it", async () => {
  const image = deferred();
  let recognized = false;
  let released = 0;
  const worker = fakeWorker(async () => { recognized = true; });
  const session = createOcrSession(() => {}, {
    labelMode: true,
    workerFactory: async () => worker,
    prepareImage: () => image.promise,
  });
  const reading = session.recognize("photo");
  const rejected = assert.rejects(reading, { name: "AbortError" });
  await tick();
  session.cancel();
  await rejected;
  image.resolve({ image: {}, dispose: () => { released += 1; } });
  await tick();
  assert.equal(released, 1);
  assert.equal(recognized, false);
  session.dispose();
});
