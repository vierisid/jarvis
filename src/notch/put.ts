/**
 * Put it there (pass 10): show Jarvis a thing, then point at a place.
 *
 * A look (./look.ts) reads a thing off the screen. For ninety seconds after,
 * Jarvis still holds what it read. In that time, holding the talk keys over a
 * place that can take it (a field, a cell, a page of writing) shows "Put 3
 * rows here" beside the pointer, before anything is clicked: the desktop app
 * draws that (`notch.hold`). A click there is not a new look: the notch asks
 * "Put 3 rows here as a table?", and on a yes Jarvis's pointer goes to the
 * place and the thing is pasted in.
 *
 * The form is the point of it. Rows copied out of a sheet and pasted into a
 * document by hand come out as words with gaps between them. What Jarvis
 * puts somewhere goes as rows of cells with the form they are to take, and
 * the desktop app puts a real table (or a list) on the clipboard beside the
 * plain words (sidecar: pasteFlavours). So a document gets a table, a sheet
 * gets cells, and a plain field gets columns that line up. The form can be
 * changed on the line ("as a table", "a list", "plain text"), or said: "put
 * it here as a list". The owner, 16 November 2026: the feature "is only
 * useful if the formatting is done correctly".
 *
 * It can also be said without pointing: with a thing held, "put it here as a
 * table" puts it where the caret is in the window in front.
 *
 * What is put is what was read. Nothing is rewritten by a model on the way.
 *
 * What was put into a cell can be taken back from Today, on the same terms
 * as any paste of Jarvis's (./jobs.ts): only while the place still holds
 * exactly what was put there.
 */
import type { NotchInbox } from './inbox.ts';
import { actRefusal, type NotchJobHands, type NotchJobs, type NotchPut as NotchPutPlace } from './jobs.ts';
import { lookCount, type NotchLooked, type NotchThing } from './look.ts';
import type { NotchPart, NotchWord } from './protocol.ts';

/** How long a thing that was shown is held. */
export const NOTCH_HOLD_MS = 90_000;
/** How long after that Jarvis still says it has forgotten, when a place is pointed at. */
export const NOTCH_HOLD_FORGOT_MS = 5 * 60_000;
/** The most that is put in one go. */
export const NOTCH_PUT_MAX_CHARS = 20_000;
/** How long after "put it here?" was asked a few words still count as its answer. */
export const NOTCH_PUT_SAID_MS = 60_000;

/** The forms rows can be put in, as the line says them. */
export const NOTCH_PUT_FORMS = ['a table', 'a list', 'plain text'] as const;
export type NotchPutForm = (typeof NOTCH_PUT_FORMS)[number];
const AS: Record<NotchPutForm, 'table' | 'list' | 'text'> = { 'a table': 'table', 'a list': 'list', 'plain text': 'text' };

const em = (text: string): NotchPart => ({ em: text });
const word = (name: string, value: string, options: readonly string[], more: Partial<NotchWord> = {}): NotchPart =>
  ({ word: { name, value, options: [...options], ...more } });

export interface NotchHeld {
  /** A few words for it: "3 rows", "1,291". */
  what: string;
  /** What it says, as plain words: cells parted by tabs, rows by line ends. */
  text: string;
  /** The same as rows of cells, which is how it is put. */
  rows: string[][];
  app: string;
  at: number;
}

const cellsOf = (thing: NotchThing): string[] => (thing.parts.length ? thing.parts : [thing.value || thing.name].filter(Boolean));

/** What a look read, as a thing that can be put somewhere. Null when there is nothing to carry, or it was cut short when read. */
export function heldFrom(looked: NotchLooked, now: number): NotchHeld | null {
  if (looked.refused || looked.things.length === 0) return null;
  const rows = looked.things.map(cellsOf).filter((cells) => cells.length > 0);
  if (rows.length === 0) return null;
  // A text that was cut where it was read ends in a mark: half a text is not put anywhere.
  if (rows.some((cells) => cells.some((cell) => cell.endsWith('…')))) return null;
  const text = rows.map((cells) => cells.join('\t')).join('\n');
  if (!text.trim() || text.length > NOTCH_PUT_MAX_CHARS) return null;
  const one = text.replace(/\s+/g, ' ').trim();
  const what = looked.things.length > 1 ? lookCount(looked.things) : ([...one].length <= 24 ? one : `this ${looked.things[0]!.kind}`);
  return { what, text, rows, app: looked.app, at: now };
}

/** Whether what is held has a form to choose: several rows, or one row of several cells. One value is just put. */
export const heldIsTable = (held: NotchHeld): boolean => held.rows.length > 1 || (held.rows[0]?.length ?? 0) > 1;

/** Whether a thing is a place something can be put: a field, a cell, a page of writing. The desktop app asks the same (lookTakes). */
export function takesAThing(thing: NotchThing | undefined): boolean {
  if (!thing) return false;
  if (thing.kind === 'field' || thing.kind === 'cell') return true;
  return thing.role === 'Document' || thing.role === 'Edit' || thing.role === 'ComboBox' || thing.role === 'DataItem';
}

const LEAD = '(?:(?:ok(?:ay)?|hey|jarvis|please|now|and|then|so)[,\\s]+)*';

/** The form the words ask for, when they name one: "as a table", "a bulleted list", "plain text". */
export function putForm(text: string): NotchPutForm | null {
  const said = text.toLowerCase();
  if (/\btable\b/.test(said)) return 'a table';
  if (/\b(?:list|bullets?|bullet points?)\b/.test(said)) return 'a list';
  if (/\b(?:plain|text|unformatted|as it is|as is)\b/.test(said)) return 'plain text';
  return null;
}

/** "Put it here", "paste that into the doc as a table": the thing that is held is to be put somewhere. */
export function putRequest(text: string): boolean {
  const said = text.trim();
  if (!said || said.split(/\s+/).length > 14) return false;
  return new RegExp(`^${LEAD}(?:put|paste|drop|insert|place)\\b`, 'i').test(said) || new RegExp(`^${LEAD}(?:mettilo|incollalo)\\b`, 'i').test(said);
}

/** A few words that only answer "put it here?": a yes, or the form alone ("as a list"). */
export function putAnswer(text: string): boolean {
  const said = text.trim().replace(/[.!]+$/, '');
  if (!said || said.split(/\s+/).length > 7) return false;
  return new RegExp(`^${LEAD}(?:yes|yeah|yep|here|there|right here|do it|go ahead|sì)$`, 'i').test(said)
    || new RegExp(`^${LEAD}(?:(?:yes[,\\s]+)?(?:as|make it|format(?:ted)?(?: it)? as|in|into)\\s+)?(?:an?\\s+)?(?:(?:bulleted\\s+)?list|table|bullets?|bullet points?|plain text|text)$`, 'i').test(said);
}

export interface NotchPutDeps {
  inbox: NotchInbox;
  jobs: NotchJobs;
  hands: NotchJobHands;
  /** Tells the desktop app what is held, in a few words, and for how long: it shows "Put ... here" beside the pointer. */
  hold(sidecarId: string, what: string, ms: number): void;
  paused?: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface NotchPutter {
  /**
   * A look was told. True when it was a place pointed at while a thing is
   * held: then it is asked "put it here?", and the look says nothing itself.
   * Otherwise what the look read is held from now on.
   */
  shown(sidecarId: string, looked: NotchLooked): boolean;
  /**
   * What the notch does itself with these words, when they are about putting
   * the held thing somewhere: an answer to "put it here?" ("as a list",
   * "yes"), or "put it here as a table" with no place pointed at, which puts
   * it at the caret of the window in front. Null when they are an
   * instruction like any other.
   */
  route(text: string): { did: string; run(): void } | null;
  /** What is held now, if anything. */
  held(): NotchHeld | null;
  stop(): void;
}

/** Where a thing goes: a place on the screen that was clicked, or where the caret is in the window in front. */
type Place = { x: number; y: number } | 'caret';

export function attachNotchPut(deps: NotchPutDeps): NotchPutter {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  let held: NotchHeld | null = null;
  /** "Put it here?" is up, or was a moment ago: a few words may still answer it. */
  let pending: { id: string; sidecarId: string; thing: NotchHeld; at: { x: number; y: number }; cell: boolean; app: string; form: () => NotchPutForm; madeAt: number } | null = null;
  let stopped = false;
  let n = 0;

  const say = (parts: NotchPart[], ms: number, mood: 'sorry' | 'careful' | 'happy', mark?: 'check' | 'fail'): void => {
    const id = `put-say-${++n}`;
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true, urgent: true, once: true, asked: true,
      title: () => parts,
      play: async (stage) => { await stage.say(parts, ms, { mood, ...(mark ? { mark } : {}) }); return 'settled'; },
    });
  };

  /** The request that puts a thing somewhere, in its form. A cell takes cells; one value is just words. */
  function request(thing: NotchHeld, form: NotchPutForm, place: Place, cell: boolean): Record<string, unknown> {
    const where = place === 'caret' ? { front: true } : { screen: true, x: place.x, y: place.y };
    if (!heldIsTable(thing)) return { do: 'paste', ...where, text: thing.text, hand: 0 };
    return { do: 'paste', ...where, rows: thing.rows, as: cell ? 'cells' : AS[form], hand: 0 };
  }

  /** Puts it there, and comes back with what is said about it. */
  async function put(sidecarId: string, thing: NotchHeld, form: NotchPutForm, place: Place, cell: boolean, appSeen: string):
    Promise<{ parts: NotchPart[]; ms: number; mood: 'sorry' | 'careful' | 'happy'; mark?: 'check' | 'fail' }> {
    if (deps.paused?.()) return { parts: ['Everything is stopped. Wake me first.'], ms: 3200, mood: 'careful' };
    if (deps.jobs.busy()) return { parts: ['I am in the middle of something. Stop it first.'], ms: 3200, mood: 'careful' };
    let result: Awaited<ReturnType<NotchJobHands['act']>> = null;
    let lost = false;
    try {
      result = await deps.hands.act(request(thing, form, place, cell));
    } catch { lost = true; }
    deps.jobs.home();
    if (lost) return { parts: ['I lost touch with your computer in the middle of it. Look whether it is there.'], ms: 5200, mood: 'sorry', mark: 'fail' };
    if (!result) return { parts: ['Your computer is not connected.'], ms: 3600, mood: 'sorry', mark: 'fail' };
    if (!result.done) return { parts: [actRefusal(result.why), ' Nothing was put there.'], ms: 4600, mood: 'sorry', mark: 'fail' };
    const app = result.app || appSeen || 'there';
    // Written down for Today. It can be taken back when it went into a cell.
    const where: NotchPutPlace[] = cell && result.win && result.pt && result.shape?.hash
      ? [{ win: result.win, x: result.pt.x, y: result.pt.y, rows: result.shape.rows ?? 1, cols: result.shape.cols ?? 1, hash: result.shape.hash }]
      : [];
    const how = heldIsTable(thing) && !cell ? ` as ${form}` : '';
    const job = deps.jobs.store.open('put', `Put ${thing.what} from ${thing.app || 'one app'} into ${app}${how}`, 1);
    deps.jobs.store.progress(job, 1, where);
    deps.jobs.store.state(job, 'done');
    log('[notch] a thing that was shown was put where the person pointed');
    if (held === thing) { held = null; deps.hold(sidecarId, '', 0); }
    return { parts: ['There. It is in ', em(app), '.'], ms: 2800, mood: 'happy', mark: 'check' };
  }

  function offer(sidecarId: string, thing: NotchHeld, looked: NotchLooked, at: { x: number; y: number }): void {
    const id = `put-${++n}`;
    const cell = looked.things[0]?.kind === 'cell' || looked.things[0]?.role === 'DataItem';
    // Rows into a document have a form to choose. Into a cell they go as cells, and one value is just put.
    const choose = heldIsTable(thing) && !cell;
    let form: NotchPutForm = 'a table';
    const mine = { id, sidecarId, thing, at, cell, app: looked.app, form: () => form, madeAt: now() };
    pending = mine;
    const line = (): NotchPart[] => (choose
      ? ['Put ', em(thing.what), ' here as ', word('as', form, NOTCH_PUT_FORMS, { label: 'As' }), '?']
      : ['Put ', em(thing.what), ' here?']);
    deps.inbox.add({
      id, subject: 'put', class: 'person', speaks: true, urgent: true, asked: true,
      title: line,
      check: () => pending === mine && held === thing && now() - thing.at < NOTCH_HOLD_FORGOT_MS,
      play: async (stage) => {
        const lineId = stage.id();
        stage.put({ id: lineId, kind: 'offer', say: line(), yes: 'put', mood: 'curious', fold: 0 });
        for (;;) {
          const answer = await stage.answer(lineId, ['yes', 'no', 'fold', 'word']);
          if (answer.act === 'word') {
            const picked = NOTCH_PUT_FORMS.find((option) => option === answer.value);
            if (answer.word === 'as' && picked) form = picked;
            stage.surface.update(lineId, { say: line() });
            continue;
          }
          if (pending === mine) pending = null;
          if (answer.act !== 'yes') return 'settled';
          const said = await put(sidecarId, thing, form, at, cell, looked.app);
          await stage.say(said.parts, said.ms, { mood: said.mood, ...(said.mark ? { mark: said.mark } : {}) });
          return 'settled';
        }
      },
    });
  }

  return {
    shown(sidecarId, looked) {
      if (stopped || looked.refused) return false;
      const target = looked.how === 'click' && looked.at && takesAThing(looked.things[0]) ? looked.at : null;
      if (target && held) {
        const age = now() - held.at;
        if (age < NOTCH_HOLD_MS) { offer(sidecarId, held, looked, target); return true; }
        if (age < NOTCH_HOLD_FORGOT_MS) {
          // It says when it has forgotten.
          held = null;
          deps.hold(sidecarId, '', 0);
          say(['I no longer have what you showed me. Show me again, then point here.'], 3600, 'sorry');
          return true;
        }
        held = null;
      }
      const thing = heldFrom(looked, now());
      if (thing) {
        held = thing;
        deps.hold(sidecarId, thing.what, NOTCH_HOLD_MS);
      }
      return false;
    },
    route(text) {
      if (stopped) return null;
      const asked = pending && now() - pending.madeAt < NOTCH_PUT_SAID_MS && held === pending.thing ? pending : null;
      const thing = asked?.thing ?? (held && now() - held.at < NOTCH_HOLD_MS ? held : null);
      // Only while something is held: otherwise "put the kettle on" is an instruction like any other.
      if (!thing || !(putRequest(text) || (asked && putAnswer(text)))) return null;
      const form = putForm(text) ?? asked?.form() ?? 'a table';
      return {
        did: 'Put what you showed me where you pointed.',
        run: () => {
          const sidecarId = asked?.sidecarId ?? '';
          if (asked) {
            // Said instead of tapped: the line that asked is answered.
            deps.inbox.remove(asked.id);
            if (pending === asked) pending = null;
          }
          void put(sidecarId, thing, form, asked ? asked.at : 'caret', asked?.cell ?? false, asked?.app ?? '')
            .then((said) => say(said.parts, said.ms, said.mood, said.mark));
        },
      };
    },
    held: () => (held && now() - held.at < NOTCH_HOLD_MS ? held : null),
    stop() {
      stopped = true;
      held = null;
      pending = null;
    },
  };
}
