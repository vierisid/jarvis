/**
 * Promises on the notch, against the real executor and the real store. Only
 * the clock of the lines is a stand-in, and the executor's window is ended
 * by hand (its own timers are real, and five seconds long).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApprovalManager } from '../authority/approval.ts';
import { EmergencyController, setActiveEmergencyController } from '../authority/emergency.ts';
import { CANCELLED_RESULT, CommitmentExecutor } from '../daemon/commitment-executor.ts';
import { createCommitment, findCommitments, getCommitment } from '../vault/commitments.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { NOTCH_FIXTURE_ORIGIN } from './fixtures.ts';
import { notchPromiseItemId } from './promises.ts';
import type { NotchAnswerAct, NotchLine, NotchToPage } from './protocol.ts';
import { attachNotchReal, type NotchReal } from './real.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  setActiveEmergencyController(null);
  closeDb();
});

const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
type Internals = { fireExecution(id: string): Promise<void> };

function harness(options: { page?: boolean; mode?: 'aggressive' | 'passive' } = {}) {
  const executor = new CommitmentExecutor(options.mode ?? 'aggressive');
  const log: string[] = [];
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const pushed: NotchToPage[] = [];
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = 0;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  if (options.page !== false) fromPage({ type: 'hello', v: 1 });
  const approvals = new ApprovalManager();
  const real: NotchReal = attachNotchReal(surface, {
    approvalManager: approvals,
    approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }),
    promises: {
      executor,
      create: (what, opts) => createCommitment(what, opts),
      kept: () => findCommitments({ status: 'completed' }),
      appendFixtureLog: (line) => { log.push(line); },
    },
    lookMs: 3_600_000,
    clock,
    log: () => {},
  });
  cleanup.push(() => { real.stop(); executor.stop(); });
  const line = (): NotchLine | null => surface.current().line;
  return {
    executor, real, approvals, log, line, fromPage, surface,
    said: (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join(''),
    count: (): number => surface.current().count,
    /** The executor's own window running out. */
    async fire(id: string): Promise<void> { await (executor as unknown as Internals).fireExecution(id); await settle(); },
    async answer(act: NotchAnswerAct): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act }); await settle(); },
    async open(): Promise<void> { fromPage({ type: 'open' }); await settle(); },
    async hello(): Promise<void> { fromPage({ type: 'hello', v: 1 }); await settle(); },
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const timer of [...timers].filter((t) => t.at <= now)) {
        const at = timers.indexOf(timer);
        if (at >= 0) { timers.splice(at, 1); timer.fn(); }
      }
      await settle();
    },
  };
}

/** A fixture promise that is already due, announced. */
async function announced(h: ReturnType<typeof harness>, what = 'Send Anna the pricing') {
  const c = createCommitment(what, { when_due: Date.now() - 1000, assigned_to: 'jarvis', created_from: NOTCH_FIXTURE_ORIGIN });
  h.executor.checkAndAnnounce();
  await settle();
  return c;
}

describe('the line with its fuse', () => {
  // Steps 3 and 4 of the hand test.
  test('a promise about to be kept arrives as a send line whose fuse is the window that is left', async () => {
    const h = harness();
    const c = await announced(h);
    const line = h.line();
    expect(line?.kind).toBe('send');
    expect(h.said()).toContain('Doing what I promised: Send Anna the pricing');
    expect(line?.kind === 'send' && line.ms).toBeGreaterThan(4000);
    expect(line?.kind === 'send' && line.ms).toBeLessThanOrEqual(5000);
    expect(h.real.inbox.showing()).toBe(notchPromiseItemId(c.id));
  });

  test('Esc cancels it: it is closed, the notch says so, and it never runs', async () => {
    const h = harness();
    const c = await announced(h);
    await h.answer('undo');
    expect(h.said()).toBe('Cancelled. I will not do it.');
    expect(getCommitment(c.id)).toMatchObject({ status: 'failed', result: CANCELLED_RESULT });
    await h.answer('done');
    expect(h.line()).toBeNull();
    // The executor's window running out, and every later sweep: nothing.
    await h.fire(c.id);
    h.executor.checkAndAnnounce();
    await settle();
    expect(h.log).toEqual([]);
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  test('left alone it is kept once, by the executor\'s own clock, and the notch says so in the same breath', async () => {
    const h = harness();
    const c = await announced(h);
    await h.answer('done');
    // The page saying the fuse has burnt starts nothing.
    expect(h.log).toEqual([]);
    expect(getCommitment(c.id)?.status).toBe('pending');
    await h.fire(c.id);
    expect(h.log).toHaveLength(1);
    expect(h.log[0]).toContain(c.id);
    expect(h.said()).toBe('Kept: Send Anna the pricing');
    expect(h.line()).toMatchObject({ kind: 'say', mark: 'check' });
    await h.fire(c.id);
    expect(h.log).toHaveLength(1);
    await h.answer('done');
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);

    // Today lists it.
    await h.open();
    expect(h.said()).toBe('Today: 1 thing done');
    const today = h.line();
    expect(today?.kind === 'sheet' && today.blocks[0]).toMatchObject({ kind: 'row', say: ['Send Anna the pricing'], small: 'promised' });
  });

  test('one that takes longer than a moment is told when it is done, as its own line', async () => {
    const h = harness();
    const c = await announced(h);
    await h.answer('done');
    await h.advance(1500);
    expect(h.line()).toBeNull();
    await h.fire(c.id);
    expect(h.said()).toBe('Kept: Send Anna the pricing');
  });

  test('a fuse takes the notch from whatever is on it, which goes back to the count', async () => {
    const h = harness();
    h.approvals.createRequest({ agentId: 'a', agentName: 'PA', toolName: 'write_file', toolArguments: {}, actionCategory: 'write_data',
      urgency: 'normal', reason: 'Write the note', context: JSON.stringify({ intent: 'Write file' }) });
    h.real.approvals.sync();
    await settle();
    expect(h.line()?.kind).toBe('offer');
    await announced(h);
    expect(h.line()?.kind).toBe('send');
    expect(h.count()).toBe(1);
  });

  test('a long promise is cut to fit one line', async () => {
    const h = harness();
    await announced(h, `Send ${'the very long list of things '.repeat(8)}to Anna`);
    expect(h.said().length).toBeLessThan(160);
    expect(h.said()).toContain('…');
  });
});

describe('when the brain or the notch was away', () => {
  // Step 6 of the hand test: the brain stopped during the fuse.
  test('after a restart inside the window the promise is announced again, runs once, and the notch says what happened', async () => {
    const first = harness();
    const c = await announced(first);
    first.executor.stop();
    first.real.stop();

    // The new brain. Its first sweep is before any notch has come back.
    const second = harness({ page: false });
    second.executor.setOriginRunner(NOTCH_FIXTURE_ORIGIN, () => { second.log.push(c.id); return 'ok'; });
    second.executor.start();
    await settle();
    expect(second.line()).toBeNull();
    // The notch comes back while the window is still open: the fuse is there.
    await second.hello();
    expect(second.line()?.kind).toBe('send');
    await second.fire(c.id);
    expect(second.log).toEqual([c.id]);
    expect(first.log).toEqual([]);
    expect(second.said()).toBe('Kept: Send Anna the pricing');
  });

  test('kept while no notch was up: it is said when one comes up', async () => {
    const h = harness({ page: false });
    const c = await announced(h);
    await h.fire(c.id);
    expect(h.log).toHaveLength(1);
    expect(h.line()).toBeNull();
    await h.hello();
    expect(h.said()).toBe('Kept: Send Anna the pricing');
  });

  test('cut off in the middle by a restart: not run again, and the notch says exactly that', async () => {
    const calls: string[] = [];
    const first = new CommitmentExecutor('aggressive');
    cleanup.push(() => first.stop());
    first.setAgentService({ handleMessage: async () => { calls.push('run'); return new Promise<string>(() => {}); } } as never);
    const c = createCommitment('Send the wire', { when_due: Date.now() - 1000 });
    first.checkAndAnnounce();
    void (first as unknown as Internals).fireExecution(c.id);
    await settle();
    expect(calls).toEqual(['run']);

    const h = harness();
    h.executor.setAgentService({ handleMessage: async () => { calls.push('run again'); return 'done'; } } as never);
    h.executor.start();
    await settle();
    expect(calls).toEqual(['run']);
    expect(h.said()).toBe('Send the wire was cut off by a restart. It may have partly run, so I did not run it again.');
    expect(h.line()).toMatchObject({ kind: 'say', mark: 'fail' });
  });

  test('paused while the fuse burns: the line leaves, nothing runs, and it comes back after Resume', async () => {
    const controller = new EmergencyController();
    setActiveEmergencyController(controller);
    const h = harness();
    controller.subscribe((state) => h.executor.onEmergency(state));
    h.executor.start();
    const c = await announced(h);
    expect(h.line()?.kind).toBe('send');
    controller.pause();
    await settle();
    expect(h.line()).toBeNull();
    await h.fire(c.id);
    expect(h.log).toEqual([]);
    controller.resume();
    await settle();
    expect(h.line()?.kind).toBe('send');
  });
});

describe('the promise fixture', () => {
  test('makes a real promise that only this code can make, and has the executor look at once', async () => {
    const h = harness();
    expect(h.real.fixtures.kinds()).toEqual(['approval', 'payment', 'promise']);
    const made = await h.real.fixtures.make('promise', { in: 60 });
    expect(made).toContain('in 60 seconds');
    expect(made).toContain('notch-fixture.log');
    const [row] = findCommitments({ status: 'pending' });
    expect(row).toMatchObject({ created_from: NOTCH_FIXTURE_ORIGIN, assigned_to: 'jarvis' });
    expect(row!.when_due! - Date.now()).toBeGreaterThan(55_000);
    // Found ahead of its time: scheduled, and not yet on the notch.
    expect(h.line()).toBeNull();
    expect((h.executor as unknown as { announceTimers: Map<string, unknown> }).announceTimers.has(row!.id)).toBe(true);
  });

  test('two made one after the other are two promises', async () => {
    const h = harness();
    const real = attachNotchReal(h.surface, {
      approvalManager: h.approvals, approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }),
      promises: { executor: h.executor, create: (what, opts) => createCommitment(what, opts), kept: () => [], appendFixtureLog: () => {} },
      lookMs: 3_600_000, log: () => {},
    });
    cleanup.push(() => real.stop());
    await real.fixtures.make('promise', { in: 300 });
    await new Promise((r) => setTimeout(r, 1100));
    await real.fixtures.make('promise', { in: 300 });
    expect(findCommitments({ status: 'pending' })).toHaveLength(2);
  });

  test('without a way to write its line there is no promise fixture', () => {
    const surface = new NotchSurface({ dispatchRPC: () => Promise.resolve({}), onEvent() {}, onSidecarDisconnected() {} }, () => {});
    const executor = new CommitmentExecutor('aggressive');
    const real = attachNotchReal(surface, {
      approvalManager: new ApprovalManager(), approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }),
      promises: { executor, create: (what, opts) => createCommitment(what, opts), kept: () => [] },
      lookMs: 3_600_000, log: () => {},
    });
    cleanup.push(() => { real.stop(); executor.stop(); });
    expect(real.fixtures.kinds()).toEqual(['approval', 'payment']);
  });
});
