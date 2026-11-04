import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { createDashboardOwner as Factory, HostDescriptor } from './owner';
let createDashboardOwner: typeof Factory;
let owner: ReturnType<typeof Factory> | undefined;
const initial: HostDescriptor = { schemaVersion: 1, scopeId: 'workspace-a', generation: 'boot-one', installMode: 'self', capabilities: { contractVersion: 1, capabilities: {} } };
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
test('a changed workspace still retires all old controllers', async () => {
  const mock = setup(); await owner!.reconciliation.refresh();
  mock.set({ ...initial, scopeId: 'workspace-b', generation: 'boot-two' }); await owner!.reconciliation.refresh();
  expect(owner!.active()).toBe(false); expect(mock.revoked()).toBe(1); expect(owner!.transport.signal.aborted).toBe(true);
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
