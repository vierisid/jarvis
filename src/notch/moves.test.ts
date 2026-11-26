/**
 * Pass 12: the prototype's movements, played at their real moments. These
 * tests are about WHEN the brain asks for a movement; what each one looks
 * like is the page's (ui/src/notch/surface/surface.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { NotchInbox } from './inbox.ts';
import { pointAim } from './point.ts';
import { NOTCH_BIRTHS, type NotchLine, type NotchToPage } from './protocol.ts';
import { NotchStage, notchArrival } from './stage.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface, notchBirthAfter } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 80; i++) await Promise.resolve(); };

function harness() {
  const pushed: NotchToPage[] = [];
  let toSurface: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { toSurface = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = 1_000_000;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown, from = 'pc'): void => toSurface(from, { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  const pass = async (ms: number): Promise<void> => {
    now += ms;
    for (const timer of [...timers]) if (timer.at <= now) { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); timer.fn(); }
    await settle();
  };
  const shows = (): NotchLine[] => pushed.flatMap((m) => (m.type === 'patch' && m.line ? [m.line] : []));
  const acts = (): Record<string, unknown>[] => pushed.filter((m) => m.type === 'effect').map(({ type: _type, seq: _seq, ...rest }) => rest);
  return { surface, clock, pushed, fromPage, pass, shows, acts };
}

describe('a line that Jarvis brings by itself comes in along the edge', () => {
  test('from the side its app is on, hopping for an agent, and twice and fast for what cannot wait', () => {
    expect(notchArrival({})).toBe('left');
    expect(notchArrival({ src: 'mail' })).toBe('left');
    expect(notchArrival({ src: 'cal' })).toBe('left');
    expect(notchArrival({ src: 'slack' })).toBe('right');
    expect(notchArrival({ src: 'bank' })).toBe('right');
    expect(notchArrival({ who: 'Tony', src: 'mail' })).toBe('hop');
    expect(notchArrival({ mood: 'urgent', who: 'Tony' })).toBe('urgent');
    expect(notchArrival({ mark: 'fail' })).toBe('urgent');
  });

  test('the first line of a script that started by itself arrives; every line after it is just there', async () => {
    const h = harness();
    h.fromPage({ type: 'hello', v: 2 });
    const stage = new NotchStage(h.surface, h.clock, 'mail', { prefix: 'item', unasked: true });
    stage.put({ id: stage.id(), kind: 'offer', say: ['Reply to Sam?'], yes: 'show', src: 'mail' });
    stage.put({ id: stage.id(), kind: 'say', say: ['Sent.'], ms: 2000, src: 'mail' });
    const [first, second] = h.shows();
    expect(first).toMatchObject({ unasked: true, arrive: 'left' });
    expect(second!.arrive).toBeUndefined();
    expect(second!.unasked).toBeUndefined();
  });

  test('a line that was asked for does not arrive, whatever way it would come by itself', () => {
    const h = harness();
    h.fromPage({ type: 'hello', v: 2 });
    const asked = new NotchStage(h.surface, h.clock, 'round', { prefix: 'item' });
    void asked.say(['3 mails while you were away.'], 4000, { comes: 'pair' });
    const line = h.shows()[0]!;
    expect(line.arrive).toBeUndefined();
    // And the page is never sent a word it does not know.
    expect('comes' in line).toBe(false);
  });

  test('the way a line says it comes is the way it comes when nobody asked', () => {
    const h = harness();
    h.fromPage({ type: 'hello', v: 2 });
    const stage = new NotchStage(h.surface, h.clock, 'back', { prefix: 'item', unasked: true });
    void stage.say(['3 mails while you were away.'], 4000, { comes: 'pair' });
    const line = h.shows()[0]!;
    expect(line.arrive).toBe('pair');
    expect('comes' in line).toBe(false);
  });
});

describe('every start is a different birth', () => {
  test('never the one before, whatever the dice say, and always one of the six', () => {
    for (const last of [...NOTCH_BIRTHS, null, 'nonsense', 7]) {
      for (const roll of [0, .19, .5, .99, 1, -3, 42]) {
        const born = notchBirthAfter(last, () => roll);
        expect(NOTCH_BIRTHS).toContain(born);
        expect(born).not.toBe(last);
      }
    }
  });

  test('the brain is asked which birth each time a page first appears, and falls back when the answer is not one', () => {
    const h = harness();
    const asked: number[] = [];
    h.surface.setBirths(() => { asked.push(asked.length); return asked.length === 1 ? 'gather' : ('nonsense' as 'run'); });
    h.fromPage({ type: 'hello', v: 2 }, 'pc');
    h.fromPage({ type: 'hello', v: 2 }, 'laptop');
    // A page that comes back is not born again.
    h.fromPage({ type: 'hello', v: 2 }, 'pc');
    const born = h.pushed.filter((m): m is Extract<NotchToPage, { type: 'state' }> => m.type === 'state').map((m) => m.born);
    expect(born).toEqual(['gather', 'run', undefined]);
    expect(asked.length).toBe(2);
  });
});

describe('its small sounds are the person\'s choice, and are kept', () => {
  test('a change is told at once, and a page that comes up later is told with everything else', () => {
    const h = harness();
    h.fromPage({ type: 'hello', v: 2 });
    h.surface.setSound(true);
    h.surface.setSound(true);
    expect(h.pushed.flatMap((m) => (m.type === 'patch' && m.sound !== undefined ? [{ sound: m.sound }] : []))).toEqual([{ sound: true }]);
    h.fromPage({ type: 'hello', v: 2 }, 'laptop');
    expect(h.pushed.at(-1)).toMatchObject({ type: 'state', sound: true });
    h.surface.setSound(false);
    h.fromPage({ type: 'hello', v: 2 }, 'third');
    expect('sound' in (h.pushed.at(-1) as object)).toBe(false);
  });
});

describe('yes at rest', () => {
  test('when it starts a round the yes is seen: a nod', async () => {
    const h = harness();
    h.fromPage({ type: 'hello', v: 2 });
    const inbox = new NotchInbox(h.surface, { clock: h.clock, log: () => {} });
    inbox.add({ id: 'a', subject: 'a', class: 'rest', title: () => ['One thing.'], play: async (stage) => { await stage.offer(['One thing.'], 'ok'); return 'settled'; } });
    await settle();
    expect(h.acts()).toEqual([]);
    h.fromPage({ type: 'open' });
    await settle();
    expect(h.acts()).toEqual([{ gesture: 'nodg', kick: 240 }]);
    // Asked for: it is just there.
    expect(h.shows().at(-1)!.arrive).toBeUndefined();
  });

  test('with nothing waiting there is nothing to nod at', async () => {
    const h = harness();
    h.fromPage({ type: 'hello', v: 2 });
    new NotchInbox(h.surface, { clock: h.clock, log: () => {} });
    h.fromPage({ type: 'open' });
    await settle();
    expect(h.acts()).toEqual([]);
  });
});

describe('the lip leans toward the thing it points at', () => {
  const window = { x: 0, w: 2000 };
  test('left end for a thing on the left, right end for one on the right, and in between only near the middle', () => {
    expect(pointAim({ x: 100, w: 40 }, window)).toBe(.14);
    expect(pointAim({ x: 1800, w: 40 }, window)).toBe(.86);
    expect(pointAim({ x: 980, w: 40 }, window)).toBe(.5);
    const near = pointAim({ x: 1040, w: 40 }, window);
    expect(near).toBeGreaterThan(.5);
    expect(near).toBeLessThan(.86);
  });

  test('with no window to go by, or nonsense, it reaches from the middle', () => {
    expect(pointAim({ x: 100, w: 40 }, null)).toBe(.5);
    expect(pointAim({ x: 100, w: 40 }, { x: 0, w: 0 })).toBe(.5);
    expect(pointAim({ x: Number.NaN, w: 40 }, window)).toBe(.5);
  });
});
