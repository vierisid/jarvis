/**
 * The one road after a yes (./decide.ts): held, the look, the fuse, the act,
 * and the one entry of what came of it. What each feature asks is its own;
 * these hold the road itself, the rules every feature's tests hold too.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { attachNotchActions, type NotchActionAsked, type NotchActionEntry, type NotchActionOutcome } from './actions.ts';
import { playDecidable, playSend, type NotchDecidable } from './decide.ts';
import { NotchStage, NotchStageEnded, type NotchClock } from './stage.ts';
import type { NotchSurface } from './surface.ts';
import type { NotchLine } from './protocol.ts';

function harness() {
  const timers: { fn: () => void; at: number }[] = [];
  let now = 0;
  const clock: NotchClock = {
    setTimeout: (fn, ms) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const shown: NotchLine[] = [];
  const surface = { show: (line: NotchLine) => { shown.push(line); }, update: () => {}, current: () => ({ line: shown.at(-1) ?? null, count: 0 }) } as unknown as NotchSurface;
  const stage = new NotchStage(surface, clock, 'test', { prefix: 't' });
  const advance = (ms: number): void => {
    now += ms;
    for (const timer of [...timers].filter((entry) => entry.at <= now)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); }
  };
  const actions = attachNotchActions(new Database(':memory:'), { log: () => {} });
  /** The page answers the line now on the notch. */
  const page = (act: 'done' | 'undo', more: { seen?: boolean } = {}): void => stage.heard({ type: 'answer', id: shown.at(-1)!.id, act, ...more } as never);
  return { stage, advance, shown, actions, page };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

const entry = (outcome: NotchActionOutcome, asked: NotchActionAsked): NotchActionEntry => ({ kind: 'people_tell', ref: 'tell:1', what: 'Message to Leo', target: 'Leo', asked, outcome });

/** A decidable whose act counts its runs and says `outcome`. */
function item(over: Partial<NotchDecidable<string, string>> = {}, outcome: NotchActionOutcome | null = 'done') {
  const ran = { n: 0 };
  const it: NotchDecidable<string, string> = {
    asked: { seen: 'line', how: 'said' },
    fuse: { say: ['Telling Leo...'], ms: 3000 },
    act: async () => { ran.n++; return { outcome, result: 'acted' }; },
    entry,
    ...over,
  };
  return { it, ran };
}

describe('after a yes', () => {
  test('a fuse seen to burn out lets it act, and one entry says what came of it, with the fuse it burnt', async () => {
    const h = harness();
    const { it, ran } = item();
    const played = playDecidable(h.stage, it, { actions: h.actions });
    await settle();
    expect(h.shown.at(-1)).toMatchObject({ kind: 'send', ms: 3000 });
    expect(ran.n).toBe(0);
    h.page('done');
    expect(await played).toEqual({ took: 'acted', fuse: 'done', result: 'acted' });
    expect(ran.n).toBe(1);
    expect(h.actions.since(0)).toMatchObject([{ kind: 'people_tell', outcome: 'done', seen: 'line', how: 'said', fuseMs: 3000, ref: 'tell:1' }]);
  });

  test('taken back with Esc: nothing is done and nothing is written', async () => {
    const h = harness();
    const { it, ran } = item();
    const played = playDecidable(h.stage, it, { actions: h.actions });
    await settle();
    h.page('undo');
    expect(await played).toEqual({ took: 'undo' });
    expect(ran.n).toBe(0);
    expect(h.actions.since(0)).toEqual([]);
  });

  test('a fuse nobody saw burn out decides nothing', async () => {
    const h = harness();
    const { it, ran } = item();
    const played = playDecidable(h.stage, it, { actions: h.actions });
    await settle();
    h.advance(3000 + 1500);
    expect(await played).toEqual({ took: 'lost' });
    expect(ran.n).toBe(0);
    expect(h.actions.since(0)).toEqual([]);
  });

  test('a letter goes only on a page that says it was seen: one that ran out without vouching is unseen', async () => {
    const h = harness();
    const { it, ran } = item({ fuse: { say: ['Offering Tue 10:00...'], ms: 8000, letter: [{ kind: 'paper', lines: [['Hi Anna']] }] } });
    const played = playDecidable(h.stage, it, { actions: h.actions });
    await settle();
    expect(h.shown.at(-1)).toMatchObject({ kind: 'send', ms: 8000, blocks: [{ kind: 'paper' }] });
    h.page('done');
    await settle();
    h.advance(8000 + 1500);
    expect(await played).toEqual({ took: 'unseen' });
    expect(ran.n).toBe(0);
    expect(h.actions.since(0)).toEqual([]);

    const vouched = harness();
    const second = item({ fuse: { say: ['Offering Tue 10:00...'], ms: 8000, letter: [{ kind: 'paper', lines: [['Hi Anna']] }] } });
    const went = playDecidable(vouched.stage, second.it, { actions: vouched.actions });
    await settle();
    vouched.page('done', { seen: true });
    expect(await went).toMatchObject({ took: 'acted', fuse: 'done' });
    expect(vouched.actions.since(0)).toMatchObject([{ fuseMs: 8000 }]);
  });

  test('held (everything is stopped): no fuse burns, nothing is done or written', async () => {
    const h = harness();
    const { it, ran } = item({ held: () => 'stopped' });
    expect(await playDecidable(h.stage, it, { actions: h.actions })).toEqual({ took: 'held', held: 'stopped' });
    expect(h.shown).toEqual([]);
    expect(ran.n).toBe(0);
    expect(h.actions.since(0)).toEqual([]);
  });

  test('no longer to be done once the fuse has burnt (decided somewhere else): nothing is done or written', async () => {
    const h = harness();
    let closed = false;
    const { it, ran } = item({ still: () => (closed ? 'closed' : null) });
    const played = playDecidable(h.stage, it, { actions: h.actions });
    await settle();
    closed = true;
    h.page('done');
    expect(await played).toEqual({ took: 'held', held: 'closed' });
    expect(ran.n).toBe(0);
    expect(h.actions.since(0)).toEqual([]);
  });

  test('an act that says nothing of its own to write (answered elsewhere, handed on) writes nothing', async () => {
    const h = harness();
    const { it } = item({}, null);
    const played = playDecidable(h.stage, it, { actions: h.actions });
    await settle();
    h.page('done');
    expect(await played).toMatchObject({ took: 'acted' });
    expect(h.actions.since(0)).toEqual([]);
  });

  test('an act that breaks off past a burnt fuse writes what `broke` says, once, and the break goes on', async () => {
    const h = harness();
    const { it } = item({ broke: 'unsure', act: async () => { throw new Error('the tab went away'); } });
    const played = playDecidable(h.stage, it, { actions: h.actions });
    await settle();
    h.page('done');
    await expect(played).rejects.toThrow('the tab went away');
    expect(h.actions.since(0)).toMatchObject([{ outcome: 'unsure' }]);

    const quiet = harness();
    const second = item({ act: async () => { throw new NotchStageEnded(); } });
    const ended = playDecidable(quiet.stage, second.it, { actions: quiet.actions });
    await settle();
    quiet.page('done');
    await expect(ended).rejects.toBeInstanceOf(NotchStageEnded);
    expect(quiet.actions.since(0)).toEqual([]);
  });

  test('a stopped stage throws in the fuse, and nothing is done or written', async () => {
    const h = harness();
    const { it, ran } = item();
    const played = playDecidable(h.stage, it, { actions: h.actions });
    await settle();
    h.stage.stop();
    await expect(played).rejects.toBeInstanceOf(NotchStageEnded);
    expect(ran.n).toBe(0);
    expect(h.actions.since(0)).toEqual([]);
  });
});

describe('a gate burnt in the middle of the act', () => {
  test('only a gate seen to burn out lets the act write what came of it', async () => {
    for (const [answer, written] of [['done', 1], ['undo', 0]] as const) {
      const h = harness();
      let past = null as boolean | null;
      const { it } = item({
        inside: true,
        act: async (gate) => { past = await gate(); return { outcome: past ? 'done' : 'not_done', result: 'acted' }; },
      });
      const played = playDecidable(h.stage, it, { actions: h.actions });
      await settle();
      h.page(answer);
      expect(await played).toEqual({ took: 'acted', fuse: answer, result: 'acted' });
      expect(past).toBe(answer === 'done');
      expect(h.actions.since(0)).toHaveLength(written);
    }
  });

  test('an act that ends before its gate (it could not be written) writes nothing', async () => {
    const h = harness();
    const { it } = item({ inside: true, act: async () => ({ outcome: 'not_done', result: 'refused' }) });
    expect(await playDecidable(h.stage, it, { actions: h.actions })).toEqual({ took: 'acted', fuse: 'lost', result: 'refused' });
    expect(h.actions.since(0)).toEqual([]);
  });
});

describe('an earlier try that may have gone', () => {
  test('is looked for before any fuse: found, the entry that said "may have gone" says it went, and nothing is done again', async () => {
    const h = harness();
    h.actions.record(entry('unsure', { seen: 'line', how: 'said', fuseMs: 3000 }));
    const { it, ran } = item({ look: { went: async () => true } });
    expect(await playDecidable(h.stage, it, { actions: h.actions })).toEqual({ took: 'found' });
    expect(h.shown.map((line) => line.kind)).toEqual(['work']);
    expect(ran.n).toBe(0);
    expect(h.actions.since(0)).toMatchObject([{ outcome: 'done', ref: 'tell:1' }]);
  });

  test('found with no entry written for it (its write had failed): it is written now, once', async () => {
    const h = harness();
    const { it } = item({ asked: { seen: 'sheet', how: 'key' }, look: { went: async () => true } });
    await playDecidable(h.stage, it, { actions: h.actions });
    expect(h.actions.since(0)).toMatchObject([{ outcome: 'done', ref: 'tell:1', seen: 'sheet', how: 'key' }]);
  });

  test('not known whether it went (or the look broke): nothing is sent again', async () => {
    for (const went of [async () => null, async () => { throw new Error('no mailbox'); }]) {
      const h = harness();
      const { it, ran } = item({ look: { went } });
      expect(await playDecidable(h.stage, it, { actions: h.actions })).toEqual({ took: 'unknown' });
      expect(ran.n).toBe(0);
      expect(h.shown.some((line) => line.kind === 'send')).toBe(false);
    }
  });

  test('a stage that ends while it is looked for ends the road there: it is not read as "not known"', async () => {
    const h = harness();
    const { it, ran } = item({ look: { went: async () => { throw new NotchStageEnded(); } } });
    await expect(playDecidable(h.stage, it, { actions: h.actions })).rejects.toBeInstanceOf(NotchStageEnded);
    expect(ran.n).toBe(0);
  });

  test('not there: the fuse burns and it goes as any other', async () => {
    const h = harness();
    const { it, ran } = item({ look: { went: async () => false } });
    const played = playDecidable(h.stage, it, { actions: h.actions });
    await settle();
    h.page('done');
    expect(await played).toMatchObject({ took: 'acted' });
    expect(ran.n).toBe(1);
  });

  test('closed while it was looked for: nothing is written, however the look ended', async () => {
    const h = harness();
    const { it } = item({ look: { went: async () => true }, still: () => 'closed' });
    expect(await playDecidable(h.stage, it, { actions: h.actions })).toEqual({ took: 'held', held: 'closed' });
    expect(h.actions.since(0)).toEqual([]);
  });
});

describe('something sent to somebody on a word', () => {
  const send = (go: () => Promise<{ ok: boolean; why?: string }>, how?: 'pick') => ({
    say: ['Telling Leo...'], ms: 3000, back: ['Taken back. Nothing was sent.'], kind: 'people_tell' as const, what: 'Message to Leo', target: 'Leo', go, ...(how ? { how } : {}),
  });

  test('goes past its fuse, and one entry says what came of it: a line broken while it went may have gone', async () => {
    for (const [answer, outcome] of [[{ ok: true }, 'done'], [{ ok: false, why: 'down' }, 'not_done'], [{ ok: false, why: 'unknown' }, 'unsure']] as const) {
      const h = harness();
      const played = playSend(h.stage, send(async () => answer, 'pick'), { actions: h.actions });
      await settle();
      h.page('done');
      expect(await played).toEqual(answer);
      expect(h.actions.since(0)).toMatchObject([{ kind: 'people_tell', outcome, seen: 'line', how: 'pick', fuseMs: 3000, target: 'Leo' }]);
    }
  });

  test('taken back, it says so and nothing goes; nobody saw it, nothing is said and nothing goes', async () => {
    const h = harness();
    let went = 0;
    const back = playSend(h.stage, send(async () => { went++; return { ok: true }; }), { actions: h.actions });
    await settle();
    h.page('undo');
    await settle();
    expect(h.shown.at(-1)).toMatchObject({ kind: 'say', say: ['Taken back. Nothing was sent.'] });
    h.advance(5000);
    expect(await back).toBeNull();

    const lost = playSend(h.stage, send(async () => { went++; return { ok: true }; }), { actions: h.actions });
    await settle();
    const before = h.shown.length;
    h.advance(3000 + 1500);
    expect(await lost).toBeNull();
    expect(h.shown.length).toBe(before);
    expect(went).toBe(0);
    expect(h.actions.since(0)).toEqual([]);
  });
});
