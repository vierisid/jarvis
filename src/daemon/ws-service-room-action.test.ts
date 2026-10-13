/**
 * The daemon's half of a room action that reports back (#933): the action is
 * broadcast with a resultId, and a panel's `room_action_result` on the
 * dashboard socket decides what the pebble says. The service is constructed
 * but never start()ed; broadcast() reaches the fake client registered here.
 */

import { describe, expect, test } from 'bun:test';
import { WebSocketService } from './ws-service.ts';
import type { JarvisConfig } from '../config/types.ts';

const makeService = () => {
  const fakeAgent = {
    setDelegationCallback: () => {},
    getConfig: () => ({ llm: { providers: {} } }) as unknown as JarvisConfig,
  } as never;
  const svc = new WebSocketService(0, fakeAgent);
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ws = { send: (raw: string) => { sent.push(JSON.parse(raw)); }, sendBinary: () => {} } as never;
  const internals = svc as unknown as {
    wsServer: { getClients: () => Set<unknown> };
    routeMessage: (msg: unknown, ws: unknown) => Promise<unknown>;
  };
  internals.wsServer.getClients().add(ws);
  const broadcastResultId = (): string => {
    const note = sent.find((m) => m.type === 'notification' && m.payload.source === 'room_action');
    if (!note) throw new Error('no room_action broadcast');
    return note.payload.resultId as string;
  };
  return { svc, ws, sent, internals, broadcastResultId };
};

describe('requestRoomAction', () => {
  test('broadcasts the action with a resultId and resolves on the panel answer', async () => {
    for (const [accepted, outcome] of [[true, 'accepted'], [false, 'rejected']] as const) {
      const { svc, ws, sent, internals, broadcastResultId } = makeService();
      const pending = svc.requestRoomAction({ room: 'settings', action: 'switch_tab', args: { tab: 'voice' } }, 1000);
      expect(sent[0]!.payload).toMatchObject({ source: 'room_action', room: 'settings', action: 'switch_tab', args: { tab: 'voice' } });
      const resultId = broadcastResultId();
      expect(typeof resultId).toBe('string');
      expect(resultId.length).toBeGreaterThan(0);
      const reply = await internals.routeMessage(
        { type: 'room_action_result', payload: { resultId, accepted }, timestamp: Date.now() }, ws);
      // Answered silently: no "Unknown message type" error back to the panel.
      expect(reply).toBeUndefined();
      expect(await pending).toBe(outcome);
    }
  });

  test('with no answer it says so instead of assuming success', async () => {
    const { svc } = makeService();
    expect(await svc.requestRoomAction({ room: 'workflows', action: 'switch_tab', args: { tab: 'editor' } }, 10))
      .toBe('no_answer');
  });

  test('with no client connected it says so at once, not after the timeout', async () => {
    const { svc, internals } = makeService();
    internals.wsServer.getClients().clear();
    const t0 = Date.now();
    expect(await svc.requestRoomAction({ room: 'settings', action: 'switch_tab', args: { tab: 'voice' } }, 60_000))
      .toBe('no_answer');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('an answer naming another request does not settle this one', async () => {
    const { svc, ws, internals } = makeService();
    const pending = svc.requestRoomAction({ room: 'settings', action: 'switch_tab', args: { tab: 'voice' } }, 30);
    await internals.routeMessage({ type: 'room_action_result', payload: { resultId: 'someone-else', accepted: true } }, ws);
    expect(await pending).toBe('no_answer');
  });
});
