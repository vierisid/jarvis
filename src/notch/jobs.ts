/**
 * A job Jarvis does where it can be seen (pass 10).
 *
 * A job is steps on the person's own screen: clicks at places, shortcuts, a
 * copy, a paste. Jarvis's own pointers go to each place before anything
 * happens there (the desktop app's `notch.act`), the notch counts ("4 of 9"),
 * and Esc stops it. Three kinds of job run here:
 *
 *   rounds  the same few steps again and again, one place further along each
 *           time: the rest of a job the person began by hand (./rounds.ts)
 *   skill   a job shown once with "Watch me", done again as it was shown
 *   undo    taking back what a job pasted
 *
 * What holds for all of them:
 *
 *   - A step is done once. Each step is one request to the desktop app. One
 *     that was done is never sent again, and neither is one whose answer was
 *     lost, because it may have been done. Only a step the desktop app
 *     refused, before touching anything, is tried again. Going on starts at
 *     the first step that did not happen. That is why a row is never there
 *     twice.
 *   - Esc stops between rounds, not in the middle of one, when the round in
 *     hand can be finished within a few seconds. A row is whole or not begun.
 *   - Stopping is not the end: go on, take it back, or leave it.
 *   - What a job pasted is kept as shapes only: where, how many cells, and a
 *     number that stands for the text. Never the text. Taking a paste back
 *     reads the place again and clears it only if it still holds exactly what
 *     was pasted. Something the person changed since is left alone.
 *   - A payment is never part of a job on the notch.
 */
import type { Database } from 'bun:sqlite';
import type { NotchInbox, NotchItem, NotchItemEnd } from './inbox.ts';
import type { NotchPart } from './protocol.ts';
import { roundPlace, roundsCopy, type RoundStep, type Rounds, type WatchWin } from './rounds.ts';
import type { NotchStage } from './stage.ts';

/** What the desktop app answers to one thing done again. */
export interface NotchActResult {
  done: boolean;
  /** Why it was not done: gone, moved, outside, covered, own, elevated, front, failed, or off (desktop control is switched off). */
  why?: string;
  /** A copy: nothing was copied, or how much. */
  empty?: boolean;
  rows?: number;
  cols?: number;
  hash?: string;
  /** A paste: the window and the place in it that took it. */
  win?: WatchWin;
  app?: string;
  pt?: { x: number; y: number };
  shape?: { rows?: number; cols?: number; hash?: string };
  /** A pointer sent somewhere: how long its way takes, in milliseconds. */
  ms?: number;
  /** A count of what is left: how many, and whether it could be told at all. */
  left?: number;
  known?: boolean;
  /** Rows measured on the screen: how far one step really is, when `known`. */
  dy?: number;
}

export interface NotchJobHands {
  /**
   * Does one thing on the person's machine and says how it went. Null when no
   * machine could be asked: then nothing was done. It throws when the request
   * was sent and its answer never came: then it may have been done.
   */
  act(request: Record<string, unknown>): Promise<NotchActResult | null>;
}

/** One thing a job pasted: where, and its shape. Never what it said. */
export interface NotchPut {
  win: WatchWin;
  x: number;
  y: number;
  rows: number;
  cols: number;
  hash: string;
  /** Jarvis's pointer that went there. */
  hand?: number;
}

export type NotchJobKind = 'rounds' | 'skill' | 'put' | 'undo';
export type NotchJobState = 'running' | 'stopped' | 'done' | 'failed' | 'undone';

export interface NotchJobRow {
  id: string;
  createdAt: number;
  kind: NotchJobKind;
  /** What was done, as the row of Today says it. */
  title: string;
  state: NotchJobState;
  done: number;
  total: number | null;
  puts: NotchPut[];
  note: string | null;
  endedAt: number | null;
}

interface StoredJob {
  id: string; created_at: number; kind: string; title: string; state: string; done: number; total: number | null;
  detail: string; note: string | null; ended_at: number | null;
}

/** The most pastes one job keeps for taking back. */
export const NOTCH_JOB_PUTS_KEPT = 500;
/** How many days a job is kept. */
export const NOTCH_JOB_DAYS = 14;

function putsOf(detail: string): NotchPut[] {
  try {
    const raw = (JSON.parse(detail) as { puts?: unknown }).puts;
    if (!Array.isArray(raw)) return [];
    return raw.filter((put): put is NotchPut => typeof put === 'object' && put !== null
      && typeof (put as NotchPut).hash === 'string' && typeof (put as NotchPut).x === 'number' && typeof (put as NotchPut).y === 'number'
      && typeof (put as NotchPut).win?.id === 'string');
  } catch { return []; }
}

/** What Jarvis did where it could be seen: for Today, and for taking it back. */
export class NotchJobStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {
    db.run(`CREATE TABLE IF NOT EXISTS notch_jobs (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      total INTEGER,
      detail TEXT NOT NULL DEFAULT '{}',
      note TEXT,
      ended_at INTEGER
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_notch_jobs_created ON notch_jobs(created_at)');
    // A job that was running when the brain went down is not running now.
    db.run("UPDATE notch_jobs SET state = 'stopped', note = 'Jarvis restarted in the middle of it.', ended_at = ? WHERE state = 'running'", [this.now()]);
    db.run('DELETE FROM notch_jobs WHERE created_at < ?', [this.now() - NOTCH_JOB_DAYS * 86_400_000]);
  }

  open(kind: NotchJobKind, title: string, total: number | null): string {
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO notch_jobs (id, created_at, kind, title, state, total) VALUES (?, ?, ?, ?, ?, ?)',
      [id, this.now(), kind, title.slice(0, 200), 'running', total]);
    return id;
  }

  /** How far it is, and what it has pasted so far. Written after every round, so a crash loses at most the round in hand. */
  progress(id: string, done: number, puts: NotchPut[]): void {
    this.db.run('UPDATE notch_jobs SET done = ?, detail = ? WHERE id = ?', [done, JSON.stringify({ puts: puts.slice(-NOTCH_JOB_PUTS_KEPT) }), id]);
  }

  state(id: string, state: NotchJobState, note: string | null = null, title?: string): void {
    const ended = state === 'running' ? null : this.now();
    if (title === undefined) this.db.run('UPDATE notch_jobs SET state = ?, note = ?, ended_at = ? WHERE id = ?', [state, note, ended, id]);
    else this.db.run('UPDATE notch_jobs SET state = ?, note = ?, ended_at = ?, title = ? WHERE id = ?', [state, note, ended, title.slice(0, 200), id]);
  }

  get(id: string): NotchJobRow | null {
    const row = this.db.query<StoredJob, [string]>('SELECT * FROM notch_jobs WHERE id = ?').get(id);
    return row ? this.parse(row) : null;
  }

  /** What was done since a moment, newest first. Not the takings back themselves, and not what did nothing. */
  since(at: number): NotchJobRow[] {
    return this.db.query<StoredJob, [number]>(
      "SELECT * FROM notch_jobs WHERE created_at >= ? AND kind != 'undo' AND done > 0 ORDER BY created_at DESC LIMIT 100").all(at)
      .map((row) => this.parse(row));
  }

  private parse(row: StoredJob): NotchJobRow {
    return {
      id: row.id, createdAt: row.created_at, kind: row.kind as NotchJobKind, title: row.title, state: row.state as NotchJobState,
      done: row.done, total: row.total, puts: putsOf(row.detail), note: row.note, endedAt: row.ended_at,
    };
  }
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

/** A run of rounds, as far as it has come. It is changed in place, so that going on continues from it. */
export interface RoundsRun {
  rounds: Rounds;
  /** How many rounds to do, when that is known. */
  count: number | null;
  /** Rounds Jarvis has finished. */
  done: number;
  /** The step of the round in hand that is next, when a round was left unfinished. */
  step: number;
  puts: NotchPut[];
  /** What the last copy of the round in hand held. */
  copied: { rows: number; cols: number; hash: string } | null;
}

export const newRoundsRun = (rounds: Rounds, count: number | null): RoundsRun =>
  ({ rounds, count, done: 0, step: 0, puts: [], copied: null });

export type NotchJobEnd =
  /** `ranOut`: it ended because there was nothing more to take, or no room to go on. */
  | { how: 'done'; ranOut?: 'empty' | 'edge' }
  | { how: 'stopped' }
  /** `unsure`: the last step was sent and its answer never came. It may have happened. */
  | { how: 'failed'; why: string; unsure?: boolean };

export interface NotchRunOptions {
  /** Asked to stop. */
  signal: AbortSignal;
  /** A round, or a step, was finished. */
  onProgress(done: number): void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The most rounds a job does when nobody said how many and nothing says the things have run out. */
export const NOTCH_ROUNDS_MOST = 200;
/** How long a round in hand may still take once stop was asked. Past it the job stops where it is. */
export const NOTCH_ROUND_FINISH_MS = 3000;
/** The pauses a program is given to take in what was done to it. */
const AFTER_CLICK_MS = 130;
const AFTER_KEYS_MS = 160;
const AFTER_PASTE_MS = 320;

/** Why a step was not done, as it is said. */
export function actRefusal(why: string | undefined): string {
  switch (why) {
    case 'gone': return 'The window is not there any more.';
    case 'moved': return 'The window is not the size it was, so things are not where they were.';
    case 'outside': return 'The next one is outside the window.';
    case 'covered': return 'Another window is in the way.';
    case 'own': return 'One of my own windows is in the way.';
    case 'elevated': return 'That window runs as administrator, and I cannot reach it.';
    case 'front': return 'Another window came to the front.';
    case 'off': return 'Desktop control is switched off in settings.';
    default: return 'A step did not work.';
  }
}

const winRequest = (win: WatchWin): Record<string, unknown> => ({ id: win.id, pid: win.pid, w: win.w, h: win.h });

/**
 * Makes every step down a list exact, or says it cannot.
 *
 * Two clicks by hand on two rows are never exactly one row apart: the hand
 * lands a few pixels higher in one and lower in the next. Going on by that
 * distance drifts, and a few rows on the click is in the wrong row. So before
 * Jarvis goes on, the desktop app measures how far apart the rows really are
 * at each place, from the screen itself (sidecar: watchPitch), and that is
 * the distance used.
 *
 * Null when the rows cannot be seen for one of the places, or what was
 * measured does not agree with what the hand did. Then Jarvis does not take
 * the job over at all: a row pasted one line off is worse than no help.
 */
export async function sureRounds(rounds: Rounds, hands: NotchJobHands): Promise<Rounds | null> {
  const steps: RoundStep[] = [];
  for (const step of rounds.steps) {
    if (step.kind !== 'click' || step.dy === 0) { steps.push(step); continue; }
    let got: NotchActResult | null = null;
    try {
      got = await hands.act({ do: 'pitch', win: winRequest(step.win), x: Math.round(step.x), y: Math.round(step.y), dy: Math.round(step.dy) });
    } catch { got = null; }
    const dy = got?.done && got.known === true && typeof got.dy === 'number' && Number.isFinite(got.dy) ? got.dy : null;
    // The same way as the hand went, and within most of a row of how far it went.
    if (dy === null || Math.sign(dy) !== Math.sign(step.dy) || Math.abs(dy) < 6 || Math.abs(dy - step.dy) > Math.abs(dy) / 2) return null;
    steps.push({ ...step, dy });
  }
  return { ...rounds, steps };
}

/** What is said when the rows cannot be seen well enough to go on by itself. */
export const NOTCH_ROWS_NOT_SEEN = 'I cannot see the rows clearly enough there to go on by myself.';

/**
 * Does rounds until they are done, there is nothing left, it is asked to
 * stop, or a step does not work. `run` is where it has come to: calling this
 * again with the same `run` goes on from there.
 */
export async function runRounds(run: RoundsRun, hands: NotchJobHands, options: NotchRunOptions): Promise<NotchJobEnd> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const steps = run.rounds.steps;
  const most = run.count ?? NOTCH_ROUNDS_MOST;
  let stopAskedAt: number | null = null;
  const stopAsked = (): boolean => {
    if (options.signal.aborted && stopAskedAt === null) stopAskedAt = now();
    return stopAskedAt !== null;
  };
  while (run.done < most) {
    const k = run.done + 1;
    if (run.step === 0) {
      // Between rounds is where a stop lands.
      if (stopAsked()) return { how: 'stopped' };
      // The next round must fit in its windows before any of it is begun.
      for (const step of steps) {
        if (step.kind === 'click' && !roundPlace(step, k)) return { how: 'done', ranOut: 'edge' };
      }
    }
    for (let i = run.step; i < steps.length; i++) {
      // A round in hand is finished, unless that takes too long.
      if (stopAsked() && now() - stopAskedAt! > NOTCH_ROUND_FINISH_MS) { run.step = i; return { how: 'stopped' }; }
      const step: RoundStep = steps[i]!;
      let request: Record<string, unknown>;
      if (step.kind === 'click') {
        const at = roundPlace(step, k)!;
        request = { do: 'click', win: winRequest(step.win), x: at.x, y: at.y, hand: step.hand, ...(step.mods ? { mods: step.mods } : {}) };
      } else if (step.copy) {
        request = { do: 'copy', win: winRequest(step.win), keys: step.keys };
      } else {
        request = { do: 'keys', win: winRequest(step.win), keys: step.keys };
      }
      let result: NotchActResult | null;
      try {
        result = await hands.act(request);
      } catch {
        // Sent, and no answer: it may have happened. It is not sent again.
        run.step = i + 1;
        return { how: 'failed', why: 'I lost touch with your computer in the middle of a step.', unsure: true };
      }
      if (!result) { run.step = i; return { how: 'failed', why: 'Your computer is not connected.' }; }
      if (!result.done) { run.step = i; return { how: 'failed', why: actRefusal(result.why) }; }
      if (step.kind === 'keys' && step.copy) {
        if (result.empty) {
          // Nothing there to take: the things have run out. Nothing of this round was put anywhere.
          run.step = 0;
          return { how: 'done', ranOut: 'empty' };
        }
        run.copied = { rows: result.rows ?? 1, cols: result.cols ?? 1, hash: result.hash ?? '' };
      }
      if (step.kind === 'keys' && step.paste) {
        // Where it went: the last place clicked before pasting. A round is a
        // circle, so that click may be the end of the round before this one.
        // What was pasted is the last thing Jarvis copied; a paste of
        // something the person copied themselves is not written down, because
        // nothing is known to check it against.
        for (let back = 1; back < steps.length; back++) {
          const j = i - back;
          const before = steps[(j + steps.length) % steps.length]!;
          if (before.kind !== 'click') continue;
          const at = roundPlace(before, j >= 0 ? k : k - 1);
          if (at && run.copied?.hash) run.puts.push({ win: before.win, x: at.x, y: at.y, rows: run.copied.rows, cols: run.copied.cols, hash: run.copied.hash, hand: before.hand });
          break;
        }
        // It is used up: the next paste needs a copy of its own.
        run.copied = null;
      }
      await sleep(step.kind === 'click' ? AFTER_CLICK_MS : step.paste ? AFTER_PASTE_MS : AFTER_KEYS_MS);
    }
    run.step = 0;
    run.done = k;
    options.onProgress(run.done);
  }
  return { how: 'done' };
}

// ---------------------------------------------------------------------------
// A job shown once, done again by place
// ---------------------------------------------------------------------------

/**
 * One step of a job that was shown, as it is done again where a program's
 * buttons cannot be found again by what they are called (a Mac, today): a
 * click at the place in its window where it was made, the keys that were
 * pressed, the words that were typed. `secret` is a step that typed a
 * password: what was typed was never kept, so it cannot be typed again.
 */
export type PlacedStep =
  | { kind: 'click'; app: string; win: WatchWin; x: number; y: number; mods?: string }
  | { kind: 'keys'; app: string; win: WatchWin; keys: string }
  | { kind: 'type'; app: string; win: WatchWin; text: string }
  | { kind: 'secret' };

/** A run of placed steps, as far as it has come. Changed in place, so that going on continues from it. */
export interface PlacedRun {
  steps: PlacedStep[];
  /** The step that is next. */
  next: number;
  /** The windows of the showing, as they were found again for this run: a window's number changes whenever its program is started. */
  found: Map<string, WatchWin>;
}

export const newPlacedRun = (steps: PlacedStep[]): PlacedRun => ({ steps, next: 0, found: new Map() });

export const NOTCH_SECRET_STEP = 'The next step types something secret, which I never keep. Do that step yourself, then tell me to go on.';

/**
 * Does the steps of a shown job again, each at its place, from where the run
 * stands. A step is done once: one that was done, or whose answer was lost,
 * is never sent again; only one the desktop app refused is tried again.
 *
 * Each window of the showing is found again first (`find`): the same
 * program, with a window of the same size. Where there is none the job
 * stops before anything is touched: what was at a place in a window of
 * another size is somewhere else now.
 */
export async function runPlaced(placed: PlacedRun, hands: NotchJobHands, options: NotchRunOptions): Promise<NotchJobEnd> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (placed.next < placed.steps.length) {
    if (options.signal.aborted) return { how: 'stopped' };
    const i = placed.next;
    const step = placed.steps[i]!;
    if (step.kind === 'secret') {
      // Going on continues after it: the person has done it by then.
      placed.next = i + 1;
      return { how: 'failed', why: NOTCH_SECRET_STEP };
    }
    let win = placed.found.get(step.win.id);
    let result: NotchActResult | null;
    try {
      if (!win) {
        // Finding a window touches nothing: asking again after a lost answer is safe.
        // Brought forward too: a key or words to type go to whichever window is in front.
        const found = await hands.act({ do: 'find', app: step.app, win: winRequest(step.win), front: true });
        if (!found) return { how: 'failed', why: 'Your computer is not connected.' };
        if (!found.done || !found.win) {
          return { how: 'failed', why: `I cannot find the window as it was when you showed me${step.app ? `: ${step.app}, at the same size` : ''}.` };
        }
        win = found.win;
        placed.found.set(step.win.id, win);
      }
      const where = winRequest(win);
      result = await hands.act(step.kind === 'click'
        ? { do: 'click', win: where, x: step.x, y: step.y, hand: 0, ...(step.mods ? { mods: step.mods } : {}) }
        : step.kind === 'keys' ? { do: 'keys', win: where, keys: step.keys } : { do: 'type', win: where, text: step.text });
    } catch {
      if (!win) return { how: 'failed', why: 'I lost touch with your computer.' };
      // Sent, and no answer: it may have happened. It is not sent again.
      placed.next = i + 1;
      return { how: 'failed', why: 'I lost touch with your computer in the middle of a step.', unsure: true };
    }
    if (!result) return { how: 'failed', why: 'Your computer is not connected.' };
    if (!result.done) return { how: 'failed', why: actRefusal(result.why) };
    placed.next = i + 1;
    options.onProgress(placed.next);
    await sleep(step.kind === 'click' ? AFTER_CLICK_MS : step.kind === 'type' ? AFTER_PASTE_MS : AFTER_KEYS_MS);
  }
  return { how: 'done' };
}

/** What taking pastes back came to. */
export interface NotchUndone { taken: number; kept: number; why?: string }

/**
 * Takes back what was pasted, newest first. Each place is read again first,
 * and cleared only when it still holds exactly what was pasted there: what
 * the person changed since is kept. `puts` loses each one that was dealt
 * with, so going on continues with the rest.
 */
export async function undoPuts(puts: NotchPut[], hands: NotchJobHands, options: NotchRunOptions): Promise<NotchUndone & { stopped?: boolean }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let taken = 0;
  let kept = 0;
  while (puts.length > 0) {
    if (options.signal.aborted) return { taken, kept, stopped: true };
    const put = puts.at(-1)!;
    const win = winRequest(put.win);
    const click = { do: 'click', win, x: put.x, y: put.y, hand: put.hand ?? 0 };
    let same = false;
    try {
      const there = await hands.act(click);
      if (!there) return { taken, kept, why: 'Your computer is not connected.' };
      if (!there.done) return { taken, kept, why: actRefusal(there.why) };
      await sleep(AFTER_CLICK_MS);
      if (put.rows === 1 && put.cols === 1) {
        // One cell. First, is this a table at all? Taking in the next cell must give two cells.
        // In a page of writing it gives one letter, and Delete there would eat a letter of the person's.
        const two = await hands.act({ do: 'copy', win, right: 1 });
        if (two?.done && !two.empty && two.cols === 2) {
          const back = await hands.act(click);
          await sleep(AFTER_CLICK_MS);
          const one = back?.done ? await hands.act({ do: 'copy', win }) : null;
          same = !!one?.done && !one.empty && one.hash === put.hash;
        }
      } else {
        const read = await hands.act({ do: 'copy', win, right: put.cols - 1, down: put.rows - 1 });
        same = !!read?.done && !read.empty && read.hash === put.hash && read.cols === put.cols && read.rows === put.rows;
      }
      if (same) {
        const cleared = await hands.act({ do: 'keys', win, keys: 'delete' });
        if (!cleared?.done) return { taken, kept, why: actRefusal(cleared?.why) };
        await sleep(AFTER_KEYS_MS);
      }
    } catch {
      return { taken, kept, why: 'I lost touch with your computer in the middle of it.' };
    }
    puts.pop();
    if (same) taken++; else kept++;
    options.onProgress(taken + kept);
  }
  return { taken, kept };
}

// ---------------------------------------------------------------------------
// On the notch
// ---------------------------------------------------------------------------

const em = (text: string): NotchPart => ({ em: text });

/** What a job says of itself. */
export interface NotchJobWords {
  /** While it works: "Pasting". */
  doing: string;
  /** So many of them, as it is said: "7 pasted", "7 steps". */
  said(n: number): string;
  /** In Today: "Pasted 7 from Notepad into Excel". */
  title(done: number): string;
}

/** A job as the notch plays it: something that can be run from where it stands, and taken back. */
export interface NotchJobPlan {
  kind: NotchJobKind;
  words: NotchJobWords;
  /** How many there are to do, when that is known. */
  total: number | null;
  /** How many are done. */
  done(): number;
  /** What it has pasted, for taking back. */
  puts(): NotchPut[];
  /** Runs it from where it stands. */
  run(options: NotchRunOptions): Promise<NotchJobEnd>;
  /** Whether going on is possible after this ending. */
  canGoOn?(end: NotchJobEnd): boolean;
}

export interface NotchJobsDeps {
  db: Database;
  hands: NotchJobHands;
  /** Everything is stopped (Esc twice): nothing is begun, and what runs stops. */
  paused?: () => boolean;
  /** A job began, or ended: whoever watches the person's hands looks away meanwhile, and starts afresh after. */
  running?: (running: boolean) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface NotchJobs {
  store: NotchJobStore;
  /** Puts a job on the notch and runs it. False when one is already running. */
  start(plan: NotchJobPlan): boolean;
  /** Takes back what a job of today pasted. Says so itself when there is nothing to take back. */
  undo(jobId: string): void;
  /** Takes back the last thing that can be. False when there is none. */
  undoLast(): boolean;
  /** Whether a job is running now. */
  busy(): boolean;
  /** What was done since a moment, for Today. */
  done(since: number): { id: string; at: number; text: string; undoable: boolean }[];
  /** Sends Jarvis's pointers home. */
  home(): void;
  stop(): void;
}

interface LiveJob {
  id: string;
  plan: NotchJobPlan;
  /** running, or how it ended and has not been shown yet. */
  end: NotchJobEnd | null;
  abort: AbortController;
  /** The run's own promise: it ends when the desktop app has answered the last step. */
  running: Promise<void> | null;
  waiters: Set<() => void>;
  /** Its cursor has been seen to leave the notch: the lip pushes out for it once, not each time the line comes back. */
  launched?: boolean;
  /** Its place in what waits for the notch. */
  item(): NotchItem;
}

/** The sentence of a job at work: what it is doing, and how far it is when there are no beads to say so. */
function workSay(plan: NotchJobPlan): NotchPart[] {
  return plan.total === null ? [plan.words.doing, '. ', em(plan.words.said(plan.done())), ' so far.'] : [plan.words.doing];
}

export function attachNotchJobs(inbox: NotchInbox, deps: NotchJobsDeps): NotchJobs {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now;
  const store = new NotchJobStore(deps.db, now);
  let live: LiveJob | null = null;
  let stopped = false;

  const home = (): void => { void deps.hands.act({ do: 'home' }).catch(() => {}); };
  const wake = (job: LiveJob): void => {
    const waiters = [...job.waiters];
    job.waiters.clear();
    for (const waiter of waiters) waiter();
  };
  const changed = (job: LiveJob): Promise<'changed'> => new Promise((resolve) => { job.waiters.add(() => resolve('changed')); });

  /** Starts, or goes on with, the run of a job. */
  function go(job: LiveJob): void {
    job.end = null;
    job.abort = new AbortController();
    store.state(job.id, 'running');
    deps.running?.(true);
    const pausedWatch = setInterval(() => { if (deps.paused?.()) job.abort.abort(); }, 250);
    (pausedWatch as { unref?: () => void }).unref?.();
    job.running = (async () => {
      let end: NotchJobEnd;
      try {
        end = await job.plan.run({
          signal: job.abort.signal,
          onProgress: (done) => { store.progress(job.id, done, job.plan.puts()); wake(job); },
          sleep: deps.sleep,
          now,
        });
      } catch (error) {
        log(`[notch] a job broke: ${error instanceof Error ? error.message : String(error)}`);
        end = { how: 'failed', why: 'Something went wrong on my side.' };
      }
      clearInterval(pausedWatch);
      store.progress(job.id, job.plan.done(), job.plan.puts());
      store.state(job.id, end.how === 'done' ? 'done' : end.how === 'stopped' ? 'stopped' : 'failed', end.how === 'failed' ? end.why : null, job.plan.words.title(job.plan.done()));
      job.end = end;
      deps.running?.(false);
      // The pointers go home when the work is over, however it ended.
      home();
      wake(job);
      // Its ending is said even when something else had the notch meanwhile.
      if (live === job && !stopped && inbox.showing() !== itemId(job.id)) inbox.add(job.item());
    })();
  }

  const itemId = (id: string): string => `job:${id}`;

  /** How far it came, as it is said: "4 of 9", or "4 pasted". */
  const far = (plan: NotchJobPlan): string =>
    (plan.total !== null ? `${plan.done()} of ${plan.total}` : plan.words.said(plan.done()));

  async function play(job: LiveJob, stage: NotchStage): Promise<NotchItemEnd> {
    const plan = job.plan;
    for (;;) {
      if (job.end === null) {
        const id = stage.id();
        stage.put({ id, kind: 'work', say: workSay(plan), steps: plan.total ?? 0, done: Math.min(plan.done(), plan.total ?? 0), mood: 'track' });
        // The edge gives birth to its cursor: the lip pushes out where it leaves.
        if (!job.launched) { job.launched = true; stage.surface.act({ lip: 'reach', aim: .5, kick: 150 }); }
        const stop = stage.answer(id, ['stop']).then(() => 'stop' as const);
        stop.catch(() => {});
        while (job.end === null) {
          const what = await Promise.race([stop, changed(job)]);
          if (what === 'stop') {
            job.abort.abort();
            // It finishes the round in hand: that is seconds, not for ever.
            if (job.end === null) await Promise.race([changed(job), stage.wait(NOTCH_ROUND_FINISH_MS + 6000).catch(() => {})]);
            break;
          }
          if (job.end === null) stage.surface.update(id, { done: Math.min(plan.done(), plan.total ?? 0), say: workSay(plan) });
        }
        if (job.end === null) return 'waits';
        continue;
      }
      const end = job.end;
      // The cursor is back in the notch: a gulp.
      if (job.launched) { job.launched = false; stage.surface.act({ kick: 260 }); }
      if (end.how === 'done') {
        const n = plan.done();
        const tail = end.ranOut === 'empty' ? ' The next one was empty.' : end.ranOut === 'edge' ? ' That is as far as the window goes.' : '';
        if (plan.kind === 'undo') {
          // An undo says its own ending (below): this is not reached for one.
          live = null;
          return 'settled';
        }
        if (n === 0) await stage.say([`Nothing left to do.${tail}`], 3200, { mood: 'look' });
        else await stage.say(['Done. ', em(plan.words.said(n)), '.', tail], 3600, { mood: 'happy', mark: 'check' });
        if (live === job) live = null;
        return 'settled';
      }
      // Stopped, or a step did not work. It is not the end: go on, take it back, or leave it.
      const goOn = (plan.canGoOn?.(end) ?? true) && !deps.paused?.();
      const canUndo = plan.puts().length > 0;
      const options = [...(goOn ? ['Go on'] : []), ...(canUndo ? ['Undo it'] : []), 'Leave it'];
      const head: NotchPart[] = end.how === 'failed'
        ? ['I stopped at ', em(far(plan)), '. ', end.why, end.unsure ? ' It may have landed.' : '']
        : ['Stopped at ', em(far(plan)), '.'];
      if (options.length < 2) {
        await stage.say(head, 4200, { mood: end.how === 'failed' ? 'sorry' : 'careful', ...(end.how === 'failed' ? { mark: 'fail' as const } : {}) });
        if (live === job) live = null;
        return 'settled';
      }
      const pick = await stage.choose([...head, ' What now?'], options, { fold: 0, mood: end.how === 'failed' ? 'worried' : 'careful' });
      if (pick.act === 'pick' && pick.option === 'Go on') { go(job); continue; }
      if (pick.act === 'pick' && pick.option === 'Undo it') {
        if (live === job) live = null;
        startUndo(job.id, plan.puts(), plan.words);
        return 'settled';
      }
      if (pick.act === 'pick') await stage.say([`Left at ${far(plan)}.`], 2400);
      if (live === job) live = null;
      return 'settled';
    }
  }

  /** Whether a job may begin. One that has ended and only waits to say so gives way. */
  function free(): boolean {
    if (stopped) return false;
    if (live && live.end === null) return false;
    if (live) { inbox.remove(itemId(live.id)); live = null; }
    return true;
  }

  function begin(plan: NotchJobPlan, playIt?: (job: LiveJob, stage: NotchStage) => Promise<NotchItemEnd>): void {
    const id = store.open(plan.kind, plan.words.title(0), plan.total);
    const job: LiveJob = {
      id, plan, end: null, abort: new AbortController(), running: null, waiters: new Set(),
      item: () => ({
        id: itemId(id), subject: 'job', class: 'person', speaks: true, urgent: true, asked: true, returns: true,
        title: () => [plan.words.doing],
        play: (stage) => (playIt ? playIt(job, stage) : play(job, stage)),
      }),
    };
    live = job;
    go(job);
    inbox.add(job.item());
  }

  function start(plan: NotchJobPlan): boolean {
    if (!free()) return false;
    begin(plan);
    return true;
  }

  /** Taking back is a job like any other: it is seen, counted, and can be stopped. */
  function startUndo(ofJob: string, puts: NotchPut[], words: NotchJobWords): void {
    const left = [...puts];
    const all = left.length;
    let result: NotchUndone & { stopped?: boolean } = { taken: 0, kept: 0 };
    let dealt = 0;
    const undoWords: NotchJobWords = { doing: 'Undoing my paste', said: (n) => `${n} looked at`, title: () => `Took back: ${words.title(all)}` };
    const plan: NotchJobPlan = {
      kind: 'undo', words: undoWords, total: all,
      done: () => dealt,
      puts: () => [],
      canGoOn: () => left.length > 0,
      async run(options) {
        const part = await undoPuts(left, deps.hands, { ...options, onProgress: () => { dealt = all - left.length; options.onProgress(dealt); } });
        result = { taken: result.taken + part.taken, kept: result.kept + part.kept, why: part.why, stopped: part.stopped };
        dealt = all - left.length;
        // What is still there can still be taken back; what was taken back cannot be again.
        store.progress(ofJob, store.get(ofJob)?.done ?? 0, left);
        if (left.length === 0) store.state(ofJob, 'undone');
        if (part.stopped) return { how: 'stopped' };
        if (part.why) return { how: 'failed', why: part.why };
        return { how: 'done' };
      },
    };
    if (!free()) return;
    begin(plan, async (job, stage) => {
      const ended = await play(job, stage);
      if (ended !== 'settled' || job.end?.how !== 'done') return ended;
      const { taken, kept } = result;
      if (kept === 0) await stage.say(['Undone. It is as you left it.'], 3000, { mood: 'look', mark: 'check' });
      else if (taken === 0) await stage.say(['I took nothing back: ', em(String(kept)), kept === 1 ? ' is not as I left it.' : ' are not as I left them.'], 5200, { mood: 'careful' });
      else await stage.say(['Took back ', em(String(taken)), '. I left ', em(String(kept)), kept === 1 ? ' that was changed since.' : ' that were changed since.'], 5200, { mood: 'careful' });
      return 'settled';
    });
  }

  const tell = (parts: NotchPart[], mood: 'careful' | 'look' = 'careful'): void => {
    const id = `job-tell-${crypto.randomUUID()}`;
    inbox.add({
      id, subject: id, class: 'person', speaks: true, urgent: true, once: true, asked: true,
      title: () => parts,
      play: async (stage) => { await stage.say(parts, 3800, { mood }); return 'settled'; },
    });
  };

  const undoable = (row: NotchJobRow): boolean => row.puts.length > 0 && row.state !== 'running' && row.state !== 'undone';

  function undo(jobId: string): void {
    if (live) { tell(['I am in the middle of something. Stop it first.']); return; }
    if (deps.paused?.()) { tell(['Everything is stopped. Wake me first.']); return; }
    const row = store.get(jobId);
    if (!row || !undoable(row)) { tell(['Nothing of mine to undo there.'], 'look'); return; }
    startUndo(row.id, row.puts, { doing: 'Undoing my paste', said: (n) => String(n), title: () => row.title });
  }

  return {
    store, start, undo,
    undoLast() {
      const row = store.since(now() - 24 * 3_600_000).find(undoable);
      if (!row) return false;
      undo(row.id);
      return true;
    },
    busy: () => live !== null && live.end === null,
    done: (since) => store.since(since).filter((row) => row.state !== 'running').map((row) => ({
      id: row.id, at: row.endedAt ?? row.createdAt,
      text: row.state === 'undone' ? `${row.title} (taken back)` : row.title,
      undoable: undoable(row),
    })),
    home,
    stop() {
      stopped = true;
      live?.abort.abort();
    },
  };
}

/** A run of rounds as a job the notch can play. */
export function roundsPlan(run: RoundsRun, hands: NotchJobHands, words: NotchJobWords): NotchJobPlan {
  return {
    kind: 'rounds', words, total: run.count,
    done: () => run.done,
    puts: () => run.puts,
    run: (options) => runRounds(run, hands, options),
    // A step whose answer was lost may have landed: going on continues after it, never with it.
    canGoOn: () => true,
  };
}

/** What a round of copying and pasting, or of anything else, calls itself. */
export function roundsWords(rounds: Rounds, apps: string[]): NotchJobWords {
  const pastes = roundsCopy(rounds) && rounds.steps.some((step) => step.kind === 'keys' && step.paste);
  const [from, to] = [apps[0], apps.at(-1)];
  const where = pastes && from && to && from !== to ? ` from ${from} into ${to}` : to ? ` in ${to}` : '';
  return pastes
    ? { doing: 'Pasting', said: (n) => `${n} pasted`, title: (done) => `Pasted ${done}${where}` }
    : { doing: 'Doing the rest', said: (n) => `${n} more`, title: (done) => `Did ${done} more${where}, the way you began` };
}
