/**
 * A stage that has ended fails every wait a script is in, a wait for time
 * included. It did not: the timer was cleared and nothing failed the wait,
 * so a script that was waiting for time never came back. Whatever it held (a
 * browser tab's turn, a thread kept from the watcher) was held until the
 * brain was started again, and what it was about to write down was lost.
 */
import { describe, expect, test } from 'bun:test';
import { NotchStage, NotchStageEnded, type NotchClock } from './stage.ts';
import type { NotchSurface } from './surface.ts';

function stageOf() {
  const timers: { fn: () => void; at: number }[] = [];
  let now = 0;
  const clock: NotchClock = {
    setTimeout: (fn, ms) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const shown: unknown[] = [];
  const surface = { show: (line: unknown) => { shown.push(line); }, update: () => {}, current: () => ({ line: null, count: 0 }) } as unknown as NotchSurface;
  const stage = new NotchStage(surface, clock, 'test', { prefix: 't' });
  const advance = (ms: number): void => {
    now += ms;
    for (const timer of [...timers].filter((entry) => entry.at <= now)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); }
  };
  return { stage, advance, timers };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
/** How a promise stands after everything that is due has run. */
const state = async (promise: Promise<unknown>): Promise<string> => {
  let is = 'pending';
  promise.then(() => { is = 'resolved'; }, (error: unknown) => { is = error instanceof NotchStageEnded ? 'ended' : 'failed'; });
  await settle();
  return is;
};

describe('a wait for time on a stage', () => {
  test('comes back when its time is up', async () => {
    const h = stageOf();
    const wait = h.stage.wait(500);
    h.advance(499);
    expect(await state(wait)).toBe('pending');
    h.advance(1);
    expect(await state(wait)).toBe('resolved');
  });

  test('fails with the stage-ended error when the stage ends in the middle of it, and leaves no timer behind', async () => {
    const h = stageOf();
    const first = h.stage.wait(500);
    const second = h.stage.wait(9000);
    h.stage.stop();
    expect(await state(first)).toBe('ended');
    expect(await state(second)).toBe('ended');
    expect(h.timers).toEqual([]);
    // Its time coming round afterwards changes nothing.
    h.advance(10_000);
    expect(await state(first)).toBe('ended');
  });

  test('entered after the stage ended, it fails at once', async () => {
    const h = stageOf();
    h.stage.stop();
    expect(await state(h.stage.wait(500))).toBe('ended');
  });

  test('a wait that was over before the stage ended is not failed afterwards', async () => {
    const h = stageOf();
    const wait = h.stage.wait(100);
    h.advance(100);
    h.stage.stop();
    expect(await state(wait)).toBe('resolved');
  });

  test('a script that waits for time between two things ends there, and what it holds is let go', async () => {
    const h = stageOf();
    let held = true;
    const script = (async () => { try { await h.stage.wait(1500); return 'went on'; } finally { held = false; } })();
    h.stage.stop();
    expect(await state(script)).toBe('ended');
    expect(held).toBe(false);
  });

  test('work in steps ends when the stage does, and a result that had left does not fail anything later', async () => {
    const h = stageOf();
    const work = h.stage.work(['Pasting'], 5, 1000);
    h.advance(1000);
    // A result whose page answered: its own wait for time is left behind, and must not be an unhandled failure.
    const said = h.stage.say(['Done.'], 2000);
    h.stage.heard({ type: 'answer', id: 't-test-2', act: 'done' });
    expect(await state(said)).toBe('resolved');
    h.stage.stop();
    expect(await state(work)).toBe('ended');
  });
});
