import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocketService } from './ws-service.ts';
import { clearRealtimeGateCache } from './realtime-gate.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { issueTrialEntitlement, startTrialClock, TRIAL_DURATION_MS } from '../trial/entitlement.ts';
import type { JarvisConfig } from '../config/types.ts';

/**
 * The conductor branch in the realtime starter, exercised through the real
 * service (constructed, never start()ed) the way ws-service-voice-start.test.ts
 * does. No session is ever dialed: the assertions all land before the socket to
 * OpenAI would open.
 *
 * The load-bearing test in here is the FIRST one. An install with no trial —
 * every install today — has to behave exactly as it does on main, and the only
 * thing standing between a stranger and a conductor session is the entitlement
 * check on `trial_conductor_start`.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearRealtimeGateCache();
  closeDb();
});

/** Realtime OFF, exactly as it ships (`src/config/types.ts` default). */
const shippedConfig = () => ({
  voice: { wake_engine: 'openwakeword', realtime: { enabled: false, max_session_minutes: 10 } },
  usejarvis_ai: { base_url: 'https://llm.usejarvis.host', api_key: 'sk-uj-abc' },
  llm: { providers: {} },
}) as unknown as JarvisConfig;

function makeService(config: JarvisConfig = shippedConfig()) {
  const fakeAgent = { setDelegationCallback: () => {}, getConfig: () => config } as never;
  const svc = new WebSocketService(0, fakeAgent);
  const sent: Array<Record<string, unknown>> = [];
  const broadcast: Array<Record<string, unknown>> = [];
  const ws = { send: (raw: string) => { sent.push(JSON.parse(raw) as Record<string, unknown>); }, sendBinary: () => {} } as never;
  const internals = svc as unknown as {
    wsServer: { getClients: () => Set<unknown>; broadcast: (m: unknown) => void };
    voiceSessions: Map<unknown, unknown>;
    realtimeSessions: Map<unknown, unknown>;
    trialConductor: { isArmed: (ws: unknown) => boolean };
    routeMessage: (msg: unknown, ws: unknown) => Promise<unknown>;
  };
  internals.wsServer.getClients().add(ws);
  const realBroadcast = internals.wsServer.broadcast.bind(internals.wsServer);
  internals.wsServer.broadcast = (m: unknown) => {
    broadcast.push(m as Record<string, unknown>);
    realBroadcast(m);
  };
  return { svc, ws, sent, broadcast, internals };
}

/** The hosted plan catalog. Excluding realtime lets the starter report a
 *  refusal instead of dialing OpenAI, which is what makes this testable. */
function catalog(includesRealtime: boolean) {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: includesRealtime ? [{ id: 'uj-realtime' }] : [{ id: 'uj-chat' }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as unknown as typeof fetch;
}

const conductorStart = () => ({ type: 'trial_conductor_start', payload: {}, timestamp: Date.now() });
const voiceStart = () => ({
  type: 'voice_start',
  payload: { requestId: 'req-1', currentRoom: 'home', mode: 'pcm' as const },
  timestamp: Date.now(),
});

describe('an install with no trial entitlement', () => {
  test('cannot become the conductor, however politely it asks', async () => {
    initDatabase(':memory:');
    const { ws, internals } = makeService();

    const reply = await internals.routeMessage(conductorStart(), ws) as { type: string; payload: { code: string } };

    expect(reply.type).toBe('error');
    expect(reply.payload.code).toBe('no_trial');
    expect(internals.trialConductor.isArmed(ws)).toBe(false);
  });

  test('its voice_start behaves exactly as it does on main — realtime stays off', async () => {
    initDatabase(':memory:');
    let catalogFetches = 0;
    globalThis.fetch = (async () => { catalogFetches++; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const { ws, internals } = makeService();

    await internals.routeMessage(voiceStart(), ws);

    // `voice.realtime.enabled` is false, so resolve fails and the starter
    // returns before it reaches the plan gate: the standard STT accumulator
    // takes the utterance. Unchanged behaviour.
    expect(internals.realtimeSessions.has(ws)).toBe(false);
    expect(internals.voiceSessions.has(ws)).toBe(true);
    expect(catalogFetches).toBe(0);
  });

  test('an expired trial is no trial', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: Date.now() - TRIAL_DURATION_MS * 3 });
    startTrialClock(Date.now() - TRIAL_DURATION_MS * 2);
    const { ws, internals } = makeService();

    const reply = await internals.routeMessage(conductorStart(), ws) as { payload: { code: string } };

    expect(reply.payload.code).toBe('no_trial');
    expect(internals.trialConductor.isArmed(ws)).toBe(false);
  });
});

describe('an install with a running trial', () => {
  test('arms the socket and reports the clock, which has not started (D9)', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({});
    const { ws, internals, broadcast } = makeService();

    const reply = await internals.routeMessage(conductorStart(), ws);

    expect(reply).toBeUndefined(); // no error
    expect(internals.trialConductor.isArmed(ws)).toBe(true);
    const status = broadcast.find((m) => m.type === 'trial_status');
    expect(status).toBeDefined();
    expect((status!.payload as { state: string; started_at: number | null }).state).toBe('issued');
    expect((status!.payload as { started_at: number | null }).started_at).toBeNull();
  });

  test('the D1 overlay turns realtime on for the armed socket alone', async () => {
    // The config here has realtime DISABLED. An unarmed socket resolves to
    // nothing and never consults the plan catalog; an armed one gets past
    // resolve and reaches the gate. That the catalog is asked at all is the
    // proof that the overlay applied — and the refusal is what keeps this test
    // from dialing OpenAI.
    initDatabase(':memory:');
    issueTrialEntitlement({});
    catalog(false);
    const { ws, sent, internals } = makeService();

    await internals.routeMessage(conductorStart(), ws);
    await internals.routeMessage(voiceStart(), ws);

    const status = sent.find((m) => m.type === 'realtime_status');
    expect((status?.payload as { reason?: string })?.reason).toBe('plan');
    // And no standard accumulator: the conductor is a PCM client.
    expect(internals.voiceSessions.has(ws)).toBe(false);
  });

  test('a second socket on the same install is not the conductor', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({});
    const { ws, internals } = makeService();
    const other = { send: () => {}, sendBinary: () => {} } as never;
    internals.wsServer.getClients().add(other);

    await internals.routeMessage(conductorStart(), ws);

    // The shell's own socket keeps its ordinary voice behaviour while the
    // conversation runs — the room beats will drive it, not speak through it.
    expect(internals.trialConductor.isArmed(ws)).toBe(true);
    expect(internals.trialConductor.isArmed(other)).toBe(false);
  });
});
