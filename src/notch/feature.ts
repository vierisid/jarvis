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
 * What Home, Settings and the router ask of all of them is gathered by the
 * registry, each in an order of its own that is written down once in
 * `real.ts` (`NOTCH_ORDER`): the words a feature acts on itself (`intents`,
 * put into the one table of ./intents.ts), its rows in Home with what they
 * open, its rows in Settings with the words they change, what it did today
 * and how that is taken back, and what it does when a page comes up. A
 * feature that gives one of them and has no place in that order cannot be
 * made (the making throws): Home does not show them in the order the
 * features are made, so the place is never guessed.
 *
 * One rule for whoever writes a feature: where a member of the feature does
 * what a method of its `api` does (`stop`, `done`, `undo`, `hello`, `intents`
 * and the others), it calls that method on the `api` when it is itself called,
 * `stop: () => api.stop()`, and never keeps the function, `stop: api.stop`.
 * The `api` object is what `real.ts` hands back, and whoever holds it may
 * stand in for one of its methods: `real-wiring.test.ts` pins the wiring that
 * way, and a kept function would go past the stand-in unseen.
 */
import type { NotchAgents } from './agents.ts';
import type { NotchAround } from './around.ts';
import type { NotchAsks } from './asks.ts';
import type { NotchCatch } from './catch.ts';
import type { NotchCalls } from './call.ts';
import type { NotchCanDo } from './cando.ts';
import type { NotchDayOne } from './dayone.ts';
import type { NotchDrop } from './drop.ts';
import type { NotchInbox } from './inbox.ts';
import type { NotchIntent } from './intents.ts';
import type { NotchJobs } from './jobs.ts';
import type { NotchLook } from './look.ts';
import type { NotchMailLayer } from './mail/attach.ts';
import type { NotchMemory } from './memory.ts';
import type { NotchMoves } from './moves.ts';
import type { NotchNews } from './news.ts';
import type { NotchNotice } from './notice.ts';
import type { NotchPeople } from './people.ts';
import type { NotchPrefs } from './prefs.ts';
import type { NotchBlock, NotchButton, NotchPart } from './protocol.ts';
import type { NotchPutter } from './put.ts';
import type { NotchQuestions } from './questions.ts';
import type { NotchSaidLine } from './said.ts';
import type { NotchSettings } from './settings.ts';
import type { NotchStanding } from './standing.ts';
import type { NotchClock, NotchStage } from './stage.ts';
import type { NotchSuggestions } from './suggestions.ts';
import type { NotchSurface } from './surface.ts';
import type { NotchTalk } from './talk.ts';
import type { NotchTeach } from './teach.ts';
import type { NotchDone } from './today.ts';
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
  jobs: NotchJobs;
  catch: NotchCatch;
  teach: NotchTeach;
  put: NotchPutter;
  agents: NotchAgents;
  asks: NotchAsks;
  look: NotchLook;
  talk: NotchTalk;
  drop: NotchDrop;

  where: NotchWhere;
  mail: NotchMailLayer;
  calls: NotchCalls;
  notice: NotchNotice;
  dayOne: NotchDayOne;
  people: NotchPeople;
  standing: NotchStanding;
  around: NotchAround;
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
 * inbox, and a page's messages are the inbox's to hear. The one exception is
 * a file dragged over the notch (`onDrag`, with the mouth it opens and the
 * gulp that swallows it), which is the drop's own (./drop.ts).
 */
export type NotchFeatureSurface = Pick<NotchSurface, 'resting' | 'current' | 'setSound' | 'onStop' | 'setFace' | 'act' | 'gulp' | 'setMouth' | 'onDrag'>;

/**
 * What a feature may give to what the registry gathers, each where `NOTCH_ORDER` puts it. A part that is not a
 * feature yet gives the same through `NotchRegistry.lend`, so that moving it changes nothing of where its rows
 * stand. Every member is asked when it is needed, and calls the part's `api` then.
 */
export interface NotchGives {
  /** The words it acts on itself, as intents of the one table (./intents.ts). The table orders them by band; inside a band, by `NOTCH_ORDER.says`. */
  intents?(): readonly NotchIntent[];
  /** Its rows in Home, as they stand now. */
  homeRows?(): NotchBlock[];
  /** A row of Home was opened: true when it was one of its own, and it was opened. */
  open?(stage: NotchStage, row: string): Promise<boolean>;
  /** Its rows in Settings, as they stand now. */
  settingsRows?(): NotchBlock[];
  /** A word of a row in Settings was changed: true when the word was its own. */
  setWord?(name: string, value: string): boolean;
  /** What it did since a moment, for Today. */
  done?(since: number): NotchDone[];
  /** Takes back what a row of Today stands for: what to say, or null when the row is not its own or the thing is over. */
  undo?(row: string): NotchPart[] | null;
  /** A notch page has come up on a machine. Told after the inbox, which is told first. */
  hello?(sidecarId: string): void;
}

/** The kinds the registry gathers in an order of its own, and the order is `NOTCH_ORDER`'s. */
export type NotchGathered = 'says' | 'homeRows' | 'settingsRows' | 'done' | 'undo' | 'hello';

/** For each kind gathered, the parts that give it, in the order they are asked and shown. */
export type NotchOrder = Readonly<Record<NotchGathered, readonly NotchFeatureId[]>>;

/** Which member of `NotchGives` puts a part in which order. */
export const NOTCH_GIVES_IN: Readonly<Record<keyof NotchGives, NotchGathered>> = {
  intents: 'says', homeRows: 'homeRows', open: 'homeRows', settingsRows: 'settingsRows', setWord: 'settingsRows', done: 'done', undo: 'undo', hello: 'hello',
};

/** What a feature has. Only the `api` must be there. */
export interface NotchFeature<Api> extends NotchGives {
  /** What the other features, and whoever asked for the notch, may call. */
  api: Api;
  /** Its clocks. Started when it is made, cleared before anything is stopped. */
  ticks?: NotchTick[];
  /**
   * Its quiet links at the foot of Home, as they stand now, and what a press
   * on one does: `stay` when Home comes back after it, `leave` when what was
   * pressed takes the notch for itself, null when the link is not its own.
   * These stand in the order the features were made.
   */
  homeLinks?(): NotchButton[];
  press?(stage: NotchStage, link: string): Promise<'stay' | 'leave' | null>;
  /** Stops it: no listener, no timer and no work of its own is left. Where the `api` has a `stop`, this calls it then: `() => api.stop()`. */
  stop?(): void;
}

/** What the registry gathered from every part, each in its order, as it stands when it is asked. For the parts that show Home and Settings, and route. */
export interface NotchAll {
  /** The one table of intents (./intents.ts). */
  intents(): NotchIntent[];
  homeRows(): NotchBlock[];
  /** Opens a row of Home by the part whose row it is. */
  open(stage: NotchStage, row: string): Promise<void>;
  homeLinks(): NotchButton[];
  press(stage: NotchStage, link: string): Promise<'stay' | 'leave' | null>;
  settingsRows(): NotchBlock[];
  setWord(name: string, value: string): boolean;
  done(since: number): NotchDone[];
  undo(row: string): NotchPart[] | null;
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
  /** What every part gives, gathered: asked when it is needed, so what a part made later gives is there. */
  all: NotchAll;
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
