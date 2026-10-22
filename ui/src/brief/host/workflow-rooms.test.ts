import { afterEach, expect, test } from 'bun:test';
import { createWorkflowRooms } from './workflow-rooms';
import { createHostTransport } from './http';
import { BRIEF_CONTRACT_VERSION } from '../../../../src/brief/contracts';

const scopeId = 'scope', flowId = 'flow', versionId = 'v1';
const journal = `brief:manual-run:pending:v1:${scopeId}:${flowId}:${versionId}`;
const capabilities = () => ({ contractVersion: BRIEF_CONTRACT_VERSION, capabilities: {
  workflowContext: { supported: true, ready: true, enabled: true, state: 'ready', reason: null } } });
const summary = (requestId: string, patch = {}) => ({ scopeId, flowId, runId: 'run-1', versionId, label: 'Run run-1',
  status: 'queued', startedAt: null, createdAt: 1, ...patch, requestId });
type Answer = (path: string, init: RequestInit) => Response;
const live: Array<{ retire(): void }> = [];
afterEach(() => { for (const rooms of live.splice(0)) rooms.retire(); });

function storage(fail = false) {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { if (fail && k === journal && v !== 'null') throw Error('quota'); map.set(k, v); } };
}
function rooms(store: ReturnType<typeof storage>, answer: Answer) {
  const posts: string[] = [];
  const transport = createHostTransport((async (path: string, init: RequestInit = {}) => {
    if (init.method === 'POST') posts.push(String(path));
    if (String(path).includes('/runs')) return Response.json({ status: 'ready', data: { items: [], nextCursor: null, total: null } });
    return answer(String(path), init);
  }) as unknown as typeof fetch);
  const value = createWorkflowRooms({ scopeId, transport, capabilities, storage: store, dirty: () => {}, runInput: async () => ({}) });
  live.push(value);
  return { posts, runs: value.controllers(flowId, versionId, false).runs, value };
}
const stored = (store: ReturnType<typeof storage>) => JSON.parse(store.map.get(journal) ?? 'null');
const notFound = () => Response.json({ code: 'not_found' }, { status: 404 });

test('an unconfirmed run stays locked across a reload until an explicit check answers', async () => {
  const store = storage();
  const first = rooms(store, () => new Response('', { status: 503 }));
  await first.runs.start();
  expect(first.runs.getSnapshot().submission).toBe('uncertain');
  const id = stored(store)?.requestId; expect(typeof id).toBe('string');
  const reload = rooms(store, (path) => { expect(path).toContain(`/run-requests/${id}`); return notFound(); });
  expect(reload.runs.canRun).toBe(false); expect(reload.runs.canCheck).toBe(true);
  expect(stored(store)?.requestId).toBe(id);
  await reload.runs.check();
  expect(reload.posts).toEqual([]); expect(reload.runs.canRun).toBe(true);
  expect(stored(store)).toBeNull();
});

test('a refusal that started nothing clears the journal; a request conflict does not', async () => {
  const held = storage();
  const paused = rooms(held, () => Response.json({ error: 'Paused' }, { status: 409 }));
  await paused.runs.start();
  expect(paused.runs.getSnapshot().submission).toBe('idle'); expect(stored(held)).toBeNull();
  const conflict = storage();
  const reused = rooms(conflict, () => Response.json({ code: 'request_conflict' }, { status: 409 }));
  await reused.runs.start();
  expect(reused.runs.getSnapshot().submission).toBe('uncertain'); expect(stored(conflict)).not.toBeNull();
});

test('an accepted receipt clears the journal only after the controller validates it', async () => {
  const wrong = storage();
  const bad = rooms(wrong, (_p, init) => Response.json({ status: 'accepted', requestId: JSON.parse(String(init.body)).brief.requestId,
    run: summary('x', { versionId: 'other' }) }, { status: 202 }));
  await bad.runs.start();
  expect(bad.runs.getSnapshot().submission).toBe('uncertain'); expect(stored(wrong)).not.toBeNull();
  const good = storage();
  const ok = rooms(good, (_p, init) => { const requestId = JSON.parse(String(init.body)).brief.requestId;
    return Response.json({ status: 'accepted', requestId, run: summary(requestId) }, { status: 202 }); });
  await ok.runs.start();
  expect(ok.runs.getSnapshot().submission).toBe('accepted'); expect(stored(good)).toBeNull();
});

test('a request that cannot be journaled is never sent', async () => {
  const store = storage(true);
  const r = rooms(store, () => { throw Error('must not send'); });
  await r.runs.start();
  expect(r.posts).toEqual([]); expect(r.runs.getSnapshot().submission).toBe('idle');
});

test('a settled request never clears a newer journal written by another window', async () => {
  const store = storage();
  const r = rooms(store, () => { store.map.set(journal, JSON.stringify({ scopeId, flowId, versionId, requestId: 'other-window' }));
    return Response.json({ error: 'Paused' }, { status: 409 }); });
  await r.runs.start();
  expect(stored(store)?.requestId).toBe('other-window');
});

test('an editable draft never inherits a journaled request', () => {
  const store = storage(); store.map.set(journal, JSON.stringify({ scopeId, flowId, versionId, requestId: 'pending' }));
  const value = rooms(store, notFound).value;
  const draft = value.controllers(flowId, versionId, true).runs;
  expect(draft.getSnapshot().submission).toBe('idle'); expect(draft.canCheck).toBe(false);
});
