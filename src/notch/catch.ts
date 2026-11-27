/**
 * Catching a repeated job by itself: "I can take it from here. 6 left."
 *
 * With the notch on, the desktop app tells the brain the shape of what the
 * person's hands do (`notch.watch`, sidecar/notch_watch.go): clicks as a
 * window and a place in it, named keys and shortcuts. Nothing that was typed,
 * no text, no names, and nothing at all from a password field, a bank or an
 * app on the person's list. Decided by the owner on 12 November 2026
 * (decision H): Jarvis watches input at all times, and keeps shapes only.
 *
 * Here those shapes are kept in memory, the last eighty of them, and looked
 * at after each one: has the same round just been done twice (./rounds.ts)?
 * If so Jarvis's pointer comes up beside the person's own, goes to where the
 * next round begins, and the notch offers to do the rest. Yes, and it does
 * (./jobs.ts), going on from the last round the person did, wherever they
 * have got to by then.
 *
 * It never acts without the yes. An offer that is turned down, or left, is
 * not made again for the same job for ten minutes.
 */
import { notchAskedHow, type NotchActionAsked } from './actions.ts';
import type { NotchFeatureDef } from './feature.ts';
import type { NotchInbox } from './inbox.ts';
import { NOTCH_ROWS_NOT_SEEN, newRoundsRun, roundsPlan, roundsWords, sureRounds, type NotchJobHands, type NotchJobs } from './jobs.ts';
import type { NotchPart } from './protocol.ts';
import {
  NOTCH_WATCH_KEPT, carryExact, findRounds, parseWatchEvent, roundPlace, roundsApps, roundsCopy, roundsName, roundsSource, roundsThatFit, roundsToDo,
  type Rounds, type WatchStep,
} from './rounds.ts';
import { NotchStageEnded, type NotchStage } from './stage.ts';

export const NOTCH_WATCH_EVENT = 'notch.watch';
/** How long an offer that was turned down, or left unanswered, is not made again for the same job. */
export const NOTCH_CATCH_QUIET_MS = 10 * 60_000;
/** How long a round done by hand is still where to go on from. Past it the windows may have been scrolled. */
export const NOTCH_CATCH_FRESH_MS = 3 * 60_000;
/** The most rounds counted ahead when counting what is left. */
export const NOTCH_CATCH_COUNT_MOST = 200;
/** How long a job whose rows could not be seen is not measured again. */
export const NOTCH_CATCH_UNSEEN_MS = 60_000;

export interface NotchCatchPort {
  onEvent(listener: (sidecarId: string, event: { event_type: string; payload: unknown }) => void): void;
  onSidecarDisconnected?(listener: (sidecarId: string) => void): void;
}

export interface NotchCatchDeps {
  inbox: NotchInbox;
  jobs: NotchJobs;
  hands: NotchJobHands;
  /** Everything is stopped (Esc twice). */
  paused?: () => boolean;
  /** The person is showing Jarvis a job ("Watch me"): what they do now is that, not a job to take over. */
  teaching?: () => boolean;
  /**
   * How many more there are, counted on the person's machine from what the
   * window says about itself. Null when it cannot tell (the window draws its
   * own rows and describes none).
   */
  count?(request: Record<string, unknown>): Promise<number | null>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface NotchCatch {
  /** The round the person last did twice by hand, while it is still fresh. For "do the rest", said. */
  last(): Rounds | null;
  /**
   * Takes over from where the person is, for `count` rounds, or for as many
   * as are left when no count is given. `none`: there is no round to go on
   * from. `nothing`: there is, and nothing is left of it. `how-many`: it
   * cannot tell how many are left, so a number is needed. `unseen`: the rows
   * cannot be seen well enough to go on by itself. `busy`: another job runs.
   */
  take(count: number | null): Promise<'started' | 'none' | 'nothing' | 'how-many' | 'unseen' | 'busy'>;
  /** Forgets what was seen: a job of Jarvis's own ran, or a teaching began. */
  reset(): void;
  stop(): void;
}

const em = (text: string): NotchPart => ({ em: text });

/** The request that counts what is left of a round, from the place the things come from. Null when the round has no such place. */
export function countRequest(rounds: Rounds): Record<string, unknown> | null {
  const source = roundsSource(rounds);
  if (!source || (source.dx === 0 && source.dy === 0)) return null;
  return {
    do: 'count', win: { id: source.win.id, pid: source.win.pid, w: source.win.w, h: source.win.h },
    x: Math.round(source.x), y: Math.round(source.y), dx: Math.round(source.dx), dy: Math.round(source.dy),
    most: Math.min(NOTCH_CATCH_COUNT_MOST, roundsThatFit(rounds, NOTCH_CATCH_COUNT_MOST)),
  };
}

export function attachNotchCatch(port: NotchCatchPort, deps: NotchCatchDeps): NotchCatch {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now;
  const seen = new Map<string, WatchStep[]>();
  /** Jobs whose offer was turned down or left, and when. */
  const quiet = new Map<string, number>();
  /** Jobs whose rows could not be seen when they were last measured, and when; and the ones being measured now. */
  const unseen = new Map<string, number>();
  const measuring = new Set<string>();
  let offer: { name: string; rounds: Rounds; sidecarId: string; left: number | null; counted: Promise<void> } | null = null;
  let stopped = false;
  let offers = 0;

  const home = (): void => { void deps.hands.act({ do: 'home' }).catch(() => {}); };

  function reset(): void {
    seen.clear();
    if (offer) { deps.inbox.remove('catch'); offer = null; }
  }

  /** The round as it stands now: the person may have done another one since it was first seen. */
  const current = (sidecarId: string): Rounds | null => {
    const rounds = findRounds(seen.get(sidecarId) ?? []);
    return rounds && now() - rounds.at <= NOTCH_CATCH_FRESH_MS ? rounds : null;
  };

  async function countLeft(rounds: Rounds): Promise<number | null> {
    const request = countRequest(rounds);
    if (!request || !deps.count) return null;
    try {
      const after = await deps.count(request);
      return after === null ? null : roundsToDo(rounds, after);
    } catch { return null; }
  }

  /** How many more to do when nothing counted them and nothing will say they ran out: asked. */
  async function howMany(stage: NotchStage): Promise<number | null> {
    const id = stage.id();
    stage.put({
      id, kind: 'ask', say: [], yes: 'go', placeholder: 'How many more? A number', focus: true, mood: 'curious',
      blocks: [{ kind: 'buttons', buttons: [5, 10, 20].map((n) => ({ id: `n${n}`, label: `${n} more` })) }],
    });
    const answer = await stage.answer(id, ['ask', 'button', 'no']);
    if (answer.act === 'button') return Number((answer.button ?? '').slice(1)) || null;
    if (answer.act !== 'ask') return null;
    const n = Number.parseInt((answer.text ?? '').replace(/[^\d]/g, ''), 10);
    return Number.isInteger(n) && n > 0 ? Math.min(n, NOTCH_CATCH_COUNT_MOST) : null;
  }

  function run(rounds: Rounds, count: number | null, asked: NotchActionAsked): boolean {
    const started = deps.jobs.start(roundsPlan(newRoundsRun(rounds, count), deps.hands, roundsWords(rounds, roundsApps(rounds))), asked);
    if (started) seen.clear();
    return started;
  }

  function propose(sidecarId: string, rounds: Rounds): void {
    const name = roundsName(rounds);
    const mine = { name, rounds, sidecarId, left: null as number | null, counted: Promise.resolve() };
    mine.counted = countLeft(rounds).then((left) => { if (offer === mine) mine.left = left; });
    offer = mine;
    const n = ++offers;
    // Shapes only, here too.
    log(`[notch] a job done twice by hand was seen: ${rounds.steps.length} step(s) a round, ${rounds.shown} round(s) shown`);
    // The baton: Jarvis's pointer comes up beside the person's own, then goes to where the next round begins.
    const first = rounds.steps.find((step) => step.kind === 'click');
    void (async () => {
      try {
        await deps.hands.act({ do: 'hand', beside: true, hand: 0 });
        const at = first && first.kind === 'click' ? roundPlace(first, 1) : null;
        if (at && first && first.kind === 'click' && offer === mine) {
          await new Promise((resolve) => setTimeout(resolve, 320));
          if (offer === mine) await deps.hands.act({ do: 'hand', win: first.win, x: at.x, y: at.y, hand: 0 });
        }
      } catch { /* no pointer is no reason not to offer */ }
    })();
    deps.inbox.add({
      id: 'catch', subject: 'catch', class: 'person', speaks: true,
      // The moment to take over is now, while the person is at it.
      urgent: true,
      title: () => ['I can take it from here.'],
      check: () => offer === mine && !deps.jobs.busy() && !deps.paused?.() && current(sidecarId) !== null,
      play: async (stage) => {
        try {
          // The count is worth a moment's wait, and no more.
          await Promise.race([mine.counted, stage.wait(400)]);
          const left = mine.left;
          const parts: NotchPart[] = left && left > 0 ? ['I can take it from here. ', em(`${left} left`), '.'] : ['I can take it from here.'];
          const answer = await stage.offer(parts, 'take over', { mood: 'track' });
          // The yes to this line, for what is written down of the job.
          const asked: NotchActionAsked = { seen: 'line', how: notchAskedHow(stage) };
          if (offer !== mine) return 'settled';
          offer = null;
          if (answer.act !== 'yes') {
            quiet.set(name, now());
            home();
            return 'settled';
          }
          // From where the person is now: they may have done another since.
          const raw = current(sidecarId);
          if (!raw || roundsName(raw) !== name) {
            home();
            await stage.say(['It is not where it was any more. Do one by hand and I will offer again.'], 4200, { mood: 'careful' });
            return 'settled';
          }
          // Where each step lands has to be exact. The distances measured for
          // the offer still hold for the same job a step or a round further
          // on; only when they do not fit is the screen measured again. (By
          // now Jarvis's own pointer stands in the strip that would be read.)
          const latest = carryExact(mine.rounds, raw) ?? await sureRounds(raw, deps.hands);
          if (!latest) {
            home();
            await stage.say([NOTCH_ROWS_NOT_SEEN], 4600, { mood: 'sorry' });
            return 'settled';
          }
          let count = await countLeft(latest);
          if (count === 0) {
            home();
            await stage.say(['Nothing left to do there.'], 3000, { mood: 'look' });
            return 'settled';
          }
          if (count === null && !roundsCopy(latest)) {
            count = await howMany(stage);
            if (count === null) { home(); quiet.set(name, now()); return 'settled'; }
          }
          if (!run(latest, count, asked)) {
            home();
            await stage.say(['I am in the middle of something else.'], 3000, { mood: 'careful' });
          }
          return 'settled';
        } catch (error) {
          if (!(error instanceof NotchStageEnded)) throw error;
          // Something took the notch. The offer stands for as long as it is true (check).
          if (offer === mine && n === offers) return 'waits';
          return 'settled';
        }
      },
    });
  }

  port.onSidecarDisconnected?.((sidecarId) => {
    seen.delete(sidecarId);
    if (offer?.sidecarId === sidecarId) { deps.inbox.remove('catch'); offer = null; }
  });

  port.onEvent((sidecarId, event) => {
    if (event.event_type !== NOTCH_WATCH_EVENT || stopped) return;
    // What Jarvis does itself is not told (the desktop app leaves out what a
    // program pressed). What the person does while Jarvis works, or while
    // they are showing it a job, is not a job to take over.
    if (deps.jobs.busy() || deps.teaching?.() || deps.paused?.()) { seen.delete(sidecarId); return; }
    const step = parseWatchEvent(event.payload, now());
    if (!step) return;
    const steps = seen.get(sidecarId) ?? [];
    steps.push(step);
    if (steps.length > NOTCH_WATCH_KEPT) steps.splice(0, steps.length - NOTCH_WATCH_KEPT);
    seen.set(sidecarId, steps);
    if (step.kind === 'gap' || step.kind === 'typed') return;
    const rounds = findRounds(steps);
    if (!rounds) return;
    const name = roundsName(rounds);
    // An offer that is no longer in the count is over: it went stale there (its check failed when the count
    // was opened) and nothing had said so here. While it stayed set, no repeated job was offered again until
    // a job ran or the desktop app connected anew.
    if (offer && !deps.inbox.has('catch')) offer = null;
    // Offered already, and still up: the offer follows the person, it is not made again.
    if (offer?.name === name) return;
    const declined = quiet.get(name);
    if (declined !== undefined && now() - declined < NOTCH_CATCH_QUIET_MS) return;
    if (quiet.size > 64) quiet.clear();
    const missed = unseen.get(name);
    if (measuring.has(name) || (missed !== undefined && now() - missed < NOTCH_CATCH_UNSEEN_MS)) return;
    if (unseen.size > 64) unseen.clear();
    // Before anything is offered: can the rows be seen there? Where they
    // cannot, a click a few rows on would land in the wrong one, and nothing
    // is offered at all.
    measuring.add(name);
    void sureRounds(rounds, deps.hands).then((sure) => {
      measuring.delete(name);
      if (offer && !deps.inbox.has('catch')) offer = null;
      if (stopped || offer || deps.jobs.busy() || deps.teaching?.()) return;
      if (!sure) {
        unseen.set(name, now());
        log('[notch] a job done twice by hand was seen, and not offered: the rows could not be seen clearly enough to go on');
        return;
      }
      propose(sidecarId, sure);
    }, () => { measuring.delete(name); });
  });

  return {
    last() {
      for (const sidecarId of seen.keys()) {
        const rounds = current(sidecarId);
        if (rounds) return rounds;
      }
      return null;
    },
    async take(count) {
      for (const sidecarId of [...seen.keys()]) {
        const rounds = current(sidecarId);
        if (!rounds) continue;
        let n = count;
        if (n === null) {
          n = await countLeft(rounds);
          if (n === 0) return 'nothing';
          // Nothing counted them and nothing will say they ran out: it does not guess.
          if (n === null && !roundsCopy(rounds)) return 'how-many';
        }
        const sure = await sureRounds(rounds, deps.hands);
        if (!sure) return 'unseen';
        if (offer) { deps.inbox.remove('catch'); offer = null; home(); }
        // Asked for in words, with no line of its own.
        return run(sure, n, { seen: 'nothing', how: 'said' }) ? 'started' : 'busy';
      }
      return 'none';
    },
    reset,
    stop() {
      stopped = true;
      reset();
    },
  };
}

/**
 * A job caught by itself when it is done twice by hand, as a feature of the notch (./feature.ts). It stands on
 * the jobs: without them it is absent, and nothing is said.
 */
export function notchCatchFeature(given: { port: NotchCatchPort; hands: NotchJobHands; count?: NotchCatchDeps['count'] } | undefined): NotchFeatureDef<'catch'> {
  return {
    id: 'catch',
    wants: ['jobs', 'teach'],
    make(ctx) {
      const jobs = ctx.use('jobs');
      if (!given || !jobs) return null;
      const api = attachNotchCatch(given.port, {
        inbox: ctx.inbox, jobs, hands: given.hands, paused: () => ctx.paused(), count: given.count,
        teaching: () => ctx.use('teach')?.watching() ?? false,
        log: ctx.log,
      });
      return { api, stop: () => api.stop() };
    },
  };
}
