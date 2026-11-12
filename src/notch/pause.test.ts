/**
 * Esc twice on the notch is the product's own pause, and the notch shows the
 * pause whoever made it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApprovalManager } from '../authority/approval.ts';
import { EmergencyController, setActiveEmergencyController } from '../authority/emergency.ts';
import { CommitmentExecutor } from '../daemon/commitment-executor.ts';
import { createCommitment, findCommitments } from '../vault/commitments.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { NOTCH_FIXTURE_ORIGIN } from './fixtures.ts';
import type { NotchAnswerAct, NotchLine, NotchToPage } from './protocol.ts';
import { attachNotchReal } from './real.ts';
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

function harness(options: { start?: 'paused' | 'killed' } = {}) {
  const controller = new EmergencyController();
  setActiveEmergencyController(controller);
  if (options.start === 'paused') controller.pause();
  if (options.start === 'killed') controller.kill();
  const executor = new CommitmentExecutor('aggressive');
  controller.subscribe((state) => executor.onEmergency(state));
  executor.onEmergency(controller.getState());
  const log: string[] = [];
  executor.setOriginRunner(NOTCH_FIXTURE_ORIGIN, () => { log.push('ran'); return 'ok'; });
  const pushed: NotchToPage[] = [];
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  const approvals = new ApprovalManager();
  const real = attachNotchReal(surface, {
    approvalManager: approvals,
    approve: async () => ({ status: 'already_decided' }),
    emergency: controller,
    promises: { executor, create: (what, opts) => createCommitment(what, opts), kept: () => findCommitments({ status: 'completed' }) },
    lookMs: 3_600_000,
    log: () => {},
  });
  executor.start();
  cleanup.push(() => { real.stop(); executor.stop(); });
  fromPage({ type: 'hello', v: 1 });
  const line = (): NotchLine | null => surface.current().line;
  return {
    controller, executor, real, approvals, pushed, log, line, fromPage,
    said: (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join(''),
    count: (): number => surface.current().count,
    faces: (): string[] => pushed.flatMap((m) => (m.type === 'face' ? [m.mood] : m.type === 'state' && m.face ? [m.face] : [])),
    async stop(): Promise<void> { fromPage({ type: 'stop' }); await settle(); },
    async open(): Promise<void> { fromPage({ type: 'open' }); await settle(); },
    async answer(act: NotchAnswerAct): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act }); await settle(); },
    async ask(): Promise<void> {
      approvals.createRequest({ agentId: 'a', agentName: 'PA', toolName: 'write_file', toolArguments: {}, actionCategory: 'write_data',
        urgency: 'normal', reason: 'Write the note', context: '' });
      real.approvals.sync();
      await settle();
    },
  };
}

describe('Esc twice', () => {
  test('pauses Jarvis itself, says so, and rests with its eyes closed', async () => {
    const h = harness();
    await h.stop();
    expect(h.controller.getState()).toBe('paused');
    expect(h.said()).toBe('Everything is stopped. Nothing runs until you wake me.');
    expect(h.faces()).toEqual(['closed']);
    await h.answer('done');
    expect(h.line()).toBeNull();
  });

  test('takes what was on the notch back to the count, and what arrives while stopped stays quiet', async () => {
    const h = harness();
    await h.ask();
    expect(h.line()?.kind).toBe('offer');
    await h.stop();
    await h.answer('done');
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    await h.ask();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(2);
  });

  test('a yes at rest wakes it: Jarvis resumes, the eyes open, and one thing that waited speaks', async () => {
    const h = harness();
    await h.stop();
    await h.answer('done');
    await h.ask();
    await h.open();
    expect(h.controller.getState()).toBe('normal');
    expect(h.faces()).toEqual(['closed', 'idle']);
    // The approval that arrived while everything was stopped gets its say.
    expect(h.line()?.kind).toBe('offer');
    expect(h.line()?.unasked).toBe(true);
  });

  test('with nothing waiting, waking says so', async () => {
    const h = harness();
    await h.stop();
    await h.answer('done');
    await h.open();
    expect(h.said()).toBe('Awake. Going on from where things were.');
  });

  test('pressed again while stopped, it says so again and changes nothing', async () => {
    const h = harness();
    await h.stop();
    await h.answer('done');
    await h.stop();
    expect(h.controller.getState()).toBe('paused');
    expect(h.said()).toBe('Everything is stopped. Nothing runs until you wake me.');
  });
});

describe('the pause, whoever made it', () => {
  test('paused from the tray or the dashboard, the notch shows it; resumed there, it wakes', async () => {
    const h = harness();
    h.controller.pause();
    await settle();
    expect(h.said()).toBe('Everything is stopped. Nothing runs until you wake me.');
    await h.answer('done');
    h.controller.resume();
    await settle();
    expect(h.said()).toBe('Awake. Going on from where things were.');
    expect(h.faces()).toEqual(['closed', 'idle']);
  });

  test('a brain that starts paused shows closed eyes to the page that comes up, and says nothing', async () => {
    const h = harness({ start: 'paused' });
    expect(h.line()).toBeNull();
    expect(h.pushed.find((m) => m.type === 'state')).toMatchObject({ type: 'state', line: null, face: 'closed' });
    await h.open();
    expect(h.controller.getState()).toBe('normal');
  });

  test('a promise whose fuse was burning leaves, does not run while stopped, and its fuse comes back on waking', async () => {
    const h = harness();
    const c = createCommitment('Send Anna the pricing', { when_due: Date.now() - 1000, created_from: NOTCH_FIXTURE_ORIGIN });
    h.executor.checkAndAnnounce();
    await settle();
    expect(h.line()?.kind).toBe('send');
    await h.stop();
    expect(h.line()?.kind).toBe('say');
    await h.answer('done');
    await (h.executor as unknown as { fireExecution(id: string): Promise<void> }).fireExecution(c.id);
    expect(h.log).toEqual([]);
    await h.open();
    expect(h.line()?.kind).toBe('send');
    expect(h.said()).toContain('I promised: Send Anna the pricing');
  });

  test('stopped with Kill is not a pause: the notch says where it is reset, and a yes wakes nothing', async () => {
    const h = harness();
    h.controller.kill();
    await settle();
    expect(h.said()).toBe('Stopped with Kill. Reset it in the dashboard, under Authority.');
    await h.answer('done');
    await h.open();
    expect(h.controller.getState()).toBe('killed');
    expect(h.said()).toBe('Stopped with Kill. Reset it in the dashboard, under Authority.');
    await h.answer('done');
    h.controller.reset();
    await settle();
    expect(h.faces().at(-1)).toBe('idle');
  });
});
