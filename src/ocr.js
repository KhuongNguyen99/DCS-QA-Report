import { createWorker } from "tesseract.js";
import { prepareOcrImage } from "./ocr-image.js";

function cancelledError() {
  return new DOMException("Recognition cancelled.", "AbortError");
}

function recognitionError(error) {
  if (error instanceof Error) return error;
  return new Error(error?.message || (typeof error === "string" && error) || "The label could not be read.");
}

export function createOcrSession(onProgress = () => {}, {
  labelMode = false,
  timeoutMs = 60000,
  hasLabelMatch = (text) => Boolean(text.trim()),
  workerFactory = createWorker,
  prepareImage = prepareOcrImage,
} = {}) {
  const assetBase = `${import.meta.env?.BASE_URL ?? "./"}ocr/`;
  let current = null;
  let disposed = false;
  let activeRun = null;

  function stopWorker(entry) {
    entry.removeListeners?.();
    entry.removeListeners = null;
    if (entry.worker) {
      const worker = entry.worker;
      entry.worker = null;
      Promise.resolve().then(() => worker.terminate()).catch(() => {});
    }
  }

  function fail(entry, error) {
    if (entry.failed) return;
    entry.failed = true;
    entry.rejectFailure(recognitionError(error));
    stopWorker(entry);
  }

  function getWorkerEntry() {
    if (current && !current.failed) return current;
    const entry = { promise: null, worker: null, failed: false };
    entry.failure = new Promise((_, reject) => { entry.rejectFailure = reject; });
    // A worker can report an error between photos, when no recognition is waiting.
    entry.failure.catch(() => {});
    current = entry;
    entry.promise = Promise.resolve().then(() => workerFactory("eng", 1, {
      workerPath: `${assetBase}worker.min.js`, corePath: assetBase, langPath: assetBase,
      workerBlobURL: false,
      logger: (message) => {
        if (!disposed && current === entry && !entry.failed) onProgress(message);
      },
      // Tesseract can leave startup promises pending for language/model failures.
      errorHandler: (error) => fail(entry, error),
    }, labelMode ? { load_system_dawg: "0", load_freq_dawg: "0" } : {}))
      .then(async (worker) => {
        entry.worker = worker;
        if (disposed || current !== entry || entry.failed) {
          stopWorker(entry);
          throw cancelledError();
        }
        const runtime = worker.worker;
        if (typeof runtime?.addEventListener === "function") {
          const onError = (event) => fail(entry, event);
          runtime.addEventListener("error", onError);
          runtime.addEventListener("messageerror", onError);
          entry.removeListeners = () => {
            runtime.removeEventListener("error", onError);
            runtime.removeEventListener("messageerror", onError);
          };
        }
        if (labelMode) await worker.setParameters({
          tessedit_pageseg_mode: "11", // Sparse labels in equipment photos.
          preserve_interword_spaces: "1",
        });
        return worker;
      });
    entry.promise.catch((error) => fail(entry, error));
    return entry;
  }

  async function recognize(image, { quarterTurns = 0 } = {}) {
    if (disposed) throw cancelledError();
    if (activeRun) throw new Error("Another label is still being read.");
    const entry = getWorkerEntry();
    const run = {};
    activeRun = run;
    let prepared = null;
    let finished = false;
    const releaseImage = () => { prepared?.dispose(); prepared = null; };
    const timer = setTimeout(() => {
      const error = new Error("Reading this label took too long. Enter its name or try again.");
      error.name = "TimeoutError";
      fail(entry, error);
    }, timeoutMs);
    const operation = (async () => {
      const worker = await entry.promise;
      if (finished || disposed || current !== entry || entry.failed) throw cancelledError();
      if (labelMode) {
        prepared = await prepareImage(image, { quarterTurns });
        if (finished || disposed || current !== entry || entry.failed) {
          releaseImage();
          throw cancelledError();
        }
      }
      if (!labelMode) return worker.recognize(image);
      const result = await worker.recognize(
        prepared.image, { rotateAuto: true }, { text: true },
      );
      if (finished || disposed || current !== entry || entry.failed) throw cancelledError();
      if (hasLabelMatch(result.data.text)) return result;
      // Sparse segmentation can miss labels enclosed by a plate or box. A
      // bounded second pass uses automatic layout and adaptive illumination
      // when the first pass has no useful label, even if it read other text.
      return worker.recognize(prepared.image, {
        rotateAuto: true, tessedit_pageseg_mode: "3", thresholding_method: "1",
      }, { text: true });
    })();
    try {
      // terminate() does not reject Tesseract's outstanding recognition promise.
      // Racing our own failure signal lets skip/close settle immediately.
      const result = await Promise.race([operation, entry.failure]);
      if (disposed || current !== entry) throw cancelledError();
      return result.data.text;
    } catch (error) {
      if (disposed || current !== entry) throw cancelledError();
      cancel();
      throw recognitionError(error);
    } finally {
      finished = true;
      clearTimeout(timer);
      releaseImage();
      if (activeRun === run) activeRun = null;
    }
  }

  function cancel() {
    const entry = current;
    current = null;
    activeRun = null;
    if (entry) fail(entry, cancelledError());
  }

  function dispose() {
    disposed = true;
    cancel();
  }

  return { recognize, cancel, dispose };
}
