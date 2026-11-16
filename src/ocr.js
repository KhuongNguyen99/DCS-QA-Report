import { createWorker } from "tesseract.js";

function cancelledError() {
  return new DOMException("Recognition cancelled.", "AbortError");
}

export function createOcrSession(onProgress = () => {}) {
  const assetBase = `${import.meta.env.BASE_URL}ocr/`;
  let current = null;
  let disposed = false;

  function getWorkerEntry() {
    if (current) return current;
    const entry = { promise: null };
    entry.promise = createWorker("eng", 1, {
      workerPath: `${assetBase}worker.min.js`,
      corePath: assetBase,
      langPath: assetBase,
      workerBlobURL: false,
      logger: (message) => {
        if (!disposed && current === entry) onProgress(message);
      },
    });
    current = entry;
    return entry;
  }

  async function recognize(image) {
    if (disposed) throw cancelledError();
    const entry = getWorkerEntry();
    try {
      const worker = await entry.promise;
      if (disposed || current !== entry) throw cancelledError();
      const result = await worker.recognize(image);
      if (disposed || current !== entry) throw cancelledError();
      return result.data.text;
    } catch (error) {
      if (disposed || current !== entry) throw cancelledError();
      cancel();
      throw error;
    }
  }

  function cancel() {
    if (!current) return;
    const entry = current;
    current = null;
    entry.promise.then((worker) => worker.terminate()).catch(() => {});
  }

  function dispose() {
    disposed = true;
    cancel();
  }

  return { recognize, cancel, dispose };
}
