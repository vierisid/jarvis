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

// What is going out is on the notch while its fuse burns, and the proof that it was seen is
// positive: a page's word that the fuse ran out is not enough without its word that it drew the
// letter. A page loaded before the brain was updated draws none, and says "done" all the same.
describe('a fuse with a letter under it', () => {
  const LETTER = [{ kind: 'paper' as const, lines: [['Hi Leo,']] }];
  const ID = 't-test-1';
  const begin = () => { const h = stageOf(); return { ...h, letter: h.stage.letter(['Offering'], 8000, LETTER) }; };
  const done = (seen?: unknown) => ({ type: 'answer' as const, id: ID, act: 'done' as const, ...(seen === undefined ? {} : { seen: seen as boolean }) });

  test('goes only on a page saying it ran out and that the letter was seen', async () => {
    const h = begin();
    expect(h.stage.burning()).toBe(true);
    h.stage.heard(done(true));
    expect(await state(h.letter)).toBe('resolved');
    expect(await h.letter).toBe('done');
    expect(h.stage.burning()).toBe(false);
  });

  test('a page saying only that it ran out does not end it: it is unseen when the time is up, and not before', async () => {
    const h = begin();
    h.advance(8000);
    h.stage.heard(done());
    expect(await state(h.letter)).toBe('pending');
    h.advance(1499);
    expect(await state(h.letter)).toBe('pending');
    h.advance(1);
    expect(await h.letter).toBe('unseen');
  });

  test('after such a page, another can still vouch, or take it back', async () => {
    const vouched = begin();
    vouched.stage.heard(done());
    vouched.stage.heard(done(true));
    expect(await vouched.letter).toBe('done');

    const undone = begin();
    undone.stage.heard(done());
    undone.stage.heard({ type: 'answer', id: ID, act: 'undo' });
    expect(await undone.letter).toBe('undo');
  });

  test('an undo before anything else is an undo, and a word that it was seen afterwards changes nothing', async () => {
    const h = begin();
    h.stage.heard({ type: 'answer', id: ID, act: 'undo' });
    h.stage.heard(done(true));
    expect(await h.letter).toBe('undo');
  });

  test('no page saying anything is lost, not unseen', async () => {
    const h = begin();
    h.advance(9500);
    expect(await h.letter).toBe('lost');
  });

  test('the stage ending in the middle of it fails it, like any wait', async () => {
    const h = begin();
    h.stage.stop();
    expect(await state(h.letter)).toBe('ended');
  });

  test('a fuse with no letter goes on the word that it ran out, as it always did', async () => {
    const h = stageOf();
    const fuse = h.stage.fuse(['Sending'], 5000);
    h.stage.heard(done());
    expect(await fuse).toBe('done');
  });
});

// Fix 05: what is written down of a yes says how it was given. An answer in words (./said.ts) is handed to
// the script as if a page had sent it, so the stage is what knows the difference.
describe('how the last answer was given', () => {
  function shownStage() {
    let current: unknown = null;
    const surface = { show: (line: unknown) => { current = line; }, update: () => {}, current: () => ({ line: current, count: 0 }) } as unknown as NotchSurface;
    const clock: NotchClock = { setTimeout: () => 0, clearTimeout: () => {} };
    return new NotchStage(surface, clock, 'test', { prefix: 't' });
  }

  test('an answer a page sent is by key, and it is so before any answer', async () => {
    const stage = shownStage();
    expect(stage.answeredHow()).toBe('key');
    const offer = stage.offer(['Send it?'], 'send');
    stage.heard({ type: 'answer', id: 't-test-1', act: 'yes' });
    expect((await offer).act).toBe('yes');
    expect(stage.answeredHow()).toBe('key');
  });

  test('an answer given in words before the line came back is said, and the next one a page sends is by key again', async () => {
    const stage = shownStage();
    stage.expectSaid('offer|Send it?|', [{ act: 'yes' }]);
    const offer = await stage.offer(['Send it?'], 'send');
    expect(offer.act).toBe('yes');
    expect(stage.answeredHow()).toBe('said');
    // The fuse that follows is answered by the page: read after it, the yes would read as a key.
    const fuse = stage.fuse(['Sending...'], 3000);
    stage.heard({ type: 'answer', id: 't-test-2', act: 'done' });
    expect(await fuse).toBe('done');
    expect(stage.answeredHow()).toBe('key');
  });

  test('an answer that arrived before the script asked for it is by key', async () => {
    const stage = shownStage();
    stage.heard({ type: 'answer', id: 't-test-1', act: 'yes' });
    expect((await stage.offer(['Send it?'], 'send')).act).toBe('yes');
    expect(stage.answeredHow()).toBe('key');
  });
});
