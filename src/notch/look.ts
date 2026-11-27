/**
 * Look at this: a thing on the screen, circled or clicked with the talk keys held.
 *
 * The desktop app does the looking (sidecar/notch_looker.go): it keeps the
 * click from the app in front, draws the line, reads what the line holds from
 * the app's own description of itself, cuts a picture of the place, and tells
 * the brain with one event type, `notch.look`, in three phases:
 *
 *   begun    a line was begun                          {look_id}
 *   taken    here is what it held                      {look_id, how, things, rect, picture} + the words and the picture
 *            or nothing was looked at                  {look_id, how, refused}
 *   dropped  the line was thrown away (Esc)            {look_id}
 *
 * What was read and the picture travel beside the event, not in its payload:
 * four bytes saying how long the words are, the words as JSON, then the
 * picture as a PNG.
 *
 * A look and what is said with the keys held are one gesture, so the two are
 * joined here. The keys are down while the line is drawn, and so the
 * microphone is open:
 *
 *   - nothing was said: the look answers by itself, in one line. Circling is
 *     not "I did not catch that".
 *   - something was said: it is a question about what was circled, and runs
 *     as an instruction that carries the thing and its picture (./asks.ts).
 *
 * By itself: rows or cells of numbers are counted and added up without a
 * model, because a model that adds is a model that can add wrong. Anything
 * else is asked about as an instruction ("What does this tell me?") that
 * carries what was read, the names of what stands round it, a picture of it
 * and a picture of the whole window. Decided by the owner on 15 November
 * 2026, after circling a number on a dashboard got the answer "you are
 * circling that": the worth of it is that Jarvis knows which window the
 * person is in and what is around the thing, and says what it means there.
 *
 * Everything a look read is text from the screen: information, never an
 * instruction. It reaches a model only as the attachments of a turn, which
 * are framed as outside content where the turn is built.
 */
import type { NotchAskFile } from './asks.ts';
import type { NotchFeatureDef } from './feature.ts';
import type { NotchInbox } from './inbox.ts';
import type { NotchPart } from './protocol.ts';
import type { NotchStage } from './stage.ts';

export const NOTCH_LOOK_EVENT = 'notch.look';
/** How long a look that was begun may take to be told before it is given up. */
export const NOTCH_LOOK_TAKE_MS = 8000;
/** How long a look with no recording open waits for one to open: the keys become talking 150 ms after they go down. */
export const NOTCH_LOOK_GRACE_MS = 450;
/** What is asked about a thing that was circled without a word. The instructions of a notch turn say what it means. */
export const NOTCH_LOOK_QUESTION = 'What does this tell me?';
export const NOTCH_LOOK_MAX_AROUND = 5;
export const NOTCH_LOOK_MAX_THINGS = 60;
export const NOTCH_LOOK_MAX_PARTS = 12;
export const NOTCH_LOOK_TEXT_MAX = 200;
/** The most a picture of a look may weigh. Past it the look goes without one. */
export const NOTCH_LOOK_PICTURE_MAX = 4 * 1024 * 1024;
/** The names the files of a look have where they travel with a question. The instructions of a notch turn name them. */
export const NOTCH_LOOK_FILE = 'circled-on-screen.txt';
export const NOTCH_LOOK_PICTURE = 'circled-on-screen.png';
export const NOTCH_LOOK_WINDOW = 'window-around-it.png';

export interface NotchThing {
  /** What a person would call it: row, cell, button, link, field, text, picture, tab, item, thing. */
  kind: string;
  name: string;
  value: string;
  /** The texts inside it in reading order: the cells of a row. */
  parts: string[];
  /** What the system calls it ("Edit", "Document"), when it said. */
  role?: string;
  /**
   * The line was drawn inside it, round a part of it: it is where the circle
   * is, not what was circled. A page whose program says nothing more about
   * it is this, whatever was circled on it.
   */
  over?: boolean;
}

export interface NotchLooked {
  id: string;
  how: 'click' | 'loop' | 'keys';
  /** Why nothing was looked at, or ''. */
  refused: string;
  app: string;
  title: string;
  /** The names of what the things stand in, the nearest first: the panel, the list, the page. */
  around: string[];
  things: NotchThing[];
  /** What was circled, close up. */
  picture: Uint8Array | null;
  /** The whole window round it, made smaller. */
  window: Uint8Array | null;
  /** The middle of what was clicked or circled, in the screen's own pixels, when the desktop app said where. */
  at?: { x: number; y: number };
}

const em = (text: string): NotchPart => ({ em: text });

const clean = (value: unknown, max = NOTCH_LOOK_TEXT_MAX): string =>
  (typeof value === 'string' ? value : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** A PNG, and not one too heavy to be shown to a model. */
const png = (bytes: Uint8Array): Uint8Array | null =>
  (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes.length <= NOTCH_LOOK_PICTURE_MAX ? bytes : null);

/**
 * What travelled beside a `taken` event: what was read, the picture of what
 * was circled, and the picture of the window round it. The words say how
 * long the first picture is; the second is what follows it. Null when it
 * cannot be read.
 */
export function parseNotchLookBody(bytes: Uint8Array): Pick<NotchLooked, 'app' | 'title' | 'around' | 'things' | 'picture' | 'window'> | null {
  if (bytes.length < 4) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (length > bytes.length - 4 || length > 1024 * 1024) return null;
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))); } catch { return null; }
  if (typeof raw !== 'object' || raw === null) return null;
  const told = raw as { app?: unknown; title?: unknown; around?: unknown; things?: unknown; picture_bytes?: unknown };
  const things: NotchThing[] = [];
  for (const entry of Array.isArray(told.things) ? told.things.slice(0, NOTCH_LOOK_MAX_THINGS) : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const thing = entry as { kind?: unknown; name?: unknown; value?: unknown; parts?: unknown; role?: unknown; over?: unknown };
    things.push({
      kind: /^[a-z][a-z ]{0,19}$/.test(typeof thing.kind === 'string' ? thing.kind : '') ? (thing.kind as string) : 'thing',
      name: clean(thing.name),
      value: clean(thing.value),
      parts: (Array.isArray(thing.parts) ? thing.parts.slice(0, NOTCH_LOOK_MAX_PARTS) : []).map((part) => clean(part)).filter(Boolean),
      ...(typeof thing.role === 'string' && /^[A-Za-z]{1,24}$/.test(thing.role) ? { role: thing.role } : {}),
      ...(thing.over === true ? { over: true } : {}),
    });
  }
  const around = (Array.isArray(told.around) ? told.around.slice(0, 40) : []).map((name) => clean(name, 80)).filter(Boolean).slice(0, NOTCH_LOOK_MAX_AROUND);
  const rest = bytes.subarray(4 + length);
  // A desktop app from before the second picture says nothing of lengths: then everything is the first.
  const first = typeof told.picture_bytes === 'number' && Number.isInteger(told.picture_bytes) && told.picture_bytes >= 0 && told.picture_bytes <= rest.length
    ? told.picture_bytes : rest.length;
  return {
    app: clean(told.app, 80), title: clean(told.title, 160), around, things,
    picture: png(rest.subarray(0, first)), window: png(rest.subarray(first)),
  };
}

// ---------------------------------------------------------------------------
// Counting, and adding up
// ---------------------------------------------------------------------------

export interface LookNumber { value: number; unit: string; decimals: number }

/**
 * A text that is one number, as people write them in tables: "1,291.00",
 * "1.291,00", "$430.33", "12 %", "(45)" for minus 45, "1 291". Null for
 * anything else: a date, a time, a size with its unit, a phone number.
 */
export function lookNumber(text: string): LookNumber | null {
  let rest = text.replace(/[  ]/g, ' ').trim();
  if (!rest || rest.length > 32) return null;
  let unit = '';
  const take = (pattern: RegExp, as?: string): void => {
    const found = pattern.exec(rest);
    if (found && !unit) { unit = as ?? found[1]!; rest = rest.replace(pattern, '').trim(); }
  };
  take(/^([$€£¥])/);
  take(/([$€£¥])$/);
  take(/^(EUR|USD|GBP|CHF)\b/i);
  take(/\b(EUR|USD|GBP|CHF)$/i);
  take(/(%)$/);
  let negative = false;
  if (/^\(.*\)$/.test(rest)) { negative = true; rest = rest.slice(1, -1).trim(); }
  if (/^[-−]/.test(rest)) { negative = !negative; rest = rest.slice(1).trim(); } else if (rest.startsWith('+')) rest = rest.slice(1).trim();
  if (!unit) { take(/^([$€£¥])/); }
  // Spaces and apostrophes only between groups of three digits.
  if (/[ ']/.test(rest)) {
    if (!/^\d{1,3}([ ']\d{3})+([.,]\d+)?$/.test(rest)) return null;
    rest = rest.replace(/[ ']/g, '');
  }
  if (!/^\d[\d.,]*$/.test(rest) || /[.,]$/.test(rest)) return null;
  const dots = (rest.match(/\./g) ?? []).length;
  const commas = (rest.match(/,/g) ?? []).length;
  let whole = rest;
  let fraction = '';
  const split = (mark: string, other: string): boolean => {
    const at = rest.lastIndexOf(mark);
    whole = rest.slice(0, at);
    fraction = rest.slice(at + 1);
    // What is left of the decimal mark is groups of three, parted by the other mark or by nothing.
    if (whole.includes(mark)) return false;
    if (whole.includes(other) && !new RegExp(`^\\d{1,3}(\\${other}\\d{3})+$`).test(whole)) return false;
    whole = whole.split(other).join('');
    return true;
  };
  if (dots && commas) {
    // Both: the one that comes last is the decimal mark.
    if (!(rest.lastIndexOf('.') > rest.lastIndexOf(',') ? split('.', ',') : split(',', '.'))) return null;
  } else if (dots + commas === 1) {
    const mark = dots ? '.' : ',';
    const after = rest.length - rest.indexOf(mark) - 1;
    // One mark with three digits after it parts thousands ("1,291"); with any other count it is the decimal mark.
    if (after === 3 && rest.indexOf(mark) <= 3) whole = rest.replace(mark, '');
    else if (!split(mark, mark === '.' ? ',' : '.')) return null;
  } else if (dots + commas > 1) {
    // The same mark several times parts thousands.
    if (!/^\d{1,3}([.,]\d{3})+$/.test(rest)) return null;
    whole = rest.replace(/[.,]/g, '');
  }
  if (!/^\d+$/.test(whole) || (fraction && !/^\d+$/.test(fraction)) || whole.length > 15) return null;
  const value = Number(fraction ? `${whole}.${fraction}` : whole);
  if (!Number.isFinite(value)) return null;
  return { value: negative ? -value : value, unit: unit.length === 3 ? unit.toUpperCase() : unit, decimals: fraction.length };
}

/** A sum as it is said: grouped in threes, with the decimals the numbers had, and their unit when they all had the same one. */
export function lookAmount(value: number, decimals: number, unit: string): string {
  const digits = Math.min(Math.max(decimals, 0), 4);
  const said = Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = value < 0 ? '-' : '';
  if (unit === '%') return `${sign}${said}%`;
  if (unit.length === 3) return `${sign}${said} ${unit}`;
  return `${sign}${unit}${said}`;
}

const PLURALS: Record<string, string> = {
  row: 'rows', cell: 'cells', button: 'buttons', link: 'links', field: 'fields', text: 'texts', picture: 'pictures',
  tab: 'tabs', item: 'items', 'menu item': 'menu items', box: 'boxes', heading: 'headings', thing: 'things',
};

/** What a thing says, as its cells: the cells of a row, or the one text of anything else. */
const cellsOf = (thing: NotchThing): string[] => (thing.parts.length ? thing.parts : [thing.value || thing.name].filter(Boolean));

/** How many of what: "3 rows", "2 things". */
export function lookCount(things: NotchThing[]): string {
  const [first] = things;
  if (!first) return 'nothing';
  const kind = things.every((thing) => thing.kind === first.kind) ? first.kind : 'thing';
  return things.length === 1 ? `1 ${kind}` : `${things.length} ${PLURALS[kind] ?? 'things'}`;
}

/**
 * The sums of several things, column by column: a column is added up when
 * every thing has a number there. Empty when nothing can be added.
 */
export function lookSums(things: NotchThing[]): string[] {
  if (things.length < 2) return [];
  const rows = things.map(cellsOf);
  const width = rows[0]!.length;
  const columns: (LookNumber | null)[][] = [];
  if (width > 0 && rows.every((row) => row.length === width)) {
    for (let column = 0; column < width; column++) columns.push(rows.map((row) => lookNumber(row[column]!)));
  } else {
    // Rows of different lengths: the one number of each, when each has exactly one.
    const ones = rows.map((row) => row.map(lookNumber).filter((found): found is LookNumber => found !== null));
    if (ones.every((found) => found.length === 1)) columns.push(ones.map((found) => found[0]!));
  }
  const sums: string[] = [];
  for (const column of columns) {
    if (column.some((found) => found === null)) continue;
    const numbers = column as LookNumber[];
    const unit = numbers.every((found) => found.unit === numbers[0]!.unit) ? numbers[0]!.unit : '';
    const decimals = Math.max(...numbers.map((found) => found.decimals));
    // Added as whole numbers of the smallest decimal, so that 0.1 and 0.2 are 0.3.
    const scale = 10 ** Math.min(decimals, 6);
    const total = numbers.reduce((sum, found) => sum + Math.round(found.value * scale), 0) / scale;
    sums.push(lookAmount(total, decimals, unit));
  }
  return sums;
}

/**
 * Whether several things are answered by arithmetic alone: rows or cells, all
 * of one kind, with numbers that add up. Then the count and the sum are the
 * answer, at once and without a model.
 */
export function lookAddsUp(things: NotchThing[]): boolean {
  const [first] = things;
  if (!first || things.length < 2 || (first.kind !== 'row' && first.kind !== 'cell')) return false;
  return things.every((thing) => thing.kind === first.kind) && lookSums(things).length > 0;
}

const short = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** What one thing is called on a line: its name, or what it says. */
const nameOf = (thing: NotchThing): string => thing.name || thing.value || thing.parts.join(' · ');

/**
 * The one line about several things, made without a model: how many, and
 * what they add up to when they are numbers; their names when they are not.
 */
export function lookSeveral(things: NotchThing[]): NotchPart[] {
  const count = lookCount(things);
  const sums = lookSums(things).slice(0, 3);
  if (sums.length === 1) return [em(count), '. They add up to ', em(sums[0]!), '.'];
  if (sums.length > 1) return [em(count), '. The columns add up to ', em(sums.slice(0, -1).join(', ')), ' and ', em(sums.at(-1)!), '.'];
  const names = things.map(nameOf).filter(Boolean).map((name) => short(name, 28));
  if (names.length === 0) return [em(count), '.'];
  const shown = names.slice(0, 3).join(', ');
  return [em(count), ': ', shown, names.length > 3 ? `, and ${names.length - 3} more.` : '.'];
}

/** The line about one thing when no model can be asked: what it is called and what it says. */
export function lookOne(thing: NotchThing): NotchPart[] {
  const name = nameOf(thing);
  const rest = thing.parts.filter((part) => part !== name).join(' · ') || (thing.value && thing.value !== name ? thing.value : '');
  if (!name) return ['A ', thing.kind, ' with no name I can read.'];
  return rest ? [em(short(name, 60)), ': ', short(rest, 150)] : [em(short(name, 120)), `, a ${thing.kind}.`];
}

const REFUSALS: Record<string, string> = {
  off: 'Watching is switched off, so I did not look.',
  password: 'A password is being typed. I am not looking.',
  bank: 'Your bank. I look away in here.',
  never: 'You told me never to watch this app, so I did not look.',
  private: 'I look away in this window, so I did not look.',
};

/** Why nothing was looked at, as it is said. */
export const lookRefusal = (reason: string): string => REFUSALS[reason] ?? 'I am not looking in here.';

// ---------------------------------------------------------------------------
// For a model
// ---------------------------------------------------------------------------

/** What a look read, as plain text: where it was, what stands round it, and each thing on a line. */
export function lookText(looked: NotchLooked): string {
  const lines = [
    `App: ${looked.app || 'not known'}`,
    `Window: ${looked.title || 'not known'}`,
    ...(looked.around.length ? [`It stands in (nearest first): ${looked.around.join(' > ')}`] : []),
    looked.things.length ? `What the person ${looked.how === 'click' ? 'clicked' : 'circled'} (${lookCount(looked.things)}):` : 'Nothing there could be read as text.',
  ];
  looked.things.forEach((thing, at) => {
    const cells = cellsOf(thing).join(' | ');
    const name = thing.name && !cells.includes(thing.name) ? `${thing.name}: ` : '';
    lines.push(`${at + 1}. ${thing.kind}: ${name}${cells}`);
  });
  return lines.join('\n');
}

/** The files a question about a look carries: what was read, the picture of it, and the picture of the window round it. */
export function lookFiles(looked: NotchLooked): NotchAskFile[] {
  const files: NotchAskFile[] = [{ kind: 'document', name: NOTCH_LOOK_FILE, mediaType: 'text/plain', bytes: new TextEncoder().encode(lookText(looked)) }];
  if (looked.picture) files.push({ kind: 'screenshot', name: NOTCH_LOOK_PICTURE, mediaType: 'image/png', bytes: looked.picture });
  if (looked.window) files.push({ kind: 'screenshot', name: NOTCH_LOOK_WINDOW, mediaType: 'image/png', bytes: looked.window });
  return files;
}

// ---------------------------------------------------------------------------
// On the notch
// ---------------------------------------------------------------------------

export interface NotchLookPort {
  onEvent(listener: (sidecarId: string, event: { event_type: string; payload: unknown; binary?: unknown }) => void): void;
  onSidecarDisconnected?(listener: (sidecarId: string) => void): void;
}

export interface NotchLookDeps {
  inbox: NotchInbox;
  /** Runs a question about what was looked at, with its files. */
  ask(text: string, files: NotchAskFile[]): void;
  /** Whether a recording is open on that desktop app: the talk keys are still held. */
  talking(sidecarId: string): boolean;
  /** Whether a model would answer now. Taken as yes when not given. With none, what was read is said as it is. */
  modelReady?: () => boolean;
  /** Everything is stopped (Esc twice). */
  paused?: () => boolean;
  /**
   * A look was told (./put.ts). True when it was a place pointed at while a
   * thing is held: then it is asked "put it here?" there, and the look
   * neither answers nor goes with any words.
   */
  shown?: (sidecarId: string, looked: NotchLooked) => boolean;
  /** A look was taken and read: the notch blinks, as a shutter does, and swallows it. */
  seen?: () => void;
  now?: () => number;
  graceMs?: number;
  takeMs?: number;
  log?: (line: string) => void;
}

export interface NotchLook {
  /** Whether a look was begun on that desktop app since a moment, and has not had its say. */
  during(sidecarId: string, since: number): boolean;
  /** The keys came up and nothing was said: the look answers by itself, when it is there. */
  alone(sidecarId: string): void;
  /** The keys came up and something was said: what was looked at, to go with the words. Null when none comes. */
  claim(sidecarId: string): Promise<NotchLooked | null>;
  /** The same, as the files the words carry. */
  files(sidecarId: string): Promise<NotchAskFile[] | null>;
  stop(): void;
}

interface Under {
  id: string;
  begunAt: number;
  looked: NotchLooked | null;
  /** What is to be done with it once it is there. */
  then: 'undecided' | 'alone' | 'claimed' | 'done';
  waiters: ((looked: NotchLooked | null) => void)[];
  timer: ReturnType<typeof setTimeout> | null;
}

export function attachNotchLook(port: NotchLookPort, deps: NotchLookDeps): NotchLook {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => Date.now());
  const graceMs = deps.graceMs ?? NOTCH_LOOK_GRACE_MS;
  const takeMs = deps.takeMs ?? NOTCH_LOOK_TAKE_MS;
  const under = new Map<string, Under>();
  /**
   * Looks whose words went on without them, because they took too long to be
   * read. If one arrives after all it is not answered by itself: the question
   * it belonged to has been asked, and "what does this tell me?" on top of it
   * would be a second answer to something else.
   */
  const late = new Set<string>();
  /**
   * When a look was last taken as a place to put something, for each desktop
   * app. Such a look is over at once, but the hold of the keys it was made in
   * is not: with nothing said in it, that hold is still not "I did not catch
   * that". The person pointed, and the notch is asking them about it.
   */
  const pointed = new Map<string, number>();
  let said = 0;
  let stopped = false;

  const clear = (look: Under): void => {
    if (look.timer) clearTimeout(look.timer);
    look.timer = null;
  };
  const after = (look: Under, ms: number, run: () => void): void => {
    clear(look);
    look.timer = setTimeout(() => { look.timer = null; run(); }, ms);
    (look.timer as { unref?: () => void }).unref?.();
  };
  const end = (sidecarId: string, look: Under, looked: NotchLooked | null): void => {
    clear(look);
    look.then = 'done';
    for (const wake of look.waiters.splice(0)) wake(looked);
    if (under.get(sidecarId) === look) under.delete(sidecarId);
  };

  /** One line that is the look's own: it was asked for, so it takes the notch now. */
  function say(script: (stage: NotchStage) => Promise<void>): void {
    const id = `look-${++said}`;
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true, urgent: true, once: true, asked: true,
      title: () => ['What you showed me'],
      play: async (stage) => { await script(stage); return 'settled'; },
    });
  }
  const lineMs = (parts: NotchPart[]): number => {
    const length = parts.reduce((sum, part) => sum + (typeof part === 'string' ? part.length : 'em' in part ? part.em.length : 0), 0);
    return Math.min(12_000, Math.max(4500, 2500 + length * 55));
  };

  /** The look answers by itself. */
  function answer(looked: NotchLooked): void {
    if (stopped) return;
    if (looked.refused) {
      say((stage) => stage.say([lookRefusal(looked.refused)], 3600, { mood: 'careful' }));
      return;
    }
    if (deps.paused?.()) {
      say((stage) => stage.say(['Everything is stopped. Wake me first.'], 3200, { mood: 'careful' }));
      return;
    }
    const [only] = looked.things;
    // Rows or cells of numbers: counted and added up here, at once.
    if (lookAddsUp(looked.things)) {
      const line = lookSeveral(looked.things);
      say((stage) => stage.say(line, lineMs(line)));
      return;
    }
    if (!only && !looked.picture && !looked.window) {
      say((stage) => stage.say(['I could not read what that is.'], 3600, { mood: 'confused' }));
      return;
    }
    if (deps.modelReady?.() === false) {
      // No model to ask what it means: what was read is said as it is.
      const line: NotchPart[] = !only ? ['I could not read what that is.'] : looked.things.length === 1 ? lookOne(only) : lookSeveral(looked.things);
      say((stage) => stage.say(line, lineMs(line)));
      return;
    }
    // What it means where it stands: asked as an instruction that carries what
    // was read, what is round it, and the pictures.
    deps.ask(NOTCH_LOOK_QUESTION, lookFiles(looked));
  }

  /** A look is there. What was decided for it, or what the keys are doing now, says what happens to it. */
  function settle(sidecarId: string, look: Under): void {
    const looked = look.looked;
    if (!looked) return;
    if (look.then === 'claimed') { end(sidecarId, look, looked); return; }
    if (look.then === 'alone') { end(sidecarId, look, looked); answer(looked); return; }
    // Refused: said at once, whatever is being said into the microphone.
    if (looked.refused) { end(sidecarId, look, looked); answer(looked); return; }
    if (deps.talking(sidecarId)) {
      // The keys are still held: what is said, or that nothing is, decides. The longest a recording may be is a minute.
      after(look, 75_000, () => { end(sidecarId, look, looked); answer(looked); });
      return;
    }
    // No recording is open. One may be about to: the keys become talking a moment after they go down.
    after(look, graceMs, () => {
      if (look.then !== 'undecided') return;
      if (deps.talking(sidecarId)) { settle(sidecarId, look); return; }
      end(sidecarId, look, looked);
      answer(looked);
    });
  }

  port.onSidecarDisconnected?.((sidecarId) => {
    pointed.delete(sidecarId);
    const look = under.get(sidecarId);
    if (look) end(sidecarId, look, null);
  });

  port.onEvent((sidecarId, event) => {
    if (event.event_type !== NOTCH_LOOK_EVENT || stopped) return;
    const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
    const id = typeof payload.look_id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(payload.look_id) ? payload.look_id : null;
    if (!id) return;
    const phase = payload.phase;
    if (phase === 'begun') {
      const before = under.get(sidecarId);
      if (before && before.id !== id) end(sidecarId, before, null);
      const look: Under = { id, begunAt: now(), looked: null, then: 'undecided', waiters: [], timer: null };
      under.set(sidecarId, look);
      // A line that is never finished or dropped (the desktop app went away in the middle) is given up.
      after(look, 5 * 60_000, () => end(sidecarId, look, null));
      return;
    }
    let look = under.get(sidecarId);
    if (phase === 'dropped') {
      if (look?.id === id) end(sidecarId, look, null);
      return;
    }
    if (phase !== 'taken') return;
    if (late.delete(id)) return;
    // A click can be told before its `begun`: both are for the same look.
    if (!look || look.id !== id) {
      if (look) end(sidecarId, look, null);
      look = { id, begunAt: now(), looked: null, then: 'undecided', waiters: [], timer: null };
      under.set(sidecarId, look);
    }
    const how = payload.how === 'click' || payload.how === 'keys' ? payload.how : 'loop';
    const refused = typeof payload.refused === 'string' ? payload.refused.slice(0, 40) : '';
    let body: ReturnType<typeof parseNotchLookBody> = null;
    const binary = event.binary as { type?: string; data?: string } | undefined;
    if (!refused && binary?.type === 'inline' && typeof binary.data === 'string') {
      try { body = parseNotchLookBody(Buffer.from(binary.data, 'base64')); } catch { body = null; }
    }
    // Counts, never what was read.
    log(`[notch] a look was told: ${how}, ${refused ? `refused (${refused})` : `${body?.things.length ?? 0} thing(s), ${body?.around.length ?? 0} name(s) round them, picture ${body?.picture?.length ?? 0} bytes, window ${body?.window?.length ?? 0} bytes`}`);
    const rect = (typeof payload.rect === 'object' && payload.rect !== null ? payload.rect : {}) as Record<string, unknown>;
    const place = [rect.x, rect.y, rect.w, rect.h].every((value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 200_000)
      ? { x: Math.round((rect.x as number) + (rect.w as number) / 2), y: Math.round((rect.y as number) + (rect.h as number) / 2) } : undefined;
    look.looked = {
      id, how, refused, app: body?.app ?? '', title: body?.title ?? '', around: body?.around ?? [], things: body?.things ?? [],
      picture: body?.picture ?? null, window: body?.window ?? null, ...(place ? { at: place } : {}),
    };
    if (!refused) { try { deps.seen?.(); } catch { /* a sign, and nothing depends on it */ } }
    let taken = false;
    try { taken = deps.shown?.(sidecarId, look.looked) === true; } catch (error) {
      log(`[notch] a look could not be held: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Pointed at as a place to put something: asked about there, and nothing else comes of this look.
    if (taken) { pointed.set(sidecarId, look.begunAt); end(sidecarId, look, null); return; }
    settle(sidecarId, look);
  });

  const claim = (sidecarId: string): Promise<NotchLooked | null> => {
    const look = under.get(sidecarId);
    if (!look || look.then === 'done') return Promise.resolve(null);
    look.then = 'claimed';
    if (look.looked) {
      const looked = look.looked;
      end(sidecarId, look, looked);
      // A look that was refused has nothing to go with the words.
      return Promise.resolve(looked.refused ? null : looked);
    }
    return new Promise((resolve) => {
      look.waiters.push((looked) => resolve(looked && !looked.refused ? looked : null));
      after(look, takeMs, () => {
        if (late.size > 32) late.clear();
        late.add(look.id);
        log(`[notch] a look was not read within ${takeMs} ms: the words that came with it go on without it`);
        end(sidecarId, look, null);
      });
    });
  };

  return {
    claim,
    async files(sidecarId) {
      const looked = await claim(sidecarId);
      return looked ? lookFiles(looked) : null;
    },
    during(sidecarId, since) {
      const look = under.get(sidecarId);
      if (look && look.then !== 'done' && look.begunAt >= since) return true;
      return (pointed.get(sidecarId) ?? -1) >= since;
    },
    alone(sidecarId) {
      const look = under.get(sidecarId);
      if (!look || look.then === 'done') return;
      look.then = 'alone';
      if (look.looked) settle(sidecarId, look);
      // Still being read: it answers when it is told, and not for ever.
      else after(look, takeMs, () => end(sidecarId, look, null));
    },
    stop() {
      stopped = true;
      for (const [sidecarId, look] of [...under]) end(sidecarId, look, null);
    },
  };
}

/**
 * Look at this (pass 9) as a feature of the notch (./feature.ts). It is joined to talking, because the same keys
 * are held for both: what is said while a thing is circled is about it. A look is asked about as an
 * instruction, so without the asks it is absent, and nothing is said.
 */
export function notchLookFeature(given: { port: NotchLookPort; modelReady?: NotchLookDeps['modelReady'] } | undefined): NotchFeatureDef<'look'> {
  return {
    id: 'look',
    wants: ['asks', 'talk', 'dayOne', 'put'],
    make(ctx) {
      const asks = ctx.use('asks');
      if (!given || !asks) return null;
      const api = attachNotchLook(given.port, {
        inbox: ctx.inbox,
        // Nothing was said with it: the question is the notch's own, not the owner's word.
        ask: (text, files) => { asks.shown(text, files); },
        talking: (sidecarId) => ctx.use('talk')?.open(sidecarId) ?? false,
        modelReady: given.modelReady,
        paused: () => ctx.paused(),
        // What was shown is held for a while, and a place pointed at meanwhile is where it goes (pass 10).
        // On day one, the first look anyone takes is the lesson, and nothing else comes of it.
        shown: (sidecarId, looked) => ctx.use('dayOne')?.shown(looked) === true || (ctx.use('put')?.shown(sidecarId, looked) ?? false),
        // The blink is the shutter, and what was circled is swallowed.
        seen: () => ctx.surface.act({ gesture: 'blink', kick: 230 }),
        log: ctx.log,
      });
      return { api, stop: () => api.stop() };
    },
  };
}
