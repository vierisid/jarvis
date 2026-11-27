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
 * It also gathers what Home, Settings and the router ask of every part
 * (`NotchGives`): the words each acts on, its rows in Home and in Settings,
 * what it did today and its undo, and what it does when a page comes up. Each
 * kind stands in the order it is given (`NOTCH_ORDER` in `real.ts`), not in
 * the order the parts are made; a part that gives one and has no place in
 * its order is refused. The quiet links at the foot of Home stand in the
 * order the features were made.
 */
import { NOTCH_GIVES_IN, type NotchAll, type NotchApis, type NotchContext, type NotchFeature, type NotchFeatureDef, type NotchFeatureId, type NotchGives, type NotchOrder, type NotchTickOptions } from './feature.ts';
import { notchIntentTable } from './intents.ts';
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
  /** Where what each part gives stands among the others. A kind not given here has no place for anybody. */
  order?: Partial<NotchOrder>;
}

export interface NotchRegistry {
  /** The scheduler: runs something by the clock until the notch is stopped, or until what comes back is called. */
  every(name: string, everyMs: number, run: () => void | Promise<void>, options?: NotchTickOptions): () => void;
  /** The inbox, once it is made. Features are made after it, and it is stopped before them. */
  setInbox(inbox: NotchInbox): void;
  /**
   * A part that is not a feature yet, reachable by its id until it is. Asked each time, so one made later is
   * found. `gives`: what it gives to what is gathered, as a feature would; asked only while the part is there.
   */
  lend<K extends NotchFeatureId>(id: K, get: () => NotchApis[K] | null, gives?: NotchGives): void;
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
  /** What every part gives, gathered, each kind in its order. */
  all: NotchAll;
  /** A page has come up on a machine: each part that hears it, in its order. Nothing on a notch that was stopped. */
  hello(sidecarId: string): void;
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
  /** What each part gives, by its id: a feature's own members, or what was lent with a part while that part is there. */
  const gives = new Map<NotchFeatureId, () => NotchGives | null>();
  const order: NotchOrder = { says: [], homeRows: [], settingsRows: [], done: [], undo: [], hello: [], ...deps.order };
  /** The features that claim the eye now. Told to the surface at every claim, as the parts used to tell it. */
  const eyes = new Set<NotchFeatureId>();

  /**
   * Throws for a part that gives something and has no place for it in that kind's order. A part that is lent is
   * refused before it is kept. A feature is asked after it was made and kept, so it is stopped with the rest
   * when the making then fails.
   */
  function placed(id: NotchFeatureId, given: NotchGives): void {
    for (const member of Object.keys(NOTCH_GIVES_IN) as (keyof NotchGives)[]) {
      if (given[member] === undefined) continue;
      const kind = NOTCH_GIVES_IN[member];
      if (!order[kind].includes(id)) throw new Error(`[notch] ${id} gives ${member}, and has no place in the order of ${kind}`);
    }
  }

  /** The parts that give a kind, in its order, each as it gives now. */
  function givers(kind: keyof NotchOrder): NotchGives[] {
    return order[kind].flatMap((id) => { const given = gives.get(id)?.() ?? null; return given ? [given] : []; });
  }

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

  const homeLinks = (): NotchButton[] => features.flatMap((one) => one.feature.homeLinks?.() ?? []);
  async function press(stage: NotchStage, link: string): Promise<'stay' | 'leave' | null> {
    for (const one of features) {
      const went = (await one.feature.press?.(stage, link)) ?? null;
      if (went !== null) return went;
    }
    return null;
  }

  const all: NotchAll = {
    intents: () => notchIntentTable(givers('says').map((given) => given.intents?.())),
    homeRows: () => givers('homeRows').flatMap((given) => given.homeRows?.() ?? []),
    async open(stage, row) {
      for (const given of givers('homeRows')) if (await given.open?.(stage, row)) return;
    },
    homeLinks,
    press,
    settingsRows: () => givers('settingsRows').flatMap((given) => given.settingsRows?.() ?? []),
    setWord: (name, value) => givers('settingsRows').some((given) => given.setWord?.(name, value) === true),
    done: (since) => givers('done').flatMap((given) => given.done?.(since) ?? []),
    undo(row) {
      for (const given of givers('undo')) {
        const said = given.undo?.(row) ?? null;
        if (said) return said;
      }
      return null;
    },
  };

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
      surface: deps.surface, inbox, settings: deps.settings, clock: deps.clock, now: deps.now, log, paused: deps.paused, every, all,
      eye: (on) => {
        if (on) eyes.add(def.id); else eyes.delete(def.id);
        deps.surface.setEye(eyes.size > 0);
      },
      use: (id) => {
        if (!named.has(id)) throw new Error(`[notch] ${def.id} asked for ${id}, which is not in its needs or wants`);
        return use(id);
      },
    };
    const feature = def.make(ctx);
    if (!feature) return null;
    // From here it is stopped with the rest, whatever fails after this: one that gives something it has no
    // place for is kept here first, so that the throw of `placed` leaves nothing of it running.
    features.push({ id: def.id, feature });
    placed(def.id, feature);
    gives.set(def.id, () => feature);
    for (const tick of feature.ticks ?? []) every(tick.name, tick.everyMs, () => tick.run(), { skipWhileRunning: tick.skipWhileRunning });
    return feature.api;
  }

  return {
    every,
    setInbox(made) {
      if (inbox) throw new Error('[notch] the inbox is there already');
      inbox = made;
    },
    lend(id, get, given) {
      if (features.some((one) => one.id === id) || lent.has(id)) throw new Error(`[notch] ${id} is there already`);
      if (given) placed(id, given);
      lent.set(id, get);
      if (given) gives.set(id, () => (get() == null ? null : given));
    },
    add,
    must(def) {
      const api = add(def);
      if (api === null) throw new Error(`[notch] ${def.id} could not be made`);
      return api;
    },
    use,
    onStop(stop) { parts.push(stop); },
    homeLinks,
    press,
    all,
    hello(sidecarId) {
      if (stopped) return;
      for (const given of givers('hello')) given.hello?.(sidecarId);
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
