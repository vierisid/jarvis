import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NotchInbox } from './inbox.ts';
import {
  NOTCH_ROUND_FINISH_MS, NOTCH_SECRET_STEP, NotchJobStore, attachNotchJobs, newPlacedRun, newRoundsRun, roundsPlan, roundsWords, runPlaced, runRounds, sureRounds, undoPuts,
  type PlacedStep,
  type NotchActResult, type NotchJobHands, type NotchPut, type RoundsRun,
} from './jobs.ts';
import type { NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import { findRounds, roundsApps, type Rounds, type WatchStep, type WatchWin } from './rounds.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string => (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');

const FILE: WatchWin = { id: '0x1a', pid: 100, w: 900, h: 700 };
const SHEET: WatchWin = { id: '0x2b', pid: 200, w: 1200, h: 800 };
const FILE_TOP = 200;
const FILE_STEP = 22;
const SHEET_STEP = 20;

/** The two rows the person did by hand: rows 0 and 1 of the file, into the sheet at 400 and 420. */
function shown(): Rounds {
  let at = 0;
  const steps: WatchStep[] = [];
  for (const n of [0, 1]) {
    steps.push(
      { kind: 'click', app: 'notepad', win: FILE, x: 120, y: FILE_TOP + FILE_STEP * n, at: (at += 300) },
      { kind: 'keys', app: 'notepad', win: FILE, keys: 'ctrl,c', at: (at += 300) },
      { kind: 'click', app: 'excel', win: SHEET, x: 300, y: 400 + SHEET_STEP * n, at: (at += 300) },
      { kind: 'keys', app: 'excel', win: SHEET, keys: 'ctrl,v', at: (at += 300) },
    );
  }
  return findRounds(steps)!;
}

const shape = (value: string): Pick<NotchActResult, 'empty' | 'rows' | 'cols' | 'hash'> =>
  (value.trim() ? { empty: false, rows: value.split('\n').length, cols: value.split('\n')[0]!.split('\t').length, hash: `h:${value}` } : { empty: true });

/**
 * A file of rows and a sheet, as the desktop app would act on them. It keeps
 * every request it was sent, in order, so a test can see that none was sent
 * twice.
 */
function world(rows: string[], options: { gated?: boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  const cells = new Map<number, string>();
  const pastes = new Map<number, number>();
  let clipboard = '';
  let source = -1;
  let cell = -1;
  /** What the next requests answer instead of being done: a refusal, or a throw. */
  const next: ({ why: string } | 'lost' | 'offline' | null)[] = [];
  const waiting: (() => void)[] = [];
  const respond = (request: Record<string, unknown>): NotchActResult | null => {
    const fate = next.shift() ?? null;
    if (fate === 'offline') return null;
    if (fate && fate !== 'lost') return { done: false, why: fate.why };
    const win = (request.win as WatchWin | undefined)?.id;
    if (request.do === 'click') {
      if (win === FILE.id) source = Math.round(((request.y as number) - FILE_TOP) / FILE_STEP);
      else cell = request.y as number;
      return { done: true };
    }
    if (request.do === 'copy') {
      if (win === FILE.id) { clipboard = rows[source] ?? ''; return { done: true, ...shape(clipboard) }; }
      // Read back from the sheet, with the cells to its right taken in.
      const there = cells.get(cell) ?? '';
      const right = (request.right as number | undefined) ?? 0;
      const read = there.split('\t').slice(0, right + 1).join('\t') + (right + 1 > there.split('\t').length && there ? '\tnext' : '');
      return { done: true, ...shape(read) };
    }
    if (request.do === 'keys' && request.keys === 'ctrl,v') {
      cells.set(cell, clipboard);
      pastes.set(cell, (pastes.get(cell) ?? 0) + 1);
      return { done: true };
    }
    if (request.do === 'keys' && request.keys === 'delete') { cells.delete(cell); return { done: true }; }
    return { done: true };
  };
  const hands: NotchJobHands = {
    act(request) {
      sent.push(request);
      const lost = next[0] === 'lost';
      // Sending a pointer somewhere is not a step of the job: it is answered at once.
      if (!options.gated || request.do === 'home' || request.do === 'hand') {
        if (lost) { respond(request); return Promise.reject(new Error('no answer')); }
        return Promise.resolve(respond(request));
      }
      return new Promise((resolve, reject) => {
        waiting.push(() => { const answer = respond(request); if (lost) reject(new Error('no answer')); else resolve(answer); });
      });
    },
  };
  /** Lets the next `n` requests be answered, one at a time. */
  const answer = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) { await settle(); waiting.shift()?.(); await settle(); }
  };
  return { hands, sent, cells, pastes, next, answer, waiting };
}

const noSleep = { sleep: async (): Promise<void> => {} };
const never = (): AbortSignal => new AbortController().signal;
const FIVE = ['r0', 'r1', 'a\t1', 'b\t2', 'c\t3', 'd\t4', 'e\t5'];

describe('doing the rest of a job the person began', () => {
  test('it goes on from the last round by hand, one place further each time, until there is nothing left to copy', async () => {
    const w = world(FIVE);
    const run = newRoundsRun(shown(), null);
    const end = await runRounds(run, w.hands, { signal: never(), onProgress: () => {}, ...noSleep });
    // Rows 2 to 6 of the file. The next one was empty: nothing of that round was pasted.
    expect(end).toEqual({ how: 'done', ranOut: 'empty' });
    expect(run.done).toBe(5);
    expect([...w.cells.entries()]).toEqual([[440, 'a\t1'], [460, 'b\t2'], [480, 'c\t3'], [500, 'd\t4'], [520, 'e\t5']]);
    // The first round Jarvis did: the place in the file and the place in the sheet, each one on from the person's last.
    expect(w.sent.slice(0, 4)).toEqual([
      { do: 'click', win: FILE, x: 120, y: 244, hand: 0 },
      { do: 'copy', win: FILE, keys: 'ctrl,c' },
      { do: 'click', win: SHEET, x: 300, y: 440, hand: 1 },
      { do: 'keys', win: SHEET, keys: 'ctrl,v' },
    ]);
    // The sixth round ended at its copy: a click and a copy, and no paste.
    expect(w.sent.length).toBe(5 * 4 + 2);
  });

  test('told how many, it does that many and no more', async () => {
    const w = world(FIVE);
    const run = newRoundsRun(shown(), 3);
    const progress: number[] = [];
    expect(await runRounds(run, w.hands, { signal: never(), onProgress: (done) => progress.push(done), ...noSleep })).toEqual({ how: 'done' });
    expect(progress).toEqual([1, 2, 3]);
    expect([...w.cells.keys()]).toEqual([440, 460, 480]);
  });

  test('it stops before a round that would leave a window, with nothing of that round begun', async () => {
    const w = world(Array.from({ length: 60 }, (_, i) => `row ${i}`));
    const run = newRoundsRun(shown(), null);
    const end = await runRounds(run, w.hands, { signal: never(), onProgress: () => {}, ...noSleep });
    // The sheet is 800 high: the last cell that fits is at 780, the 18th round.
    expect(end).toEqual({ how: 'done', ranOut: 'edge' });
    expect(run.done).toBe(18);
    expect(w.sent.length).toBe(18 * 4);
  });

  test('what was pasted is kept as where and how much, never as what', async () => {
    const w = world(FIVE);
    const run = newRoundsRun(shown(), 2);
    await runRounds(run, w.hands, { signal: never(), onProgress: () => {}, ...noSleep });
    expect(run.puts).toEqual([
      { win: SHEET, x: 300, y: 440, rows: 1, cols: 2, hash: 'h:a\t1', hand: 1 },
      { win: SHEET, x: 300, y: 460, rows: 1, cols: 2, hash: 'h:b\t2', hand: 1 },
    ]);
  });
});

describe('making each step exact before going on', () => {
  const measured = (answers: Record<string, NotchActResult | null | 'throws'>): { hands: NotchJobHands; asked: Record<string, unknown>[] } => {
    const asked: Record<string, unknown>[] = [];
    return {
      asked,
      hands: {
        act: async (request) => {
          asked.push(request);
          const answer = answers[(request.win as WatchWin).id];
          if (answer === 'throws') throw new Error('no answer');
          return answer ?? null;
        },
      },
    };
  };

  test('each place that moves on is measured on the screen, and what was measured is what is used', async () => {
    const m = measured({ [FILE.id]: { done: true, known: true, dy: 22.4 }, [SHEET.id]: { done: true, known: true, dy: 24.5 } });
    const sure = (await sureRounds(shown(), m.hands))!;
    expect(m.asked).toEqual([
      { do: 'pitch', win: FILE, x: 120, y: 222, dy: 22 },
      { do: 'pitch', win: SHEET, x: 300, y: 420, dy: 20 },
    ]);
    expect(sure.steps.map((step) => (step.kind === 'click' ? step.dy : null))).toEqual([22.4, null, 24.5, null]);
    // A step that stays where it is needs no measuring.
    expect(sure.steps[1]).toEqual(shown().steps[1]!);
  });

  test('where the rows cannot be seen, or what was measured does not fit what the hand did, there is no going on', async () => {
    const seen: NotchActResult = { done: true, known: true, dy: 22 };
    for (const sheet of [
      { done: true, known: false } as NotchActResult,
      { done: false, why: 'gone' } as NotchActResult,
      { done: true, known: true } as NotchActResult,                 // no distance in the answer
      { done: true, known: true, dy: -20 } as NotchActResult,        // the other way
      { done: true, known: true, dy: 61 } as NotchActResult,         // three times what the hand did
      { done: true, known: true, dy: 2 } as NotchActResult,          // no row is two pixels high
      { done: true, known: true, dy: Number.NaN } as NotchActResult,
      null, 'throws' as const,
    ]) {
      const m = measured({ [FILE.id]: seen, [SHEET.id]: sheet });
      expect(await sureRounds(shown(), m.hands)).toBeNull();
    }
  });
});

describe('taking over in the middle of a round', () => {
  // The person has already clicked the cell and has not pasted: the round, as it stands, begins with the paste.
  test('the first paste is of what the person copied, and is not written down; the ones after are', async () => {
    let at = 0;
    const steps: WatchStep[] = [];
    for (const n of [0, 1]) {
      steps.push(
        { kind: 'click', app: 'notepad', win: FILE, x: 120, y: FILE_TOP + FILE_STEP * n, at: (at += 300) },
        { kind: 'keys', app: 'notepad', win: FILE, keys: 'ctrl,c', at: (at += 300) },
        { kind: 'click', app: 'excel', win: SHEET, x: 300, y: 400 + SHEET_STEP * n, at: (at += 300) },
        { kind: 'keys', app: 'excel', win: SHEET, keys: 'ctrl,v', at: (at += 300) },
      );
    }
    // Row 2 by hand as far as the click into the sheet.
    steps.push(
      { kind: 'click', app: 'notepad', win: FILE, x: 120, y: FILE_TOP + FILE_STEP * 2, at: (at += 300) },
      { kind: 'keys', app: 'notepad', win: FILE, keys: 'ctrl,c', at: (at += 300) },
      { kind: 'click', app: 'excel', win: SHEET, x: 300, y: 400 + SHEET_STEP * 2, at: (at += 300) },
    );
    const rounds = findRounds(steps)!;
    expect(rounds.steps.map((step) => (step.kind === 'keys' ? step.keys : 'click'))).toEqual(['ctrl,v', 'click', 'ctrl,c', 'click']);
    const w = world(FIVE);
    const run = newRoundsRun(rounds, 2);
    expect(await runRounds(run, w.hands, { signal: never(), onProgress: () => {}, ...noSleep })).toEqual({ how: 'done' });
    // Its first step is the paste the person was about to make.
    expect(w.sent[0]).toEqual({ do: 'keys', win: SHEET, keys: 'ctrl,v' });
    // Only the second paste is Jarvis's own copy, and it went where the round before ended: the cell after the person's.
    expect(run.puts).toEqual([{ win: SHEET, x: 300, y: 460, rows: 1, cols: 2, hash: 'h:b\t2', hand: 1 }]);
  });
});

describe('stopping, and going on', () => {
  // The plan's test: "Esc at four. Go on. It finishes, and no row is there twice."
  test('a stop lands between two rounds, and going on does every row exactly once', async () => {
    const w = world(FIVE);
    const run = newRoundsRun(shown(), 5);
    const stop = new AbortController();
    const first = await runRounds(run, w.hands, { signal: stop.signal, onProgress: (done) => { if (done === 2) stop.abort(); }, ...noSleep });
    expect(first).toEqual({ how: 'stopped' });
    expect(run.done).toBe(2);
    expect(run.step).toBe(0);
    const second = await runRounds(run, w.hands, { signal: never(), onProgress: () => {}, ...noSleep });
    expect(second).toEqual({ how: 'done' });
    expect(run.done).toBe(5);
    expect([...w.pastes.values()]).toEqual([1, 1, 1, 1, 1]);
    expect(w.sent.length).toBe(5 * 4);
  });

  test('a stop asked in the middle of a round lets that round finish: a row is whole or not begun', async () => {
    const w = world(FIVE);
    const run = newRoundsRun(shown(), 5);
    const stop = new AbortController();
    const hands: NotchJobHands = { act: (request) => { if (w.sent.length === 5) stop.abort(); return w.hands.act(request); } };
    // Asked during the second round's copy.
    expect(await runRounds(run, hands, { signal: stop.signal, onProgress: () => {}, ...noSleep })).toEqual({ how: 'stopped' });
    expect(run.done).toBe(2);
    expect([...w.cells.keys()]).toEqual([440, 460]);
  });

  test('a round that cannot be finished in time is left where it is, and going on takes it up at that step', async () => {
    const w = world(FIVE);
    const run = newRoundsRun(shown(), 5);
    const stop = new AbortController();
    let now = 0;
    const hands: NotchJobHands = {
      act: (request) => {
        // Stop is asked during the first step, and every step after takes two seconds.
        if (w.sent.length === 0) stop.abort();
        now += 2000;
        return w.hands.act(request);
      },
    };
    const end = await runRounds(run, hands, { signal: stop.signal, onProgress: () => {}, now: () => now, ...noSleep });
    expect(end).toEqual({ how: 'stopped' });
    expect(run.done).toBe(0);
    // The stop was seen after the first step. Two more steps fit in its three seconds; the fourth does not.
    expect(NOTCH_ROUND_FINISH_MS).toBe(3000);
    expect(run.step).toBe(3);
    expect(w.sent.length).toBe(3);
    await runRounds(run, w.hands, { signal: never(), onProgress: () => {}, ...noSleep });
    // The first three steps of that round were not sent a second time.
    expect(w.sent.filter((request) => request.do === 'click' && (request.win as WatchWin).id === FILE.id && request.y === 244).length).toBe(1);
    expect([...w.pastes.values()]).toEqual([1, 1, 1, 1, 1]);
  });

  test('a step that was refused did not happen: going on tries that step, and only that one, again', async () => {
    const w = world(FIVE);
    const run = newRoundsRun(shown(), 3);
    // The third request (the click into the sheet) finds another window in the way.
    w.next.push(null, null, { why: 'covered' });
    const end = await runRounds(run, w.hands, { signal: never(), onProgress: () => {}, ...noSleep });
    expect(end).toEqual({ how: 'failed', why: 'Another window is in the way.' });
    expect(run.done).toBe(0);
    expect(run.step).toBe(2);
    expect(w.cells.size).toBe(0);
    expect(await runRounds(run, w.hands, { signal: never(), onProgress: () => {}, ...noSleep })).toEqual({ how: 'done' });
    expect([...w.pastes.values()]).toEqual([1, 1, 1]);
    // The copy before it was not made again.
    expect(w.sent.filter((request) => request.do === 'copy').length).toBe(3);
  });

  // Said once, done once: a step that may have happened is never sent again.
  test('a step whose answer never came may have happened: it is not sent again', async () => {
    const w = world(FIVE);
    const run = newRoundsRun(shown(), 2);
    // The paste of the first round is done on the machine, and its answer is lost.
    w.next.push(null, null, null, 'lost');
    const end = await runRounds(run, w.hands, { signal: never(), onProgress: () => {}, ...noSleep });
    expect(end).toEqual({ how: 'failed', why: 'I lost touch with your computer in the middle of a step.', unsure: true });
    expect(w.cells.get(440)).toBe('a\t1');
    // Going on starts after it.
    expect(run.step).toBe(4);
    expect(await runRounds(run, w.hands, { signal: never(), onProgress: () => {}, ...noSleep })).toEqual({ how: 'done' });
    expect(w.pastes.get(440)).toBe(1);
    expect(w.pastes.get(460)).toBe(1);
  });

  test('with no computer to ask, nothing is done and it says so', async () => {
    const w = world(FIVE);
    const run = newRoundsRun(shown(), 2);
    w.next.push('offline');
    expect(await runRounds(run, w.hands, { signal: never(), onProgress: () => {}, ...noSleep })).toEqual({ how: 'failed', why: 'Your computer is not connected.' });
    expect(run.step).toBe(0);
  });
});

describe('a shown job done again by place', () => {
  const EDIT: WatchWin = { id: '0x51', pid: 900, w: 800, h: 600 };
  const NOW: WatchWin = { id: '0x9c', pid: 1200, w: 800, h: 600 };
  const steps: PlacedStep[] = [
    { kind: 'click', app: 'TextEdit', win: EDIT, x: 40, y: 12 },
    { kind: 'keys', app: 'TextEdit', win: EDIT, keys: 'cmd,s' },
    { kind: 'type', app: 'TextEdit', win: EDIT, text: 'notes for Thursday' },
    { kind: 'keys', app: 'TextEdit', win: EDIT, keys: 'enter' },
  ];
  /** A desktop app whose windows have other numbers than when the job was shown. */
  function mac(fates: Record<number, 'refuse' | 'lost' | 'offline'> = {}, found: WatchWin | null = NOW) {
    const sent: Record<string, unknown>[] = [];
    let n = 0;
    const hands: NotchJobHands = {
      act: async (request) => {
        sent.push(request);
        if (request.do === 'find') return found ? { done: true, win: found } : { done: false, why: 'gone' };
        const fate = fates[n++];
        if (fate === 'lost') throw new Error('no answer');
        if (fate === 'offline') return null;
        return fate === 'refuse' ? { done: false, why: 'covered' } : { done: true };
      },
    };
    return { hands, sent };
  }

  test('each step is done where it was made, in the window as it is found again today', async () => {
    const m = mac();
    const run = newPlacedRun(steps);
    const progress: number[] = [];
    expect(await runPlaced(run, m.hands, { signal: never(), onProgress: (done) => progress.push(done), ...noSleep })).toEqual({ how: 'done' });
    expect(progress).toEqual([1, 2, 3, 4]);
    expect(m.sent).toEqual([
      // The window is looked for once: the same program, the same size.
      // And it is brought forward: a key or words to type go to whichever window is in front.
      { do: 'find', app: 'TextEdit', win: EDIT, front: true },
      { do: 'click', win: NOW, x: 40, y: 12, hand: 0 },
      { do: 'keys', win: NOW, keys: 'cmd,s' },
      { do: 'type', win: NOW, text: 'notes for Thursday' },
      { do: 'keys', win: NOW, keys: 'enter' },
    ]);
  });

  test('with no such window it stops before anything is touched', async () => {
    const m = mac({}, null);
    const run = newPlacedRun(steps);
    expect(await runPlaced(run, m.hands, { signal: never(), onProgress: () => {}, ...noSleep }))
      .toEqual({ how: 'failed', why: 'I cannot find the window as it was when you showed me: TextEdit, at the same size.' });
    expect(run.next).toBe(0);
    expect(m.sent.length).toBe(1);
  });

  test('stopped, refused or cut off, going on does no step twice', async () => {
    // Asked to stop after the first step.
    const stopped = mac();
    const run = newPlacedRun(steps);
    const stop = new AbortController();
    expect(await runPlaced(run, stopped.hands, { signal: stop.signal, onProgress: () => stop.abort(), ...noSleep })).toEqual({ how: 'stopped' });
    expect(run.next).toBe(1);
    expect(await runPlaced(run, stopped.hands, { signal: never(), onProgress: () => {}, ...noSleep })).toEqual({ how: 'done' });
    expect(stopped.sent.filter((request) => request.do === 'click').length).toBe(1);
    expect(stopped.sent.filter((request) => request.do === 'find').length).toBe(1);

    // The second step is refused: it did not happen, and is the one tried again.
    const refused = mac({ 1: 'refuse' });
    const second = newPlacedRun(steps);
    expect(await runPlaced(second, refused.hands, { signal: never(), onProgress: () => {}, ...noSleep })).toEqual({ how: 'failed', why: 'Another window is in the way.' });
    expect(second.next).toBe(1);

    // The typing's answer is lost: it may have been typed, and is never typed again.
    const lost = mac({ 2: 'lost' });
    const third = newPlacedRun(steps);
    expect(await runPlaced(third, lost.hands, { signal: never(), onProgress: () => {}, ...noSleep }))
      .toEqual({ how: 'failed', why: 'I lost touch with your computer in the middle of a step.', unsure: true });
    expect(third.next).toBe(3);
    await runPlaced(third, lost.hands, { signal: never(), onProgress: () => {}, ...noSleep });
    expect(lost.sent.filter((request) => request.do === 'type').length).toBe(1);
  });

  // What was typed into a password field was never kept.
  test('a step that typed a password is the person\'s to do: it stops there, and going on continues after it', async () => {
    const m = mac();
    const run = newPlacedRun([steps[0]!, { kind: 'secret' }, steps[3]!]);
    expect(await runPlaced(run, m.hands, { signal: never(), onProgress: () => {}, ...noSleep })).toEqual({ how: 'failed', why: NOTCH_SECRET_STEP });
    expect(run.next).toBe(2);
    expect(m.sent.some((request) => request.do === 'type')).toBe(false);
    expect(await runPlaced(run, m.hands, { signal: never(), onProgress: () => {}, ...noSleep })).toEqual({ how: 'done' });
    expect(m.sent.at(-1)).toEqual({ do: 'keys', win: NOW, keys: 'enter' });
  });
});

describe('taking back what was pasted', () => {
  async function pasted(n: number): Promise<{ w: ReturnType<typeof world>; run: RoundsRun }> {
    const w = world(FIVE);
    const run = newRoundsRun(shown(), n);
    await runRounds(run, w.hands, { signal: never(), onProgress: () => {}, ...noSleep });
    w.sent.length = 0;
    return { w, run };
  }

  test('each place is read again and cleared, newest first, when it still holds what was pasted', async () => {
    const { w, run } = await pasted(3);
    const puts = [...run.puts];
    expect(await undoPuts(puts, w.hands, { signal: never(), onProgress: () => {}, ...noSleep })).toEqual({ taken: 3, kept: 0 });
    expect(w.cells.size).toBe(0);
    expect(puts).toEqual([]);
    // Newest first: the last row pasted is the first one clicked.
    expect(w.sent[0]).toEqual({ do: 'click', win: SHEET, x: 300, y: 480, hand: 1 });
    // Read with the cell to its right taken in, because two cells were pasted.
    expect(w.sent[1]).toEqual({ do: 'copy', win: SHEET, right: 1, down: 0 });
    expect(w.sent[2]).toEqual({ do: 'keys', win: SHEET, keys: 'delete' });
  });

  test('a row the person changed since is left alone', async () => {
    const { w, run } = await pasted(3);
    w.cells.set(460, 'b\t999');
    expect(await undoPuts([...run.puts], w.hands, { signal: never(), onProgress: () => {}, ...noSleep })).toEqual({ taken: 2, kept: 1 });
    expect([...w.cells.entries()]).toEqual([[460, 'b\t999']]);
    // No Delete was pressed there.
    expect(w.sent.filter((request) => request.do === 'keys').length).toBe(2);
  });

  test('one cell is only cleared where there is a table: in a page of writing Delete would eat a letter', async () => {
    const one: NotchPut = { win: SHEET, x: 300, y: 440, rows: 1, cols: 1, hash: 'h:42' };
    // A table: taking in the next cell gives two cells.
    const table = world([]);
    table.cells.set(440, '42');
    expect(await undoPuts([{ ...one }], table.hands, { signal: never(), onProgress: () => {}, ...noSleep })).toEqual({ taken: 1, kept: 0 });
    expect(table.cells.size).toBe(0);
    // A page of writing: taking in "the next cell" gives one more letter, not a second cell.
    const page: NotchJobHands = {
      act: async (request) => (request.do === 'copy' ? { done: true, empty: false, rows: 1, cols: 1, hash: request.right ? 'h:4' : 'h:42' } : { done: true }),
    };
    const sent: Record<string, unknown>[] = [];
    const watched: NotchJobHands = { act: (request) => { sent.push(request); return page.act(request); } };
    expect(await undoPuts([{ ...one }], watched, { signal: never(), onProgress: () => {}, ...noSleep })).toEqual({ taken: 0, kept: 1 });
    expect(sent.some((request) => request.do === 'keys')).toBe(false);
  });

  test('a window that is gone ends it, and what is left can still be taken back later', async () => {
    const { w, run } = await pasted(3);
    const puts = [...run.puts];
    // The first is taken back (click, copy, delete), then the window is gone.
    w.next.push(null, null, null, { why: 'gone' });
    expect(await undoPuts(puts, w.hands, { signal: never(), onProgress: () => {}, ...noSleep })).toEqual({ taken: 1, kept: 0, why: 'The window is not there any more.' });
    expect(puts.length).toBe(2);
  });
});

describe('the record of what was done', () => {
  test('a job is written down as it goes, and one cut off by a restart is not left as running', () => {
    const db = new Database(':memory:');
    let now = 1000;
    const store = new NotchJobStore(db, () => now);
    const id = store.open('rounds', 'Pasted 0 from Notepad into Excel', 9);
    store.progress(id, 4, [{ win: SHEET, x: 300, y: 440, rows: 1, cols: 2, hash: 'h:x' }]);
    expect(store.get(id)).toMatchObject({ state: 'running', done: 4, total: 9, puts: [{ win: SHEET, x: 300, y: 440, hash: 'h:x' }] });
    now = 2000;
    const again = new NotchJobStore(db, () => now);
    expect(again.get(id)).toMatchObject({ state: 'stopped', note: 'Pillow restarted in the middle of it.', endedAt: 2000 });
    // What did nothing is not in what was done; a taking back is not either.
    again.open('rounds', 'Pasted 0', null);
    const undo = again.open('undo', 'Took back', 1);
    again.progress(undo, 1, []);
    expect(again.since(0).map((row) => row.id)).toEqual([id]);
  });

  test('nothing of the text of a paste is in it', () => {
    const db = new Database(':memory:');
    const store = new NotchJobStore(db);
    const id = store.open('rounds', 'Pasted 1', 1);
    store.progress(id, 1, [{ win: SHEET, x: 1, y: 2, rows: 1, cols: 2, hash: '9f2c' }]);
    const stored = JSON.stringify(db.query('SELECT * FROM notch_jobs').all());
    expect(stored).toContain('9f2c');
    expect(stored).not.toContain('a\\t1');
  });
});

// ---------------------------------------------------------------------------
// On the notch
// ---------------------------------------------------------------------------

function notch(rows: string[], options: { paused?: () => boolean } = {}) {
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
  fromPage({ type: 'hello', v: 1 });
  const inbox = new NotchInbox(surface, { clock, log: () => {} });
  const w = world(rows, { gated: true });
  const running: boolean[] = [];
  const jobs = attachNotchJobs(inbox, {
    db: new Database(':memory:'), hands: w.hands, paused: options.paused, running: (on) => running.push(on),
    sleep: async () => {}, log: () => {},
  });
  const line = (): NotchLine | null => surface.current().line;
  const said = (): string => text(line()?.say);
  const reply = async (act: string, more: Record<string, unknown> = {}): Promise<void> => {
    fromPage({ type: 'answer', id: line()!.id, act, ...more });
    await settle();
  };
  /** Lets a result line have had its time. */
  const pass = async (ms: number): Promise<void> => {
    now += ms;
    for (const timer of [...timers]) if (timer.at <= now) { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); timer.fn(); }
    await settle();
  };
  const start = (count: number | null): boolean => {
    const rounds = shown();
    return jobs.start(roundsPlan(newRoundsRun(rounds, count), w.hands, roundsWords(rounds, roundsApps(rounds))));
  };
  return { ...w, jobs, line, said, reply, pass, start, running, pushed };
}

describe('a job on the notch', () => {
  test('it counts as it goes, and says when it is done', async () => {
    const n = notch(FIVE);
    expect(n.start(3)).toBe(true);
    await settle();
    expect(n.line()).toMatchObject({ kind: 'work', steps: 3, done: 0, mood: 'track' });
    expect(n.said()).toBe('Pasting');
    await n.answer(4);
    expect(n.line()).toMatchObject({ kind: 'work', steps: 3, done: 1 });
    await n.answer(8);
    await settle();
    expect(n.said()).toBe('Done. 3 pasted.');
    expect(n.line()).toMatchObject({ kind: 'say', mark: 'check' });
    // The pointers were sent home when the work was over.
    expect(n.sent.at(-1)).toEqual({ do: 'home' });
    expect(n.running).toEqual([true, false]);
    expect(n.jobs.busy()).toBe(false);
  });

  test('with no count the sentence says how far it is, and the end says why it ended', async () => {
    const n = notch(['r0', 'r1', 'a\t1', 'b\t2']);
    n.start(null);
    await settle();
    expect(n.line()).toMatchObject({ kind: 'work', steps: 0 });
    expect(n.said()).toBe('Pasting. 0 pasted so far.');
    await n.answer(4);
    expect(n.said()).toBe('Pasting. 1 pasted so far.');
    // The second row, then the click and the copy that finds nothing.
    await n.answer(6);
    await settle();
    expect(n.said()).toBe('Done. 2 pasted. The next one was empty.');
  });

  // The plan's test, steps 2 and 3.
  test('Esc stops it at a whole row; it can go on, and no row is there twice', async () => {
    const n = notch(FIVE);
    n.start(5);
    await n.answer(8);
    expect(n.line()).toMatchObject({ kind: 'work', done: 2 });
    // Esc while the third row's first step is on its way.
    await n.reply('stop');
    // It finishes that row: three more steps are answered.
    await n.answer(4);
    await settle();
    expect(n.said()).toBe('Stopped at 3 of 5. What now?');
    expect(n.line()).toMatchObject({ kind: 'offer', options: ['Go on', 'Undo it', 'Leave it'] });
    expect(n.jobs.busy()).toBe(false);
    await n.reply('pick', { option: 'Go on', index: 0 });
    expect(n.line()).toMatchObject({ kind: 'work', steps: 5, done: 3 });
    await n.answer(8);
    await settle();
    expect(n.said()).toBe('Done. 5 pasted.');
    expect([...n.pastes.values()]).toEqual([1, 1, 1, 1, 1]);
  });

  test('"Leave it" leaves it, and "Undo it" takes back what it pasted', async () => {
    const left = notch(FIVE);
    left.start(5);
    await left.answer(4);
    await left.reply('stop');
    await left.answer(4);
    await settle();
    expect(left.said()).toBe('Stopped at 2 of 5. What now?');
    await left.reply('pick', { option: 'Leave it', index: 2 });
    expect(left.said()).toBe('Left at 2 of 5.');
    expect(left.cells.size).toBe(2);

    const undone = notch(FIVE);
    undone.start(5);
    await undone.answer(4);
    await undone.reply('stop');
    await undone.answer(4);
    await settle();
    await undone.reply('pick', { option: 'Undo it', index: 1 });
    await settle();
    expect(undone.line()).toMatchObject({ kind: 'work', steps: 2, done: 0 });
    expect(undone.said()).toBe('Undoing my paste');
    // Each paste: a click, a read, a Delete.
    await undone.answer(6);
    await settle();
    expect(undone.said()).toBe('Undone. It is as you left it.');
    expect(undone.cells.size).toBe(0);
  });

  test('a step that does not work says why, and offers the same three ways on', async () => {
    const n = notch(FIVE);
    n.start(5);
    await n.answer(4);
    n.next.push({ why: 'moved' });
    await n.answer(1);
    await settle();
    expect(n.said()).toBe('I stopped at 1 of 5. The window is not the size it was, so things are not where they were. What now?');
    expect(n.line()).toMatchObject({ kind: 'offer', options: ['Go on', 'Undo it', 'Leave it'] });
  });

  test('one job at a time', async () => {
    const n = notch(FIVE);
    expect(n.start(5)).toBe(true);
    expect(n.start(5)).toBe(false);
  });

  test('Esc twice stops a job that is running', async () => {
    let paused = false;
    const n = notch(FIVE, { paused: () => paused });
    n.start(5);
    await n.answer(4);
    paused = true;
    // It looks four times a second.
    await new Promise((resolve) => setTimeout(resolve, 320));
    await n.answer(4);
    await settle();
    // Nothing more is begun, and going on is not offered while everything is stopped.
    expect(n.said()).toBe('Stopped at 2 of 5. What now?');
    expect(n.line()).toMatchObject({ kind: 'offer', options: ['Undo it', 'Leave it'] });
  });
});

describe('what was done today, and taking it back from there', () => {
  test('a finished job is in the list with an Undo, and Undo takes its rows back', async () => {
    const n = notch(FIVE);
    n.start(3);
    await n.answer(12);
    await settle();
    await n.pass(6000);
    const [row] = n.jobs.done(0);
    expect(row).toMatchObject({ text: 'Pasted 3 from notepad into excel', undoable: true });
    n.jobs.undo(row!.id);
    await settle();
    expect(n.said()).toBe('Undoing my paste');
    await n.answer(9);
    await settle();
    expect(n.said()).toBe('Undone. It is as you left it.');
    expect(n.cells.size).toBe(0);
    await n.pass(6000);
    // Taken back: it is still in the list, and can not be taken back twice.
    expect(n.jobs.done(0)).toMatchObject([{ text: 'Pasted 3 from notepad into excel (taken back)', undoable: false }]);
    n.jobs.undo(row!.id);
    await settle();
    expect(n.said()).toBe('Nothing of mine to undo there.');
  });

  test('rows the person changed since are said, not hidden', async () => {
    const n = notch(FIVE);
    n.start(3);
    await n.answer(12);
    await settle();
    await n.pass(6000);
    n.cells.set(460, 'changed');
    expect(n.jobs.undoLast()).toBe(true);
    await settle();
    // Two are cleared (three requests each), one is read and left (two requests).
    await n.answer(8);
    await settle();
    expect(n.said()).toBe('Took back 2. I left 1 that was changed since.');
    expect([...n.cells.entries()]).toEqual([[460, 'changed']]);
    await n.pass(6000);
    // Every paste was looked at. The one that was changed is the person's now: there is nothing left to take back.
    expect(n.jobs.done(0)[0]).toMatchObject({ undoable: false });
  });

  test('with nothing to take back, it says so', () => {
    const n = notch(FIVE);
    expect(n.jobs.undoLast()).toBe(false);
  });
});
