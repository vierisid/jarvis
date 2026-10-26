/**
 * #1026 item 3: a pebble fast-path confirmation ("Closed Settings.", "Hid the
 * amber background agent.") acknowledges something done on this screen. It
 * was mirrored with broadcastHeartbeat, which also runs
 * channelService.broadcastToAll, so it reached every connected Telegram and
 * Discord recipient. Owner decision: these go to the dashboard only.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { WebSocketService } from './ws-service.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { ChannelService } from './channel-service.ts';
import { AgentOrchestrator } from '../agents/orchestrator.ts';

function service() {
  const fakeAgent = {
    setDelegationCallback: () => {},
    getConfig: () => ({ llm: { providers: {} } }) as unknown as JarvisConfig,
    getOrchestrator: () => new AgentOrchestrator(),
  } as never;
  const svc = new WebSocketService(0, fakeAgent);
  const dashboard: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ws = { send: (raw: string) => { dashboard.push(JSON.parse(raw)); return raw.length; }, sendBinary: () => {} };
  (svc as unknown as { wsServer: { getClients: () => Set<unknown> } }).wsServer.getClients().add(ws);
  const channels: string[] = [];
  svc.setChannelService({
    broadcastToAll: async (text: string) => { channels.push(text); },
  } as unknown as ChannelService);
  return { svc, dashboard, channels };
}

describe('pebble fast-path confirmations stay on the dashboard (#1026)', () => {
  test('the dashboard-only heartbeat reaches the dashboard and no channel', async () => {
    const { svc, dashboard, channels } = service();
    svc.broadcastHeartbeatToDashboard('Closed Settings.');
    await Promise.resolve();
    expect(dashboard).toHaveLength(1);
    expect(dashboard[0]).toMatchObject({ type: 'chat', payload: { text: 'Closed Settings.', source: 'heartbeat' } });
    expect(channels).toEqual([]);
  });

  test('the ordinary heartbeat still reaches both, so the narrowing is only where it is asked for', async () => {
    const { svc, dashboard, channels } = service();
    svc.broadcastHeartbeat('A goal update.');
    await Promise.resolve();
    expect(dashboard).toHaveLength(1);
    expect(channels).toEqual(['A goal update.']);
  });

  test('every fast path mirrors through the dashboard-only heartbeat', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const wiring = src.slice(src.indexOf('const speakConfirmation = makeSpeakConfirmation({'));
    expect(wiring.slice(0, wiring.indexOf('});'))).toContain('heartbeat: (text) => wsService.broadcastHeartbeatToDashboard(text),');
    // The panel-intent path used to call broadcastHeartbeat(confirm) itself.
    // What still reaches channels from index.ts is the full LLM reply of a
    // pebble turn and the goal service's chat callback, nothing else.
    const direct = [...src.matchAll(/wsService\.broadcastHeartbeat\(([^)]*)\)/g)].map((m) => m[1]);
    expect(direct.sort()).toEqual(['fullText', 'text']);
  });
});
