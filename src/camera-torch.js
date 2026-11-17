export function cameraTorchState(track) {
  try {
    const capability = track?.getCapabilities?.().torch;
    const supported =
      capability === true ||
      (Array.isArray(capability) &&
        capability.includes(true) &&
        capability.includes(false));
    return {
      supported: Boolean(
        supported &&
        track.readyState !== "ended" &&
        typeof track.applyConstraints === "function",
      ),
      enabled: track?.getSettings?.().torch === true,
    };
  } catch {
    return { supported: false, enabled: false };
  }
}

export async function setCameraTorch(track, enabled) {
  if (!cameraTorchState(track).supported)
    throw new Error("Flashlight is not available on this camera.");
  await track.applyConstraints({
    ...track.getConstraints?.(),
    advanced: [{ torch: enabled }],
  });
  if (track.readyState === "ended") throw new Error("The camera has closed.");
  const actual = track.getSettings?.().torch;
  if (typeof actual === "boolean" && actual !== enabled)
    throw new Error("The camera did not change its flashlight setting.");
  return enabled;
}

export function stopCameraStream(stream) {
  for (const track of stream?.getTracks() || []) {
    try {
      // Request torch off before releasing the camera; stopping still runs if it fails.
      if (track.kind === "video" && cameraTorchState(track).supported) {
        void Promise.resolve(
          track.applyConstraints({
            ...track.getConstraints?.(),
            advanced: [{ torch: false }],
          }),
        ).catch(() => {});
      }
    } catch {
      /* Camera release must not depend on torch support. */
    }
    track.stop();
  }
}
