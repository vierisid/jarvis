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
// Run reads the workflow's on/off state before it sends: `status` answers that read,
// null makes it fail.
function rooms(store: ReturnType<typeof storage>, answer: Answer, status: string | null = 'ENABLED', confirm?: (message: string) => Promise<boolean>) {
  const posts: string[] = [];
  const transport = createHostTransport((async (path: string, init: RequestInit = {}) => {
    if (init.method === 'POST') posts.push(String(path));
    if (String(path).includes('/runs')) return Response.json({ status: 'ready', data: { items: [], nextCursor: null, total: null } });
    if (String(path) === `/api/workflows/${flowId}` && !init.method)
      return status === null ? new Response('', { status: 503 }) : Response.json({ flow: { id: flowId, status } });
    return answer(String(path), init);
  }) as unknown as typeof fetch);
  const value = createWorkflowRooms({ scopeId, transport, capabilities, storage: store, dirty: () => {}, runInput: async () => ({}), confirm });
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

test('a check that cannot answer keeps the journal and the lock', async () => {
  const store = storage(); store.map.set(journal, JSON.stringify({ scopeId, flowId, versionId, requestId: 'pending' }));
  const r = rooms(store, () => new Response('', { status: 503 }));
  await r.runs.check();
  expect(r.runs.getSnapshot().submission).toBe('uncertain'); expect(r.runs.canRun).toBe(false);
  expect(stored(store)?.requestId).toBe('pending');
});

test('a refusal whose body cannot be read is not taken as "no run started"', async () => {
  const store = storage();
  const r = rooms(store, () => new Response('{"code":', { status: 409 }));
  await r.runs.start();
  expect(r.runs.getSnapshot().submission).toBe('uncertain'); expect(stored(store)).not.toBeNull();
});

test('a window never overwrites another window\'s waiting request', async () => {
  const store = storage();
  const r = rooms(store, () => { throw Error('must not send'); });
  store.map.set(journal, JSON.stringify({ scopeId, flowId, versionId, requestId: 'other-window' }));
  await r.runs.start();
  expect(r.posts).toEqual([]); expect(r.runs.getSnapshot().submission).toBe('idle');
  expect(stored(store)?.requestId).toBe('other-window');
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

const accept: Answer = (_p, init) => { const requestId = JSON.parse(String(init.body)).brief.requestId;
  return Response.json({ status: 'accepted', requestId, run: summary(requestId) }, { status: 202 }); };

test('a run by hand of a turned-off workflow asks first, says it ran once, and sends nothing when declined', async () => {
  const asked: string[] = [];
  const ask = (answer: boolean) => async (message: string) => { asked.push(message); return answer; };
  const declined = rooms(storage(), () => { throw Error('must not send'); }, 'DISABLED', ask(false));
  await declined.runs.start();
  expect(declined.posts).toEqual([]); expect(declined.runs.getSnapshot().submission).toBe('idle');
  expect(declined.runs.workflowOff).toBe(true);
  expect(asked[0]).toContain('turned off'); expect(asked[0]).toContain('once anyway');
  const accepted = rooms(storage(), accept, 'DISABLED', ask(true));
  await accepted.runs.start();
  expect(accepted.posts.length).toBe(1);
  expect(accepted.runs.getSnapshot().message).toBe('Started one run. The workflow is still off.');
  // A workflow that is on never asks and keeps the plain message.
  const before = asked.length;
  const on = rooms(storage(), accept, 'ENABLED', ask(true));
  await on.runs.start();
  expect(asked.length).toBe(before); expect(on.runs.getSnapshot().message).toBe('Run requested.');
});

test('Run asks about a workflow turned off after the room loaded, and sends nothing when its state cannot be read', async () => {
  const asked: string[] = [];
  // The room loaded while the workflow was on; another window turned it off since.
  const stale = rooms(storage(), () => { throw Error('must not send'); }, 'DISABLED', async (m) => { asked.push(m); return false; });
  stale.runs.setWorkflowOff(false);
  await stale.runs.start();
  expect(asked.length).toBe(1); expect(stale.posts).toEqual([]);
  expect(stale.runs.workflowOff).toBe(true);
  // On/off is not part of the controller key: the version keeps one controller either way.
  const same = stale.value.controllers(flowId, versionId, false).runs;
  expect(same).toBe(stale.runs);
  const unreadable = rooms(storage(), () => { throw Error('must not send'); }, null, async (m) => { asked.push(m); return true; });
  await unreadable.runs.start();
  expect(unreadable.posts).toEqual([]); expect(asked.length).toBe(1);
  expect(unreadable.runs.getSnapshot().message).toBe('No run started: could not check whether this workflow is on. Try again.');
});
