import { validatePhotoMetadata } from "./photos.js";
import { drawRotatedImage, normalizeQuarterTurns, rotatedDimensions } from "./photo-orientation.js";

// Keep small device tags legible without sending full camera-resolution images
// through a long-lived WASM worker. The saved report photo is processed separately.
const MAX_OCR_EDGE = 2800;
const MIN_OCR_EDGE = 1400;

export function fitOcrDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1)
    throw new Error("This photo could not be decoded. Choose another image.");
  const edge = Math.max(width, height);
  const scale = edge > MAX_OCR_EDGE
    ? MAX_OCR_EDGE / edge
    : Math.min(2, Math.max(1, MIN_OCR_EDGE / edge));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decodePhoto(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close(),
      };
    } catch {
      // The image-element decoder supports additional formats in some browsers.
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    if (typeof image.decode === "function") {
      image.src = url;
      await image.decode();
    } else {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });
    }
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("This photo could not be decoded. Choose another image.");
  }
}

/** Prepare a lossless, upright OCR image. Always dispose it after recognition. */
export async function prepareOcrImage(blob, { quarterTurns = 0 } = {}) {
  validatePhotoMetadata(blob);
  const turns = normalizeQuarterTurns(quarterTurns);
  const decoded = await decodePhoto(blob);
  let canvas;
  try {
    const fitted = fitOcrDimensions(decoded.width, decoded.height);
    const dimensions = rotatedDimensions(fitted.width, fitted.height, turns);
    canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Label recognition is unavailable in this browser.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    drawRotatedImage(context, decoded.image, fitted.width, fitted.height, turns);
    return {
      image: canvas,
      dispose: () => { canvas.width = 0; canvas.height = 0; },
    };
  } catch (error) {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    throw error;
  } finally {
    decoded.dispose();
  }
}
