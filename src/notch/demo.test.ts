import { describe, expect, test } from 'bun:test';
import { createNotchDemo } from './demo.ts';
import type { NotchDemoClock } from './demo.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';
import type { NotchLine, NotchPart, NotchToPage } from './protocol.ts';

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: NotchDemoClock = {
    setTimeout(fn, ms) { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(handle) { timers.delete(handle as number); },
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(id); timer.fn(); }
    }
  };
  return { clock, advance };
}

/** Lets every promise that can settle, settle. */
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness(options: { real?: boolean; onEnd?: () => void } = {}) {
  const pushed: NotchToPage[] = [];
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) {
      pushed.push((params as { message: NotchToPage }).message);
      return Promise.resolve({ pushed: true });
    },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const logs: string[] = [];
  const surface = new NotchSurface(port, (line) => logs.push(line));
  const { clock, advance } = fakeClock();
  const demo = createNotchDemo(surface, { clock, log: (line) => logs.push(line), ...options });
  const say = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  say({ type: 'hello', v: 1 });
  pushed.length = 0;
  const shown = (): NotchLine[] => pushed.flatMap((m) => (m.type === 'show' ? [m.line] : []));
  return { demo, surface, pushed, logs, say, advance, shown };
}

describe('the demo plays through the real path', () => {
  test('an unknown moment is refused and nothing is shown', () => {
    const h = harness();
    expect(h.demo.play('nothing-by-this-name')).toBe(false);
    expect(h.demo.play('constructor')).toBe(false);
    expect(h.pushed).toEqual([]);
    expect(h.demo.running()).toBeNull();
  });

  test('choices, a pick, a send that runs out, and the result', async () => {
    const h = harness();
    expect(h.demo.play('slot')).toBe(true);
    expect(h.demo.running()).toBe('slot');
    await settle();
    const offer = h.shown().at(-1)!;
    expect(offer.kind).toBe('offer');
    expect(offer.kind === 'offer' && offer.options).toEqual(['Thursday at 15:00', 'Friday at 10:00', 'Monday at 9:30']);

    h.say({ type: 'answer', id: offer.id, act: 'pick', option: 'Friday at 10:00', index: 1 });
    await settle();
    const send = h.shown().at(-1)!;
    expect(send.kind).toBe('send');
    expect(JSON.stringify(send.say)).toContain('Friday at 10:00');

    h.say({ type: 'answer', id: send.id, act: 'done' });
    await settle();
    const result = h.shown().at(-1)!;
    expect(result.kind).toBe('say');
    expect(result.mark).toBe('check');

    h.say({ type: 'answer', id: result.id, act: 'done' });
    await settle();
    expect(h.demo.running()).toBeNull();
    expect(h.surface.current().line).toBeNull();
  });

  test('a send that is taken back is not reported as sent', async () => {
    const h = harness();
    h.demo.play('slot');
    await settle();
    const offer = h.shown().at(-1)!;
    h.say({ type: 'answer', id: offer.id, act: 'pick', option: 'Monday at 9:30', index: 2 });
    await settle();
    h.say({ type: 'answer', id: h.shown().at(-1)!.id, act: 'undo' });
    await settle();
    expect(JSON.stringify(h.shown().at(-1)!.say)).toContain('Nothing was offered');
  });

  test('turning an offer down ends the moment', async () => {
    const h = harness();
    h.demo.play('fail');
    await settle();
    const offer = h.shown().at(-1)!;
    expect(offer.who).toBe('Otto');
    expect(offer.mark).toBe('fail');
    h.say({ type: 'answer', id: offer.id, act: 'no' });
    await settle();
    expect(h.demo.running()).toBeNull();
    expect(h.shown().length).toBe(1);
  });

  test('work moves on step by step, and stops where it is asked to', async () => {
    const h = harness();
    h.demo.play('sheets');
    await settle();
    h.say({ type: 'answer', id: h.shown().at(-1)!.id, act: 'yes' });
    await settle();
    const work = h.shown().at(-1)!;
    expect(work.kind === 'work' && [work.steps, work.done]).toEqual([9, 0]);
    for (let i = 0; i < 3; i++) { h.advance(520); await settle(); }
    const updates = h.pushed.flatMap((m) => (m.type === 'update' && m.id === work.id ? [m.done] : []));
    expect(updates).toEqual([1, 2, 3]);
    h.say({ type: 'answer', id: work.id, act: 'stop' });
    await settle();
    h.advance(520);
    await settle();
    const stopped = h.shown().at(-1)!;
    expect(stopped.kind === 'offer' && stopped.options).toEqual(['Go on', 'Undo it', 'Leave it']);
    expect(JSON.stringify(stopped.say)).toContain('3 of 9');
  });

  test('a sheet changes in place when one of its buttons is pressed', async () => {
    const h = harness();
    h.demo.play('morning');
    await settle();
    h.advance(1400);
    await settle();
    expect(h.surface.current().count).toBe(2);
    h.say({ type: 'answer', id: h.shown().at(-1)!.id, act: 'yes' });
    await settle();
    const sheet = h.shown().at(-1)!;
    expect(sheet.kind).toBe('sheet');
    h.say({ type: 'answer', id: sheet.id, act: 'word', word: 'day', value: 'Monday' });
    h.say({ type: 'answer', id: sheet.id, act: 'button', button: 'pay', row: 'pay' });
    await settle();
    const update = h.pushed.findLast((m) => m.type === 'update' && m.id === sheet.id);
    expect(JSON.stringify(update)).toContain('on Monday. You get the receipt.');
    expect(h.surface.current().count).toBe(1);
    // Still the same sheet: nothing new was shown.
    expect(h.shown().at(-1)!.id).toBe(sheet.id);
  });

  test('a sheet can open another, and closing that one goes back', async () => {
    const h = harness();
    h.demo.play('home');
    await settle();
    const home = h.shown().at(-1)!;
    expect(home.kind).toBe('ask');
    h.say({ type: 'answer', id: home.id, act: 'button', button: 'memory' });
    await settle();
    const memory = h.shown().at(-1)!;
    // Long enough to need scrolling: that is what it is there to try.
    expect(memory.kind === 'sheet' && memory.blocks.length).toBeGreaterThan(20);
    h.say({ type: 'answer', id: memory.id, act: 'no' });
    await settle();
    const back = h.shown().at(-1)!;
    expect(back.kind).toBe('ask');
    expect(back.id).not.toBe(home.id);
    expect(h.demo.running()).toBe('home');
  });

  test('a moment that is replaced says nothing more', async () => {
    const h = harness();
    h.demo.play('mail');
    await settle();
    const old = h.shown().at(-1)!;
    h.demo.play('slot');
    await settle();
    const before = h.shown().length;
    h.say({ type: 'answer', id: old.id, act: 'yes' });
    h.advance(60_000);
    await settle();
    expect(h.shown().length).toBe(before);
    expect(h.demo.running()).toBe('slot');
  });

  test('yes with nothing on the notch opens Jarvis; a moment waiting for it gets it instead', async () => {
    const h = harness();
    h.say({ type: 'open' });
    await settle();
    expect(h.demo.running()).toBe('home');
    expect(h.shown().at(-1)!.kind).toBe('ask');
  });

  test('Esc twice stops whatever is playing, and nothing runs until woken', async () => {
    const h = harness();
    h.demo.play('sheets');
    await settle();
    h.say({ type: 'answer', id: h.shown().at(-1)!.id, act: 'yes' });
    await settle();
    expect(h.shown().at(-1)!.kind).toBe('work');
    h.say({ type: 'stop' });
    await settle();
    const stopped = h.shown().at(-1)!;
    expect(h.demo.running()).toBe('stopped');
    expect(JSON.stringify(stopped.say)).toContain('Everything is stopped');
    expect(stopped.kind === 'offer' && [stopped.yes, stopped.fold]).toEqual(['wake', 0]);
    // The work that was going on says nothing more.
    const before = h.pushed.length;
    h.advance(30_000);
    await settle();
    expect(h.pushed.length).toBe(before);
    h.say({ type: 'answer', id: stopped.id, act: 'yes' });
    await settle();
    expect(JSON.stringify(h.shown().at(-1)!.say)).toContain('Awake');
  });

  test('"stopped" is where Esc twice leads, not a moment to pick from the list', () => {
    const h = harness();
    expect(h.demo.names()).not.toContain('stopped');
    expect(h.demo.names()).toContain('morning');
  });

  test('stop rests the notch and nothing follows', async () => {
    const h = harness();
    h.demo.play('quiet');
    await settle();
    h.demo.stop();
    await settle();
    const count = h.pushed.length;
    expect(h.pushed.at(-1)).toEqual({ type: 'rest' });
    h.advance(60_000);
    await settle();
    expect(h.pushed.length).toBe(count);
    expect(h.logs.filter((line) => line.includes('failed'))).toEqual([]);
  });
});

/** Every lit word in a line, wherever it stands. */
function words(line: NotchLine): string[] {
  const out: string[] = [];
  const inParts = (parts: NotchPart[] | undefined): void => {
    for (const part of parts ?? []) if (typeof part === 'object' && 'word' in part) out.push(part.word.name);
  };
  inParts(line.say);
  if (line.kind === 'sheet' || line.kind === 'ask') {
    for (const block of line.blocks) {
      if (block.kind === 'row' || block.kind === 'note') inParts(block.say);
      if (block.kind === 'paper') { inParts(block.to); block.lines.forEach(inParts); }
    }
  }
  return out;
}

describe('every moment', () => {
  // Plays each moment to its end with a stand-in person who agrees to
  // everything, and holds what was shown to the rules the page relies on.
  const names = createNotchDemo(new NotchSurface({
    dispatchRPC: () => Promise.resolve(null), onEvent() {}, onSidecarDisconnected() {},
  })).names();

  test('there are about a dozen, each with a plain name', () => {
    expect(names.length).toBeGreaterThanOrEqual(12);
    for (const name of names) expect(name).toMatch(/^[a-z]+$/);
  });

  for (const name of names) {
    test(`"${name}" runs to its end and every line is well formed`, async () => {
      const h = harness();
      h.demo.play(name);
      const answered = new Set<string>();
      for (let step = 0; step < 4000 && h.demo.running(); step++) {
        await settle();
        const line = h.surface.current().line;
        if (line && !answered.has(line.id)) {
          answered.add(line.id);
          if (line.kind === 'say' || line.kind === 'send') h.say({ type: 'answer', id: line.id, act: 'done' });
          else if (line.kind === 'offer' && line.options) h.say({ type: 'answer', id: line.id, act: 'pick', option: line.options[0], index: 0 });
          else if (line.kind === 'offer') h.say({ type: 'answer', id: line.id, act: 'yes' });
          else if (line.kind === 'sheet') h.say({ type: 'answer', id: line.id, act: line.yes ? 'yes' : 'no' });
          else if (line.kind === 'ask') h.say({ type: 'answer', id: line.id, act: 'no' });
          continue;
        }
        // The moment may have ended while things settled: then there is
        // nothing to open, and an open now would start another.
        if (!h.demo.running()) break;
        if (!line) h.say({ type: 'open' });
        h.advance(250);
      }
      expect(h.demo.running()).toBeNull();
      expect(h.logs.filter((entry) => entry.includes('failed'))).toEqual([]);
      const lines = h.shown();
      expect(lines.length).toBeGreaterThan(0);
      expect(new Set(lines.map((line) => line.id)).size).toBe(lines.length);
      for (const line of lines) {
        expect(line.id.startsWith(`demo-${name}-`)).toBe(true);
        const named = words(line);
        expect(new Set(named).size).toBe(named.length);
        if (line.kind === 'offer') expect(Boolean(line.yes) !== Boolean(line.options?.length)).toBe(true);
        if (line.kind === 'work') expect(line.done).toBeLessThanOrEqual(line.steps);
      }
      // The notch is left at rest.
      expect(h.surface.current().line).toBeNull();
    });
  }
});

describe('beside real things', () => {
  test('yes at rest and Esc twice are not the demo\'s when real things live on the notch', async () => {
    const h = harness({ real: true });
    h.say({ type: 'open' });
    h.say({ type: 'stop' });
    await settle();
    expect(h.demo.running()).toBeNull();
    expect(h.shown()).toEqual([]);
  });

  test('Esc twice ends the moment that is playing, and says the notch is free again', async () => {
    let ended = 0;
    const h = harness({ real: true, onEnd: () => { ended++; } });
    h.demo.play('mail');
    await settle();
    expect(h.demo.running()).toBe('mail');
    h.say({ type: 'stop' });
    await settle();
    expect(h.demo.running()).toBeNull();
    expect(ended).toBe(1);
    expect(h.surface.current().line).toBeNull();
  });

  test('a moment that ends by itself says so too', async () => {
    let ended = 0;
    const h = harness({ onEnd: () => { ended++; } });
    h.demo.play('faces');
    for (let i = 0; i < 400 && h.demo.running(); i++) { h.advance(2000); await settle(); }
    expect(h.demo.running()).toBeNull();
    expect(ended).toBe(1);
  });
});
