/**
 * Put it there (pass 10): show Jarvis a thing, then point at a place.
 *
 * A look (./look.ts) reads a thing off the screen. For ninety seconds after,
 * Jarvis still holds what it read. In that time, holding the talk keys over a
 * place that can take it (a field, a cell, a page of writing) shows "Put 3
 * rows here" beside the pointer, before anything is clicked: the desktop app
 * draws that (`notch.hold`). A click there is not a new look: the notch asks
 * "Put 3 rows here?", and on a yes Jarvis's pointer goes to the place and the
 * thing is pasted in.
 *
 * What is put is what was read, as it was read: the cells of a row parted by
 * tabs, rows by line ends, so that rows land as rows in a sheet. Nothing is
 * rewritten by a model on the way.
 *
 * What was put into a cell can be taken back from Today, on the same terms
 * as any paste of Jarvis's (./jobs.ts): only while the place still holds
 * exactly what was put there.
 */
import type { NotchInbox } from './inbox.ts';
import { actRefusal, type NotchJobHands, type NotchJobs, type NotchPut as NotchPutPlace } from './jobs.ts';
import { lookCount, type NotchLooked, type NotchThing } from './look.ts';
import type { NotchPart } from './protocol.ts';

/** How long a thing that was shown is held. */
export const NOTCH_HOLD_MS = 90_000;
/** How long after that Jarvis still says it has forgotten, when a place is pointed at. */
export const NOTCH_HOLD_FORGOT_MS = 5 * 60_000;
/** The most that is put in one go. */
export const NOTCH_PUT_MAX_CHARS = 20_000;

const em = (text: string): NotchPart => ({ em: text });

export interface NotchHeld {
  /** A few words for it: "3 rows", "1,291". */
  what: string;
  /** What is put: cells parted by tabs, rows by line ends. */
  text: string;
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
  return { what, text, app: looked.app, at: now };
}

/** Whether a thing is a place something can be put: a field, a cell, a page of writing. The desktop app asks the same (lookTakes). */
export function takesAThing(thing: NotchThing | undefined): boolean {
  if (!thing) return false;
  if (thing.kind === 'field' || thing.kind === 'cell') return true;
  return thing.role === 'Document' || thing.role === 'Edit' || thing.role === 'ComboBox' || thing.role === 'DataItem';
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
  /** What is held now, if anything. */
  held(): NotchHeld | null;
  stop(): void;
}

export function attachNotchPut(deps: NotchPutDeps): NotchPutter {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  let held: NotchHeld | null = null;
  let stopped = false;
  let n = 0;

  const say = (parts: NotchPart[], ms: number, mood: 'sorry' | 'careful'): void => {
    const id = `put-say-${++n}`;
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true, urgent: true, once: true, asked: true,
      title: () => parts,
      play: async (stage) => { await stage.say(parts, ms, { mood }); return 'settled'; },
    });
  };

  function offer(sidecarId: string, thing: NotchHeld, looked: NotchLooked, at: { x: number; y: number }): void {
    const id = `put-${++n}`;
    const cell = looked.things[0]?.kind === 'cell' || looked.things[0]?.role === 'DataItem';
    deps.inbox.add({
      id, subject: 'put', class: 'person', speaks: true, urgent: true, asked: true,
      title: () => ['Put ', em(thing.what), ' here?'],
      check: () => held === thing && now() - thing.at < NOTCH_HOLD_FORGOT_MS,
      play: async (stage) => {
        const answer = await stage.offer(['Put ', em(thing.what), ' here?'], 'put', { mood: 'curious', fold: 0 });
        if (answer.act !== 'yes') return 'settled';
        if (deps.paused?.()) { await stage.say(['Everything is stopped. Wake me first.'], 3200, { mood: 'careful' }); return 'settled'; }
        if (deps.jobs.busy()) { await stage.say(['I am in the middle of something. Stop it first.'], 3200, { mood: 'careful' }); return 'settled'; }
        let result: Awaited<ReturnType<NotchJobHands['act']>> = null;
        let lost = false;
        try {
          result = await deps.hands.act({ do: 'paste', screen: true, x: at.x, y: at.y, text: thing.text, hand: 0 });
        } catch { lost = true; }
        deps.jobs.home();
        if (lost) { await stage.say(['I lost touch with your computer in the middle of it. Look whether it is there.'], 5200, { mood: 'sorry', mark: 'fail' }); return 'settled'; }
        if (!result) { await stage.say(['Your computer is not connected.'], 3600, { mood: 'sorry', mark: 'fail' }); return 'settled'; }
        if (!result.done) { await stage.say([actRefusal(result.why), ' Nothing was put there.'], 4600, { mood: 'sorry', mark: 'fail' }); return 'settled'; }
        const app = result.app || looked.app || 'there';
        // Written down for Today. It can be taken back when it went into a cell.
        const where: NotchPutPlace[] = cell && result.win && result.pt && result.shape?.hash
          ? [{ win: result.win, x: result.pt.x, y: result.pt.y, rows: result.shape.rows ?? 1, cols: result.shape.cols ?? 1, hash: result.shape.hash }]
          : [];
        const job = deps.jobs.store.open('put', `Put ${thing.what} from ${thing.app || 'one app'} into ${app}`, 1);
        deps.jobs.store.progress(job, 1, where);
        deps.jobs.store.state(job, 'done');
        log('[notch] a thing that was shown was put where the person pointed');
        if (held === thing) { held = null; deps.hold(sidecarId, '', 0); }
        await stage.say(['There. It is in ', em(app), '.'], 2800, { mood: 'happy', mark: 'check' });
        return 'settled';
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
    held: () => (held && now() - held.at < NOTCH_HOLD_MS ? held : null),
    stop() {
      stopped = true;
      held = null;
    },
  };
}
