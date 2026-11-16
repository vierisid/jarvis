/**
 * A job done several times over, told from the shape of what the hands did.
 *
 * The desktop app tells the brain what the person does as shapes, and nothing
 * else (sidecar/notch_watch.go): a click, in which window, at which place in
 * it; a named key or a shortcut, in which window. Never a letter that was
 * typed, never a text, never a name or a title.
 *
 * From those shapes this file answers one question: did the person just do
 * the same thing twice, one step further along each time? Copy a row, click
 * the next cell, paste; then the same again one row down. That is a round,
 * done twice. What changes between the two is where each click landed, and by
 * how much. A third round is the same steps with every place moved on by that
 * much again, and that is all Jarvis needs to go on from where the person is.
 *
 * It knows nothing of rows or sheets, so it works wherever things stand at
 * even distances: a spreadsheet, a list of files, lines in a document.
 *
 * What it refuses to see as a round, on purpose:
 *   - a stretch with typing in it. Typing is told only as "typed", so there
 *     is a part of the job Jarvis did not see and cannot do again.
 *   - anything across a moment where the desktop app looked away (a password,
 *     a bank, an app on the person's list).
 *   - a round in which nothing moves on. Pressing the same button twice is
 *     not a job with a rest to finish.
 *   - a round of clicks alone, done only twice. Two clicks in a window happen
 *     all day; it takes a third to be a pattern.
 *
 * Pure: no clock, no I/O.
 */

/** A window as a step names it: a number that stays the same while the window lives, its process, its size. */
export interface WatchWin { id: string; pid: number; w: number; h: number }

/** One thing the person did, as its shape. `at` is when, in milliseconds. */
export type WatchStep =
  | { kind: 'click'; app: string; win: WatchWin; x: number; y: number; mods?: string; at: number }
  | { kind: 'keys'; app: string; win: WatchWin; keys: string; at: number }
  /** Something was typed. What, and how much, was not told. */
  | { kind: 'typed'; at: number }
  /** The desktop app looked away for a while. */
  | { kind: 'gap'; at: number };

/** One step of a round as Jarvis does it: the place moves on by `dx, dy` every round. */
export type RoundStep =
  | { kind: 'click'; app: string; win: WatchWin; x: number; y: number; dx: number; dy: number; mods?: string; hand: number }
  | { kind: 'keys'; app: string; win: WatchWin; keys: string; copy?: boolean; paste?: boolean };

export interface Rounds {
  /** The steps, with every place as it was in the LAST round done by hand. */
  steps: RoundStep[];
  /** How many rounds were seen done by hand, one after the other. */
  shown: number;
  /** When the last of them ended. */
  at: number;
}

/** The longest round, in steps. */
export const NOTCH_ROUND_MAX_STEPS = 12;
/** A place that moved less than this did not move: the hand is not that steady. */
export const NOTCH_ROUND_STILL_PX = 5;
/** A place that moved at least this much moved on. Between the two it is neither, and there is no round. */
export const NOTCH_ROUND_MOVE_PX = 8;
/** The longest one round may take by hand, and the longest pause between two. */
export const NOTCH_ROUND_MAX_MS = 90_000;
/** How many steps of what was watched are kept. */
export const NOTCH_WATCH_KEPT = 80;

const KEYS = /^(?:(?:ctrl|alt|shift|win),)*(?:[a-z0-9]|enter|tab|delete|insert|pageup|pagedown|end|home|left|up|right|down|backspace|space|f(?:[1-9]|1[0-2]))$/;
const MODS = /^(?:ctrl|shift|alt)(?:,(?:ctrl|shift|alt))*$/;

/**
 * Whether a text names a key that is a step: a named key, alone or with
 * others held, or a letter or digit with Ctrl, Alt or Win. A letter alone, or
 * with Shift only, is typing: the desktop app never tells one, and one that
 * arrived anyway is not kept or pressed.
 */
export function watchKeysOk(spec: string): boolean {
  if (spec.length > 40 || !KEYS.test(spec)) return false;
  const parts = spec.split(',');
  const types = /^(?:[a-z0-9]|backspace|space)$/.test(parts.at(-1)!);
  return !types || parts.some((part) => part === 'ctrl' || part === 'alt' || part === 'win');
}

function winOf(raw: unknown): WatchWin | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const win = raw as Record<string, unknown>;
  const whole = (value: unknown, most: number): number | null =>
    (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= most ? value : null);
  const id = typeof win.id === 'string' && /^0x[0-9a-f]{1,16}$/.test(win.id) ? win.id : null;
  const pid = whole(win.pid, 0xffffffff);
  const w = whole(win.w, 100_000);
  const h = whole(win.h, 100_000);
  return id && pid && w && h ? { id, pid, w, h } : null;
}

const appOf = (raw: unknown): string =>
  (typeof raw === 'string' ? raw.replace(/[^\w .-]+/g, '').trim().slice(0, 60) : '');

/**
 * Reads one `notch.watch` event. Anything that is not exactly a shape is
 * null: the desktop app is the brain's own, but what it sends has crossed a
 * socket as text.
 */
export function parseWatchEvent(payload: unknown, now: number): WatchStep | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as Record<string, unknown>;
  const at = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : now;
  if (raw.kind === 'gap') return { kind: 'gap', at };
  if (raw.kind === 'typed') return { kind: 'typed', at };
  const win = winOf(raw.win);
  if (!win) return null;
  const app = appOf(raw.app);
  if (raw.kind === 'keys') {
    return typeof raw.keys === 'string' && watchKeysOk(raw.keys) ? { kind: 'keys', app, win, keys: raw.keys, at } : null;
  }
  if (raw.kind !== 'click') return null;
  const pt = (typeof raw.pt === 'object' && raw.pt !== null ? raw.pt : {}) as Record<string, unknown>;
  const { x, y } = pt;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y)) return null;
  // A click told for a place outside its own window is not a click in it.
  if (x < 0 || y < 0 || x >= win.w || y >= win.h) return null;
  const mods = typeof raw.mods === 'string' && MODS.test(raw.mods) ? raw.mods : undefined;
  return { kind: 'click', app, win, x, y, at, ...(mods ? { mods } : {}) };
}

const sameWin = (a: WatchWin, b: WatchWin): boolean => a.id === b.id && a.pid === b.pid && a.w === b.w && a.h === b.h;

/** How two steps at the same position of two rounds compare. */
function between(a: WatchStep, b: WatchStep): { dx: number; dy: number } | 'same' | null {
  if (a.kind === 'keys' && b.kind === 'keys') return a.keys === b.keys && sameWin(a.win, b.win) ? 'same' : null;
  if (a.kind !== 'click' || b.kind !== 'click') return null;
  if (!sameWin(a.win, b.win) || (a.mods ?? '') !== (b.mods ?? '')) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const still = (d: number): boolean => Math.abs(d) < NOTCH_ROUND_STILL_PX;
  const moved = (d: number): boolean => Math.abs(d) >= NOTCH_ROUND_MOVE_PX;
  if (still(dx) && still(dy)) return 'same';
  // Things in a row or a column stand in a line: it moves on along one axis, and holds on the other.
  if (moved(dy) && still(dx)) return { dx: 0, dy };
  if (moved(dx) && still(dy)) return { dx, dy: 0 };
  if (moved(dx) && moved(dy)) return { dx, dy };
  return null;
}

const COPY = new Set(['ctrl,c', 'ctrl,x', 'ctrl,insert']);
const PASTE = new Set(['ctrl,v', 'shift,insert', 'ctrl,shift,v']);

/**
 * The round the person has just done twice (or more), if there is one: the
 * shortest run of steps at the end of `steps` that was done at least twice
 * running, each time one place further along.
 */
export function findRounds(steps: WatchStep[]): Rounds | null {
  // Only what came after the last thing that was not seen.
  let from = steps.length;
  while (from > 0 && steps[from - 1]!.kind !== 'gap' && steps[from - 1]!.kind !== 'typed') from--;
  const seen = steps.slice(from);
  for (let length = 1; length <= NOTCH_ROUND_MAX_STEPS; length++) {
    if (seen.length < 2 * length) break;
    const last = seen.slice(seen.length - length);
    const before = seen.slice(seen.length - 2 * length, seen.length - length);
    const moves: ({ dx: number; dy: number } | 'same')[] = [];
    let fits = true;
    for (let i = 0; i < length && fits; i++) {
      const move = between(before[i]!, last[i]!);
      if (move === null) fits = false; else moves.push(move);
    }
    if (!fits) continue;
    // Something has to move on, or there is no "rest" to do.
    if (!moves.some((move) => move !== 'same')) continue;
    // Done at an even pace: neither round took long, and they were done one after the other.
    if (last.at(-1)!.at - last[0]!.at > NOTCH_ROUND_MAX_MS || before.at(-1)!.at - before[0]!.at > NOTCH_ROUND_MAX_MS) continue;
    if (last[0]!.at - before.at(-1)!.at > NOTCH_ROUND_MAX_MS) continue;
    // How many rounds before these two were the same again.
    let shown = 2;
    for (let end = seen.length - 2 * length; end - length >= 0; end -= length) {
      const earlier = seen.slice(end - length, end);
      const later = seen.slice(end, end + length);
      const same = earlier.every((step, i) => {
        const move = between(step, later[i]!);
        const want = moves[i]!;
        if (move === null) return false;
        if (want === 'same' || move === 'same') return want === move;
        return Math.abs(move.dx - want.dx) < NOTCH_ROUND_STILL_PX && Math.abs(move.dy - want.dy) < NOTCH_ROUND_STILL_PX;
      });
      if (!same) break;
      shown++;
    }
    const hasKeys = last.some((step) => step.kind === 'keys');
    // Clicks alone, twice, are not yet a pattern.
    if (!hasKeys && shown < 3) continue;
    let clicks = 0;
    const out: RoundStep[] = last.map((step, i): RoundStep => {
      if (step.kind === 'keys') {
        return { kind: 'keys', app: step.app, win: step.win, keys: step.keys, ...(COPY.has(step.keys) ? { copy: true } : {}), ...(PASTE.has(step.keys) ? { paste: true } : {}) };
      }
      const click = step as Extract<WatchStep, { kind: 'click' }>;
      const move = moves[i]!;
      // One of Jarvis's pointers for each place a round touches, up to three.
      const hand = Math.min(clicks++, 2);
      return {
        kind: 'click', app: click.app, win: click.win, x: click.x, y: click.y,
        dx: move === 'same' ? 0 : move.dx, dy: move === 'same' ? 0 : move.dy, hand,
        ...(click.mods ? { mods: click.mods } : {}),
      };
    });
    return { steps: out, shown, at: last.at(-1)!.at };
  }
  return null;
}

/** Where a click of round `k` lands (1 is the first round after the last one done by hand). Null when that is outside its window. */
export function roundPlace(step: Extract<RoundStep, { kind: 'click' }>, k: number): { x: number; y: number } | null {
  const x = step.x + k * step.dx;
  const y = step.y + k * step.dy;
  return x >= 0 && y >= 0 && x < step.win.w && y < step.win.h ? { x, y } : null;
}

/**
 * How many rounds fit before a place leaves its window. Not how many are
 * left to do: only the most there could be.
 */
export function roundsThatFit(rounds: Rounds, most: number): number {
  let fit = most;
  for (const step of rounds.steps) {
    if (step.kind !== 'click' || (step.dx === 0 && step.dy === 0)) continue;
    let k = 0;
    while (k < fit && roundPlace(step, k + 1)) k++;
    fit = k;
  }
  return fit;
}

/**
 * What makes two rounds the same job: their steps, windows and moves. For "do
 * not offer this again". A round is a circle: the person who stops after the
 * click in the file and the one who stops after the paste are in the same
 * job, at another step of it. So the name is the same wherever the round is
 * taken to begin.
 */
export function roundsName(rounds: Rounds): string {
  const parts = rounds.steps.map((step) => (step.kind === 'keys'
    ? `k:${step.win.id}:${step.keys}`
    : `c:${step.win.id}:${step.mods ?? ''}:${Math.sign(step.dx)}:${Math.sign(step.dy)}`));
  let best = parts.join('|');
  for (let turn = 1; turn < parts.length; turn++) {
    const turned = [...parts.slice(turn), ...parts.slice(0, turn)].join('|');
    if (turned < best) best = turned;
  }
  return best;
}

/** Where in a round the click is that says where the things come from: the one before the copy, going round. -1 when there is none. */
function sourceAt(rounds: Rounds): number {
  const steps = rounds.steps;
  const copyAt = steps.findIndex((step) => step.kind === 'keys' && step.copy);
  if (copyAt >= 0) {
    for (let back = 1; back < steps.length; back++) {
      const i = (copyAt - back + steps.length) % steps.length;
      if (steps[i]!.kind === 'click') return i;
    }
  }
  return steps.findIndex((step) => step.kind === 'click' && (step.dx !== 0 || step.dy !== 0));
}

/** The click that says where the things come from: the one before the copy, or else the first that moves on. */
export function roundsSource(rounds: Rounds): Extract<RoundStep, { kind: 'click' }> | null {
  const step = rounds.steps[sourceAt(rounds)];
  return step && step.kind === 'click' ? step : null;
}

/**
 * How many rounds there are to do, given how many things stand after the
 * last one the person picked. When the person has already picked the next
 * thing and not yet copied it (the round, as it stands, copies before it
 * picks), that thing is still to be done: one more.
 */
export function roundsToDo(rounds: Rounds, after: number): number {
  const copyAt = rounds.steps.findIndex((step) => step.kind === 'keys' && step.copy);
  return copyAt >= 0 && sourceAt(rounds) > copyAt ? after + 1 : after;
}

/** The programs a round touches, in the order it touches them, each once. */
export function roundsApps(rounds: Rounds): string[] {
  const apps: string[] = [];
  for (const step of rounds.steps) if (step.app && !apps.includes(step.app)) apps.push(step.app);
  return apps;
}

/** Whether a round copies something and puts it somewhere: then "nothing left to copy" ends the job. */
export const roundsCopy = (rounds: Rounds): boolean => rounds.steps.some((step) => step.kind === 'keys' && step.copy);
