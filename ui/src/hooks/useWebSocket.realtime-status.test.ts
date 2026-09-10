import { describe, expect, test } from "bun:test";
import { dispatchRealtimeStatus, type VoiceCallbacks } from "./useWebSocket.ts";

function recorder(withRealtimeError = true) {
  const calls: string[] = [];
  const callbacks: VoiceCallbacks = {
    onTTSBinary: () => {},
    onTTSStart: () => {},
    onTTSEnd: () => {},
    onError: (m) => calls.push(`error:${m}`),
    onRealtimeClosed: (r) => calls.push(`closed:${r}`),
    ...(withRealtimeError ? { onRealtimeError: (m?: string) => calls.push(`realtime-error:${m}`) } : {}),
  };
  return { calls, callbacks };
}

describe("dispatchRealtimeStatus", () => {
  test("a realtime error goes to the realtime handler, not the generic one", () => {
    const { calls, callbacks } = recorder();
    dispatchRealtimeStatus({ state: "error", message: "boom" }, callbacks);
    expect(calls).toEqual(["realtime-error:boom"]);
  });

  test("without a realtime handler the error still reaches onError", () => {
    const { calls, callbacks } = recorder(false);
    dispatchRealtimeStatus({ state: "error", message: "boom" }, callbacks);
    expect(calls).toEqual(["error:boom"]);
  });

  test("closed passes the reason through", () => {
    const { calls, callbacks } = recorder();
    dispatchRealtimeStatus({ state: "closed", reason: "unavailable" }, callbacks);
    expect(calls).toEqual(["closed:unavailable"]);
  });

  test("live and unknown states, or no hook attached, do nothing", () => {
    const { calls, callbacks } = recorder();
    dispatchRealtimeStatus({ state: "live" }, callbacks);
    dispatchRealtimeStatus(undefined, callbacks);
    dispatchRealtimeStatus({ state: "error" }, null);
    expect(calls).toEqual([]);
  });
});
