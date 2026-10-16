import { expect, test } from 'bun:test';
import { createTourProvider } from './provider.ts';
import { createTourViewAdapter } from './view-adapter.ts';
import { key, owner, portFixture } from './test-fixture.ts';
import type { TourStep } from './steps.ts';
import type { TourCommand, TourResult } from './types.ts';

const workspace = { roomId: 'workflows', selectedObject: null, theme: 'dark' as const,
  sidebar: 'rail' as const, chat: { open: false, conversationId: null } };
const context = (revision: number) => ({ journey: { scopeId: key(), journeyId: 'journey', revision }, signal: new AbortController().signal });
const intent = (revision: number, from: TourStep, action = 'next') => ({ sessionId: 'journey', revision, from, action });
function fixture() {
  const f = portFixture();
  const provider = createTourProvider({ enabled: true, authorize: () => owner, journeyFor: () => f.port, roomStatus: () => 'ready' });
  const call = (c: TourCommand, signal: AbortSignal) => provider.request(null, c, signal);
  const adapter = (transport = call) => createTourViewAdapter({ scopeId: key(), workspace, available: () => true,
    renderer: { isolation: 'fixture-only', renderRoom: () => ({ status: 'ready', content: 'room' }) },
    pebble: { isolation: 'tutorial-sandbox', Surface: () => null }, call: transport });
  return { f, provider, call, adapter };
}
async function withoutRandomUUID(run: () => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  try { await run(); }
  finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
    else Reflect.deleteProperty(crypto, 'randomUUID');
  }
}

test.each([
  { action: 'next', from: 'today', to: 'workflows' },
  { action: 'back', from: 'memory', to: 'goals' },
  { action: 'skip', from: 'memory', to: null },
  { action: 'finish', from: 'pebble', to: null },
] as const)('HTTP LAN supports $action from $from without randomUUID', async ({ action, from, to }) => {
  const { f, call, adapter } = fixture(); f.state.tourStepId = from;
  const sent: TourCommand[] = [];
  const a = adapter((c, signal) => { sent.push(c); return call(c, signal); });
  try {
    const view = await a.read(context(0));
    if (from === 'pebble') view.ports.adapter.onOpenChange(true);
    await withoutRandomUUID(() => a.command(context(0), action, intent(0, from, action)));
    expect(f.writes).toBe(1);
    expect(f.state).toMatchObject({ revision: 1, tourStepId: to, stepId: to ? 'tour' : 'activation' });
    const command = sent.find(c => c.type === 'navigate');
    expect(command?.requestId).toBeString(); expect(command!.requestId.length).toBeGreaterThan(0);
  } finally { a.dispose(); }
});

test('HTTP receipt identity survives a lost acknowledgement without another transition', async () => {
  const { f, call, adapter } = fixture();
  const sent: TourCommand[] = [];
  let acknowledged: TourResult | undefined;
  const a = adapter(async (c, signal) => {
    if (c.type !== 'navigate') return call(c, signal);
    sent.push(structuredClone(c));
    if (acknowledged) return acknowledged;
    acknowledged = await call(c, signal);
    throw Error('Lost acknowledgement');
  });
  try {
    await a.read(context(0));
    await withoutRandomUUID(async () => {
      await expect(a.command(context(0), 'next', intent(0, 'today'))).rejects.toThrow('Lost acknowledgement');
      expect(f.writes).toBe(1);
      await a.command(context(0), 'next', intent(0, 'today'));
    });
    expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]); expect(f.writes).toBe(1);
    expect((await a.read(context(1))).model).toMatchObject({ revision: 1, stepId: 'workflows' });
  } finally { a.dispose(); }
});

test('a late stale read cannot invalidate navigation after a newer read recovers progress', async () => {
  const { f, provider, call, adapter } = fixture();
  let release!: () => void, captured!: () => void, hold = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { captured = resolve; });
  const a = adapter(async (c, signal) => {
    const result = await call(c, signal);
    if (c.type === 'read' && hold) { hold = false; captured(); await gate; }
    return result;
  });
  try {
    // The first read outlives its host timeout; reconnect reads the peer's newer revision.
    const older = a.read(context(0)).catch((error: unknown) => error); await started;
    expect(await provider.request(null, { type: 'navigate', ...intent(0, 'today'), requestId: 'peer-next' })).toMatchObject({ availability: 'ready' });
    expect((await a.read(context(1))).model).toMatchObject({ revision: 1, stepId: 'workflows' });
    release(); const error = await older;
    expect(error).toBeInstanceOf(Error); expect(error).toMatchObject({ message: 'Stale tour snapshot' });
    // No extra recovery read: the currently displayed navigation must remain usable.
    await a.command(context(1), 'next', intent(1, 'workflows'));
    expect(f.writes).toBe(2); expect(f.state).toMatchObject({ revision: 2, tourStepId: 'opportunities' });
  } finally { release(); a.dispose(); }
});
