/**
 * What a feature of the notch is (fix 02).
 *
 * `real.ts` puts the notch together. It used to do so in one closure that
 * knew every part by name: a holder for each, its clock, its row in Home, its
 * line in stop. A feature says those things about itself instead, in one
 * shape, and `registry.ts` keeps what they have in common: one scheduler and
 * one way down.
 *
 * A definition names the feature, says which others it cannot be made
 * without (`needs`) and which it uses when they are there (`wants`), and
 * makes it from the context. What it makes says what it has: an `api` the
 * others call, clocks, quiet links at the foot of Home, and how it is
 * stopped. Everything but the `api` is optional.
 *
 * Not in the contract yet, because nothing gathers them yet: rows in Home
 * with what they open, rows in Settings, what was done today and how it is
 * taken back, and what happens when a page comes up. Each needs a position
 * of its own (Home does not show them in the order the features are made),
 * and is added with the step that moves it out of `real.ts`.
 *
 * The words a feature acts on itself are not in the contract either: `route`
 * stays a method of its `api`. Once the intent table of point 3
 * (notch/fix-03-table) has landed, a feature contributes its words through
 * that table, not through a chain in `real.ts`.
 *
 * One rule for whoever writes a feature: where a member of the feature does
 * what a method of its `api` does (`stop` today; `done`, `hello` and the
 * others later), it calls that method on the `api` when it is itself called,
 * `stop: () => api.stop()`, and never keeps the function, `stop: api.stop`.
 * The `api` object is what `real.ts` hands back, and whoever holds it may
 * stand in for one of its methods: `real-wiring.test.ts` pins the wiring that
 * way, and a kept function would go past the stand-in unseen.
 */
import type { NotchAgents } from './agents.ts';
import type { NotchCalls } from './call.ts';
import type { NotchCanDo } from './cando.ts';
import type { NotchDayOne } from './dayone.ts';
import type { NotchInbox } from './inbox.ts';
import type { NotchMailLayer } from './mail/attach.ts';
import type { NotchMemory } from './memory.ts';
import type { NotchMoves } from './moves.ts';
import type { NotchNews } from './news.ts';
import type { NotchNotice } from './notice.ts';
import type { NotchPrefs } from './prefs.ts';
import type { NotchButton } from './protocol.ts';
import type { NotchQuestions } from './questions.ts';
import type { NotchSaidLine } from './said.ts';
import type { NotchSettings } from './settings.ts';
import type { NotchClock, NotchStage } from './stage.ts';
import type { NotchSuggestions } from './suggestions.ts';
import type { NotchSurface } from './surface.ts';
import type { NotchWhere } from './where.ts';

/** A feature that others have nothing to ask of: it only listens, and is stopped. */
export type NotchNoApi = Readonly<Record<string, never>>;

/**
 * Every part another may ask for by its id, and what it gets.
 *
 * The first group are features. The second are parts `real.ts` still makes by
 * hand and lends under their id (`NotchRegistry.lend`), so that a feature
 * that leans on one reads the same whether or not it has been moved yet.
 */
export interface NotchApis {
  questions: NotchQuestions;
  news: NotchNews;
  moves: NotchMoves;
  canDo: NotchCanDo;
  memory: NotchMemory;
  prefs: NotchPrefs;
  said: NotchSaidLine;
  promises: NotchNoApi;
  pause: NotchNoApi;
  suggestions: NotchSuggestions;

  where: NotchWhere;
  mail: NotchMailLayer;
  agents: NotchAgents;
  calls: NotchCalls;
  notice: NotchNotice;
  dayOne: NotchDayOne;
}

export type NotchFeatureId = keyof NotchApis;

/** How a clock runs. */
export interface NotchTickOptions {
  /**
   * For a run that takes time (it comes back with a promise): while one is
   * still under way, the next is not started, and nothing is said of it.
   * Off when not given: every run is started at its time, whatever the one
   * before it is doing.
   */
  skipWhileRunning?: boolean;
}

/** Something a feature does by the clock. A run that fails is said in the log and tried again at the next one. */
export interface NotchTick extends NotchTickOptions {
  /** What it is, as the log says it: "looking for questions". */
  name: string;
  everyMs: number;
  run(): void | Promise<void>;
}

/**
 * What a feature may do to the notch itself: effects, and the two things
 * that are read off it. Not the whole surface: what is shown goes through the
 * inbox, and a page's messages are the inbox's to hear.
 */
export type NotchFeatureSurface = Pick<NotchSurface, 'resting' | 'current' | 'setSound' | 'onStop' | 'setFace' | 'act'>;

/** What a feature has. Only the `api` must be there. */
export interface NotchFeature<Api> {
  /** What the other features, and whoever asked for the notch, may call. */
  api: Api;
  /** Its clocks. Started when it is made, cleared before anything is stopped. */
  ticks?: NotchTick[];
  /**
   * Its quiet links at the foot of Home, as they stand now, and what a press
   * on one does: `stay` when Home comes back after it, `leave` when what was
   * pressed takes the notch for itself, null when the link is not its own.
   */
  homeLinks?(): NotchButton[];
  press?(stage: NotchStage, link: string): Promise<'stay' | 'leave' | null>;
  /** Stops it: no listener, no timer and no work of its own is left. Where the `api` has a `stop`, this calls it then: `() => api.stop()`. */
  stop?(): void;
}

/** What a feature is made from: what every one of them needs of the notch, and a way to the others. */
export interface NotchContext {
  surface: NotchFeatureSurface;
  inbox: NotchInbox;
  /** The notch's own settings. Null when the brain was not given where to keep them. */
  settings: NotchSettings | null;
  /** The clock the lines on the notch run on, when a test gave one. */
  clock: NotchClock | undefined;
  now(): number;
  log(line: string): void;
  /** Whether everything is stopped (Esc twice, the tray's Pause, Kill). False where there is no pause to ask. */
  paused(): boolean;
  /**
   * Runs something by the clock until the notch is stopped, or until what
   * comes back is called. A feature whose clock never ends by itself names it
   * in `ticks` instead.
   */
  every(name: string, everyMs: number, run: () => void | Promise<void>, options?: NotchTickOptions): () => void;
  /**
   * Another part, by its id: null while it is not there. Asked when it is
   * needed, so a part made later is found. Only a part the definition names
   * in `needs` or `wants`: asking for any other throws, so that the list of
   * what a feature leans on is the whole list.
   */
  use<K extends NotchFeatureId>(id: K): NotchApis[K] | null;
}

export interface NotchFeatureDef<K extends NotchFeatureId> {
  id: K;
  /** The parts it cannot be made without. One that is missing: it is not made, and the log says so once. */
  needs?: readonly NotchFeatureId[];
  /** The parts it uses when they are there. With `needs`, the only parts `use` hands it. */
  wants?: readonly NotchFeatureId[];
  /** Makes it. Null when the brain was not given what it needs: then it is absent, and nothing is said. */
  make(ctx: NotchContext): NotchFeature<NotchApis[K]> | null;
}
