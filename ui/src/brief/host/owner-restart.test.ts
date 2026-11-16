import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { createDashboardOwner as Factory, HostDescriptor } from './owner';
let createDashboardOwner: typeof Factory;
let owner: ReturnType<typeof Factory> | undefined;
const initial: HostDescriptor = { schemaVersion: 1, scopeId: 'jrv_proj_default', workspaceId: 'install-a', generation: 'boot-one', installMode: 'self', capabilities: { contractVersion: 1, capabilities: {} } };
beforeAll(async () => { GlobalRegistrator.register({ url: 'https://jarvis.test/' }); ({ createDashboardOwner } = await import('./owner')); });
afterEach(() => { owner?.retire(); sessionStorage.clear(); });
afterAll(() => GlobalRegistrator.unregister());
function setup() {
  let next = initial, status = 200, revoked = 0;
  owner = createDashboardOwner(initial, { storage: sessionStorage,
    fetch: (async path => String(path) === '/api/brief/host' ? Response.json(next, { status }) : new Response(null, { status: 404 })) as typeof fetch,
    changed() {}, unauthorized() { revoked++; }, explain() {}, confirm: async () => true, runInput: async () => null,
    revealConversationItem() {}, replayTutorial: async () => ({ state: 'unavailable' }) });
  owner.setWorkflowDirty('draft', true); owner.reconciliation.start();
  return { set(value: HostDescriptor, code = 200) { next = value; status = code; }, revoked: () => revoked };
}
test('same workspace restart preserves owner, edits and navigation guard while refreshing capabilities', async () => {
  const mock = setup(); await owner!.reconciliation.refresh();
  const next = { ...initial, generation: 'boot-two', capabilities: { contractVersion: 1, capabilities: { changed: true } } };
  mock.set(next); await owner!.reconciliation.refresh();
  expect(owner!.active()).toBe(true); expect(mock.revoked()).toBe(0);
  expect(owner!.hasUnsaved()).toBe(true); expect(owner!.descriptor()).toEqual(next);
  expect(await owner!.canLeave(new AbortController().signal)).toBe(false);
});
// The daemon always sends the default project as scopeId, so the workspace id
// is what tells a restart of the same data directory from another one.
test('a restart serving another workspace id retires all old controllers', async () => {
  const mock = setup(); await owner!.reconciliation.refresh();
  mock.set({ ...initial, workspaceId: 'install-b', generation: 'boot-two' }); await owner!.reconciliation.refresh();
  expect(owner!.active()).toBe(false); expect(mock.revoked()).toBe(1); expect(owner!.transport.signal.aborted).toBe(true);
  expect(owner!.hasUnsaved()).toBe(false);
});
test('a daemon without workspace ids is identified per boot, so its restart retires the owner', async () => {
  const mock = setup(); await owner!.reconciliation.refresh();
  const { workspaceId: _omitted, ...legacy } = initial;
  mock.set({ ...legacy, generation: 'boot-two' } as HostDescriptor); await owner!.reconciliation.refresh();
  expect(owner!.active()).toBe(false); expect(mock.revoked()).toBe(1);
});
test('a daemon without workspace ids keeps the owner within one boot', async () => {
  const { readHost } = await import('./owner');
  const { workspaceId: _omitted, ...legacy } = initial;
  expect(readHost(legacy).workspaceId).toBe('boot-one');
});
for (const [label, change] of [
  ['install mode', { installMode: 'hosted' }],
  ['dashboard choice', { dashboard: 'brief' }],
] as const) test(`a restart that changes the ${label} retires the owner`, async () => {
  const mock = setup(); await owner!.reconciliation.refresh();
  mock.set({ ...initial, ...change, generation: 'boot-two' }); await owner!.reconciliation.refresh();
  expect(owner!.active()).toBe(false); expect(mock.revoked()).toBe(1);
});
test('an absent dashboard choice and an explicit legacy one are the same owner', async () => {
  const mock = setup(); await owner!.reconciliation.refresh();
  mock.set({ ...initial, dashboard: 'legacy', generation: 'boot-two' }); await owner!.reconciliation.refresh();
  expect(owner!.active()).toBe(true); expect(mock.revoked()).toBe(0);
});
test('authentication revocation still retires the owner', async () => {
  const mock = setup(); await owner!.reconciliation.refresh();
  mock.set(initial, 401); await owner!.reconciliation.refresh();
  expect(owner!.active()).toBe(false); expect(mock.revoked()).toBe(1);
});
test('temporary host failure keeps edits and recovers without replaying mutations', async () => {
  const mock = setup(); await owner!.reconciliation.refresh();
  mock.set(initial, 503); await owner!.reconciliation.refresh();
  expect(owner!.hasUnsaved()).toBe(true); expect(owner!.active()).toBe(true);
  mock.set({ ...initial, generation: 'recovered' }); await owner!.reconciliation.refresh();
  expect(owner!.active()).toBe(true); expect(owner!.hasUnsaved()).toBe(true); expect(mock.revoked()).toBe(0);
});

function setupEnded() {
  let status = 200, revoked = 0, ended = 0;
  owner = createDashboardOwner(initial, { storage: sessionStorage,
    fetch: (async path => String(path) === '/api/brief/host' ? Response.json(initial, { status }) : new Response(null, { status: 404 })) as typeof fetch,
    changed() {}, unauthorized() { revoked++; }, sessionEnded() { ended++; }, explain() {}, confirm: async () => true, runInput: async () => null,
    revealConversationItem() {}, replayTutorial: async () => ({ state: 'unavailable' }) });
  owner.reconciliation.start();
  return { expire() { status = 401; }, revoked: () => revoked, ended: () => ended };
}
test('a session that ends while edits are unsaved keeps the owner, and so the edits, and says so once', async () => {
  const mock = setupEnded(); owner!.setWorkflowDirty('draft', true); await owner!.reconciliation.refresh();
  mock.expire(); await owner!.reconciliation.refresh(); await owner!.reconciliation.refresh();
  expect(owner!.active()).toBe(true); expect(owner!.hasUnsaved()).toBe(true);
  expect(owner!.sessionEnded()).toBe(true); expect(mock.ended()).toBe(1); expect(mock.revoked()).toBe(0);
});
test('a session that ends with nothing unsaved still retires the owner', async () => {
  const mock = setupEnded(); await owner!.reconciliation.refresh();
  mock.expire(); await owner!.reconciliation.refresh();
  expect(owner!.active()).toBe(false); expect(mock.revoked()).toBe(1); expect(mock.ended()).toBe(0);
});
