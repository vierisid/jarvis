import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
let voice: ReturnType<typeof useVoice>;
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
let available = true;
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
  audioWorklet = { addModule: async () => {} };
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
const pcm = () => new Int16Array([0, 4000, -4000, 0]).buffer;
const sources = () => contexts.flatMap(ctx => ctx.sources);

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ useVoice } = await import("./useVoice"));
});
beforeEach(() => {
  available = true;
  contexts.length = sent.length = decoded.length = raw.length = 0;
  deferDecode = false;
  resolveDecode = null;
  pollAvailability = null;
  window.setInterval = ((handler: () => void, delay: number, ...args: any[]) => {
    if (delay === 15000) pollAvailability = handler;
    return originals.interval.call(window, handler, delay, ...args);
  }) as typeof window.setInterval;
  globals.AudioContext = AudioDevice;
  globals.AudioWorkletNode = class extends AudioSource { port = { onmessage: null }; };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  });
  globalThis.fetch = (async () => new Response(JSON.stringify({
    realtime: { enabled: available, available },
  }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
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

async function mount() {
  const wsRef = { current: { readyState: WebSocket.OPEN, send: (data: string) => { sent.push(data); } } as unknown as WebSocket };
  function Harness() {
    voice = useVoice({ wsRef, nativeWakeActive: true });
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
}
async function beginTTS(id = "standard-tts") {
  await act(async () => { voice.handleTTSStart(id); voice.handleTTSBinary(mp3()); });
}
async function beginRealtime() {
  await act(async () => { voice.startRecording(); });
  expect(sent.some(data => JSON.parse(data).payload?.mode === "pcm")).toBe(true);
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

  test("availability alone never authorizes unframed raw playback", async () => {
    await mount();
    await act(async () => { voice.handleTTSBinary(pcm()); });
    expect(raw.length).toBe(0);
    expect(decoded.length).toBe(0);
  });

  test("a real realtime session plays PCM and barge-in flushes without closing it", async () => {
    await mount();
    await beginRealtime();
    await act(async () => { voice.handleTTSBinary(pcm()); });
    expect(raw).toEqual([{ rate: 24000, length: 4 }]);
    expect(decoded.length).toBe(0);
    await act(async () => { voice.handleTTSEnd(undefined, true); });
    expect(sources().at(-1)!.stopped).toBe(true);
    expect(sent.some(data => JSON.parse(data).type === "voice_end")).toBe(false);
    await act(async () => { voice.handleTTSBinary(pcm()); });
    expect(raw.length).toBe(2);
  });

  test("marked TTS takes the decoder path even during a realtime session", async () => {
    await mount();
    await beginRealtime();
    await beginTTS();
    expect(decoded.length).toBe(1);
    expect(raw.length).toBe(0);
    await act(async () => { voice.handleTTSEnd("standard-tts"); sources().at(-1)!.onended?.(); });
    await act(async () => { voice.handleTTSBinary(pcm()); });
    expect(raw.length).toBe(1);
  });

  test("closed realtime session rejects late PCM and permits subsequent standard TTS", async () => {
    await mount();
    await beginRealtime();
    await act(async () => { voice.handleRealtimeClosed(); voice.handleTTSBinary(pcm()); });
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
    await act(async () => { voice.handleTTSBinary(pcm()); });
    expect(raw.length).toBe(1);
    await act(async () => { voice.handleRealtimeClosed(); voice.handleTTSBinary(pcm()); });
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
