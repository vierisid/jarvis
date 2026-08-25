import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { issueTrialEntitlement, startTrialClock } from '../trial/entitlement.ts';
import type { WSMessage } from '../comms/websocket.ts';

/**
 * `/api/trial/preview` draws one frame of the room beats' surfaces without a
 * microphone. It exists because the beats are only reachable through a live
 * realtime conversation, which made the proposal card, the authority ladder
 * and the pebble's flight unreviewable by eye.
 *
 * Two things have to hold. It must be OFF on an install with no trial, which
 * is every install today. And it must stay a DRAW: it writes nothing, it does
 * not advance the beat ledger, and it cannot be used to push arbitrary frames
 * at the dashboard.
 */

type Handler = (req: Request) => Response | Promise<Response>;

function handler(routes: Record<string, unknown>, path: string): Handler {
  const route = routes[path] as { POST?: Handler } | undefined;
  if (!route?.POST) throw new Error(`POST ${path} not registered`);
  return route.POST;
}

function ctxWith(sent: WSMessage[]): ApiContext {
  const config = structuredClone(DEFAULT_CONFIG) as JarvisConfig;
  return {
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config,
    agentService: {} as ApiContext['agentService'],
    wsService: { broadcastRaw: (m: WSMessage) => sent.push(m) } as unknown as ApiContext['wsService'],
  } as ApiContext;
}

function post(h: Handler, body: unknown): Response | Promise<Response> {
  return h(new Request('http://x/api/trial/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('/api/trial/preview', () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
  });
  afterEach(() => closeDb());

  test('is off on an install with no trial', async () => {
    const sent: WSMessage[] = [];
    const h = handler(createApiRoutes(ctxWith(sent)), '/api/trial/preview');
    const res = await post(h, { type: 'trial_proposal', payload: {} });
    expect(res.status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  test('is off once the trial has expired', async () => {
    const sent: WSMessage[] = [];
    const past = Date.now() - 72 * 60 * 60 * 1000;
    issueTrialEntitlement({ now: past });
    startTrialClock(past);
    const h = handler(createApiRoutes(ctxWith(sent)), '/api/trial/preview');
    expect((await post(h, { type: 'trial_proposal', payload: {} })).status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  test('draws a trial frame while a trial is running', async () => {
    const sent: WSMessage[] = [];
    issueTrialEntitlement({ now: Date.now() });
    const h = handler(createApiRoutes(ctxWith(sent)), '/api/trial/preview');
    const res = await post(h, {
      type: 'trial_proposal',
      payload: { proposal: { beat: 'goals', objective: 'x', keyResults: [] } },
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('trial_proposal');
  });

  test('cannot be used to push anything other than a trial frame', async () => {
    const sent: WSMessage[] = [];
    issueTrialEntitlement({ now: Date.now() });
    const h = handler(createApiRoutes(ctxWith(sent)), '/api/trial/preview');
    for (const type of ['notification', 'chat', 'command', 'realtime_status', '']) {
      const res = await post(h, { type, payload: { source: 'room_action' } });
      expect(res.status).toBe(400);
    }
    expect(sent).toHaveLength(0);
  });
});
