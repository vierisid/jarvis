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
