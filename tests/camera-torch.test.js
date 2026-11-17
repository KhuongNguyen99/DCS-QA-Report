import test from "node:test";
import assert from "node:assert/strict";
import {
  cameraTorchState,
  setCameraTorch,
  stopCameraStream,
} from "../src/camera-torch.js";

function fixture(capability = true) {
  const calls = [];
  let enabled = false;
  const track = {
    kind: "video",
    readyState: "live",
    getCapabilities: () => ({ torch: capability }),
    getSettings: () => ({ torch: enabled }),
    getConstraints: () => ({ facingMode: { ideal: "environment" } }),
    async applyConstraints(constraints) {
      calls.push(constraints);
      enabled = constraints.advanced[0].torch;
    },
    stop() {
      calls.push("stop");
      track.readyState = "ended";
      enabled = false;
    },
  };
  return { track, calls };
}

test("torch detection accepts Chromium booleans and controllable capability lists", () => {
  for (const value of [true, [true, false]])
    assert.equal(cameraTorchState(fixture(value).track).supported, true);
  for (const value of [false, [false], [true], undefined])
    assert.equal(
      cameraTorchState(fixture(value === undefined ? null : value).track)
        .supported,
      false,
    );
  assert.deepEqual(cameraTorchState(null), {
    supported: false,
    enabled: false,
  });
  const { track } = fixture();
  track.getCapabilities = () => {
    throw new Error("Unavailable");
  };
  assert.equal(cameraTorchState(track).supported, false);
});

test("torch toggles both ways and preserves the rear-camera constraint", async () => {
  const { track, calls } = fixture();
  assert.equal(await setCameraTorch(track, true), true);
  assert.equal(cameraTorchState(track).enabled, true);
  assert.equal(await setCameraTorch(track, false), false);
  assert.equal(cameraTorchState(track).enabled, false);
  assert.deepEqual(calls, [
    { facingMode: { ideal: "environment" }, advanced: [{ torch: true }] },
    { facingMode: { ideal: "environment" }, advanced: [{ torch: false }] },
  ]);
});

test("ignored, rejected, unsupported, and ended torch requests never report success", async () => {
  const { track } = fixture();
  track.applyConstraints = async () => {};
  await assert.rejects(setCameraTorch(track, true), /did not change/);
  track.applyConstraints = async () => {
    throw new Error("Hardware busy");
  };
  await assert.rejects(setCameraTorch(track, true), /Hardware busy/);
  await assert.rejects(
    setCameraTorch(fixture(false).track, true),
    /not available/,
  );
  track.readyState = "ended";
  await assert.rejects(setCameraTorch(track, true), /not available/);
});

test("camera release requests torch off and stops every track even if torch control fails", async () => {
  for (const failure of [false, true]) {
    const { track, calls } = fixture();
    await setCameraTorch(track, true);
    if (failure)
      track.applyConstraints = () => {
        throw new Error("Camera lost");
      };
    let audioStopped = false;
    stopCameraStream({
      getTracks: () => [
        track,
        {
          kind: "audio",
          stop: () => {
            audioStopped = true;
          },
        },
      ],
    });
    assert.equal(track.readyState, "ended");
    assert.equal(cameraTorchState(track).enabled, false);
    assert.equal(audioStopped, true);
    if (!failure) assert.equal(calls[1].advanced[0].torch, false);
    assert.equal(calls.at(-1), "stop");
  }
});

test("a pending torch request cannot report enabled after camera release", async () => {
  const { track } = fixture();
  let release;
  track.applyConstraints = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const request = setCameraTorch(track, true);
  track.stop();
  release();
  await assert.rejects(request, /camera has closed/);
});
