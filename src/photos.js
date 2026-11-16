const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_EDGE = 1600;
const SUPPORTED_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "",
]);

export function validatePhotoMetadata(file) {
  if (!(file instanceof Blob)) {
    throw new Error("Choose an image to continue.");
  }
  if (!SUPPORTED_TYPES.has(file.type.toLowerCase())) {
    throw new Error("Choose a JPEG, PNG, WebP, or HEIC photo.");
  }
  if (file.size === 0) {
    throw new Error("This photo is empty. Choose another image.");
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error("This photo is too large. Choose one under 20 MB.");
  }
}

export function fitPhotoDimensions(width, height) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error("This photo could not be decoded. Choose another image.");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: "from-image",
      });
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close(),
      };
    } catch {
      // Safari and older browsers may need the image-element decoder instead.
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    if (typeof image.decode === "function") {
      await image.decode();
    } else {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
      });
    }
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      cleanup: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("This photo could not be decoded. Choose another image.");
  }
}

function encodeJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(
              new Error("This photo could not be saved. Try another image."),
            ),
      "image/jpeg",
      quality,
    );
  });
}

export async function normalizePhoto(fileOrBlob, name = "photo.jpg") {
  validatePhotoMetadata(fileOrBlob);
  const decoded = await decodeImage(fileOrBlob);
  try {
    const { width, height } = fitPhotoDimensions(decoded.width, decoded.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Photo processing is unavailable in this browser.");
    }
    context.drawImage(decoded.image, 0, 0, width, height);

    let blob;
    for (const quality of [0.86, 0.76, 0.64]) {
      blob = await encodeJpeg(canvas, quality);
      if (blob.size <= MAX_OUTPUT_BYTES) break;
    }
    if (blob.size > MAX_OUTPUT_BYTES) {
      throw new Error(
        "This photo is too detailed to save. Try a lower resolution image.",
      );
    }
    const baseName =
      String(name || "photo")
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .slice(0, 80) || "photo";
    return { blob, width, height, name: `${baseName}.jpg` };
  } finally {
    decoded.cleanup();
  }
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    if (!(blob instanceof Blob)) {
      reject(new Error("Photo data is missing."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Photo data could not be read."));
    reader.readAsDataURL(blob);
  });
}
