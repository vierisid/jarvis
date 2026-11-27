/**
 * The real things on the notch, put together.
 *
 * One call from the daemon builds the inbox, connects each kind of real thing
 * to it (approvals, and the rest as they are added), gives yes at rest its
 * home (Today), and keeps looking for what is new. The daemon hands over the
 * product's own objects and functions; nothing here reaches for them itself,
 * so this file can be read as the list of what the notch touches.
 */
import type { ApprovalManager, ApprovalRequest } from '../authority/approval.ts';
import type { ApprovalDecisionOutcome } from '../daemon/approval-decision.ts';
import type { Database } from 'bun:sqlite';
import { notchWhereFeature, type NotchWhere, type NotchWherePort } from './where.ts';
import { attachNotchActionsOrNone } from './actions.ts';
import type { AuditTrail } from '../authority/audit.ts';
import { NOTCH_APPROVAL_LOOK_MS, attachNotchApprovals } from './approvals.ts';
import { notchAsksFeature } from './asks.ts';
import type { NotchAskFile, NotchAskHow, NotchAsks, NotchAsksDeps } from './asks.ts';
import { notchIntentTable, resolveIntent, type NotchIntent, type NotchIntentHit, type NotchIntentSource, type NotchRouted } from './intents.ts';
import type { NotchOrder } from './feature.ts';
import { NotchLedger } from './ledger.ts';
import { notchLookFeature, type NotchLook, type NotchLookDeps, type NotchLookPort } from './look.ts';
import { notchTalkFeature } from './talk.ts';
import type { NotchTalk, NotchTalkDeps, NotchTalkPort } from './talk.ts';
import type { NotchApprovalWhere, NotchApprovals } from './approvals.ts';
import type { CommitmentEvent } from '../daemon/commitment-executor.ts';
import { NotchInbox } from './inbox.ts';
import { notchNewsFeature } from './news.ts';
import type { NotchNews, NotchOpenFailure } from './news.ts';
import { notchPauseFeature } from './pause.ts';
import type { NotchPauseDeps } from './pause.ts';
import { notchPromisesFeature } from './promises.ts';
import { notchQuestionsFeature } from './questions.ts';
import type { NotchQuestionDeps, NotchQuestions } from './questions.ts';
import { notchAroundFeature, type NotchAround, type NotchAroundPort } from './around.ts';
import { notchCallsFeature, type NotchCallDeps, type NotchCallPort } from './call.ts';
import { notchNoticeFeature, type NotchNotice, type NotchNoticeDeps } from './notice.ts';
import { notchDropFeature, type NotchDrop } from './drop.ts';
import { notchDayFeature } from './day.ts';
import { notchMailFeature, type NotchMailLayer, type NotchMailLayerDeps } from './mail/attach.ts';
import { notchPresenceFeature, type NotchPresence } from './presence.ts';
import { NotchQuiet, notchQuietHome } from './quiet.ts';
import { NotchSettings } from './settings.ts';
import { notchSoonFeature, type NotchSoon } from './soon.ts';
import type { NotchClock } from './stage.ts';
import { notchBirthAfter, type NotchSurface } from './surface.ts';
import { notchSuggestionsFeature } from './suggestions.ts';
import type { NotchSuggestions } from './suggestions.ts';
import { notchDoneBetween, notchToday, notchTodayBlocks, notchTodayScript } from './today.ts';
import { notchCatchFeature, type NotchCatch, type NotchCatchDeps, type NotchCatchPort } from './catch.ts';
import { notchJobsFeature, type NotchJobHands, type NotchJobs } from './jobs.ts';
import { notchPutFeature, type NotchPutDeps, type NotchPutter } from './put.ts';
import { notchStandingFeature } from './standing.ts';
import { notchPeopleFeature, type NotchPeople } from './people.ts';
import type { PeerLink } from '../peers/link.ts';
import type { PeerSetupLike } from '../peers/setup.ts';
import type { PeerFileFound } from './people-files.ts';
import { PeerStore } from '../peers/store.ts';
import { notchAgentsFeature, type NotchAgentWorkflows, type NotchAgents } from './agents.ts';
import { notchTeachFeature, type NotchTeach, type NotchTeachDeps } from './teach.ts';
import { notchMemoryFeature, type NotchMemory, type NotchMemoryDeps } from './memory.ts';
import { notchMovesFeature, type NotchMoves } from './moves.ts';
import { notchPrefsFeature, type NotchPrefs, type NotchPrefsDeps, type NotchSettingsPage } from './prefs.ts';
import { notchDayOneFeature, type NotchDayOne, type NotchDayOneDeps } from './dayone.ts';
import { notchCanDoFeature } from './cando.ts';
import { notchSaidFeature } from './said.ts';
import { whereQuestion } from './point.ts';
import { createNotchIntentReader, type IntentReadPeople, type NotchIntentReader, type NotchIntentReaderDeps, type NotchRead } from './intent-read.ts';
import { createNotchRegistry } from './registry.ts';

export { NOTCH_TICK_FAILURE_SAID_MS } from './registry.ts';

export interface NotchRealDeps {
  /** Something else has the notch for now (a demo moment is playing). */
  busy?: () => boolean;
  /**
   * What a file that arrived from somebody is, in one sentence (./drop-gist.ts):
   * one bounded question to the model. Without it an arrival is told by its
   * name and where it is.
   */
  gist?: (file: NotchAskFile, signal: AbortSignal) => Promise<string | null>;
  /**
   * The back office that fits in a sheet (pass 12): the product's memory with
   * its own Forget, the keys of the machine a sheet is open on, what makes
   * out speech, and what is connected.
   */
  office?: {
    memory?: Pick<NotchMemoryDeps, 'list' | 'forget'>;
    keys?: NotchPrefsDeps['keys'];
    voice?: NotchPrefsDeps['voice'];
    connections?: NotchPrefsDeps['connections'];
    connect?: NotchPrefsDeps['connect'];
    /** Opens the dashboard at one of its settings pages. */
    openPage?: (sidecarId: string | null, page: NotchSettingsPage) => void;
  };
  /**
   * Day one in the notch (pass 12): the first five minutes, on a brain that
   * was never set up, and again whenever it is asked for.
   */
  dayOne?: Pick<NotchDayOneDeps, 'fresh' | 'name' | 'model' | 'voice' | 'watching' | 'told' | 'around' | 'system' | 'installed'>;
  approvalManager: Pick<ApprovalManager, 'getPending' | 'getRequest' | 'getHistory' | 'createRequest'>;
  /** Approves through the product's one decision function, as the notch. */
  approve(requestId: string): Promise<ApprovalDecisionOutcome>;
  /** Denies through the same function, as the notch: what Esc on an approval's line does. */
  deny(requestId: string): Promise<ApprovalDecisionOutcome>;
  /**
   * Closes an approval nobody answered, because the instruction that asked
   * for it is over. Through the same function, as the system and not as the
   * notch: the owner said nothing, and the audit must not say they said no.
   */
  withdraw(requestId: string): Promise<ApprovalDecisionOutcome>;
  /** Opens the dashboard on the machine named, or on every machine showing the notch. */
  openDashboard?: (sidecarId: string | null) => void;
  /**
   * What the notch does in the world, written down (./actions.ts): where the
   * list is kept, and the product's audit trail, which gets every entry too.
   * Not given: nothing is written down, and no table is made.
   */
  actions?: { db: Database; audit?: Pick<AuditTrail, 'log'> | null };
  /** Promises: the executor that keeps them, and the store they live in. */
  promises?: {
    executor: {
      subscribe(listener: (event: CommitmentEvent) => void): () => void;
      cancelExecution(commitmentId: string): boolean;
    };
    /** Promises that were kept, for Today. */
    kept(): { what: string; completed_at: number | null }[];
    /**
     * Promises that were due between two moments and were not kept, and may
     * be opened again: the evening offers to move them (./day.ts). One that
     * may have partly run is not among them.
     */
    slipped?(since: number, until: number): { id: string; what: string }[];
    /** Opens those again, due at that moment. How many were moved. */
    move?(ids: string[], at: number): number;
  };
  /** How often to look for what is new. */
  lookMs?: number;
  /** Workflow questions: what waits, and the product's own function for answering one. */
  questions?: Pick<NotchQuestionDeps, 'pending' | 'get' | 'answer'>;
  /** The failures that are open now, each with its one sentence. New ones are said once. */
  openFailures?: () => NotchOpenFailure[];
  /**
   * Hears a background agent's task end. Called until it answers true: the
   * task manager is made after the notch, so it may not be there yet.
   */
  onTaskEnded?: (listener: NotchNews['taskEnded']) => boolean;
  /** The product's pause: Esc twice pauses through it, and the notch shows its state whoever changed it. */
  emergency?: NotchPauseDeps['controller'];
  /**
   * Asking: typed in Home, or spoken while the talk keys are held. With this
   * given, yes at rest opens the text field with today under it.
   */
  asks?: {
    /** Where the ledger of instructions is kept. */
    db: Database;
    turns: NotchAsksDeps['turns'];
    modelReady: NotchAsksDeps['modelReady'];
    remember?: NotchAsksDeps['remember'];
    understand?: NotchAsksDeps['understand'];
    /** "Where is…?" answered by pointing at it on the screen (pass 9). */
    point?: NotchAsksDeps['point'];
    /**
     * One small question to the model about a sentence that none of the fixed words fit (./intent-read.ts).
     * `tier` 'people': the sentence names somebody of the organisation, and is asked of the tier that read
     * such sentences before. Not given: only words about people are read, by `peers.think`.
     */
    readIntent?: NotchIntentReaderDeps['think'];
    /** Puts an approval in plain words, from its tool and arguments alone. */
    describeApproval?: (request: ApprovalRequest) => Promise<string | null>;
    /** What on the screen an approval would land on, as that machine reads it now. Shown to the person only. */
    whereApproval?: (request: ApprovalRequest) => Promise<NotchApprovalWhere | null>;
    /** The desktop app's recordings arrive as its events. */
    talkPort: NotchTalkPort;
    stt: NotchTalkDeps['stt'];
    /**
     * Look at this (pass 9): the desktop apps that say what was circled or
     * clicked with the talk keys held. A look is asked about as an
     * instruction, so it needs the rest of asking.
     */
    look?: { port: NotchLookPort; modelReady?: NotchLookDeps['modelReady'] };
  };
  /**
   * Where the person is (pass 6): the desktop apps that say which app is in
   * front, and whether watching is switched on at all.
   */
  where?: { port: NotchWherePort; watching?: () => boolean; openEyes?: () => Promise<boolean | null> };
  /**
   * Mail (pass 7): Jarvis looks at the mailbox by itself, prepares a reply
   * where a person is waiting, and puts it on the notch. Everything it needs
   * of the product: the database, the notch's own browser tab, the model.
   */
  mail?: Omit<NotchMailLayerDeps, 'paused' | 'log' | 'noClock'> & { noClock?: boolean };
  /**
   * Standing things (pass 11), the part that stands on mail: an eye kept on
   * a person's answer, and a chase until it is in. Needs `mail`. `chaseWaitMs`
   * is given by a test brain: how long a chase waits between two steps.
   */
  standing?: { chaseWaitMs?: number; noClock?: boolean };
  /**
   * Agents (pass 11): a sentence becomes a workflow that is switched on and
   * asks first, with its own name and its own rung of trust. `workflows` is
   * the product's composer and the switches of a workflow. Needs `asks`.
   */
  agents?: { db: Database; workflows: NotchAgentWorkflows; noClock?: boolean };
  /**
   * From anywhere, and the shape of the day (pass 8). With this given: a
   * line nobody asked for comes up only in a still moment and never in the
   * person's quiet hours; a meeting is said ten minutes before; things are
   * held during a call; the morning, the evening and "while you were away"
   * have their lines; and a lost connection is said. `db` is where the quiet
   * hours and the day of the last morning line are kept. `around` is how the
   * desktop app says that a call is on and whether the machine is online.
   */
  day?: { db: Database; around?: NotchAroundPort; now?: () => number; noClock?: boolean };
  /**
   * Listening to a call (./call.ts): with the person's yes for that call, the
   * desktop app hears it, the pieces are made into words here, and when the
   * call is over the notch says what came out of it. `port` is how the
   * pieces arrive, `listen` asks a desktop app to hear or to stop, `stt` is
   * what makes out speech, `think` is one question to the model. Needs `day`
   * with `around`: a call has to be known to be on.
   */
  calls?: { db: Database; port: NotchCallPort; listen: NotchCallDeps['listen']; stt: NotchCallDeps['stt']; think: NotchCallDeps['think']; noClock?: boolean };
  /**
   * Other people's Jarvises (src/peers/, ./people.ts): what carries the
   * words, and how a page is opened in the person's own browser, for the
   * sign-in. Given only when the engine's switch is on.
   */
  peers?: {
    db: Database; link: PeerLink; openPage(sidecarId: string | null, url: string): Promise<boolean>;
    /** Does a request the person said yes to (src/daemon/notch-peers.ts). */
    work?: (request: { from: string; words: string }) => Promise<{ ok: true; answer: string } | { ok: false }>;
    /** Getting in: the engine put in place, and the server for whoever makes an organisation. */
    setup?: PeerSetupLike;
    /** Files between Pillows: where one is kept while it crosses, and how one that arrived is saved (./people-files.ts). */
    files?: {
      dir: string;
      save(name: string, bytes: Uint8Array): Promise<{ place: string; name: string } | null>;
      /** Looks on the person's computer for the files that may be meant by some words, and takes one from its folder (./people-files.ts). */
      find?: (words: string) => Promise<PeerFileFound[] | null>;
      open?: (place: PeerFileFound['place'], name: string, dir: string) => Promise<Uint8Array | null>;
      /** One bounded question to the model: which of the files is meant. */
      think?: (messages: { role: 'system' | 'user'; content: string }[], signal?: AbortSignal) => Promise<string>;
      /** The line that is remembered about a file the owner once had read. */
      known?: (place: PeerFileFound['place'], name: string) => string | null;
    };
    /** One bounded question to the model: what a sentence that names somebody of the organisation means (./people-read.ts). */
    think?: (messages: { role: 'system' | 'user'; content: string }[], signal?: AbortSignal) => Promise<string>;
    noClock?: boolean;
  };
  /**
   * Noticing (./notice.ts): in the window the person is in, Jarvis looks
   * when their hands rest and offers one thing it could do there. `see` is a
   * picture of that window, `read` what the program names in it, `think` one
   * question to a model that sees pictures. Needs `asks` (a yes runs an
   * instruction) and what `where` knows of the app in front.
   */
  notice?: { see: NotchNoticeDeps['see']; read?: NotchNoticeDeps['read']; think: NotchNoticeDeps['think']; mark?: NotchNoticeDeps['mark']; unmark?: NotchNoticeDeps['unmark']; noClock?: boolean };
  /**
   * Doing it in view (pass 10): jobs done where they can be seen, with
   * Jarvis's own pointers; a job caught by itself when it is done twice by
   * hand; a job shown with "Watch me"; and a thing put where the person
   * points. `hands` does one step on the person's machine. `watchPort` is how
   * the desktop app tells the shape of what the hands do. Needs `asks`: all
   * of it is started by what is said or answered on the notch.
   */
  jobs?: {
    db: Database;
    hands: NotchJobHands;
    watchPort: NotchCatchPort;
    count?: NotchCatchDeps['count'];
    hold: NotchPutDeps['hold'];
    /** Copies a circle off its picture, where a model that sees pictures can be asked. */
    read?: NotchPutDeps['read'];
    /** Asks the desktop apps to tell what the hands do, now and as they connect. */
    watch?: () => void;
    teach: Pick<NotchTeachDeps, 'recorder' | 'save' | 'describe' | 'forget' | 'effect' | 'runSkill' | 'byPlace'>;
    /** Without the clock that offers a shown job at its time of the week. */
    noClock?: boolean;
  };
  /** The clock the lines on the notch run on. Tests give one they can wind forward. */
  clock?: NotchClock;
  log?: (line: string) => void;
}

export interface NotchReal {
  inbox: NotchInbox;
  approvals: NotchApprovals;
  news: NotchNews;
  questions: NotchQuestions | null;
  /** Where suggestion toasts go while the notch is on: the count. */
  suggestions: NotchSuggestions;
  /** Instructions given on the notch, when the brain takes them. */
  asks: NotchAsks | null;
  /** Where the person is and whether Jarvis is looking, when a desktop app tells it. */
  where: NotchWhere | null;
  /** The mail layer, when the brain was given what it needs. */
  mail: NotchMailLayer | null;
  /** The person's quiet hours, when pass 8 is on. */
  quiet: NotchQuiet | null;
  /** What is remembered, with forget (pass 12), when the brain was given its memory. */
  memory: NotchMemory | null;
  /** The notch's own settings and the connections (pass 12). */
  prefs: NotchPrefs | null;
  /** Every movement, playable by hand (pass 12). */
  moves: NotchMoves | null;
  /** Day one (pass 12), when the brain was given what it needs. */
  dayOne: NotchDayOne | null;
  /** The agents (pass 11), when the brain was given the product's workflows. */
  agents: NotchAgents | null;
  /** Whether the person is there, when pass 8 is on. */
  presence: NotchPresence | null;
  /** Calls and the connection, when a desktop app can tell. */
  around: NotchAround | null;
  /** Noticing in the window in front (./notice.ts), when the brain was given what it needs. */
  notice: NotchNotice | null;
  /** Meetings coming up, when the calendar can be reached. */
  soon: NotchSoon | null;
  /** The organisation: the people whose Jarvises this one may talk to (./people.ts), when the engine's switch is on. */
  people: NotchPeople | null;
  talk: NotchTalk | null;
  /** Looking at a thing on the screen, when a desktop app can. */
  look: NotchLook | null;
  /** A file dropped on the notch, when the brain takes instructions. */
  drop: NotchDrop | null;
  /** Doing it in view (pass 10), when the brain was given what it needs. */
  jobs: NotchJobs | null;
  catcher: NotchCatch | null;
  teach: NotchTeach | null;
  put: NotchPutter | null;
  /** The one table of intents the notch routes by, as it stands now: from the words every part hands over, in `NOTCH_ORDER.says`. */
  intents(): NotchIntent[];
  /** Whether a notch page is up: then the notch tells the person, and the toasts need not. */
  showing(): boolean;
  /** Stops looking. */
  stop(): void;
}

/** The parts that have words of their own, as they stand when something is said. Null: that part was not made. */
export interface NotchSideRouters {
  dayOne: NotchIntentSource | null; mail: NotchIntentSource | null; put: NotchIntentSource | null; teach: NotchIntentSource | null;
  people: NotchIntentSource | null; standing: NotchIntentSource | null; agents: NotchIntentSource | null; memory: NotchIntentSource | null;
  calls: NotchIntentSource | null; prefs: NotchIntentSource | null; moves: NotchIntentSource; canDo: NotchIntentSource; said: NotchIntentSource;
  /** The control word: "pause" (./pause.ts). Null when the product's pause was not given. */
  pause: NotchIntentSource | null;
}

/**
 * Where what each part gives stands among the others (./registry.ts gathers it in this order). Not the order
 * the parts are made in: Home shows people, agents, chases and eyes, calls, and they are made as agents,
 * people, chases and eyes, calls; Settings shows noticing before calls, and calls are made first.
 *
 *   says          the words each part acts on itself. The one table orders intents by band (a control word, an
 *                 answer to what is up, a command, something to open, what was said over a line); inside a
 *                 band this is the order. A word to Leo before an eye and a chase, and those before an agent,
 *                 because "tell me when" and "get Sam's answer" are theirs.
 *   homeRows      the rows in Home under the field, each leading to its own list (the rows of a call that is
 *                 on, the prepared replies, what is seen and the jobs that were shown stand above them, in
 *                 places of their own in ./asks.ts).
 *   settingsRows  the rows in Settings that other parts own, after the notch's own.
 *   done, undo    what was done today besides approvals, promises, mail and jobs, and its undo.
 *   hello         who is told that a page came up, after the inbox.
 */
export const NOTCH_ORDER = {
  says: ['pause', 'dayOne', 'mail', 'put', 'teach', 'people', 'standing', 'agents', 'memory', 'calls', 'prefs', 'moves', 'canDo', 'said'],
  homeRows: ['people', 'agents', 'standing', 'calls'],
  settingsRows: ['notice', 'calls'],
  done: ['standing', 'agents'],
  undo: ['standing', 'agents'],
  hello: ['dayOne'],
} as const satisfies NotchOrder & { says: readonly (keyof NotchSideRouters)[] };

/**
 * The one table of intents (./intents.ts), from the lists the parts hand over, in `NOTCH_ORDER.says`: the
 * order the notch's own table has (./registry.ts), so that the corpus asks what the notch asks.
 */
export function notchIntents(routers: NotchSideRouters): NotchIntent[] {
  return notchIntentTable(NOTCH_ORDER.says.map((id) => routers[id]?.intents()));
}

/**
 * Words the notch acts on itself: which intent of the table takes them, or null when none does and they
 * are an instruction like any other. The one place that decides it: the notch calls this, and so does the
 * corpus of what every sentence means (./intents-corpus.test.ts).
 */
export function notchSide(routers: NotchSideRouters, text: string, how?: NotchAskHow): NotchRouted | null {
  return resolveIntent(notchIntents(routers), text, how);
}

/** What a reading of a sentence is made from (`notchRead`). */
export interface NotchReadParts {
  teach: { begins(text: string): boolean } | null;
  people: { read(text: string): Promise<NotchIntentHit | null> | null; reads(text: string): IntentReadPeople | null } | null;
  /** The one reader of a sentence the fixed words missed (./intent-read.ts), and the parts whose intents it may name. Not given: only words about people are read, as before there was one. */
  reader?: NotchIntentReader | null;
  routers?: NotchSideRouters;
  /** The table itself, where it is put together elsewhere (the notch's registry): asked in place of `routers`. */
  table?: () => NotchIntent[];
  /** The name of the app in front, when the notch is looking at it. The name, and nothing else of the window. */
  app?: () => string | null;
}

/**
 * A sentence that no intent took: what the model makes of it (./intent-read.ts), or null when it is not
 * asked and nothing waits. One question for one sentence: whether it is one of the things the notch does
 * itself, said another way; when it names somebody of the organisation, whether it is a word, a question or
 * a file for them (the reading ./people.ts used to ask for by itself, now part of the same question); and
 * what kinds of act it asks for. The answer selects among the intents of the table and the table places it.
 *
 * A sentence that begins as the words for a job that was shown ("continue with the draft to Sam") is not
 * read as a word for anybody: that sentence is for the assistant, and a reading of it could send a word to
 * Sam. Neither is an entry for the owner's own calendar, nor a sentence that names somebody who is not here
 * beside somebody who is (./people.ts, `reads`). The notch calls this, and so does the corpus.
 */
export function notchRead(parts: NotchReadParts, text: string, how?: NotchAskHow): Promise<NotchRead | null> | null {
  const about = parts.teach?.begins(text) ? null : parts.people;
  if (!parts.reader || (!parts.routers && !parts.table)) {
    // No reader of every sentence: words that name somebody are still read, in the question they always had.
    const reading = about?.read(text) ?? null;
    return reading ? reading.then((hit) => ({ hit, asksFor: null, how: 'read' as const, ms: 0 })) : null;
  }
  const people = about?.reads(text) ?? null;
  // After sentences that were not read in time the reading rests: nothing is asked, and nothing waits. Each
  // tier rests on its own, so a sentence that names somebody here is still read while the small tier rests.
  if (parts.reader.resting(people && people.names.length > 0 ? 'people' : 'small')) return null;
  let app: string | null = null;
  try { app = parts.app?.() ?? null; } catch { app = null; }
  return parts.reader.read({ text, how, table: parts.table ? parts.table() : notchIntents(parts.routers!), app, people });
}

/**
 * Whether a line nobody asked for may come up now: only in a still moment, not to an empty chair, and never in
 * the quiet hours. Without the part that knows whether the person is there (before it is made) their hands
 * hold nothing back, and the quiet hours still do.
 */
export function notchMaySpeak(presence: Pick<NotchPresence, 'still' | 'isAway'> | null, quiet: Pick<NotchQuiet, 'now'>): boolean {
  return (!presence || (presence.still() && !presence.isAway())) && !quiet.now();
}

/**
 * Puts the real things on the notch. When a part cannot be made, what was made
 * before it is stopped again and the throw goes on to whoever asked: nothing
 * is left looking at a window or a mailbox for a notch that is not there.
 */
export function attachNotchReal(surface: NotchSurface, deps: NotchRealDeps): NotchReal {
  const built: { stop: (() => void) | null } = { stop: null };
  try {
    return makeNotchReal(surface, deps, built);
  } catch (error) {
    built.stop?.();
    throw error;
  }
}

function makeNotchReal(surface: NotchSurface, deps: NotchRealDeps, built: { stop: (() => void) | null }): NotchReal {
  const log = deps.log ?? ((line: string) => console.log(line));
  // What the notch does in the world, as one list that also writes the audit. Each part writes its own
  // entries, where it knows what came of a thing: this only makes the list and hands it to them.
  const actions = deps.actions ? attachNotchActionsOrNone(deps.actions.db, { audit: deps.actions.audit, log }) : null;
  // Pass 8: the notch's own settings and the person's quiet hours. Made before the inbox, which asks them
  // whether a line may come up.
  const dayNow = deps.day?.now ?? Date.now;
  const settings = deps.day ? new NotchSettings(deps.day.db) : null;
  if (settings) {
    // Every start is a different birth, never the same twice running, across restarts too.
    surface.setBirths(() => {
      const born = notchBirthAfter(settings.get<unknown>('birth', null));
      settings.set('birth', born);
      return born;
    });
    // Its small sounds are the person's own choice, and are kept.
    surface.setSound(settings.get<unknown>('sound', false) === true);
  }
  const quiet = settings ? new NotchQuiet(settings, dayNow) : null;
  // The features, their one scheduler, their one way down, and what they give to Home, Settings and the
  // router, each in NOTCH_ORDER (./registry.ts).
  const registry = createNotchRegistry({
    surface, settings, clock: deps.clock, now: dayNow, log,
    paused: () => (deps.emergency ? deps.emergency.getState() !== 'normal' : false),
    order: NOTCH_ORDER,
  });
  // From here on there is something to stop, if the making fails further down.
  built.stop = () => registry.stop();
  const todayDeps = {
    executedApprovals: (limit: number) => deps.approvalManager.getHistory({ status: 'executed', limit }),
    keptPromises: deps.promises ? () => deps.promises!.kept() : undefined,
    sentMail: (since: number) => registry.use('mail')?.sentSince(since) ?? [],
    // The jobs have a place of their own in Today, and their own undo.
    jobs: (since: number) => registry.use('jobs')?.done(since) ?? [],
    // What else was started and can be taken back: a watch, a chase, an agent that was made (NOTCH_ORDER.done).
    more: (since: number) => registry.all.done(since),
    // And what only the list of what was done has: a follow-up, a word to somebody, what may have gone.
    actions: (since: number) => actions?.today(since) ?? [],
  };
  const today = notchTodayScript(todayDeps);
  const inbox = new NotchInbox(surface, {
    busy: deps.busy,
    clock: deps.clock,
    log,
    home: (stage) => { const asks = registry.use('asks'); return asks ? asks.home(stage) : today(stage); },
    // Only in a still moment, not to an empty chair, and never in the quiet hours. The part that knows whether
    // the person is there is made right after this, whenever there are settings; the quiet hours hold either way.
    ...(quiet ? { maySpeak: () => notchMaySpeak(registry.use('presence'), quiet) } : {}),
    // Replies that were seen wait in Home, not in the count: with any of them there, a round has not been everything.
    elsewhere: () => (registry.use('mail')?.store.ready().length ?? 0) > 0,
  });
  registry.setInbox(inbox);
  // A page has come up: the inbox hears it first (it listens from its making), then each part in NOTCH_ORDER.hello.
  surface.onHello((sidecarId) => registry.hello(sidecarId));
  // Whether the person is there (pass 8). First: the inbox asks it whether a line may come up.
  const presence: NotchPresence | null = registry.add(notchPresenceFeature);
  const approvals = attachNotchApprovals(inbox, {
    approvalManager: deps.approvalManager,
    approve: deps.approve,
    deny: deps.deny,
    openDashboard: deps.openDashboard,
    describe: deps.asks?.describeApproval,
    where: deps.asks?.whereApproval,
    mine: (requestId) => registry.use('asks')?.mine(requestId) === true,
    actions,
    clock: deps.clock,
    log,
  });
  // Where the person is, and whether Jarvis is looking (pass 6). Before the asks and the pause, which both show what it knows.
  const where: NotchWhere | null = registry.add(notchWhereFeature(deps.where ? { ...deps.where, sleep: () => deps.emergency?.pause() } : undefined));
  // Doing it in view (pass 10): jobs done where they can be seen, a job caught when it is done twice by hand, a
  // job shown with "Watch me", and a thing put where the person points. Before asking, which sends "Watch me"
  // and "run it" here. All of it is started by what is said or answered on the notch: without asking, none.
  const shown = deps.asks ? deps.jobs : undefined;
  const jobs: NotchJobs | null = registry.add(notchJobsFeature(shown ? { db: shown.db, hands: shown.hands, actions } : undefined));
  const catcher: NotchCatch | null = registry.add(notchCatchFeature(shown ? { port: shown.watchPort, hands: shown.hands, count: shown.count } : undefined));
  const teach: NotchTeach | null = registry.add(notchTeachFeature(shown ? { ...shown.teach, hands: shown.hands, db: shown.db, count: shown.count, noClock: shown.noClock } : undefined));
  const put: NotchPutter | null = registry.add(notchPutFeature(shown ? { hands: shown.hands, hold: shown.hold, read: shown.read, actions } : undefined));
  if (jobs) shown?.watch?.();
  // Agents (pass 11): a sentence becomes a workflow that is switched on and asks first.
  const agents: NotchAgents | null = registry.add(notchAgentsFeature(deps.agents ? { ...deps.agents, asks: deps.asks !== undefined, actions } : undefined));
  // The back office that fits in a sheet (pass 12): what is remembered, the notch's own settings,
  // what is connected, and every movement, playable by hand. Reached from the foot of Home, and by saying so.
  const office = deps.office;
  const memory: NotchMemory | null = registry.add(notchMemoryFeature(office?.memory));
  const moves: NotchMoves = registry.must(notchMovesFeature);
  // Everything it does, on one sheet: day one ends on it, the settings lead to it, "what can you do" opens it.
  registry.must(notchCanDoFeature);
  // The organisation: the people whose Jarvises this one may talk to. Only with the engine's switch on.
  const peers = deps.peers;
  const people: NotchPeople | null = registry.add(notchPeopleFeature(peers ? { ...peers, store: new PeerStore(peers.db), actions } : undefined));
  // What is said with a line up is tried as an answer to that line (./said.ts). An instruction's own lines are read by ./asks.ts.
  // Words that a shown job could mean are that job's, and are not read as a new value for the line.
  registry.must(notchSaidFeature({ jobWords: (text) => teach?.begins(text) ?? false }));
  const prefs: NotchPrefs | null = registry.add(notchPrefsFeature({
    keys: office?.keys, voice: office?.voice, connections: office?.connections,
    // Called on the back office, as day one's is.
    connect: office?.connect ? (id, sidecarId) => office.connect!(id, sidecarId) : undefined,
    openPage: office?.openPage, openDashboard: deps.openDashboard,
    dayOne: deps.dayOne !== undefined,
  }));
  const readIntent = deps.asks?.readIntent;
  const intentReader = readIntent ? createNotchIntentReader({ think: readIntent, log }) : null;
  const asks: NotchAsks | null = registry.add(notchAsksFeature(deps.asks ? {
    ledger: new NotchLedger(deps.asks.db),
    turns: deps.asks.turns,
    modelReady: deps.asks.modelReady,
    remember: deps.asks.remember,
    understand: deps.asks.understand,
    point: deps.asks.point,
    // After the fixed words: a sentence that is none of them is read by the model, once
    // (./intent-read.ts): is it one of these things said another way, is it a word for somebody of the
    // organisation, and what does it ask for. Only what `side` left: while day one waits to hear the
    // person, whatever they say is its answer and never gets here. The model is told the sentence and the
    // name of the app in front, when the notch is looking at it and the person is not on the desktop.
    read: (text, how) => notchRead({
      teach, people, reader: intentReader,
      table: () => registry.all.intents(),
      app: () => (where && where.onDesktop() !== true ? where.front()?.name ?? null : null),
    }, text, how),
    raiseApproval: (approvalId) => approvals.raise(approvalId),
    stillFor: () => presence?.stillFor() ?? 0,
    // The instruction is over: what it was still asking for is asked no more. Closed as the system:
    // it went through `deny`, and every turn that ended was written in the audit as the owner's no
    // on the notch (the review of 26 November 2026).
    withdrawApproval: (approvalId) => { void deps.withdraw(approvalId).catch(() => {}); },
    openDashboard: deps.openDashboard,
    today: () => notchTodayBlocks(notchToday(todayDeps)),
    // The quiet hours are changed where they are shown. Ending them lets what waited speak.
    quiet: quiet ? notchQuietHome(quiet, () => inbox.calmed()) : undefined,
    mail: deps.mail !== undefined,
  } : undefined));
  // Look at this (pass 9), talking with the keys held, and a file dropped on the notch (pass 9).
  const looking = deps.asks?.look;
  const lookAt: NotchLook | null = registry.add(notchLookFeature(looking ? { port: looking.port, modelReady: looking.modelReady ?? deps.asks!.modelReady } : undefined));
  const talk: NotchTalk | null = registry.add(notchTalkFeature(deps.asks ? { port: deps.asks.talkPort, stt: deps.asks.stt } : undefined));
  const drop: NotchDrop | null = registry.add(notchDropFeature(deps.asks ? { gist: deps.gist } : undefined));
  const promises = deps.promises;
  registry.add(notchPromisesFeature(promises?.executor, actions));
  registry.add(notchPauseFeature(deps.emergency));
  const questions: NotchQuestions | null = registry.add(notchQuestionsFeature(deps.questions ? { ...deps.questions, openDashboard: deps.openDashboard, actions } : undefined));
  // Mail (pass 7), and what stands on it (pass 11): an eye kept on a person's answer, and a chase.
  const mail: NotchMailLayer | null = registry.add(notchMailFeature(deps.mail ? { ...deps.mail, actions } : undefined));
  registry.add(notchStandingFeature(deps.mail && deps.standing ? { ...deps.standing, db: deps.mail.db, actions } : undefined));
  // Pass 8, the rest of it: the calendar as a source, calls and the connection, and the lines of the day.
  const memoryFacts = office?.memory;
  const soon: NotchSoon | null = registry.add(notchSoonFeature(deps.day ? { facts: memoryFacts ? (about) => memoryFacts.list(about) : undefined } : undefined));
  const emergency = deps.emergency;
  const heard = deps.day?.around ? deps.calls : undefined;
  registry.add(notchCallsFeature(heard ? {
    ...heard, actions,
    onPause: emergency ? (listener) => { emergency.subscribe((state) => listener(state !== 'normal')); } : undefined,
  } : undefined));
  const around: NotchAround | null = registry.add(notchAroundFeature(deps.day?.around));
  registry.add(notchDayFeature(deps.day ? {
    done: (since, until) => notchDoneBetween(todayDeps, since, until).length,
    // Called on the promises, as they always were: they may be methods of the product's store.
    slipped: promises?.slipped && promises.move ? { today: (since, until) => promises.slipped!(since, until), move: (ids, at) => promises.move!(ids, at) } : undefined,
    overnight: {
      blocks: (since) => notchTodayBlocks(notchDoneBetween(todayDeps, since, dayNow()), 'Nothing was done overnight.'),
      undo: (row) => {
        if (row.startsWith('job:')) { if (!jobs) return null; jobs.undo(row.slice(4)); return 'left'; }
        return registry.all.undo(row);
      },
    },
    noClock: deps.day.noClock,
  } : undefined));
  // Noticing: in the window the person is in, one thing offered, when their hands rest (./notice.ts).
  const notice: NotchNotice | null = registry.add(notchNoticeFeature(deps.notice ? { ...deps.notice, quiet } : undefined));
  const news = registry.must(notchNewsFeature({
    openFailures: deps.openFailures,
    run: deps.agents ? (flowId) => deps.agents!.workflows.run(flowId) : undefined,
    // The task manager is made later in the daemon's start: it is asked for until it is there.
    onTaskEnded: deps.onTaskEnded,
  }));

  const look = (): void => {
    try {
      approvals.sync();
    } catch (error) {
      log(`[notch] looking for what waits failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  look();
  registry.every('looking for what waits', deps.lookMs ?? NOTCH_APPROVAL_LOOK_MS, look);

  // Day one (pass 12). Made last: it leans on the look, the mail layer and the way to a sign-in.
  const dayOne: NotchDayOne | null = registry.add(notchDayOneFeature(deps.dayOne ? {
    ...deps.dayOne, isWhere: whereQuestion, canPoint: deps.asks?.point !== undefined,
    // Called on the back office, as it always was.
    connect: office?.connect ? (id, sidecarId) => office.connect!(id, sidecarId) : undefined,
  } : undefined));

  const suggestions = registry.must(notchSuggestionsFeature);
  return {
    inbox, approvals, news, questions, suggestions, asks, where, talk, look: lookAt, drop, mail, quiet, presence, around, soon,
    jobs, catcher, teach, put, memory, prefs, moves, dayOne, agents, notice, people,
    intents: () => registry.all.intents(),
    // A notch that was stopped tells the person nothing: what it would have said goes where it went before there was a notch.
    showing: () => !registry.stopped() && surface.listening() > 0,
    stop: () => registry.stop(),
  };
}
