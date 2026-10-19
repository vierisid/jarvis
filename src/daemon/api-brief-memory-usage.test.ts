import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb, closeDb } from '../vault/schema';
import { ChatTurnRepository } from '../vault/chat-turns';
import { createEntity } from '../vault/entities';
import { createFact, deleteFact } from '../vault/facts';
import { getMemoryUsageLedger, MemoryUsageLedger, memoryFactRef } from '../vault/memory-usage';
import { MemoryStream } from '../brief/memory-stream';
import { registerMemoryUsage } from '../brief/registrations/memory-usage';
import { registerMemoryStream } from '../brief/registrations/memory-stream';
import { BriefCapabilities } from '../brief/capabilities';
import { createApiRoutes, type ApiContext } from './api-routes';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';

let saved: string | undefined, ledger: MemoryUsageLedger;
beforeEach(() => { saved = process.env.JARVIS_BRIEF_MEMORY_USAGE; process.env.JARVIS_BRIEF_MEMORY_USAGE = '1'; initDatabase(':memory:', { quiet: true }); ledger = getMemoryUsageLedger(); });
afterEach(() => { closeDb(); if (saved === undefined) delete process.env.JARVIS_BRIEF_MEMORY_USAGE; else process.env.JARVIS_BRIEF_MEMORY_USAGE = saved; });
const path = '/api/brief/memory-usage';
function table(enabled = true, registered = ledger) {
  const stream = new MemoryStream(getDb(), ledger);
  return createApiRoutes({ briefMemoryUsage: ledger, briefMemoryStream: stream,
    briefCapabilities: new BriefCapabilities([...registerMemoryUsage(registered), ...registerMemoryStream(stream)], enabled ? ['memoryUsage', 'memoryStream'] : []) } as ApiContext) as Record<string, any>;
}
async function call(suffix = '?conversationId=unknown', routes = table()) {
  const response = await routes[path].GET(new Request(`http://localhost${path}${suffix}`));
  expect(response.headers.get('Cache-Control')).toBe('no-store'); return { status: response.status, body: await response.json() };
}
function supplied() {
  const repo = new ChatTurnRepository(getDb()), conversationId = repo.conversations.create().conversationId;
  const ref = { conversationId, turnId: 'turn', requestId: 'request' }; repo.accept({ ...ref, text: 'SECRET PROMPT' }); repo.start(ref);
  const fact = createFact(createEntity('person', 'Ada').id, 'note', 'SECRET FACT', { quote: 'SECRET QUOTE', sourceRef: 'SECRET SOURCE' });
  const target = { purpose: 'conversation_context' as const, turn: ref, runId: null, workflowId: null, callId: ref.turnId };
  ledger.record(target, [memoryFactRef(fact, 'Ada')], 'selected'); ledger.record(target, [memoryFactRef(fact, 'Ada')], 'supplied');
  return { fact, ref };
}
test('missing, mismatched, disabled and replaced providers never return an empty success', async () => {
  expect((await call('', createApiRoutes({} as ApiContext))).status).toBe(501);
  expect((await call(undefined, table(true, new MemoryUsageLedger(getDb())))).status).toBe(501);
  expect((await call(undefined, table(false))).status).toBe(503);
  const routes = table(); closeDb(); initDatabase(':memory:', { quiet: true });
  expect((await call(undefined, routes)).status).toBe(503);
});
test('safe summaries preserve deleted fact IDs and stages without exposing content or crossing conversations', async () => {
  const { fact, ref } = supplied(); deleteFact(fact.id);
  const result = await call(`?conversationId=${ref.conversationId}`);
  expect(result.status).toBe(200); expect(result.body.data.uses).toHaveLength(2);
  expect(result.body.data.uses.every((u: any) => u.factId === fact.id && u.factState === 'missing' && u.turn.conversationId === ref.conversationId)).toBe(true);
  expect(result.body.data.coverage).toMatchObject({ retentionDays: 90, maxRecords: 50_000, paths: ['brief_conversation_recall', 'workflow_ask_recall'] });
  for (const secret of ['SECRET PROMPT', 'SECRET FACT', 'SECRET QUOTE', 'SECRET SOURCE']) expect(JSON.stringify(result)).not.toContain(secret);
  expect(await call('?conversationId=another')).toMatchObject({ status: 200, body: { state: 'empty', data: { uses: [] } } });
});
test('strict target filters reject missing, ambiguous, duplicate, unknown and malformed values', async () => {
  for (const suffix of ['', '?conversationId=', '?conversationId=a&runId=b', '?runId=a&runId=b', '?q=secret', '?runId=%00', '?runId=%2F', '?runId=' + 'x'.repeat(201)]) {
    expect((await call(suffix)).status).toBe(400);
  }
});
test('real F18 provider satisfies the F17 dependency only with both flags, and exposes coverage', async () => {
  const { ref } = supplied(), routes = table();
  const response = await routes['/api/brief/memory'].GET(new Request(`http://localhost/api/brief/memory?usedIn=conversation:${ref.conversationId}`));
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: 'ready', data: { count: { matched: 1 }, usageCoverage: { retentionDays: 90 } } });
  delete process.env.JARVIS_BRIEF_MEMORY_USAGE;
  expect((await call(undefined, routes)).status).toBe(503);
  expect((await routes['/api/brief/memory'].GET(new Request('http://localhost/api/brief/memory'))).status).toBe(503);
});
test('usage history is protected by real HTTP panel authentication and stays no-store', async () => {
  const { ref } = supplied(), directory = mkdtempSync(join(tmpdir(), 'jarvis-f18-http-')), socket = join(directory, 'api.sock');
  const server = new WebSocketServer(0, socket), sessions = new PanelSessionStore();
  server.setSidecarManager({ openPanelSession: async (token: string) => token === 'fixture-access' ? sessions.create('fixture') : null,
    resolvePanelSession: (value: string) => sessions.get(value) } as SidecarManager);
  server.setApiRoutes(table());
  const send = (query: string, init: RequestInit = {}) => fetch(`http://localhost${path}${query}`, { ...init, unix: socket });
  try {
    server.start(); expect((await send(`?conversationId=${ref.conversationId}`)).status).toBe(401);
    const bootstrap = await send('?token=fixture-access', { redirect: 'manual' });
    const response = await send(`?conversationId=${ref.conversationId}`, { headers: { Cookie: bootstrap.headers.get('set-cookie')!.split(';')[0]! } });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.json() as any).data.uses).toHaveLength(2);
  } finally { server.stop(); rmSync(directory, { recursive: true, force: true }); }
});
