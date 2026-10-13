/** F-27 loopback-only synthetic transport. No daemon, database, tools, models or credentials. */
import page from '../ui/src/brief/reconciliation/preview/index.html';
import { BriefCapabilities } from '../src/brief/capabilities';
import { registerReconciliation } from '../src/brief/registrations/reconciliation';
const ready = { readiness: () => 'ready' as const };
const caps = new BriefCapabilities([...registerReconciliation(() => ({ snapshots: true, sharedSocket: true, identityLifecycle: true })),
  { id: 'decisions', provider: ready }, { id: 'memoryStream', provider: ready }, { id: 'memoryUsage', provider: ready },
  { id: 'workflowContext', provider: ready }], ['reconciliation', 'decisions', 'memoryStream', 'memoryUsage', 'workflowContext']);
let changed = false, memoryUnavailable = false;
const sockets = new Set<import('bun').ServerWebSocket<undefined>>();
const broadcast = (sequence: number) => { for (const socket of sockets) socket.send(JSON.stringify({ type: 'goal_event',
  payload: { eventId: `fixture-${sequence}`, sequence }, timestamp: Date.now() })); };
const server = Bun.serve<undefined>({ hostname: '127.0.0.1', port: 4427, routes: { '/': page },
  websocket: { open(socket) { sockets.add(socket); }, close(socket) { sockets.delete(socket); }, message() {} },
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === '/ws' && server.upgrade(request, { data: undefined })) return;
    const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
    if (request.method === 'POST') {
      if (path === '/fixture/drop') changed = true;
      else if (path === '/fixture/reconnect') { for (const socket of sockets) socket.close(); }
      else if (path === '/fixture/reorder') { for (const sequence of [1, 4, 4, 2, 3]) broadcast(sequence); }
      else if (path === '/fixture/unavailable') { memoryUnavailable = true; broadcast(5); }
      else if (path === '/fixture/recover') { memoryUnavailable = false; broadcast(6); }
      else return json({ error: 'Fixture allowlist' }, 404);
      return json({ ok: true });
    }
    if (request.method !== 'GET') return json({ error: 'Fixture allowlist' }, 405);
    if (path === '/api/brief/capabilities') return json(caps.snapshot());
    if (path === '/api/authority/approvals') return json([]);
    if (path === '/api/vault/conversations/active') return json({ messages: [] });
    if (path === '/api/brief/decisions') return json({ state: 'ready', asOf: Date.now(), data: {
      items: (changed ? ['approval-a', 'approval-b'] : ['approval-a']).map(decisionId => ({ decisionId, revision: changed ? '2' : '1', title: decisionId })), nextCursor: null } });
    if (path === '/api/brief/memory') {
      if (memoryUnavailable) return json({ state: 'unavailable' }, 503);
      return json({ state: changed ? 'empty' : 'ready', asOf: Date.now(), data: {
        items: changed ? [] : [{ factId: 'fact-a', revision: '1', sentence: 'Synthetic fact to forget' }], nextCursor: null,
        count: { total: changed ? 0 : 1, matched: changed ? 0 : 1, returned: changed ? 0 : 1 }, usedIn: { state: 'ready' } } });
    }
    if (path === '/api/brief/workflows/flow-a/inspection') {
      const ref = { scopeId: 'fixture', flowId: 'flow-a', versionId: 'version-a', runId: 'run-a' };
      return json({ status: 'ready', data: { ...ref, canvas: { status: 'empty' }, context: {},
        run: { ...ref, label: 'Selected run A', status: changed ? 'paused' : 'queued' } } });
    }
    return json({ error: 'Not provided by this isolated fixture' }, 501);
  },
});
console.log(`F-27 synthetic fixture: ${server.url}`);
