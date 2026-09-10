import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocketService } from './ws-service.ts';
import { clearRealtimeGateCache } from './realtime-gate.ts';
import type { JarvisConfig } from '../config/types.ts';

/**
 * pr6#1 regression suite — the plan-gate refusal must never swallow the
 * standard WAV voice pipeline. The service is constructed but never
 * start()ed (no port bound); routeMessage/handleVoiceAudio are exercised
 * directly, with the gate driven through a stubbed global fetch.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearRealtimeGateCache();
});

const hostedConfig = () => ({
  voice: { realtime: { enabled: true } },
  usejarvis_ai: { base_url: 'https://llm.usejarvis.host', api_key: 'sk-uj-abc' },
  llm: { providers: {} },
}) as unknown as JarvisConfig;

const makeService = (config: JarvisConfig = hostedConfig()) => {
  const fakeAgent = {
    setDelegationCallback: () => {},
    getConfig: () => config,
  } as never;
  const svc = new WebSocketService(0, fakeAgent);
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    send: (raw: string) => { sent.push(JSON.parse(raw) as Record<string, unknown>); },
    sendBinary: () => {},
  } as never;
  // Liveness: the starter checks membership in the server's client set to
  // detect a mid-gate disconnect. Register by default; tests remove to
  // simulate a disconnect.
  const internals = svc as unknown as {
    wsServer: { getClients: () => Set<unknown> };
    voiceSessions: Map<unknown, { chunks: Buffer[] }>;
    realtimeSessions: Map<unknown, unknown>;
    pendingVoiceFrames: Map<unknown, { chunks: Buffer[]; bytes: number; ended?: boolean }>;
    routeMessage: (msg: unknown, ws: unknown) => Promise<unknown>;
    handleVoiceAudio: (data: Buffer, ws: unknown) => Promise<void>;
  };
  internals.wsServer.getClients().add(ws);
  return { svc, ws, sent, internals };
};

const refusingCatalog = () => {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: [{ id: 'uj-chat' }] }), // no uj-realtime → excluded
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as unknown as typeof fetch;
};

const voiceStart = (mode?: 'pcm' | 'wav') => ({
  type: 'voice_start',
  payload: { requestId: 'req-1', currentRoom: 'home', ...(mode ? { mode } : {}) },
  timestamp: Date.now(),
});

describe('voice_start under a plan-excluded hosted realtime config', () => {
  test('a WAV-mode utterance opens the standard accumulator without touching the gate', async () => {
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const { ws, internals } = makeService();
    await internals.routeMessage(voiceStart('wav'), ws);
    expect(internals.voiceSessions.has(ws)).toBe(true);
    expect(internals.realtimeSessions.has(ws)).toBe(false);
    expect(fetches).toBe(0); // wav never consults the realtime gate
  });

  test('a WAV utterance still transcribes AFTER a cached refusal (the pr6#1 outage)', async () => {
    refusingCatalog();
    const { ws, sent, internals } = makeService();
    // Utterance 1 (pcm): refused, verdict now cached false.
    await internals.routeMessage(voiceStart('pcm'), ws);
    expect(sent.some((m) => (m.payload as { reason?: string })?.reason === 'plan')).toBe(true);
    // Utterance 2 (wav — the client downgraded): must reach the accumulator,
    // not be swallowed by the cached refusal.
    await internals.routeMessage(voiceStart('wav'), ws);
    expect(internals.voiceSessions.has(ws)).toBe(true);
    const wav = Buffer.from('RIFFxxxxWAVE');
    await internals.handleVoiceAudio(wav, ws);
    expect(internals.voiceSessions.get(ws)!.chunks).toEqual([wav]);
  });

  test('a PCM refusal opens NO standard session (headerless frames are not WAV)', async () => {
    refusingCatalog();
    const { ws, sent, internals } = makeService();
    await internals.routeMessage(voiceStart('pcm'), ws);
    expect(internals.voiceSessions.has(ws)).toBe(false);
    expect(internals.realtimeSessions.has(ws)).toBe(false);
    expect(internals.pendingVoiceFrames.has(ws)).toBe(false);
    const status = sent.find((m) => m.type === 'realtime_status');
    expect((status?.payload as { state?: string; reason?: string })?.state).toBe('closed');
    expect((status?.payload as { state?: string; reason?: string })?.reason).toBe('plan');
  });

  test('a mode-less (older client) voice_start fails OPEN to the standard pipeline', async () => {
    refusingCatalog();
    const { ws, internals } = makeService();
    await internals.routeMessage(voiceStart(), ws);
    expect(internals.voiceSessions.has(ws)).toBe(true);
    expect(internals.realtimeSessions.has(ws)).toBe(false);
  });

  test('frames arriving mid-gate are buffered and seed the fallback accumulator', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    globalThis.fetch = (async () => {
      await gate;
      return new Response(JSON.stringify({ data: [{ id: 'uj-chat' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const { ws, internals } = makeService();
    const routed = internals.routeMessage(voiceStart(), ws);
    await Bun.sleep(1); // let the starter park on the gate
    const frame = Buffer.from('RIFFdataWAVE');
    await internals.handleVoiceAudio(frame, ws); // would previously warn-drop
    release();
    await routed;
    expect(internals.voiceSessions.get(ws)!.chunks).toEqual([frame]);
  });
});

describe('disconnect during the gate window', () => {
  test('no realtime session is created for a socket that left mid-gate', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    globalThis.fetch = (async () => {
      await gate;
      return new Response(JSON.stringify({ data: [{ id: 'uj-realtime' }] }), { // plan INCLUDES realtime
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const { ws, internals } = makeService();
    const routed = internals.routeMessage(voiceStart('pcm'), ws);
    await Bun.sleep(1);
    internals.wsServer.getClients().delete(ws); // the client disconnected
    release();
    await routed;
    // Before the liveness re-check this dialed a live, billed session into a
    // dead socket until max_session_minutes.
    expect(internals.realtimeSessions.has(ws)).toBe(false);
    expect(internals.pendingVoiceFrames.has(ws)).toBe(false);
  });
});

describe('voice_start when the daemon cannot resolve realtime', () => {
  const offConfig = () => ({
    voice: { realtime: { enabled: false } },
    llm: { providers: {} },
  }) as unknown as JarvisConfig;

  // The client's settings poll can still say realtime is on (it lags up to one
  // poll interval behind a toggle). Its PCM frames are useless to the WAV
  // accumulator, so falling back used to drop the turn with nothing said.
  test('a PCM client is told the session is closed instead of feeding the WAV pipeline', async () => {
    const { ws, sent, internals } = makeService(offConfig());
    await internals.routeMessage(voiceStart('pcm'), ws);
    expect(internals.voiceSessions.has(ws)).toBe(false);
    expect(internals.realtimeSessions.has(ws)).toBe(false);
    expect(internals.pendingVoiceFrames.has(ws)).toBe(false);
    const status = sent.find((m) => m.type === 'realtime_status');
    expect(status?.payload).toMatchObject({ state: 'closed', reason: 'unavailable' });
  });

  test('a mode-less client still falls open to the standard pipeline', async () => {
    const { ws, sent, internals } = makeService(offConfig());
    await internals.routeMessage(voiceStart(), ws);
    expect(internals.voiceSessions.has(ws)).toBe(true);
    expect(sent.some((m) => m.type === 'realtime_status')).toBe(false);
  });
});

describe('realtime output on the dashboard socket', () => {
  test('is tagged so the dashboard can tell it from encoded TTS', async () => {
    const { untagRealtimePcm } = await import('../comms/realtime-frame.ts');
    const { ws, internals } = makeService();
    const frames: Buffer[] = [];
    (ws as unknown as { sendBinary: (b: Buffer) => void }).sendBinary = (b) => { frames.push(b); };
    const sink = (internals as unknown as {
      realtimeAudioSink: (socket: unknown) => (chunk: Buffer) => void;
    }).realtimeAudioSink(ws);
    sink(Buffer.from([1, 2, 3, 4]));
    expect(frames).toHaveLength(1);
    const payload = untagRealtimePcm(new Uint8Array(frames[0]!).buffer);
    expect(payload && [...new Uint8Array(payload)]).toEqual([1, 2, 3, 4]);
  });
});

describe('proactive TTS and live realtime sessions', () => {
  const fakeClient = () => {
    const json: Array<Record<string, unknown>> = [];
    const binary: Buffer[] = [];
    const socket = {
      send: (raw: string) => { json.push(JSON.parse(raw) as Record<string, unknown>); },
      sendBinary: (b: Buffer) => { binary.push(b); },
    };
    return { socket, json, binary };
  };
  const withClients = (...clients: Array<ReturnType<typeof fakeClient>>) => {
    const { svc, internals } = makeService();
    const set = internals.wsServer.getClients();
    set.clear();
    for (const c of clients) set.add(c.socket);
    let synthesized = 0;
    (svc as unknown as { ttsProvider: unknown }).ttsProvider = {
      async *synthesizeStream() { synthesized++; yield Buffer.from('mp3-bytes'); },
    };
    return { svc, internals, synthesized: () => synthesized };
  };

  const session = (isResponding: boolean, lastMicAt = 0) => ({ session: { isResponding }, lastMicAt });

  // A proactive clip on a socket whose realtime reply is streaming talks over
  // the model, and the open mic feeds it back into the session.
  test('a socket whose model is answering gets no clip; the others get all of it', async () => {
    const live = fakeClient();
    const other = fakeClient();
    const { svc, internals } = withClients(live, other);
    internals.realtimeSessions.set(live.socket, session(true));
    await svc.broadcastProactiveVoice('Your meeting starts in five minutes.');
    expect(live.json).toEqual([]);
    expect(live.binary).toEqual([]);
    expect(other.json.map((m) => m.type)).toEqual(['tts_start', 'tts_end']);
    expect(other.binary).toHaveLength(1);
  });

  test('a socket whose user is talking into the session gets no clip', async () => {
    const talking = fakeClient();
    const { svc, internals, synthesized } = withClients(talking);
    internals.realtimeSessions.set(talking.socket, session(false, Date.now()));
    await svc.broadcastProactiveVoice('Heads up.');
    expect(synthesized()).toBe(0);
    expect(talking.json).toEqual([]);
  });

  // A session stays open for max_session_minutes after the last turn; skipping
  // proactive voice for that whole time would silence it for the dashboard.
  test('a session left open with no turn in progress still gets proactive voice', async () => {
    const open = fakeClient();
    const { svc, internals } = withClients(open);
    internals.realtimeSessions.set(open.socket, session(false, Date.now() - 60_000));
    await svc.broadcastProactiveVoice('Heads up.');
    expect(open.json.map((m) => m.type)).toEqual(['tts_start', 'tts_end']);
    expect(open.binary).toHaveLength(1);
  });
});

describe('mic frames on a socket with a realtime session', () => {
  const liveEntry = (pushed: Buffer[]) => ({
    transport: { pushMicChunk: (b: Buffer) => { pushed.push(b); } },
    lastMicAt: 0,
  });

  test('a WAV upload opened beside the session keeps its frames', async () => {
    const { ws, internals } = makeService();
    const pushed: Buffer[] = [];
    internals.realtimeSessions.set(ws, liveEntry(pushed));
    await internals.routeMessage(voiceStart('wav'), ws);
    const wav = Buffer.from('RIFFxxxxWAVE');
    await internals.handleVoiceAudio(wav, ws);
    expect(internals.voiceSessions.get(ws)!.chunks).toEqual([wav]);
    expect(pushed).toEqual([]);
  });

  test('realtime mic frames go to the session and mark the user as talking', async () => {
    const { ws, internals } = makeService();
    const pushed: Buffer[] = [];
    const entry = liveEntry(pushed);
    internals.realtimeSessions.set(ws, entry);
    const frame = Buffer.from([1, 2, 3, 4]);
    await internals.handleVoiceAudio(frame, ws);
    expect(pushed).toEqual([frame]);
    expect(entry.lastMicAt).toBeGreaterThan(0);
  });

  test('frames still arriving after a PCM refusal are dropped without a warning each', async () => {
    const offConfig = { voice: { realtime: { enabled: false } }, llm: { providers: {} } } as unknown as JarvisConfig;
    const { ws, internals } = makeService(offConfig);
    await internals.routeMessage(voiceStart('pcm'), ws);
    const warn = console.warn;
    let warnings = 0;
    console.warn = () => { warnings++; };
    try {
      await internals.handleVoiceAudio(Buffer.from([1, 2]), ws);
      await internals.handleVoiceAudio(Buffer.from([3, 4]), ws);
    } finally {
      console.warn = warn;
    }
    expect(warnings).toBe(0);
  });
});

describe('closing a realtime session', () => {
  test('a quiet close ends the session without a closed status', async () => {
    const { ws, sent, internals } = makeService();
    let closed = 0;
    internals.realtimeSessions.set(ws, {
      session: { close: () => { closed++; } },
      timeout: setTimeout(() => {}, 0),
      startedAt: Date.now(),
      hosted: true,
      lastMicAt: 0,
    });
    (internals as unknown as { closeRealtimeVoice: (s: unknown, o?: { notify?: boolean }) => void })
      .closeRealtimeVoice(ws, { notify: false });
    expect(closed).toBe(1);
    expect(internals.realtimeSessions.has(ws)).toBe(false);
    expect(sent.some((m) => m.type === 'realtime_status')).toBe(false);
    // Mic frames the client sent before it heard are dropped without a warning each.
    const warn = console.warn;
    let warnings = 0;
    console.warn = () => { warnings++; };
    try {
      await internals.handleVoiceAudio(Buffer.from([1, 2]), ws);
    } finally {
      console.warn = warn;
    }
    expect(warnings).toBe(0);
  });
});
