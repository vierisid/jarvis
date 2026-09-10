import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { tagRealtimePcm } from "../../../src/comms/realtime-frame";

// Exercise the real hook and realtime controller. Only the browser's audio
// device is replaced: these tests assert decoder selection, not sound quality.
GlobalRegistrator.register();
const globals = globalThis as any;
const originals = {
  fetch: globalThis.fetch,
  audio: globals.AudioContext,
  worklet: globals.AudioWorkletNode,
  act: globals.IS_REACT_ACT_ENVIRONMENT,
  media: Object.getOwnPropertyDescriptor(navigator, "mediaDevices"),
  interval: window.setInterval,
};
globals.IS_REACT_ACT_ENVIRONMENT = true;

let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useVoice: typeof import("./useVoice").useVoice;
let pollMs = 0;
let voice: ReturnType<typeof useVoice>;
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
let available = true;
let fetches = 0;
let failWorklet = false;
const contexts: AudioDevice[] = [];
const sent: string[] = [];
const decoded: ArrayBuffer[] = [];
const raw: Array<{ rate: number; length: number }> = [];
let resolveDecode: ((value: any) => void) | null = null;
let deferDecode = false;
let pollAvailability: (() => void) | null = null;

class AudioSource {
  buffer: any = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  connect() {}
  disconnect() {}
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
class AudioDevice {
  state = "running";
  currentTime = 0;
  sampleRate = 24000;
  destination = {};
  sources: AudioSource[] = [];
  audioWorklet = { addModule: async () => { if (failWorklet) throw new Error("worklet unavailable"); } };
  constructor() { contexts.push(this); }
  resume() { return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
  decodeAudioData(data: ArrayBuffer) {
    decoded.push(data);
    return deferDecode
      ? new Promise<any>(resolve => { resolveDecode = resolve; })
      : Promise.resolve({ duration: 1 });
  }
  createBuffer(_channels: number, length: number, rate: number) {
    raw.push({ length, rate });
    return { duration: length / rate, copyToChannel() {} };
  }
  createBufferSource() {
    const source = new AudioSource();
    this.sources.push(source);
    return source;
  }
  createMediaStreamSource() { return new AudioSource(); }
  createOscillator() {
    return Object.assign(new AudioSource(), { frequency: { value: 0 } });
  }
  createGain() {
    return { connect() {}, gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } };
  }
}

// An MP3 header is sufficient to distinguish the two playback entry points.
const mp3 = () => new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, 0, 0]).buffer;
// Raw PCM as a realtime session sends it: tagged. Untagged PCM is not realtime.
const pcm = () => new Int16Array([0, 4000, -4000, 0]).buffer;
const realtimePcm = () => tagRealtimePcm(new Uint8Array(pcm())).slice().buffer;
const sources = () => contexts.flatMap(ctx => ctx.sources);
const messages = (log: string[] = sent) => log.map(data => JSON.parse(data));
const pcmStarts = (log: string[] = sent) => messages(log).filter(m => m.type === "voice_start" && m.payload?.mode === "pcm");
const socket = (log: string[]) => ({ readyState: WebSocket.OPEN, send: (data: string) => { log.push(data); } }) as unknown as WebSocket;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ useVoice, REALTIME_AVAILABILITY_POLL_MS: pollMs } = await import("./useVoice"));
});
beforeEach(() => {
  available = true;
  fetches = 0;
  failWorklet = false;
  contexts.length = sent.length = decoded.length = raw.length = 0;
  deferDecode = false;
  resolveDecode = null;
  pollAvailability = null;
  window.setInterval = ((handler: () => void, delay: number, ...args: any[]) => {
    if (delay === pollMs) pollAvailability = handler;
    return originals.interval.call(window, handler, delay, ...args);
  }) as typeof window.setInterval;
  globals.AudioContext = AudioDevice;
  globals.AudioWorkletNode = class extends AudioSource { port = { onmessage: null }; };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  });
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(JSON.stringify({
      realtime: { enabled: available, available },
    }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});
afterAll(() => {
  globalThis.fetch = originals.fetch;
  globals.AudioContext = originals.audio;
  globals.AudioWorkletNode = originals.worklet;
  globals.IS_REACT_ACT_ENVIRONMENT = originals.act;
  window.setInterval = originals.interval;
  if (originals.media) Object.defineProperty(navigator, "mediaDevices", originals.media);
  else delete (navigator as any).mediaDevices;
  GlobalRegistrator.unregister();
});

async function mount(options: { errorFlashMs?: number } = {}) {
  const wsRef = { current: socket(sent) as WebSocket | null };
  function Harness() {
    voice = useVoice({ wsRef, nativeWakeActive: true, ...options });
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
  return wsRef;
}
async function beginTTS(id = "standard-tts") {
  await act(async () => { voice.handleTTSStart(id); voice.handleTTSBinary(mp3()); });
}
async function beginRealtime() {
  await act(async () => { voice.startRecording(); });
  expect(pcmStarts().length > 0).toBe(true);
  expect(voice.voiceState).toBe("recording");
}

describe("dashboard audio format and lifecycle", () => {
  test.each([false, true])("decodes marked TTS with realtime availability %s", async flag => {
    available = flag;
    await mount();
    await beginTTS();
    expect(decoded.length).toBe(1);
    expect(raw.length).toBe(0);
    expect(voice.voiceState).toBe("speaking");
  });

  test("finishes standard TTS and drops late audio with realtime available", async () => {
    await mount();
    await beginTTS();
    await act(async () => { voice.handleTTSEnd("standard-tts"); sources()[0]!.onended?.(); });
    expect(voice.voiceState).toBe("idle");
    expect(voice.ttsAudioPlaying).toBe(false);
    await act(async () => { voice.handleTTSBinary(mp3()); });
    expect(decoded.length).toBe(1);
    expect(raw.length).toBe(0);
  });

  test("cancel stops standard playback and drops late packets with realtime available", async () => {
    await mount();
    await beginTTS();
    await act(async () => { voice.cancelTTS(); voice.handleTTSBinary(mp3()); });
    expect(contexts.every(ctx => ctx.state === "closed")).toBe(true);
    expect(voice.voiceState).toBe("idle");
    expect(decoded.length).toBe(1);
    expect(raw.length).toBe(0);
  });

  test("availability alone never authorizes raw playback", async () => {
    await mount();
    await act(async () => { voice.handleTTSBinary(pcm()); voice.handleTTSBinary(realtimePcm()); });
    expect(raw.length).toBe(0);
    expect(decoded.length).toBe(0);
  });

  test("a real realtime session plays PCM and barge-in flushes without closing it", async () => {
    await mount();
    await beginRealtime();
    await act(async () => { voice.handleTTSBinary(realtimePcm()); });
    expect(raw).toEqual([{ rate: 24000, length: 4 }]);
    expect(decoded.length).toBe(0);
    await act(async () => { voice.handleTTSEnd(undefined, true); });
    expect(sources().at(-1)!.stopped).toBe(true);
    expect(sent.some(data => JSON.parse(data).type === "voice_end")).toBe(false);
    await act(async () => { voice.handleTTSBinary(realtimePcm()); });
    expect(raw.length).toBe(2);
  });

  test("marked TTS takes the decoder path even during a realtime session", async () => {
    await mount();
    await beginRealtime();
    await beginTTS();
    expect(decoded.length).toBe(1);
    expect(raw.length).toBe(0);
    await act(async () => { voice.handleTTSEnd("standard-tts"); sources().at(-1)!.onended?.(); });
    await act(async () => { voice.handleTTSBinary(realtimePcm()); });
    expect(raw.length).toBe(1);
  });

  test("closed realtime session rejects late PCM and permits subsequent standard TTS", async () => {
    await mount();
    await beginRealtime();
    await act(async () => { voice.handleRealtimeClosed(); voice.handleTTSBinary(realtimePcm()); });
    expect(raw.length).toBe(0);
    await beginTTS();
    expect(decoded.length).toBe(1);
    expect(raw.length).toBe(0);
  });

  test("a settings poll cannot change the format or cleanup of an existing PCM session", async () => {
    await mount();
    await beginRealtime();
    available = false;
    expect(pollAvailability !== null).toBe(true);
    await act(async () => { pollAvailability?.(); });
    await act(async () => { voice.handleTTSBinary(realtimePcm()); });
    expect(raw.length).toBe(1);
    await act(async () => { voice.handleRealtimeClosed(); voice.handleTTSBinary(realtimePcm()); });
    expect(raw.length).toBe(1);
    expect(sent.some(data => JSON.parse(data).type === "voice_end")).toBe(true);
    expect(voice.voiceState).toBe("idle");
  });

  test("closing realtime does not mark an ordinary TTS clip idle while it is playing", async () => {
    await mount();
    await beginRealtime();
    await beginTTS();
    await act(async () => { voice.handleRealtimeClosed(); });
    expect(voice.voiceState).toBe("speaking");
    expect(voice.ttsAudioPlaying).toBe(true);
    await act(async () => { voice.handleTTSEnd("standard-tts"); sources().at(-1)!.onended?.(); });
    expect(voice.voiceState).toBe("idle");
  });

  test("cancelling while an encoded chunk decodes cannot restart speech", async () => {
    await mount();
    deferDecode = true;
    await beginTTS();
    expect(resolveDecode !== null).toBe(true);
    await act(async () => { voice.cancelTTS(); resolveDecode?.({ duration: 1 }); });
    expect(sources().length).toBe(0);
    expect(voice.voiceState).toBe("idle");
  });
});

describe("tagged realtime frames", () => {
  test("untagged bytes never reach the PCM player, even during a live session", async () => {
    await mount();
    await beginRealtime();
    await act(async () => { voice.handleTTSBinary(pcm()); voice.handleTTSBinary(mp3()); });
    expect(raw.length).toBe(0);
    expect(decoded.length).toBe(0);
  });

  // The static burst: a frame the daemon had already sent lands after cancel
  // cleared the request id, and a live session used to route it to PCM.
  test("stop during a live session drops late encoded frames instead of playing them as PCM", async () => {
    await mount();
    await beginRealtime();
    await beginTTS("proactive-1");
    await act(async () => { voice.cancelTTS(); voice.handleTTSBinary(mp3()); voice.handleTTSBinary(mp3()); });
    expect(raw.length).toBe(0);
    expect(decoded.length).toBe(1);
  });

  test("realtime audio during a TTS clip still plays as PCM while the clip decodes", async () => {
    await mount();
    await beginRealtime();
    await beginTTS("chat-1");
    await act(async () => { voice.handleTTSBinary(realtimePcm()); });
    expect(raw.length).toBe(1);
    expect(decoded.length).toBe(1);
  });
});

describe("state while the realtime mic streams", () => {
  test("a clip ending returns to listening, not idle", async () => {
    await mount();
    await beginRealtime();
    await beginTTS("proactive-1");
    expect(voice.voiceState).toBe("speaking");
    await act(async () => { voice.handleTTSEnd("proactive-1"); sources().at(-1)!.onended?.(); });
    expect(voice.voiceState).toBe("recording");
    await act(async () => { voice.handleTTSBinary(realtimePcm()); });
    expect(raw.length).toBe(1);
  });

  test("a bare tts_end mid-turn keeps the listening state", async () => {
    await mount();
    await beginRealtime();
    await act(async () => { voice.handleTTSEnd(); });
    expect(voice.voiceState).toBe("recording");
  });

  test("realtime output draining returns to listening", async () => {
    await mount();
    await beginRealtime();
    await act(async () => { voice.handleTTSBinary(realtimePcm()); });
    expect(voice.voiceState).toBe("speaking");
    await act(async () => { sources().at(-1)!.onended?.(); });
    expect(voice.voiceState).toBe("recording");
  });

  test("cancelling a clip returns to listening", async () => {
    await mount();
    await beginRealtime();
    await beginTTS();
    await act(async () => { voice.cancelTTS(); });
    expect(voice.voiceState).toBe("recording");
  });

  test("an ended clip while the model is still talking shows speaking", async () => {
    await mount();
    await beginRealtime();
    await beginTTS();
    await act(async () => { voice.handleTTSBinary(realtimePcm()); });
    await act(async () => { voice.handleTTSEnd("standard-tts"); sources().find(s => s.buffer?.duration === 1)!.onended?.(); });
    expect(voice.voiceState).toBe("speaking");
  });
});

describe("socket drop and reconnect", () => {
  test("a dropped socket ends the session: late PCM is ignored and forceIdle works again", async () => {
    await mount();
    await beginRealtime();
    await act(async () => { voice.handleDisconnect(); voice.handleTTSBinary(realtimePcm()); });
    expect(raw.length).toBe(0);
    expect(voice.voiceState).toBe("idle");
    await beginTTS();
    await act(async () => { voice.forceIdle(); });
    expect(voice.ttsAudioPlaying).toBe(false);
    expect(voice.voiceState).toBe("idle");
  });

  test("after a reconnect the next recording streams on the new socket", async () => {
    const wsRef = await mount();
    await beginRealtime();
    await act(async () => { voice.handleDisconnect(); });
    const fresh: string[] = [];
    wsRef.current = socket(fresh);
    await act(async () => { voice.startRecording(); });
    expect(pcmStarts(fresh)).toHaveLength(1);
    expect(voice.voiceState).toBe("recording");
    await act(async () => { voice.handleTTSBinary(realtimePcm()); });
    expect(raw.length).toBe(1);
  });

  test("a TTS turn cut off by a dropped socket settles instead of sticking on speaking", async () => {
    await mount();
    await beginTTS();
    await act(async () => { voice.handleDisconnect(); });
    expect(voice.voiceState).toBe("speaking");
    await act(async () => { sources().at(-1)!.onended?.(); });
    expect(voice.voiceState).toBe("idle");
  });
});

describe("session scope", () => {
  test("a live session carries the next recording even after the poll says realtime is off", async () => {
    await mount();
    await beginRealtime();
    await act(async () => { voice.stopRecording(); });
    // The model answers and its reply drains, so the orb is idle again.
    await act(async () => { voice.handleTTSBinary(realtimePcm()); });
    await act(async () => { sources().at(-1)!.onended?.(); });
    expect(voice.voiceState).toBe("idle");
    available = false;
    await act(async () => { pollAvailability?.(); });
    await act(async () => { voice.startRecording(); });
    expect(pcmStarts()).toHaveLength(2);
    expect(voice.voiceState).toBe("recording");
  });

  test("an unrelated error frame leaves the live session alone", async () => {
    await mount();
    await beginRealtime();
    await act(async () => { voice.handleError("chat request failed"); voice.handleTTSBinary(realtimePcm()); });
    expect(raw.length).toBe(1);
    expect(messages().some(m => m.type === "voice_end")).toBe(false);
  });

  test("a realtime error ends the session", async () => {
    await mount();
    await beginRealtime();
    await act(async () => { voice.handleRealtimeError("upstream failed"); voice.handleTTSBinary(realtimePcm()); });
    expect(raw.length).toBe(0);
    expect(messages().some(m => m.type === "voice_end")).toBe(true);
    expect(voice.voiceState).toBe("error");
  });

  test("a realtime error does not cut an ordinary clip", async () => {
    await mount();
    await beginRealtime();
    await beginTTS();
    await act(async () => { voice.handleRealtimeError("upstream failed"); });
    expect(voice.voiceState).toBe("speaking");
    expect(voice.ttsAudioPlaying).toBe(true);
  });

  test("no voice_start goes out when the capture graph cannot be built", async () => {
    await mount();
    failWorklet = true;
    await act(async () => { voice.startRecording(); });
    expect(pcmStarts()).toHaveLength(0);
    await act(async () => { voice.handleTTSBinary(realtimePcm()); });
    expect(raw.length).toBe(0);
  });

  test("an error flash settles back to listening over a live mic, and never overrides a newer state", async () => {
    await mount({ errorFlashMs: 20 });
    await beginRealtime();
    await act(async () => { voice.handleError("chat request failed"); });
    expect(voice.voiceState).toBe("error");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
    expect(voice.voiceState).toBe("recording");
    await act(async () => { voice.handleError("chat request failed"); voice.handleTTSStart("after-error"); });
    expect(voice.voiceState).toBe("speaking");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
    expect(voice.voiceState).toBe("speaking");
  });

  test("no voice_start goes into a socket that dropped while the mic was starting", async () => {
    const wsRef = await mount();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          (wsRef.current as unknown as { readyState: number }).readyState = WebSocket.CLOSED;
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    });
    await act(async () => { voice.startRecording(); });
    expect(pcmStarts()).toHaveLength(0);
    expect(voice.voiceState).not.toBe("recording");
  });

  test("an unavailable refusal re-checks availability at once", async () => {
    await mount();
    await beginRealtime();
    const before = fetches;
    await act(async () => { voice.handleRealtimeClosed("unavailable"); });
    expect(fetches).toBe(before + 1);
  });
});
