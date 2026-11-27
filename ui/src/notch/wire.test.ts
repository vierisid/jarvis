// Point 7 of the notch review, step 4 (protocol v2), 26 November 2026: the
// brain's own NotchSurface and the page's own surface and wiring, joined by
// a pipe that can lose, copy and hold back what it carries, each way. Time is
// the test's own (./surface/test-clock.ts), shared by both sides: nothing
// here waits. See docs/notch/fixes/07-page-renderer.md.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import {
  NOTCH_ANSWER_AGAIN_MS, NOTCH_ANSWER_SENDS, NOTCH_ANSWERS_WAITING_MAX, NOTCH_AT_EVERY_MS, NOTCH_ESC_LEASE_MS, NOTCH_ESC_RENEW_MS,
  NOTCH_FOLD_GRACE_MS, NOTCH_FOLD_MS, NOTCH_PROTOCOL_VERSION,
} from '../../../src/notch/protocol.ts';
import type { NotchFromPage, NotchLine, NotchToPage } from '../../../src/notch/protocol.ts';
import type { NotchAnswer, NotchSurface as Brain, NotchSurfacePort } from '../../../src/notch/surface.ts';
import type { NotchReloader } from './bridge.ts';
import type { NotchTestClock } from './surface/test-clock.ts';

let mod: {
  Brain: typeof import('../../../src/notch/surface.ts')['NotchSurface'];
  event: string;
  connectNotch: typeof import('./bridge.ts')['connectNotch'];
  notchSend: typeof import('./bridge.ts')['notchSend'];
  createNotchSurface: typeof import('./surface/index.ts')['createNotchSurface'];
  createTestClock: typeof import('./surface/test-clock.ts')['createTestClock'];
};

beforeAll(async () => {
  GlobalRegistrator.register();
  const surface = await import('../../../src/notch/surface.ts');
  const bridge = await import('./bridge.ts');
  const page = await import('./surface/index.ts');
  const clock = await import('./surface/test-clock.ts');
  mod = {
    Brain: surface.NotchSurface, event: surface.NOTCH_MESSAGE_EVENT, connectNotch: bridge.connectNotch, notchSend: bridge.notchSend,
    createNotchSurface: page.createNotchSurface, createTestClock: clock.createTestClock,
  };
});
afterAll(() => GlobalRegistrator.unregister());

/** What a pipe does to the next message: carry it, lose it, carry it twice, or hold it back until let go. */
type Fate = 'carry' | 'lose' | 'twice' | 'hold';

/** One direction of the pipe: a rule for each message, and what was held back. */
interface Pipe {
  fate: (message: { type: string } & Record<string, unknown>) => Fate;
  held: (() => void)[];
  /** Lets go what was held, the last first: out of order. */
  release(): void;
}

function pipe(): Pipe {
  const p: Pipe = {
    fate: () => 'carry',
    held: [],
    release() {
      const held = p.held.splice(0).reverse();
      for (const deliver of held) deliver();
    },
  };
  return p;
}

function through(p: Pipe, message: { type: string } & Record<string, unknown>, deliver: () => void): void {
  const fate = p.fate(message);
  if (fate === 'lose') return;
  if (fate === 'hold') { p.held.push(deliver); return; }
  deliver();
  if (fate === 'twice') deliver();
}

interface Desk {
  id: string;
  root: HTMLElement;
  /** Brain to page, and page to brain. */
  down: Pipe;
  up: Pipe;
  /** Everything the page said, as it went out (lost or not), and everything the brain sent it. */
  said: NotchFromPage[];
  told: NotchToPage[];
  logs: string[];
  esc: boolean[];
  leases: number[];
  reloads: number;
  key(name: string): void;
  /** Says to the page what no brain here said: as a brain of another version would. */
  receive(message: unknown): void;
  /** Says to the brain what no page here said: as an old page would. */
  send(message: unknown): void;
  body(): string | undefined;
  text(): string;
  answered(): boolean;
  /** The page goes away and a new loading of it comes up on the same desktop app. */
  reload(): void;
  /** The desktop app's connection to the brain goes, and comes back. */
  disconnect(): void;
  end(): void;
}

interface World {
  clock: NotchTestClock;
  brain: Brain;
  heard: { answer: NotchAnswer; from?: string }[];
  desks: Desk[];
  desk(id: string, options?: { reloader?: NotchReloader; up?: Pipe['fate'] }): Desk;
  /** The brain is started again: a new run, with the same desktop apps still up. */
  restart(): void;
}

let world: World | null = null;
afterEach(() => {
  for (const desk of world?.desks ?? []) desk.end();
  world = null;
});

function make(): World {
  const clock = mod.createTestClock();
  let toBrain: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  let gone: (sidecarId: string) => void = () => {};
  const desks = new Map<string, Desk>();
  const port: NotchSurfacePort = {
    dispatchRPC(sidecarId, _method, params) {
      const message = structuredClone((params as { message: NotchToPage }).message);
      desks.get(sidecarId)?.told.push(message);
      const desk = desks.get(sidecarId);
      if (desk) through(desk.down, message as never, () => host(sidecarId)?.__notch_receive?.(structuredClone(message)));
      return Promise.resolve({ pushed: true });
    },
    onEvent(listener) { toBrain = listener; },
    onSidecarDisconnected(listener) { gone = listener; },
  };
  type Host = NonNullable<Parameters<typeof mod.connectNotch>[1]>;
  const hosts = new Map<string, Host>();
  const host = (id: string): Host | undefined => hosts.get(id);
  const timers = { setTimeout: (fn: () => void, ms: number) => clock.after(ms, fn), clearTimeout: (handle: unknown) => clock.cancel(handle as number) };
  const heard: World['heard'] = [];
  const newBrain = (): Brain => {
    const brain = new mod.Brain(port, () => {}, () => clock.now(), timers);
    brain.onAnswer((answer, from) => heard.push({ answer, from }));
    return brain;
  };
  const w: World = {
    clock,
    brain: newBrain(),
    heard,
    desks: [],
    restart() { w.brain = newBrain(); },
    desk(id, options = {}) {
      let kept: string | null = null;
      const reloader: NotchReloader = options.reloader ?? {
        get: () => kept, set: (value) => { kept = value; }, clear: () => { kept = null; }, reload: () => { desk.reloads++; desk.reload(); },
      };
      let page: ReturnType<typeof mod.createNotchSurface>;
      /** The loading of the page that is up. A page that was loaded again is gone, with every timer it had. */
      let loading = 0;
      const open = (): void => {
        const mine = ++loading;
        const own = { now: () => clock.now(), after: (ms: number, fn: () => void) => clock.after(ms, () => { if (mine === loading) fn(); }), cancel: (handle: number) => clock.cancel(handle) };
        const h: Host = {
          __notch_send: (text) => {
            const message = JSON.parse(text) as NotchFromPage;
            desk.said.push(message);
            through(desk.up, message as never, () => toBrain(id, { event_type: mod.event, payload: { message } }));
          },
          __notch_log: (text) => { desk.logs.push(text); },
          __notch_esc: (want) => { desk.esc.push(want); },
          __notch_esc_lease: (ms) => { desk.leases.push(ms); },
        };
        hosts.set(id, h);
        page = mod.createNotchSurface(desk.root, mod.notchSend(h), { reducedMotion: true, clock: own });
        mod.connectNotch(page, h, { clock: own, reloader });
      };
      const desk: Desk = {
        id, root: document.createElement('div'), down: pipe(), up: pipe(), said: [], told: [], logs: [], esc: [], leases: [], reloads: 0,
        key: (name) => host(id)?.__notch_key?.(name),
        receive: (message) => host(id)?.__notch_receive?.(message as never),
        send: (message) => toBrain(id, { event_type: mod.event, payload: { message } }),
        body: () => desk.root.querySelector<HTMLElement>('.nin')?.dataset.body,
        text: () => (desk.root.querySelector('.say')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        answered: () => desk.root.querySelector('.nin')?.classList.contains('answered') === true,
        reload() { page.destroy(); desk.root.replaceChildren(); open(); },
        disconnect() { gone(id); },
        end() { loading++; page.destroy(); desk.root.remove(); hosts.delete(id); },
      };
      if (options.up) desk.up.fate = options.up;
      document.body.append(desk.root);
      desks.set(id, desk);
      w.desks.push(desk);
      open();
      return desk;
    },
  };
  world = w;
  return w;
}

const offer = (id = 'o1', more: Partial<NotchLine> = {}): NotchLine => ({ id, kind: 'offer', say: ['Reply to Marco?'], yes: 'reply', ...more } as NotchLine);
const answers = (w: World, act?: string): NotchAnswer[] => w.heard.map((entry) => entry.answer).filter((answer) => act === undefined || answer.act === act);
const sentAnswers = (desk: Desk, act?: string) => desk.said.filter((m): m is Extract<NotchFromPage, { type: 'answer' }> => m.type === 'answer' && (act === undefined || m.act === act));
const ofType = (t: string) => (m: { type: string }): boolean => m.type === t;

describe('the brain and the page over a pipe that loses, copies and reorders', () => {
  test('every message kind each way is read back as it was sent', async () => {
    const { parseNotchFromPage, readNotchToPage, notchRuled } = await import('../../../src/notch/protocol.ts');
    const toPage: NotchToPage[] = [
      { type: 'state', v: NOTCH_PROTOCOL_VERSION, brain: 'b1', seq: 1, line: notchRuled(offer()), count: 2, face: 'closed', eye: true, sound: true, park: 1, mouth: 'open', born: 'run' },
      { type: 'patch', seq: 2, line: notchRuled({ id: 's', kind: 'send', say: ['Sent'], ms: 4000, left: 1200 }) },
      { type: 'patch', seq: 3, line: null, count: 0 },
      { type: 'patch', seq: 4, edit: { id: 'w', done: 2, away: 'none' } },
      { type: 'effect', seq: 5, gesture: 'wink', lip: 'reach', aim: 0.25, body: 'nod', kick: -100, edge: 'carry', side: 'right', mood: 'happy', birth: 'eye', gulp: true },
      { type: 'ack', n: 7, took: false },
      { type: 'ack', n: 8, took: true, unread: true },
      { type: 'refuse', v: NOTCH_PROTOCOL_VERSION },
    ];
    for (const message of toPage) expect(readNotchToPage(JSON.parse(JSON.stringify(message)))).toEqual({ message });
    const fromPage: NotchFromPage[] = [
      { type: 'hello', v: NOTCH_PROTOCOL_VERSION, page: 'p1' }, { type: 'answer', n: 1, id: 'o1', act: 'yes', since: 400 },
      { type: 'answer', n: 2, id: 'f', act: 'done', seen: true, since: 5000 }, { type: 'answer', n: 3, id: 'w', act: 'word', word: 'when', text: 'Tell R&D "x < 5"' },
      { type: 'hand', id: 'o1', on: true }, { type: 'at', seq: 4 },
      { type: 'open' }, { type: 'stop' }, { type: 'drag', state: 'lost' }, { type: 'signed-out' },
    ];
    for (const message of fromPage) expect(parseNotchFromPage(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  test('a page comes up and is told the whole, and every message after it is numbered in a row', () => {
    const w = make();
    const pc = w.desk('pc');
    expect(pc.said[0]).toMatchObject({ type: 'hello', v: NOTCH_PROTOCOL_VERSION });
    w.brain.show(offer());
    w.brain.setCount(2);
    w.brain.act({ gesture: 'wink' });
    expect(pc.told.map((m) => [m.type, (m as { seq?: number }).seq])).toEqual([['state', 1], ['patch', 2], ['patch', 3], ['effect', 4]]);
    expect(pc.text()).toContain('Reply to Marco?');
  });

  test('a yes lost on the way is sent again, and counts once', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(offer());
    w.clock.advance(400);
    let lose = 2;
    pc.up.fate = (m) => (m.type === 'answer' && lose-- > 0 ? 'lose' : 'carry');
    pc.key('yes');
    expect(pc.answered()).toBe(true);
    expect(answers(w)).toEqual([]);
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * 2);
    expect(answers(w, 'yes')).toHaveLength(1);
    expect(sentAnswers(pc, 'yes').map((m) => m.n)).toEqual([1, 1, 1]);
    // Acknowledged: it is said no more.
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * 10);
    expect(sentAnswers(pc, 'yes')).toHaveLength(3);
    expect(answers(w, 'yes')).toHaveLength(1);
  });

  test('a yes carried twice, and its ack lost, is still one yes', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(offer());
    w.clock.advance(400);
    pc.up.fate = (m) => (m.type === 'answer' ? 'twice' : 'carry');
    // Both acks of the first send are lost; the page sends it again, and that one is heard.
    let lose = 2;
    pc.down.fate = (m) => (m.type === 'ack' && lose-- > 0 ? 'lose' : 'carry');
    pc.key('yes');
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * 6);
    expect(answers(w, 'yes')).toHaveLength(1);
    expect(pc.told.filter(ofType('ack'))).toHaveLength(4);
    expect(sentAnswers(pc, 'yes')).toHaveLength(2);
    expect(pc.answered()).toBe(true);
  });

  test('a yes the brain never hears: the line is answerable again after the last try, and the second yes is the same answer', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(offer());
    w.clock.advance(400);
    pc.up.fate = (m) => (m.type === 'answer' ? 'lose' : 'carry');
    pc.key('yes');
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * NOTCH_ANSWER_SENDS - 1);
    expect(pc.answered()).toBe(true);
    w.clock.advance(1);
    // Bounded: said NOTCH_ANSWER_SENDS times, then given up. Not dimmed for good: it can be answered again.
    expect(sentAnswers(pc, 'yes')).toHaveLength(NOTCH_ANSWER_SENDS);
    expect(pc.answered()).toBe(false);
    expect(pc.logs.some((line) => line.includes('no word that the brain has the yes'))).toBe(true);
    expect(pc.text()).toContain('Reply to Marco?');
    // The link is back. The person says yes again: the same number, and one yes.
    pc.up.fate = () => 'carry';
    w.clock.advance(400);
    pc.key('yes');
    expect(sentAnswers(pc, 'yes').at(-1)!.n).toBe(sentAnswers(pc, 'yes')[0]!.n);
    expect(answers(w, 'yes')).toHaveLength(1);
    expect(pc.answered()).toBe(true);
  });

  test('a slow first yes and the second yes after it was given up are one yes', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(offer());
    w.clock.advance(400);
    // Every try of the first is held on the way, as on a link that has stalled.
    pc.up.fate = (m) => (m.type === 'answer' ? 'hold' : 'carry');
    pc.key('yes');
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * NOTCH_ANSWER_SENDS);
    expect(pc.answered()).toBe(false);
    pc.up.fate = () => 'carry';
    w.clock.advance(400);
    pc.key('yes');
    // The stalled tries arrive after it.
    pc.up.release();
    expect(answers(w, 'yes')).toHaveLength(1);
  });

  test('a fuse taken back on a link that loses: one undo, and never a done after it', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show({ id: 'f1', kind: 'send', say: ['Sending'], ms: 4000 });
    w.clock.advance(800);
    let lose = 1;
    pc.up.fate = (m) => (m.type === 'answer' && lose-- > 0 ? 'lose' : 'carry');
    pc.key('esc');
    w.clock.advance(8000);
    expect(answers(w).map((a) => a.act)).toEqual(['undo']);
    expect(sentAnswers(pc, 'done')).toEqual([]);
  });

  test('a rest that was lost is found by the page\'s own word on how far it has read', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(offer('o1', { fold: 0 } as Partial<NotchLine>));
    pc.down.fate = (m) => (m.type === 'patch' ? 'lose' : 'carry');
    w.brain.rest();
    expect(pc.body()).toBe('line');
    pc.down.fate = () => 'carry';
    w.clock.advance(NOTCH_AT_EVERY_MS);
    expect(pc.said.filter(ofType('at')).length).toBeGreaterThanOrEqual(1);
    expect(pc.body()).toBe('rest');
  });

  test('messages that come out of order: the gap is seen, and the page asks for the whole', () => {
    const w = make();
    const pc = w.desk('pc');
    // Not a moment after the first hello: a page does not ask twice in a row.
    w.clock.advance(3000);
    pc.down.fate = (m) => (m.type === 'patch' ? 'hold' : 'carry');
    w.brain.show(offer('o1'));
    w.brain.show(offer('o2', { say: ['Reply to Anna?'] } as Partial<NotchLine>));
    pc.down.fate = () => 'carry';
    const hellos = pc.said.filter(ofType('hello')).length;
    pc.down.release();
    // The newer came first, the older after it and is passed over as a copy. The gap was asked about.
    expect(pc.said.filter(ofType('hello')).length).toBe(hellos + 1);
    expect(pc.text()).toContain('Reply to Anna?');
  });

  test('a message carried twice is drawn once', () => {
    const w = make();
    const pc = w.desk('pc');
    pc.down.fate = () => 'twice';
    w.brain.show({ id: 'w1', kind: 'work', say: ['Working'], steps: 3, done: 0 });
    w.brain.update('w1', { done: 1 });
    expect(pc.said.filter(ofType('hello'))).toHaveLength(1);
    expect(pc.logs.filter((line) => line.includes('out of step'))).toEqual([]);
  });

  test('a fold the brain made, whose patch was lost: the brain is not left waiting, and the page catches up', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(offer());
    pc.down.fate = (m) => (m.type === 'patch' ? 'lose' : 'carry');
    w.clock.advance(NOTCH_FOLD_MS + NOTCH_FOLD_GRACE_MS);
    expect(answers(w, 'fold')).toHaveLength(1);
    expect(w.brain.current().line).toBeNull();
    pc.down.fate = () => 'carry';
    w.clock.advance(NOTCH_AT_EVERY_MS);
    expect(pc.body()).toBe('rest');
  });
});

describe('two desktops', () => {
  test('each is acknowledged its own answers, the first that holds a line stands, and a no on one takes the line off the other', () => {
    const w = make();
    const pc = w.desk('pc'), mac = w.desk('mac');
    w.brain.show({ id: 'w1', kind: 'work', say: ['Working'], steps: 3, done: 0 });
    w.clock.advance(400);
    pc.key('esc');
    mac.key('esc');
    // Both asked it to stop: the first is taken, the second is told it came late.
    expect(answers(w, 'stop').map((a) => a.key?.split('\n')[0])).toEqual(['pc']);
    expect(pc.told.filter(ofType('ack'))).toEqual([{ type: 'ack', n: 1, took: true }]);
    expect(mac.told.filter(ofType('ack'))).toEqual([{ type: 'ack', n: 1, took: false }]);
    expect(mac.answered()).toBe(true);
    w.brain.show(offer());
    w.clock.advance(400);
    mac.key('esc');
    expect(answers(w, 'no')).toHaveLength(1);
    expect(pc.body()).toBe('rest');
    expect(mac.body()).toBe('rest');
  });

  test('one says yes and goes away in the middle of sending it again: one yes, the other still waits, and the yes said again on return is not a second', () => {
    const w = make();
    const pc = w.desk('pc'), mac = w.desk('mac');
    w.brain.show(offer());
    w.clock.advance(400);
    pc.down.fate = (m) => (m.type === 'ack' ? 'lose' : 'carry');
    pc.key('yes');
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS);
    // The connection goes: nothing more from this desktop reaches the brain.
    pc.disconnect();
    pc.up.fate = () => 'lose';
    pc.down.fate = () => 'lose';
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * NOTCH_ANSWER_SENDS);
    expect(answers(w, 'yes')).toHaveLength(1);
    expect(w.brain.listening()).toBe(1);
    expect(mac.text()).toContain('Reply to Marco?');
    expect(mac.answered()).toBe(false);
    // Given up on this page: the line can be answered again there.
    expect(pc.answered()).toBe(false);
    // It comes back, is told the line it shows, and the person says yes again: the same answer, taken once.
    pc.up.fate = () => 'carry';
    pc.down.fate = () => 'carry';
    w.clock.advance(NOTCH_AT_EVERY_MS);
    expect(w.brain.listening()).toBe(2);
    pc.key('yes');
    expect(answers(w, 'yes')).toHaveLength(1);
    expect(pc.told.filter(ofType('ack')).at(-1)).toMatchObject({ type: 'ack', took: true });
  });
});

describe('a page that comes and goes, and a brain that does', () => {
  test('a desktop app that comes back in the middle of a fuse burns what is left, and the done counts once', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show({ id: 'f1', kind: 'send', say: ['Sending'], ms: 6000 });
    w.clock.advance(1000);
    pc.disconnect();
    pc.reload();
    const state = pc.told.filter(ofType('state')).at(-1) as Extract<NotchToPage, { type: 'state' }>;
    expect(state.line).toMatchObject({ id: 'f1', left: 5000 });
    w.clock.advance(5000);
    expect(answers(w, 'done')).toHaveLength(1);
    w.clock.advance(10_000);
    expect(answers(w, 'done')).toHaveLength(1);
  });

  test('a page loaded again in the middle of a letter under its fuse is told the letter, and must vouch for it again', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show({ id: 'f2', kind: 'send', say: ['Sending'], ms: 8000, blocks: [{ kind: 'paper', lines: [['Hi Leo,'], ['Sam']] }] });
    w.clock.advance(2000);
    pc.reload();
    const state = pc.told.filter(ofType('state')).at(-1) as Extract<NotchToPage, { type: 'state' }>;
    expect(state.line).toMatchObject({ id: 'f2', left: 6000, asking: true, blocks: [{ kind: 'paper' }] });
    w.clock.advance(6000);
    expect(answers(w, 'done')).toHaveLength(1);
  });

  test('a brain started again under a page that is up: the page is refused, says hello, and is told the new run whole', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(offer('old'));
    w.clock.advance(400);
    // The old brain's ack never comes: it is gone.
    pc.down.fate = (m) => (m.type === 'ack' ? 'lose' : 'carry');
    pc.key('yes');
    w.restart();
    pc.down.fate = () => 'carry';
    w.brain.show(offer('new', { say: ['Reply to Anna?'], fold: 0 } as Partial<NotchLine>));
    // The new brain does not know the page. The page's next try is refused, and it says hello (not twice in 3 s).
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * 3);
    expect(pc.told.filter(ofType('refuse')).at(-1)).toEqual({ type: 'refuse', v: NOTCH_PROTOCOL_VERSION });
    expect(pc.text()).toContain('Reply to Anna?');
    expect(pc.answered()).toBe(false);
    // Nothing of the old answer reaches the new run, however long it is waited for.
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * 10);
    expect(w.heard.filter((entry) => entry.answer.id === 'new')).toEqual([]);
  });
});

describe('versions', () => {
  test('a page refused for another version loads itself again once, then rests and says so, and comes back when the brain fits', async () => {
    const { NOTCH_HELLO_RESTING_MS } = await import('./bridge.ts');
    const w = make();
    let kept: string | null = null;
    let reloads = 0;
    // A brain of version 3 is there in place of this one: every hello is answered with its refusal.
    let three = true;
    const pc = w.desk('pc', {
      reloader: { get: () => kept, set: (value) => { kept = value; }, clear: () => { kept = null; }, reload: () => { reloads++; pc.reload(); } },
      up: (m) => (three && m.type === 'hello' ? 'lose' : 'carry'),
    });
    const answerHello = (): void => { if (three) pc.receive({ type: 'refuse', v: 3 }); };
    w.brain.show(offer());
    answerHello();
    expect(reloads).toBe(1);
    // The page that was loaded again finds the same: it does not load itself again, it rests.
    answerHello();
    expect(reloads).toBe(1);
    expect(pc.logs.some((line) => line.includes('also after the page was loaded again'))).toBe(true);
    expect(pc.body()).not.toBe('line');
    expect(pc.esc.includes(true)).toBe(false);
    // Nothing a brain of another version says is drawn, and nothing is answered to it.
    pc.receive({ type: 'state', v: 3, brain: 'b3', seq: 1, line: null, count: 4 });
    expect(pc.said.filter(ofType('answer'))).toEqual([]);
    // The brain is changed for one that fits: the page's next hello is answered whole.
    three = false;
    w.clock.advance(NOTCH_HELLO_RESTING_MS);
    expect(pc.text()).toContain('Reply to Marco?');
    expect(kept).toBeNull();
  });

  test('the brain takes no done for a fuse from a page of another version', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show({ id: 'f1', kind: 'send', say: ['Sending'], ms: 4000 });
    // An old page on the same desktop app says hello in version 1 and then that the fuse ran out.
    pc.up.fate = () => 'carry';
    pc.send({ type: 'hello', v: 1 });
    pc.send({ type: 'answer', id: 'f1', act: 'done' });
    pc.send({ type: 'answer', n: 1, id: 'f1', act: 'done', seen: true });
    expect(answers(w)).toEqual([]);
    expect(pc.told.filter(ofType('refuse')).length).toBeGreaterThanOrEqual(1);
  });
});

describe('the lease on Esc', () => {
  test('the page says the length of its lease once, and its claim again every renewal while it wants Esc', () => {
    const w = make();
    const pc = w.desk('pc');
    expect(pc.leases).toEqual([NOTCH_ESC_LEASE_MS]);
    w.brain.show(offer('o1', { fold: 0 } as Partial<NotchLine>));
    w.clock.advance(400);
    const before = pc.esc.length;
    expect(pc.esc.at(-1)).toBe(true);
    w.clock.advance(NOTCH_ESC_RENEW_MS * 3);
    expect(pc.esc.slice(before)).toEqual([true, true, true]);
    // Given up once, and not said again.
    pc.key('esc');
    expect(pc.esc.at(-1)).toBe(false);
    const after = pc.esc.length;
    w.clock.advance(NOTCH_ESC_RENEW_MS * 5);
    expect(pc.esc.length).toBe(after);
  });
});

describe('bounded memory', () => {
  test('with the brain away, a page keeps a handful of answers to send again, never more', () => {
    const w = make();
    const pc = w.desk('pc');
    pc.up.fate = (m) => (m.type === 'answer' ? 'lose' : 'carry');
    w.brain.show({ id: 's1', kind: 'sheet', say: ['Pick'], blocks: [{ kind: 'buttons', buttons: Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, label: `B${i}` })) }] });
    w.clock.advance(400);
    const buttons = [...pc.root.querySelectorAll<HTMLElement>('.sheet button')];
    expect(buttons.length).toBe(30);
    for (const button of buttons) button.click();
    const said = sentAnswers(pc, 'button').length;
    expect(said).toBe(30);
    // Each was said once; only the newest NOTCH_ANSWERS_WAITING_MAX are said again.
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS);
    expect(sentAnswers(pc, 'button').length - said).toBe(NOTCH_ANSWERS_WAITING_MAX);
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * NOTCH_ANSWER_SENDS * 2);
    expect(sentAnswers(pc, 'button').length).toBe(said + NOTCH_ANSWERS_WAITING_MAX * (NOTCH_ANSWER_SENDS - 1));
  });
});

// The review of step 4, 27 November 2026: what a hostile pipe still got through.
const inOrder = (p: Pipe): void => { const held = p.held.splice(0); for (const deliver of held) deliver(); };

describe('what the review of step 4 found', () => {
  test('a fuse the page said ran out is never offered for undo again, even when no ack comes, nor after the page is loaded again', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show({ id: 'f1', kind: 'send', say: ['Sending'], ms: 4000 });
    // Nothing comes back: no ack, and no state that would say the brain holds it.
    pc.down.fate = (m) => (m.type === 'ack' || m.type === 'state' ? 'lose' : 'carry');
    w.clock.advance(4000);
    expect(answers(w).map((a) => a.act)).toEqual(['done']);
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * NOTCH_ANSWER_SENDS + 10);
    // Given up on, it stays answered: no undo is shown, and Esc takes nothing back.
    expect(pc.answered()).toBe(true);
    expect(pc.root.querySelector('.hint')?.textContent ?? '').not.toContain('undo');
    pc.down.fate = () => 'carry';
    pc.key('esc');
    expect(sentAnswers(pc, 'undo')).toEqual([]);
    // Loaded again, it is told the fuse as the brain holds it: answered, burning nothing, with no undo.
    pc.reload();
    const state = pc.told.filter(ofType('state')).at(-1) as Extract<NotchToPage, { type: 'state' }>;
    expect(state.line).toMatchObject({ id: 'f1', held: true });
    expect(pc.answered()).toBe(true);
    expect(pc.root.querySelector('.hint')?.textContent ?? '').not.toContain('undo');
    pc.key('esc');
    w.clock.advance(10_000);
    expect(sentAnswers(pc, 'undo')).toEqual([]);
    expect(answers(w).map((a) => a.act)).toEqual(['done']);
  });

  test('a page that is up while the brain is away for long says hello again once a brain refuses it, and claims no Esc meanwhile', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(offer('o1', { fold: 0 } as Partial<NotchLine>));
    w.clock.advance(800);
    expect(pc.esc.at(-1)).toBe(true);
    pc.up.fate = () => 'lose';
    pc.down.fate = () => 'lose';
    pc.key('yes');
    w.clock.advance(90_000);
    // Every hello was spent on nobody: the page gave up, and holds no Esc for a line nobody may hold.
    expect(pc.esc.at(-1)).toBe(false);
    const renewals = pc.esc.length;
    w.clock.advance(30_000);
    expect(pc.esc.length).toBe(renewals);
    w.restart();
    pc.disconnect();
    pc.up.fate = () => 'carry';
    pc.down.fate = () => 'carry';
    w.brain.show(offer('n1', { say: ['New run line'], fold: 0 } as Partial<NotchLine>));
    w.clock.advance(NOTCH_AT_EVERY_MS + 3000);
    expect(w.brain.listening()).toBe(1);
    expect(pc.text()).toContain('New run line');
    expect(pc.esc.at(-1)).toBe(true);
  });

  test('a brain started again with a line of the same name, and its state lost: the old run\'s yes is not taken by the new line', () => {
    const w = make();
    const pc = w.desk('pc');
    w.clock.advance(3000);
    w.brain.show(offer('item-chase-1-1', { fold: 0 } as Partial<NotchLine>));
    w.clock.advance(800);
    pc.down.fate = (m) => (m.type === 'ack' ? 'lose' : 'carry');
    pc.key('yes');
    w.restart();
    w.brain.show(offer('item-chase-1-1', { fold: 0 } as Partial<NotchLine>));
    pc.down.fate = (m) => (m.type === 'state' || m.type === 'ack' ? 'lose' : 'carry');
    const before = w.heard.length;
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * 10);
    expect(w.heard.slice(before)).toEqual([]);
    expect(sentAnswers(pc, 'yes').every((m) => m.brain !== undefined)).toBe(true);
  });

  test('an undo lost on a long fuse and given up on: the fuse running out on the page says no done after it', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show({ id: 'f9', kind: 'send', say: ['Sending'], ms: 9000 });
    w.clock.advance(800);
    pc.up.fate = (m) => (m.type === 'answer' ? 'lose' : 'carry');
    pc.key('esc');
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * NOTCH_ANSWER_SENDS + 100);
    // Answerable again, for the undo to be said again: not for "it ran out".
    expect(pc.answered()).toBe(false);
    pc.up.fate = () => 'carry';
    w.clock.advance(6000);
    expect(sentAnswers(pc, 'done')).toEqual([]);
    expect(answers(w, 'done')).toEqual([]);
  });

  test('a page told the whole by a new run of the brain sends nothing more it held for the run before', () => {
    const w = make();
    const pc = w.desk('pc');
    // Not a moment after its first hello, so that it says the next at once.
    w.clock.advance(3000);
    w.brain.show(offer('o1', { fold: 0 } as Partial<NotchLine>));
    w.clock.advance(800);
    pc.down.fate = (m) => (m.type === 'ack' ? 'lose' : 'carry');
    pc.key('yes');
    const n = sentAnswers(pc, 'yes')[0]!.n;
    w.restart();
    // The page learns of the new run (it is refused at its next try, and says hello), while it still has
    // tries of the old answer to make.
    const first = (pc.told.find(ofType('state')) as Extract<NotchToPage, { type: 'state' }>).brain;
    while (!pc.told.some((m) => m.type === 'state' && m.brain !== first)) w.clock.advance(100);
    expect(sentAnswers(pc, 'yes').length).toBeLessThan(NOTCH_ANSWER_SENDS);
    const after = pc.said.length;
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * 10);
    expect(pc.said.slice(after).filter((m) => m.type === 'answer' && m.n === n)).toEqual([]);
  });

  test('a second pick unlike the first, after the first was given up on: the first that reached the brain stands, and the page shows the line answered', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show({ id: 'c1', kind: 'offer', say: ['Which day?'], options: ['Thursday', 'Friday'], fold: 0 });
    w.clock.advance(800);
    pc.up.fate = (m) => (m.type === 'answer' ? 'hold' : 'carry');
    const opts = (): HTMLElement[] => [...pc.root.querySelectorAll<HTMLElement>('.opts button, .opt, [data-opt]')];
    const pick = (label: string): void => { opts().find((b) => (b.textContent ?? '').includes(label))!.click(); };
    pick('Thursday');
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * NOTCH_ANSWER_SENDS + 10);
    expect(pc.answered()).toBe(false);
    pick('Friday');
    const [first, second] = [sentAnswers(pc, 'pick')[0]!, sentAnswers(pc, 'pick').at(-1)!];
    expect(second.option).toBe('Friday');
    expect(second.n).not.toBe(first.n);
    pc.up.fate = () => 'carry';
    inOrder(pc.up);
    expect(answers(w, 'pick').map((a) => a.option)).toEqual(['Thursday']);
    expect(pc.told.filter((m) => m.type === 'ack' && m.n === second.n)).toEqual([{ type: 'ack', n: second.n!, took: false }]);
    expect(pc.answered()).toBe(true);
  });

  test('a yes slow past the give-up, and a no given after it: the yes stands and the no is late', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(offer('o1', { fold: 0 } as Partial<NotchLine>));
    w.clock.advance(800);
    pc.up.fate = (m) => (m.type === 'answer' ? 'hold' : 'carry');
    pc.key('yes');
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * NOTCH_ANSWER_SENDS + 10);
    pc.key('esc');
    pc.up.fate = () => 'carry';
    inOrder(pc.up);
    expect(answers(w).map((a) => a.act)).toEqual(['yes']);
    expect(w.brain.current().line?.id).toBe('o1');
  });

  test('a yes in the last moment of an offer, lost once, still counts in place of the fold', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(offer());
    w.clock.advance(NOTCH_FOLD_MS - 50);
    let lose = 1;
    pc.up.fate = (m) => (m.type === 'answer' && lose-- > 0 ? 'lose' : 'carry');
    pc.key('yes');
    w.clock.advance(NOTCH_FOLD_GRACE_MS + 2000);
    expect(answers(w).map((a) => a.act)).toEqual(['yes']);
    expect(w.brain.current().line?.id).toBe('o1');
    // Every page put it away with the fold: it is back, answered, until the brain says what next.
    expect(pc.answered()).toBe(true);
  });

  test('a yes that comes after the grace is late, and the fold stands', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(offer());
    w.clock.advance(NOTCH_FOLD_MS - 50);
    pc.up.fate = (m) => (m.type === 'answer' ? 'hold' : 'carry');
    pc.key('yes');
    w.clock.advance(NOTCH_FOLD_GRACE_MS + 100);
    pc.up.fate = () => 'carry';
    inOrder(pc.up);
    expect(answers(w).map((a) => a.act)).toEqual(['fold']);
  });

  test('an offer\'s time does not run while its only page is refused for its version, and starts again when a page comes', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(offer());
    w.clock.advance(1000);
    // What is on that desktop now is a page of version 1, and nothing else speaks from there.
    pc.up.fate = () => 'lose';
    pc.send({ type: 'hello', v: 1 });
    w.clock.advance(7000);
    // A page of this version comes back: the offer has all its time from here.
    pc.up.fate = () => 'carry';
    pc.send({ type: 'hello', v: NOTCH_PROTOCOL_VERSION });
    w.clock.advance(NOTCH_FOLD_MS - 100);
    expect(answers(w, 'fold')).toEqual([]);
    w.clock.advance(100 + NOTCH_FOLD_GRACE_MS);
    expect(answers(w, 'fold')).toHaveLength(1);
  });

  test('a page told the whole again while another desktop\'s answer holds the line shows it answered, with no undo', () => {
    const w = make();
    const pc = w.desk('pc'), mac = w.desk('mac');
    w.clock.advance(3000);
    w.brain.show({ id: 'f2', kind: 'send', say: ['Sending'], ms: 9000 });
    w.clock.advance(800);
    mac.key('esc');
    expect(answers(w).map((a) => a.act)).toEqual(['undo']);
    expect(pc.answered()).toBe(false);
    // Something the brain said to the pc could not be read: it asks for the whole, and learns the fuse is decided.
    pc.receive({ type: 'patch' });
    expect(pc.answered()).toBe(true);
    expect(pc.root.querySelector('.hint')?.textContent ?? '').not.toContain('undo');
    pc.key('esc');
    w.clock.advance(10_000);
    expect(sentAnswers(pc)).toEqual([]);
  });

  test('a page of version 1 left up across the update is opened anew on its first answer, once for the connection', () => {
    const w = make();
    const refused: [string, number][] = [];
    w.brain.onRefused((id, v) => refused.push([id, v]));
    const pc = w.desk('pc');
    w.brain.show(offer());
    pc.disconnect();
    // It never says hello again: it only answers, as version 1 did, with no number.
    pc.send({ type: 'answer', id: 'o1', act: 'yes' });
    pc.send({ type: 'answer', id: 'o1', act: 'no' });
    expect(refused).toEqual([['pc', 1]]);
    expect(answers(w)).toEqual([]);
  });

  test('at rest a page says how far it has read once a minute, with a line up every few seconds, and a brain started again under a resting page is still found', () => {
    const w = make();
    const pc = w.desk('pc');
    const ats = (): number => pc.said.filter(ofType('at')).length;
    w.clock.advance(600_000);
    expect(ats()).toBeLessThanOrEqual(600_000 / 60_000);
    w.brain.show(offer('o1', { fold: 0 } as Partial<NotchLine>));
    const before = ats();
    w.clock.advance(NOTCH_AT_EVERY_MS * 4);
    expect(ats() - before).toBe(4);
    w.brain.rest();
    w.restart();
    pc.disconnect();
    w.brain.show(offer('n1', { say: ['New run line'], fold: 0 } as Partial<NotchLine>));
    w.clock.advance(60_000 + 3000);
    expect(pc.text()).toContain('New run line');
  });
});

describe('a value typed into a lit word', () => {
  const schedule = (): NotchLine => offer('a1', {
    say: ['Every ', { word: { name: 'when', value: 'Monday at 9:00', options: ['Monday at 9:00'], label: 'Schedule', read: 'sched' } }, ', send me the news.'], fold: 0,
  } as Partial<NotchLine>);
  /** Opens the word's field on a desk and types `text` into it, then Enter. */
  const type = (desk: Desk, text: string): HTMLInputElement => {
    if (!desk.root.querySelector('.pick input')) desk.root.querySelector<HTMLElement>('.say .live')!.click();
    const field = desk.root.querySelector<HTMLInputElement>('.pick input')!;
    field.value = text;
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return field;
  };

  test('goes to the brain as it was typed, and what the brain read is drawn on every desktop', () => {
    const w = make();
    const pc = w.desk('pc');
    const mac = w.desk('mac');
    w.brain.show(schedule());
    w.clock.advance(400);
    type(pc, 'weekday at 9');
    expect(sentAnswers(pc, 'word')).toEqual([expect.objectContaining({ word: 'when', text: 'weekday at 9' })]);
    expect(sentAnswers(pc, 'word')[0]).not.toHaveProperty('value');
    // Whoever waits on the line hears it as it was read, with what was typed beside it.
    expect(answers(w, 'word')).toEqual([expect.objectContaining({ word: 'when', value: 'Monday to Friday at 9:00', text: 'weekday at 9' })]);
    expect(pc.root.querySelector('.pick input')).toBeNull();
    expect(pc.text()).toContain('Every Monday to Friday at 9:00');
    expect(mac.text()).toContain('Every Monday to Friday at 9:00');
  });

  test('one the brain cannot read changes nothing and is heard of by nobody: the field says so and stays', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(schedule());
    w.clock.advance(400);
    // "month" was Monday on the page; "sunset" Sunday.
    for (const text of ['month', 'sunset']) {
      const field = type(pc, text);
      expect(field.isConnected).toBe(true);
      expect(field.placeholder).toBe('I did not get that');
      expect(field.classList.contains('no')).toBe(true);
    }
    expect(sentAnswers(pc, 'word').map((answer) => answer.text)).toEqual(['month', 'sunset']);
    expect(answers(w, 'word')).toEqual([]);
    expect(pc.text()).toContain('Every Monday at 9:00');
    // A yes now is a yes to the line as it stands.
    pc.root.querySelector<HTMLInputElement>('.pick input')!.value = '';
    pc.key('yes');
    expect(answers(w, 'yes')).toHaveLength(1);
  });

  test('a refusal whose ack was lost is told again with the answer sent again', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(schedule());
    w.clock.advance(400);
    let lose = 1;
    pc.down.fate = (m) => (m.type === 'ack' && lose-- > 0 ? 'lose' : 'carry');
    const field = type(pc, 'month');
    expect(field.placeholder).not.toBe('I did not get that');
    // While the brain has not said, a yes is taken by the field: the line is not answered with the word as it was.
    pc.key('yes');
    expect(sentAnswers(pc, 'yes')).toEqual([]);
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS);
    expect(sentAnswers(pc, 'word')).toHaveLength(2);
    expect(field.placeholder).toBe('I did not get that');
    expect(answers(w, 'word')).toEqual([]);
  });

  test('while it waits for the brain the strip stays up, however long, and a yes answers nothing', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(schedule());
    w.clock.advance(400);
    // The brain hears it and answers, but its answers are slow to come back.
    pc.down.fate = (m) => (m.type === 'ack' ? 'hold' : 'carry');
    // The strip is opened, and what is typed in it a while later is taken by the yes keys (no key in the field).
    pc.root.querySelector<HTMLElement>('.say .live')!.click();
    w.clock.advance(5000);
    const field = pc.root.querySelector<HTMLInputElement>('.pick input')!;
    field.value = 'weekday at 9';
    pc.key('yes');
    expect(sentAnswers(pc, 'word')).toHaveLength(1);
    w.clock.advance(1500);
    expect(field.isConnected).toBe(true);
    pc.key('yes');
    expect(sentAnswers(pc, 'yes')).toEqual([]);
  });

  test('one that came too late for its line says so in the field', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(schedule());
    w.clock.advance(400);
    // The line goes in the brain, and this page does not hear of it.
    pc.down.fate = (m) => (m.type === 'ack' ? 'carry' : 'lose');
    w.brain.rest();
    const field = type(pc, 'weekday at 9');
    expect(field.isConnected).toBe(true);
    expect(field.placeholder).toBe('That did not go in');
    expect(answers(w, 'word')).toEqual([]);
  });

  test('one that never reached the brain can be sent again as it stands', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show(schedule());
    w.clock.advance(400);
    pc.up.fate = (m) => (m.type === 'answer' ? 'lose' : 'carry');
    type(pc, 'weekday at 9');
    w.clock.advance(NOTCH_ANSWER_AGAIN_MS * (NOTCH_ANSWER_SENDS + 1));
    expect(answers(w, 'word')).toEqual([]);
    pc.up.fate = () => 'carry';
    // Enter again, the same text: it was given up, and goes again.
    type(pc, 'weekday at 9');
    expect(answers(w, 'word')).toEqual([expect.objectContaining({ value: 'Monday to Friday at 9:00' })]);
    expect(pc.text()).toContain('Every Monday to Friday at 9:00');
  });

  test('a sentence typed into a word that takes one reaches the brain whole', () => {
    const w = make();
    const pc = w.desk('pc');
    w.brain.show({
      id: 'd', kind: 'sheet', say: ['Reply to ', { em: 'Sam' }], yes: 'send', stay: true,
      blocks: [{ kind: 'row', lead: 'Tell me', say: [{ word: { name: 'told', value: 'tell me', options: ['say no'], label: 'Tell', free: true, long: true } }] }],
    } as NotchLine);
    w.clock.advance(400);
    pc.root.querySelector<HTMLElement>('.sheet .live')!.click();
    const field = pc.root.querySelector<HTMLInputElement>('.pick input')!;
    field.value = 'Tell R&D "x < 5"';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(answers(w, 'word')).toEqual([expect.objectContaining({ word: 'told', value: 'Tell R&D "x < 5"' })]);
    expect(pc.root.querySelector('.sheet')?.textContent).toContain('Tell R&D "x < 5"');
  });
});
