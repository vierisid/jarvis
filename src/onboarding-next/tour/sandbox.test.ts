import { expect, test } from 'bun:test';
import { createTourSandbox } from './sandbox.ts';
import { createTourProvider } from './provider.ts';
import { createTourViewAdapter } from './view-adapter.ts';
import { owner, key, portFixture } from './test-fixture.ts';
import type { TourSnapshot } from './types.ts';
const workspace = { roomId: 'workflows', selectedObject: { kind: 'version', id: 'saved-draft-v1' }, theme: 'dark' as const,
  sidebar: 'rail' as const, chat: { open: true, conversationId: 'existing-conversation' } };
async function fixture() {
  const f = portFixture(), provider = createTourProvider({ enabled: true, authorize: () => owner, journeyFor: () => f.port, roomStatus: () => 'ready' });
  const result = await provider.request(null, { type: 'read' }); if (result.availability !== 'ready') throw Error();
  return { f, provider, s: result.snapshot };
}
test('demonstration never writes original room, selection, theme, sidebar or conversation; account rooms are local', async () => {
  const { s } = await fixture(), before = structuredClone(workspace), sandbox = createTourSandbox(key(), workspace);
  for (const step of ['profile', 'settings', 'billing'] as const) {
    const result = sandbox.present({ ...s, stepId: step }); expect(result.accountMenuOpen).toBe(true); expect(result.roomId).toBe(step);
    expect(result).toMatchObject({ mode: 'tutorial', effects: 'disabled', theme: 'dark', sidebar: 'rail' }); expect(workspace).toEqual(before);
  }
  const pebble = sandbox.present({ ...s, stepId: 'pebble' }); expect(pebble.chat.open).toBe(false); expect(pebble.selectedObject).toEqual(before.selectedObject);
  sandbox.setPebbleOpen(true); expect(sandbox.read().chat.open).toBe(true); sandbox.setPebbleOpen(false);
  expect(workspace).toEqual(before);
  const exit = sandbox.present({ ...s, active: false, stepId: null, revision: 1 }); expect(exit.original).toEqual(before); expect(exit.chat).toEqual(before.chat);
});
test('returned snapshots cannot mutate captured state; stale, foreign and disposed callbacks fail', async () => {
  const { s } = await fixture(), box = createTourSandbox(key(), workspace);
  const state = box.present({ ...s, stepId: 'pebble', revision: 2 }); state.original.selectedObject!.id = 'changed';
  expect(box.read().original).toEqual(workspace);
  expect(() => box.present(s)).toThrow(); expect(() => box.present({ ...s, scopeId: 'other', revision: 3 })).toThrow();
  box.dispose(); expect(() => box.setPebbleOpen(true)).toThrow(); expect(() => box.present({ ...s, revision: 3 })).toThrow();
});
test('missing shell, leaving Pebble, and replay reset only the local demonstration', async () => {
  const { s } = await fixture(), box = createTourSandbox(key(), workspace);
  box.present({ ...s, stepId: 'pebble', roomStatus: 'unsupported' }); expect(() => box.setPebbleOpen(true)).toThrow();
  box.present({ ...s, stepId: 'pebble' }); box.setPebbleOpen(true);
  box.present({ ...s, stepId: 'billing', revision: 1 }); box.present({ ...s, stepId: 'pebble', revision: 2 }); expect(box.read().chat.open).toBe(false);
});
test('U10 structural adapter uses authoritative position and never invents room content', async () => {
  const { f, provider, s } = await fixture(); f.state.tourStepId = 'pebble';
  const calls: unknown[] = []; const surface = () => null; const renderer = { isolation: 'fixture-only' as const, renderRoom: () => ({ status: 'unsupported' }) };
  const adapter = createTourViewAdapter({ scopeId: key(), workspace, available: () => true, renderer,
    pebble: { isolation: 'tutorial-sandbox', Surface: surface }, call: (c, signal) => { calls.push(c); return provider.request(null, c, signal); } });
  const context = { journey: { scopeId: key(), journeyId: s.sessionId, revision: 0 }, signal: new AbortController().signal };
  const view = await adapter.read(context); expect(view.ports.renderer).toBe(renderer); expect(view.ports.adapter.Surface).toBe(surface); expect(view.ports.adapter.open).toBe(false);
  const intent = { sessionId: s.sessionId, revision: 0, from: 'pebble', action: 'next', to: 'first-workflow' };
  await expect(adapter.command(context, 'next', intent)).rejects.toThrow(); expect(f.writes).toBe(0);
  let updates = 0; const unsubscribe = adapter.subscribe(() => updates++);
  view.ports.adapter.onOpenChange(true); expect(updates).toBe(1); expect(calls).toHaveLength(1);
  expect((await adapter.read(context)).ports.adapter.open).toBe(true);
  await adapter.command(context, 'next', intent); expect(f.state.stepId).toBe('activation'); expect(f.writes).toBe(1);
  unsubscribe(); adapter.dispose(); expect(adapter.available()).toBe(false); expect(() => view.ports.adapter.onOpenChange(true)).toThrow();
});
test('adapter refuses mixed revisions, account changes, forged intents and a revoked signal', async () => {
  const { provider, s } = await fixture(); const adapter = createTourViewAdapter({ scopeId: key(), workspace, available: () => true,
    renderer: { isolation: 'fixture-only', renderRoom: () => null }, pebble: { isolation: 'tutorial-sandbox', Surface: () => null }, call: (c, signal) => provider.request(null, c, signal) });
  const c = { journey: { scopeId: key(), journeyId: s.sessionId, revision: 0 }, signal: new AbortController().signal }; await adapter.read(c);
  await expect(adapter.read({ ...c, journey: { ...c.journey, revision: 1 } })).rejects.toThrow();
  await expect(adapter.read({ ...c, journey: { ...c.journey, scopeId: 'other' } })).rejects.toThrow();
  await expect(adapter.command(c, 'next', { sessionId: s.sessionId, revision: 0, from: 'billing', action: 'next' })).rejects.toThrow();
  await expect(adapter.read({ ...c, signal: AbortSignal.abort() })).rejects.toThrow(); adapter.dispose();
});

test.each(['unsupported', 'unavailable'] as const)('adapter exposes %s room state without rendering a ready preview', async roomStatus => {
  const { provider } = await fixture(); let renders = 0;
  const adapter = createTourViewAdapter({ scopeId: key(), workspace, available: () => true,
    renderer: { isolation: 'fixture-only', renderRoom: () => { renders++; return { status: 'ready' }; } },
    pebble: { isolation: 'tutorial-sandbox', Surface: () => null }, call: async (c, signal) => {
      const r = await provider.request(null, c, signal); return r.availability === 'ready' ? { ...r, snapshot: { ...r.snapshot, roomStatus } } : r;
    } });
  const v = await adapter.read({ journey: { scopeId: key(), journeyId: 'journey', revision: 0 }, signal: new AbortController().signal });
  expect(v.ports.renderer.renderRoom({})).toEqual({ status: roomStatus === 'unsupported' ? 'unsupported' : 'error' }); expect(renders).toBe(0);
  expect(v.ports.adapter.status).toBe(roomStatus === 'unsupported' ? 'unsupported' : 'error'); adapter.dispose();
});
test('a lost local capability fences a retained Pebble callback', async () => {
  const { f, provider } = await fixture(); f.state.tourStepId = 'pebble'; let available = true;
  const adapter = createTourViewAdapter({ scopeId: key(), workspace, available: () => available,
    renderer: { isolation: 'fixture-only', renderRoom: () => null }, pebble: { isolation: 'tutorial-sandbox', Surface: () => null }, call: (c, signal) => provider.request(null, c, signal) });
  const c = { journey: { scopeId: key(), journeyId: 'journey', revision: 0 }, signal: new AbortController().signal };
  const v = await adapter.read(c); available = false;
  expect(() => v.ports.adapter.onOpenChange(true)).toThrow(); await expect(adapter.read(c)).rejects.toThrow(); expect(f.writes).toBe(0); adapter.dispose();
});
