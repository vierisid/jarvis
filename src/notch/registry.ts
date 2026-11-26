/**
 * The features of the notch, kept in one place (fix 02).
 *
 * `real.ts` makes the features one after the other, through this. What they
 * have in common is kept here once:
 *
 *   one scheduler   every clock of the notch runs through `every`. A run that
 *                   fails is said in the log and tried again at the next one:
 *                   a throw out of a timer is an uncaught exception, and that
 *                   ends the brain. No clock keeps the process alive.
 *   one way down    `stop` clears the clocks first, so that nothing new is
 *                   started, then ends what is on the notch, then stops the
 *                   features, the last one made first, then the parts
 *                   `real.ts` still makes by hand. Each by itself: one that
 *                   fails to stop is said and does not keep the others going.
 *                   Whatever was made when the making failed is what is
 *                   stopped; a part that was never made has nothing here.
 *
 * It also gathers what Home asks of the features. Today that is the quiet
 * links at its foot. Rows in Home, rows in Settings, what was done today, an
 * undo and a hello are still put together by hand in `real.ts`, in an order
 * of their own, and are not in the contract until they are gathered here.
 */
import type { NotchApis, NotchContext, NotchFeature, NotchFeatureDef, NotchFeatureId, NotchTickOptions } from './feature.ts';
import type { NotchInbox } from './inbox.ts';
import type { NotchButton } from './protocol.ts';
import type { NotchSettings } from './settings.ts';
import type { NotchClock, NotchStage } from './stage.ts';
import type { NotchSurface } from './surface.ts';

/** How often a clock of the notch that keeps failing says so in the log. */
export const NOTCH_TICK_FAILURE_SAID_MS = 60_000;

export interface NotchRegistryDeps {
  surface: NotchSurface;
  settings: NotchSettings | null;
  clock?: NotchClock;
  now: () => number;
  log: (line: string) => void;
  /** Whether everything is stopped. */
  paused: () => boolean;
}

export interface NotchRegistry {
  /** The scheduler: runs something by the clock until the notch is stopped, or until what comes back is called. */
  every(name: string, everyMs: number, run: () => void | Promise<void>, options?: NotchTickOptions): () => void;
  /** The inbox, once it is made. Features are made after it, and it is stopped before them. */
  setInbox(inbox: NotchInbox): void;
  /** A part that is not a feature yet, reachable by its id until it is. Asked each time, so one made later is found. */
  lend<K extends NotchFeatureId>(id: K, get: () => NotchApis[K] | null): void;
  /** Makes a feature and starts its clocks. Null when it is absent: a part it needs is, or the brain was not given what it is made from. */
  add<K extends NotchFeatureId>(def: NotchFeatureDef<K>): NotchApis[K] | null;
  /** The same, for a feature the notch is not made without: its absence is a failure of the making. */
  must<K extends NotchFeatureId>(def: NotchFeatureDef<K>): NotchApis[K];
  /** Another part, by its id: null while it is not there. */
  use<K extends NotchFeatureId>(id: K): NotchApis[K] | null;
  /** How a part that is not a feature yet is stopped. These run after the features, in the order they were given. */
  onStop(stop: () => void): void;
  /** The quiet links at the foot of Home, in the order their features were made. */
  homeLinks(): NotchButton[];
  /** A press on one of them: what the feature that owns it answers, or null when none does. */
  press(stage: NotchStage, link: string): Promise<'stay' | 'leave' | null>;
  /** Whether the notch was stopped. */
  stopped(): boolean;
  stop(): void;
}

export function createNotchRegistry(deps: NotchRegistryDeps): NotchRegistry {
  const { log } = deps;
  let inbox: NotchInbox | null = null;
  let stopped = false;
  const clocks = new Set<ReturnType<typeof setInterval>>();
  const features: { id: NotchFeatureId; feature: NotchFeature<unknown> }[] = [];
  const lent = new Map<NotchFeatureId, () => unknown>();
  const parts: (() => void)[] = [];

  function every(name: string, everyMs: number, run: () => void | Promise<void>, options: NotchTickOptions = {}): () => void {
    if (stopped) return () => {};
    // One that fails at every look is not said at every look: the first time, with where it failed, and then
    // once a minute with how often it failed in between.
    let saidAt: number | null = null;
    let unsaid = 0;
    const failed = (error: unknown): void => {
      // Nothing gets out of here, not even a log that cannot be written: out of a timer it would end the
      // brain, and out of a run that failed later it would be a rejection nobody hears.
      try {
        const at = Date.now();
        if (saidAt !== null && at - saidAt < NOTCH_TICK_FAILURE_SAID_MS) { unsaid++; return; }
        const why = error instanceof Error ? error.message : String(error);
        const where = saidAt === null && error instanceof Error && error.stack ? `\n${error.stack}` : '';
        log(`[notch] ${name} failed${unsaid > 0 ? ` (and ${unsaid} more ${unsaid === 1 ? 'time' : 'times'} since that was last said)` : ''}: ${why}${where}`);
        saidAt = at;
        unsaid = 0;
      } catch { /* said as well as it could be */ }
    };
    /** A run that came back with a promise and has not ended yet. */
    let under = false;
    const timer = setInterval(() => {
      if (options.skipWhileRunning && under) return;
      try {
        const going = run();
        if (going && typeof going.then === 'function') {
          under = true;
          going.then(() => { under = false; }, (error: unknown) => { under = false; failed(error); });
        }
      } catch (error) {
        failed(error);
      }
    }, everyMs);
    // Looking must not keep the process alive.
    timer.unref?.();
    clocks.add(timer);
    return () => { clearInterval(timer); clocks.delete(timer); };
  }

  function use<K extends NotchFeatureId>(id: K): NotchApis[K] | null {
    const made = features.find((one) => one.id === id);
    if (made) return made.feature.api as NotchApis[K];
    return (lent.get(id)?.() as NotchApis[K] | null | undefined) ?? null;
  }

  function add<K extends NotchFeatureId>(def: NotchFeatureDef<K>): NotchApis[K] | null {
    if (!inbox) throw new Error(`[notch] ${def.id} cannot be made before the inbox`);
    if (stopped) throw new Error(`[notch] ${def.id} cannot be made on a notch that was stopped`);
    if (features.some((one) => one.id === def.id) || lent.has(def.id)) throw new Error(`[notch] ${def.id} is there already`);
    const missing = (def.needs ?? []).filter((id) => use(id) === null);
    if (missing.length > 0) {
      log(`[notch] ${def.id} was not made: it needs ${missing.join(', ')}`);
      return null;
    }
    // Only what it said it leans on: the list in its definition is the whole list.
    const named = new Set<NotchFeatureId>([...(def.needs ?? []), ...(def.wants ?? [])]);
    const ctx: NotchContext = {
      surface: deps.surface, inbox, settings: deps.settings, clock: deps.clock, now: deps.now, log, paused: deps.paused, every,
      use: (id) => {
        if (!named.has(id)) throw new Error(`[notch] ${def.id} asked for ${id}, which is not in its needs or wants`);
        return use(id);
      },
    };
    const feature = def.make(ctx);
    if (!feature) return null;
    // From here it is stopped with the rest, whatever fails after this.
    features.push({ id: def.id, feature });
    for (const tick of feature.ticks ?? []) every(tick.name, tick.everyMs, () => tick.run(), { skipWhileRunning: tick.skipWhileRunning });
    return feature.api;
  }

  return {
    every,
    setInbox(made) {
      if (inbox) throw new Error('[notch] the inbox is there already');
      inbox = made;
    },
    lend(id, get) {
      if (features.some((one) => one.id === id) || lent.has(id)) throw new Error(`[notch] ${id} is there already`);
      lent.set(id, get);
    },
    add,
    must(def) {
      const api = add(def);
      if (api === null) throw new Error(`[notch] ${def.id} could not be made`);
      return api;
    },
    use,
    onStop(stop) { parts.push(stop); },
    homeLinks: () => features.flatMap((one) => one.feature.homeLinks?.() ?? []),
    async press(stage, link) {
      for (const one of features) {
        const went = (await one.feature.press?.(stage, link)) ?? null;
        if (went !== null) return went;
      }
      return null;
    },
    stopped: () => stopped,
    stop() {
      stopped = true;
      const steps: (() => void)[] = [
        // The clocks first, so that nothing new is started while the rest is stopped.
        ...[...clocks].map((timer) => () => { clearInterval(timer); clocks.delete(timer); }),
        // What is on the notch ends where it is: a yes whose window is still running sends nothing.
        () => inbox?.stop(),
        ...[...features].reverse().map((one) => () => one.feature.stop?.()),
        ...parts,
      ];
      for (const step of steps) {
        try {
          step();
        } catch (error) {
          log(`[notch] a part of the notch did not stop: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}
