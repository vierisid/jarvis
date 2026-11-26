/**
 * Pass 8 as the brain wires it (./real.ts): the real inbox, where, presence,
 * quiet hours, calls and the lines of the day, told by the events a desktop
 * app sends. Only the clocks are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ApprovalManager } from '../authority/approval.ts';
import { setActiveEmergencyController } from '../authority/emergency.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { NOTCH_AROUND_EVENT, NOTCH_CALL_AFTER_MS } from './around.ts';
import type { NotchItem, NotchItemEnd } from './inbox.ts';
import type { NotchAnswerAct, NotchBlock, NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import { attachNotchReal, type NotchReal } from './real.ts';
import type { NotchStage } from './stage.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface, type NotchSurfacePort } from './surface.ts';
import { NOTCH_WHERE_EVENT } from './where.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  setActiveEmergencyController(null);
  closeDb();
});

const settle = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 2)); for (let i = 0; i < 60; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string => (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? `[${part.word.value}]` : '')).join('');

/** A weekday at ten in the morning, or at the hour given, on this machine's clock. */
const at = (hour: number, minute = 0): number => new Date(2026, 10, 16, hour, minute).getTime();

function harness(start = at(10)) {
  type Listener = (sidecarId: string, event: { event_type: string; payload: unknown }) => void;
  const listeners: Listener[] = [];
  const pushed: NotchToPage[] = [];
  const port: NotchSurfacePort & { onEvent(listener: Listener): void } = {
    dispatchRPC(_sidecarId, _method, params) { const message = (params as { message?: NotchToPage }).message; if (message) pushed.push(message); return Promise.resolve({}); },
    onEvent(listener) { listeners.push(listener); },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = start;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const index = timers.indexOf(handle as { fn: () => void; at: number }); if (index >= 0) timers.splice(index, 1); },
  };
  const surface = new NotchSurface(port, () => {});
  const send = (event_type: string, payload: unknown): void => { for (const listener of listeners) listener('pc', { event_type, payload }); };
  const fromPage = (message: unknown): void => send(NOTCH_MESSAGE_EVENT, { message });
  fromPage({ type: 'hello', v: 1 });
  const real: NotchReal = attachNotchReal(surface, {
    approvalManager: new ApprovalManager(),
    approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
    where: { port: { ...port, dispatchRPC: async () => ({}) } },
    asks: undefined,
    day: { db: new Database(':memory:'), around: port, now: () => now, noClock: true },
    lookMs: 3_600_000,
    clock,
    log: () => {},
  });
  cleanup.push(() => real.stop());
  const line = (): NotchLine | null => surface.current().line;
  const item = (id: string, more: Partial<NotchItem> = {}): NotchItem => ({
    id, subject: id, class: 'person', speaks: true, title: () => [`${id} waits`],
    async play(stage: NotchStage): Promise<NotchItemEnd> { return (await stage.offer([`${id}?`], 'yes')).act === 'yes' ? 'settled' : 'waits'; },
    ...more,
  });
  return {
    real, line, item,
    said: (): string => text(line()?.say),
    count: (): number => surface.current().count,
    blocks: (): NotchBlock[] => { const shown = line(); return shown && 'blocks' in shown ? shown.blocks ?? [] : []; },
    /** The desktop app's word about the person's hands. */
    async hands(still: boolean): Promise<void> { send(NOTCH_WHERE_EVENT, { app: 'code', name: 'Code', title: 'x', look: '', still, never: [] }); await settle(); },
    async around(payload: Record<string, unknown>): Promise<void> { send(NOTCH_AROUND_EVENT, payload); await settle(); },
    async answer(act: NotchAnswerAct, more: Record<string, unknown> = {}): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act, ...more }); await settle(); },
    async open(): Promise<void> { fromPage({ type: 'open' }); await settle(); },
    async pass(ms: number): Promise<void> {
      const until = now + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        timers.splice(timers.indexOf(next), 1);
        next.fn();
        await settle();
      }
      now = until;
      await settle();
    },
    set: (moment: number): void => { now = moment; },
  };
}

describe('the rule for speaking up, as wired', () => {
  test('the first hands of the day bring the morning line, once they are still', async () => {
    const h = harness(at(8, 30));
    await h.hands(false);
    // They are typing: it waits.
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    await h.hands(true);
    expect(h.said()).toBe('Morning. Nothing happened overnight, and nothing needs you.');
  });

  test('what arrives while they type waits for their hands to stop', async () => {
    const h = harness();
    await h.hands(false);
    await h.hands(true);
    await h.answer('done');
    await h.hands(false);
    h.real.inbox.add(h.item('question'));
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    await h.hands(true);
    expect(h.said()).toBe('question?');
  });

  test('nothing is said to an empty chair: after twenty minutes away it waits for them to be back and still', async () => {
    const h = harness();
    await h.hands(false);
    await h.hands(true);
    await h.answer('done');
    await h.pass(21 * 60_000);
    h.real.inbox.add(h.item('question'));
    await settle();
    expect(h.line()).toBeNull();
    await h.hands(false);
    expect(h.line()).toBeNull();
    await h.hands(true);
    expect(h.said()).toBe('question?');
  });
});

describe('quiet hours, as wired', () => {
  test('inside them nothing arrives, and it does when they are over', async () => {
    const h = harness(at(23));
    h.real.inbox.add(h.item('question'));
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    // The person can still open the notch and find it.
    await h.open();
    expect(h.said()).toBe('question?');
    await h.answer('fold');
    // A round ends on the list of what still waits: closed.
    await h.answer('no');
    h.real.inbox.add(h.item('other'));
    await settle();
    expect(h.line()).toBeNull();
    // Morning: the hours are over, and the brain's clock asks again.
    h.set(at(7, 1) + 24 * 60 * 60 * 1000);
    h.real.inbox.calmed();
    await settle();
    expect(h.said()).toBe('other?');
  });

  test('"quiet for an hour" holds everything back now, and ending it lets it speak', async () => {
    const h = harness();
    h.real.quiet!.quietFor();
    h.real.inbox.add(h.item('question'));
    await settle();
    expect(h.line()).toBeNull();
    h.real.quiet!.end();
    h.real.inbox.calmed();
    await settle();
    expect(h.said()).toBe('question?');
  });

  test('a promise about to be kept is still shown: its window is running', async () => {
    const h = harness(at(23));
    h.real.inbox.add(h.item('fuse', { class: 'clock', urgent: true }));
    await settle();
    expect(h.said()).toBe('fuse?');
  });
});

describe('a call, as wired', () => {
  test('everything is held while a calling program has the microphone, and offered after', async () => {
    const h = harness();
    await h.hands(false);
    await h.hands(true);
    await h.answer('done');
    await h.around({ call: true, online: true });
    await h.pass(NOTCH_CALL_AFTER_MS);
    expect(h.said()).toBe('On a call. I hold everything until you are done.');
    await h.answer('done');
    h.real.inbox.add(h.item('question'));
    await settle();
    expect(h.line()).toBeNull();
    await h.around({ call: false, online: true });
    await h.pass(20_000);
    expect(h.said()).toBe('Call ended. I held 1 thing.');
  });
});
