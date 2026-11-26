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
 * others call, clocks, rows and links in Home, rows in Settings, what it did
 * today and how that is taken back, what it does when a page comes up, and
 * how it is stopped. Everything but the `api` is optional.
 *
 * The words a feature acts on itself (`route`) are not in the contract yet:
 * they stay a method of its `api`, and `real.ts` hands them to `notchSide`
 * as before, until the routing itself moves.
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
import type { NotchBlock, NotchButton, NotchPart } from './protocol.ts';
import type { NotchQuestions } from './questions.ts';
import type { NotchSaidLine } from './said.ts';
import type { NotchSettings } from './settings.ts';
import type { NotchClock, NotchStage } from './stage.ts';
import type { NotchSuggestions } from './suggestions.ts';
import type { NotchSurface } from './surface.ts';
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

  where: NotchWhere;
  mail: NotchMailLayer;
  agents: NotchAgents;
  calls: NotchCalls;
  notice: NotchNotice;
  dayOne: NotchDayOne;
}

export type NotchFeatureId = keyof NotchApis;

/** Something a feature does by the clock. A run that fails is said in the log and tried again at the next one. */
export interface NotchTick {
  /** What it is, as the log says it: "looking for questions". */
  name: string;
  everyMs: number;
  run(): void | Promise<void>;
}

/** A row of Settings that a feature other than the settings owns: the row, and what a word of it changes. */
export interface NotchSettingsRow {
  row(): NotchBlock | null;
  /** True when the word was this row's and was taken. */
  set(name: string, value: string): boolean;
}

/** What a feature has. Only the `api` must be there. */
export interface NotchFeature<Api> {
  /** What the other features, and whoever asked for the notch, may call. */
  api: Api;
  /** Its clocks. Started when it is made, cleared before anything is stopped. */
  ticks?: NotchTick[];
  /** Its rows in Home, as they stand now, and what one of them opens. */
  homeRows?(): NotchBlock[];
  open?(stage: NotchStage, row: string): Promise<void>;
  /**
   * Its quiet links at the foot of Home, as they stand now, and what a press
   * on one does: `stay` when Home comes back after it, `leave` when what was
   * pressed takes the notch for itself, null when the link is not its own.
   */
  homeLinks?(): NotchButton[];
  press?(stage: NotchStage, link: string): Promise<'stay' | 'leave' | null>;
  /** Its rows in Settings. */
  settingsRows?(): NotchSettingsRow[];
  /** What it did since a moment, for Today. */
  done?(since: number): NotchDone[];
  /** Takes back a row of what was done: what to say, or null when the row is not its own or stands for nothing that can be taken back. */
  undo?(row: string): NotchPart[] | null;
  /** A page has come up. */
  hello?(sidecarId: string): void;
  /** Stops it: no listener, no timer and no work of its own is left. */
  stop?(): void;
}

/** What a feature is made from: what every one of them needs of the notch, and a way to the others. */
export interface NotchContext {
  surface: NotchSurface;
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
  every(name: string, everyMs: number, run: () => void | Promise<void>): () => void;
  /** Another part, by its id: null while it is not there. Asked when it is needed, so a part made later is found. */
  use<K extends NotchFeatureId>(id: K): NotchApis[K] | null;
}

export interface NotchFeatureDef<K extends NotchFeatureId> {
  id: K;
  /** The parts it cannot be made without. One that is missing: it is not made, and the log says so once. */
  needs?: readonly NotchFeatureId[];
  /** The parts it uses when they are there. For the reader: nothing is checked. */
  wants?: readonly NotchFeatureId[];
  /** Makes it. Null when the brain was not given what it needs: then it is absent, and nothing is said. */
  make(ctx: NotchContext): NotchFeature<NotchApis[K]> | null;
}
