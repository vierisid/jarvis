import { afterEach, describe, expect, test } from "bun:test";
import {
  WAKE_MIC_CONSTRAINTS,
  mergeWakeMicConstraints,
  withWakeMicConstraints,
} from "./wakeMic.ts";

afterEach(() => {
  delete (globalThis as Record<string, unknown>).navigator;
});

describe("mergeWakeMicConstraints", () => {
  // Echo cancellation is the one that matters: it is what attaches the page to
  // the OUTPUT device and degrades playback for everything else on it.
  test("turns off Chromium's audio processing for `audio: true`", () => {
    const got = mergeWakeMicConstraints({ audio: true });
    expect(got.audio).toEqual({ ...WAKE_MIC_CONSTRAINTS });
    expect((got.audio as MediaTrackConstraints).echoCancellation).toBe(false);
  });

  test("turns it off when no constraints were given at all", () => {
    expect(mergeWakeMicConstraints(undefined).audio).toEqual({ ...WAKE_MIC_CONSTRAINTS });
  });

  // The engine passes a deviceId when the user picked a specific microphone.
  // Losing that would silently move wake detection to the wrong input.
  test("preserves a device selection", () => {
    const got = mergeWakeMicConstraints({ audio: { deviceId: { exact: "mic-7" } } });
    expect(got.audio).toEqual({ deviceId: { exact: "mic-7" }, ...WAKE_MIC_CONSTRAINTS });
  });

  test("overrides processing the caller asked for", () => {
    const got = mergeWakeMicConstraints({ audio: { echoCancellation: true, noiseSuppression: true } });
    expect((got.audio as MediaTrackConstraints).echoCancellation).toBe(false);
    expect((got.audio as MediaTrackConstraints).noiseSuppression).toBe(false);
  });

  test("leaves an explicit audio:false alone", () => {
    expect(mergeWakeMicConstraints({ audio: false, video: true }).audio).toBe(false);
  });
});

describe("withWakeMicConstraints", () => {
  function installMediaDevices() {
    const calls: MediaStreamConstraints[] = [];
    const original = (c?: MediaStreamConstraints) => {
      calls.push(c!);
      return Promise.resolve({} as MediaStream);
    };
    (globalThis as Record<string, unknown>).navigator = { mediaDevices: { getUserMedia: original } };
    return { calls, original };
  }

  test("applies the constraints to whatever the callee opens", async () => {
    const { calls } = installMediaDevices();
    await withWakeMicConstraints(async () => {
      await globalThis.navigator.mediaDevices.getUserMedia({ audio: true });
    });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.audio as MediaTrackConstraints).echoCancellation).toBe(false);
  });

  // A leaked override would silently strip echo cancellation from the RECORDER
  // too, which does want it. Identity, not just behaviour: restoring a bound
  // copy would leave the native method permanently replaced.
  test("restores the original afterwards", async () => {
    const { original } = installMediaDevices();
    await withWakeMicConstraints(async () => {});
    expect(globalThis.navigator.mediaDevices.getUserMedia).toBe(original as never);
  });

  test("restores the original even when the callee throws", async () => {
    const { original } = installMediaDevices();
    await expect(
      withWakeMicConstraints(async () => {
        throw new Error("mic busy");
      }),
    ).rejects.toThrow("mic busy");
    expect(globalThis.navigator.mediaDevices.getUserMedia).toBe(original as never);
  });

  test("still runs the callee when there is no mediaDevices at all", async () => {
    (globalThis as Record<string, unknown>).navigator = {};
    let ran = false;
    await withWakeMicConstraints(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
