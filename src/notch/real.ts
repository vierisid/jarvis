/**
 * The real things on the notch, put together.
 *
 * One call from the daemon builds the inbox, connects each kind of real thing
 * to it (approvals, and the rest as they are added), gives yes at rest its
 * home (Today), and keeps looking for what is new. The daemon hands over the
 * product's own objects and functions; nothing here reaches for them itself,
 * so this file can be read as the list of what the notch touches.
 */
import type { ToolRegistry } from '../actions/tools/registry.ts';
import type { ApprovalManager, ApprovalRequest } from '../authority/approval.ts';
import type { ApprovalDecisionOutcome } from '../daemon/approval-decision.ts';
import type { Database } from 'bun:sqlite';
import { attachNotchWhere, type NotchWhere, type NotchWherePort } from './where.ts';
import { NOTCH_APPROVAL_LOOK_MS, attachNotchApprovals } from './approvals.ts';
import { attachNotchAsks } from './asks.ts';
import type { NotchAskFile, NotchAskHow, NotchAsks, NotchAsksDeps } from './asks.ts';
import { NotchLedger } from './ledger.ts';
import { attachNotchLook, type NotchLook, type NotchLookDeps, type NotchLookPort } from './look.ts';
import { attachNotchTalk } from './talk.ts';
import type { NotchTalk, NotchTalkDeps, NotchTalkPort } from './talk.ts';
import type { NotchApprovalWhere, NotchApprovals } from './approvals.ts';
import type { CommitmentEvent, CommitmentRunner } from '../daemon/commitment-executor.ts';
import { NOTCH_FIXTURE_ORIGIN, createNotchFixtures, notchFixturePromiseRun } from './fixtures.ts';
import type { NotchFixtures } from './fixtures.ts';
import { NotchInbox } from './inbox.ts';
import { NOTCH_FAILURE_LOOK_MS, attachNotchNews } from './news.ts';
import type { NotchNews, NotchOpenFailure } from './news.ts';
import { attachNotchPause } from './pause.ts';
import type { NotchPauseDeps } from './pause.ts';
import { attachNotchPromises } from './promises.ts';
import { NOTCH_QUESTION_LOOK_MS, attachNotchQuestions } from './questions.ts';
import type { NotchQuestionDeps, NotchQuestions } from './questions.ts';
import { attachNotchAround, type NotchAround, type NotchAroundPort } from './around.ts';
import { attachNotchCalls, type NotchCallDeps, type NotchCallPort, type NotchCalls } from './call.ts';
import { attachNotchNotice, type NotchNotice, type NotchNoticeDeps } from './notice.ts';
import { attachNotchDrop, type NotchDrop } from './drop.ts';
import { attachNotchDay, type NotchDay } from './day.ts';
import { attachMailLayer, type NotchMailLayer, type NotchMailLayerDeps } from './mail/attach.ts';
import { NOTCH_MAIL_ITEM, mailToneFacts } from './mail/notch.ts';
import { NotchPresence } from './presence.ts';
import { NotchQuiet, notchQuietHome } from './quiet.ts';
import { NotchSettings } from './settings.ts';
import { attachNotchSoon, type NotchSoon } from './soon.ts';
import type { NotchClock } from './stage.ts';
import { notchBirthAfter, type NotchSurface } from './surface.ts';
import { attachNotchSuggestions } from './suggestions.ts';
import type { NotchSuggestions } from './suggestions.ts';
import { notchDoneBetween, notchToday, notchTodayBlocks, notchTodayScript } from './today.ts';
import { attachNotchCatch, type NotchCatch, type NotchCatchDeps, type NotchCatchPort } from './catch.ts';
import { attachNotchJobs, type NotchJobHands, type NotchJobs } from './jobs.ts';
import { attachNotchPut, type NotchPutDeps, type NotchPutter } from './put.ts';
import { NOTCH_STANDING_TICK_MS, attachNotchStanding, type NotchStanding } from './standing.ts';
import { attachNotchPeople } from './people.ts';
import type { NotchPeople } from './people.ts';
import type { PeerLink } from '../peers/link.ts';
import type { PeerSetupLike } from '../peers/setup.ts';
import type { PeerFileFound } from './people-files.ts';
import { PeerStore } from '../peers/store.ts';
import { NOTCH_AGENT_TICK_MS, attachNotchAgents, type NotchAgentWorkflows, type NotchAgents } from './agents.ts';
import { attachNotchTeach, type NotchTeach, type NotchTeachDeps } from './teach.ts';
import { attachNotchMemory, type NotchMemory, type NotchMemoryDeps } from './memory.ts';
import { attachNotchMoves, type NotchMoves } from './moves.ts';
import { attachNotchPrefs, type NotchPrefs, type NotchPrefsDeps, type NotchSettingsPage } from './prefs.ts';
import { attachNotchDayOne, type NotchDayOne, type NotchDayOneDeps } from './dayone.ts';
import { attachNotchCanDo, type NotchCanDo } from './cando.ts';
import { notchBeforeNotes } from './before.ts';
import type { NotchPart } from './protocol.ts';
import { attachNotchSaid } from './said.ts';
import { whereQuestion } from './point.ts';

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
  /** Approves as a click on the dashboard card does. Given only when fixtures may be made, and used by them only. */
  approveAsDashboard?: (requestId: string) => Promise<ApprovalDecisionOutcome>;
  /** The brain's own tools, once loaded. Used by the shell command fixture only, and given only when fixtures may be made. */
  toolRegistry?: () => ToolRegistry | null | undefined;
  /** Shows a new approval wherever approvals are shown. Used by the fixtures only. */
  deliverApproval?: (request: ApprovalRequest) => Promise<void> | void;
  /** Opens the dashboard on the machine named, or on every machine showing the notch. */
  openDashboard?: (sidecarId: string | null) => void;
  /** Promises: the executor that keeps them, and the store they live in. */
  promises?: {
    executor: {
      subscribe(listener: (event: CommitmentEvent) => void): () => void;
      cancelExecution(commitmentId: string): boolean;
      checkAndAnnounce(): void;
      setOriginRunner(origin: string, run: CommitmentRunner): void;
    };
    create(what: string, options: { when_due: number; assigned_to: string; created_from: string }): { id: string; when_due: number | null };
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
    /** Adds a line to the fixture promise's log. Given only when fixtures may be made. */
    appendFixtureLog?: (line: string) => void;
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
  /** Makes one test failure in the product's own failure list. Given only when fixtures may be made. */
  recordFixtureFailure?: () => string;
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
  fixtures: NotchFixtures;
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
  /** Whether a notch page is up: then the notch tells the person, and the toasts need not. */
  showing(): boolean;
  /** Stops looking. */
  stop(): void;
}

/** One of the parts that has words of its own. */
interface NotchSideRouter { route(text: string, how?: NotchAskHow): { did: string; run(): void } | null }

/** The parts that have words of their own, as they stand when something is said. Null: that part was not made. */
export interface NotchSideRouters {
  dayOne: NotchSideRouter | null; mail: NotchSideRouter | null; put: NotchSideRouter | null; teach: NotchSideRouter | null;
  people: NotchSideRouter | null; standing: NotchSideRouter | null; agents: NotchSideRouter | null; memory: NotchSideRouter | null;
  calls: NotchSideRouter | null; prefs: NotchSideRouter | null; moves: NotchSideRouter; canDo: NotchSideRouter; saidLine: NotchSideRouter;
}

/**
 * Words the notch acts on itself: which part takes them, asked in this order, or null when none does and
 * they are an instruction like any other. The one place that decides it: the notch calls this, and so does
 * the corpus of what every sentence means (./intents-corpus.test.ts).
 */
export function notchSide(routers: NotchSideRouters, text: string, how?: NotchAskHow): { did: string; run(): void } | null {
  const { dayOne, mail, put, teach, people, standing, agents, memory, calls, prefs, moves, canDo, saidLine } = routers;
  return dayOne?.route(text) ?? mail?.route(text, how) ?? put?.route(text) ?? teach?.route(text) ?? people?.route(text) ?? standing?.route(text) ?? agents?.route(text)
    ?? memory?.route(text) ?? calls?.route(text) ?? prefs?.route(text) ?? moves.route(text) ?? canDo.route(text)
    // After everything that has words of its own: what was said over a line that is up answers that line.
    ?? saidLine.route(text, how) ?? null;
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

/** How often a clock of the notch that keeps failing says so in the log. */
export const NOTCH_TICK_FAILURE_SAID_MS = 60_000;

function makeNotchReal(surface: NotchSurface, deps: NotchRealDeps, built: { stop: (() => void) | null }): NotchReal {
  const log = deps.log ?? ((line: string) => console.log(line));
  // From here on there is something to stop, if the making fails further down.
  built.stop = stop;
  /**
   * What a clock runs. A look that fails is said in the log and is tried again
   * at the next one: a throw out of a timer is an uncaught exception, and that
   * ends the brain.
   */
  const guarded = (what: string, run: () => void): (() => void) => {
    // One that fails at every look is not said at every look: the first time, with where it failed, and then
    // once a minute with how often it failed in between.
    let saidAt: number | null = null;
    let unsaid = 0;
    return () => {
      try {
        run();
      } catch (error) {
        const at = Date.now();
        if (saidAt !== null && at - saidAt < NOTCH_TICK_FAILURE_SAID_MS) { unsaid++; return; }
        const why = error instanceof Error ? error.message : String(error);
        const where = saidAt === null && error instanceof Error && error.stack ? `\n${error.stack}` : '';
        log(`[notch] ${what} failed${unsaid > 0 ? ` (and ${unsaid} more ${unsaid === 1 ? 'time' : 'times'} since that was last said)` : ''}: ${why}${where}`);
        saidAt = at;
        unsaid = 0;
      }
    };
  };
  // Whether the notch was made whole, and whether it was stopped since. Up here, where `stop` can always read them.
  let whole = false;
  let stopped = false;
  // Made after the inbox it puts its lines in; Today and the place the person is in both reach it.
  let mail: NotchMailLayer | null = null;
  // Made after the inbox they play on; Today lists what they did.
  let jobs: NotchJobs | null = null;
  let catcher: NotchCatch | null = null;
  let teach: NotchTeach | null = null;
  let put: NotchPutter | null = null;
  let standing: NotchStanding | null = null;
  let standingTimer: ReturnType<typeof setInterval> | null = null;
  // Made further down, once the mail and the day are: what is said and shown before then finds it when it is asked.
  let calls: NotchCalls | null = null;
  let people: NotchPeople | null = null;
  let callTimer: ReturnType<typeof setInterval> | null = null;
  let notice: NotchNotice | null = null;
  let noticeTimer: ReturnType<typeof setInterval> | null = null;
  // One of the notch's eyes is citron while something is watched for, or a call is listened to.
  let eyeKept = false, eyeCall = false;
  const paintEye = (): void => surface.setEye(eyeKept || eyeCall);
  let agents: NotchAgents | null = null;
  let agentsTimer: ReturnType<typeof setInterval> | null = null;
  const todayDeps = {
    executedApprovals: (limit: number) => deps.approvalManager.getHistory({ status: 'executed', limit }),
    keptPromises: deps.promises ? () => deps.promises!.kept() : undefined,
    sentMail: (since: number) => mail?.sentSince(since) ?? [],
    jobs: (since: number) => jobs?.done(since) ?? [],
    // What else was started and can be taken back: a watch, a chase, an agent that was made.
    more: (since: number) => [...(standing?.done(since) ?? []), ...(agents?.done(since) ?? [])],
  };
  /** Undo on a row of what was done that is not a paste: what to say, or null when the row stands for nothing that can be taken back. */
  const undoRow = (row: string): NotchPart[] | null => standing?.undo(row) ?? agents?.undo(row) ?? null;
  // Made after the inbox, which opens it: yes at rest with nothing waiting.
  let asks: NotchAsks | null = null;
  const today = notchTodayScript(todayDeps);
  // Pass 8: whether the person is there, and their quiet hours. Made before the inbox, which asks them
  // whether a line may come up; what they set off is made after it and reached through these.
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
  let day: NotchDay | null = null;
  let calmed: () => void = () => {};
  const presence = settings ? new NotchPresence({
    settings,
    calm: () => calmed(),
    hands: () => asks?.handsOn(),
    left: (at) => day?.left(at),
    back: (away) => { void day?.back(away); },
    morning: (away) => day?.morning(away),
    now: dayNow,
    clock: deps.clock,
    log,
  }) : null;
  const inbox = new NotchInbox(surface, {
    busy: deps.busy,
    clock: deps.clock,
    log,
    home: (stage) => (asks ? asks.home(stage) : today(stage)),
    // Only in a still moment, not to an empty chair, and never in the quiet hours.
    ...(presence && quiet ? { maySpeak: () => presence.still() && !presence.isAway() && !quiet.now() } : {}),
    // Replies that were seen wait in Home, not in the count: with any of them there, a round has not been everything.
    elsewhere: () => (mail?.store.ready().length ?? 0) > 0,
  });
  calmed = () => inbox.calmed();
  const approvals = attachNotchApprovals(inbox, {
    approvalManager: deps.approvalManager,
    approve: deps.approve,
    deny: deps.deny,
    openDashboard: deps.openDashboard,
    describe: deps.asks?.describeApproval,
    where: deps.asks?.whereApproval,
    mine: (requestId) => asks?.mine(requestId) === true,
    clock: deps.clock,
    log,
  });
  // Where the person is, and whether Jarvis is looking (pass 6). Before the
  // asks and the pause, which both show what it knows.
  const where: NotchWhere | null = deps.where
    ? attachNotchWhere(surface, inbox, deps.where.port, {
      asleep: () => (deps.emergency ? deps.emergency.getState() !== 'normal' : false),
      sleep: () => deps.emergency?.pause(),
      watching: deps.where.watching,
      openEyes: deps.where.openEyes,
      // Coming to Gmail is where a prepared reply speaks up (pass 7).
      arrived: (site) => mail?.arrived(site),
      // Their hands: still, away, back, the first time today (pass 8).
      hands: (still) => presence?.hands(still),
      log,
    })
    : null;
  let talk: NotchTalk | null = null;
  let lookAt: NotchLook | null = null;
  let drop: NotchDrop | null = null;
  const jobTimers: ReturnType<typeof setInterval>[] = [];
  if (deps.asks && deps.jobs) {
    // Doing it in view (pass 10). Before asking, which sends "Watch me" and "run it" here.
    const given = deps.jobs;
    const emergency = deps.emergency;
    const paused = emergency ? () => emergency.getState() !== 'normal' : undefined;
    jobs = attachNotchJobs(inbox, {
      db: given.db, hands: given.hands, paused,
      // What the person does while Jarvis works is not a job to take over, and what came before it is over.
      running: () => catcher?.reset(),
      log,
    });
    catcher = attachNotchCatch(given.watchPort, {
      inbox, jobs, hands: given.hands, paused, count: given.count,
      teaching: () => teach?.watching() ?? false,
      log,
    });
    teach = attachNotchTeach({
      inbox, jobs, hands: given.hands, db: given.db, ...given.teach, count: given.count,
      catcher: () => catcher, paused, log,
    });
    put = attachNotchPut({ inbox, jobs, hands: given.hands, hold: given.hold, read: given.read, paused, log });
    given.watch?.();
    if (!given.noClock) {
      const learned = teach;
      const every = setInterval(guarded('the clock of the shown jobs', () => learned.tick()), 30_000);
      every.unref?.();
      jobTimers.push(every);
    }
  }
  if (deps.agents && deps.asks) {
    const emergency = deps.emergency;
    const made = attachNotchAgents({
      inbox, db: deps.agents.db, workflows: deps.agents.workflows, log,
      paused: emergency ? () => emergency.getState() !== 'normal' : undefined,
    });
    agents = made;
    if (!deps.agents.noClock) {
      agentsTimer = setInterval(() => { try { made.tick(); } catch (error) { log(`[notch] the agents' runs could not be looked at: ${error instanceof Error ? error.message : String(error)}`); } }, NOTCH_AGENT_TICK_MS);
      agentsTimer.unref?.();
    }
  }
  // The back office that fits in a sheet (pass 12): what is remembered, the notch's own settings,
  // what is connected, and every movement, playable by hand. Reached from the foot of Home, and by saying so.
  const office = deps.office;
  // Made further down, when what it leans on is there. Reached through this until then.
  let dayOne: NotchDayOne | null = null;
  // How a person is always written to ("Always use a short tone with Marco?") is something that was learned:
  // it stands in Memory with everything else that is remembered, and is forgotten there.
  const toneFacts = (about?: string): ReturnType<NotchMemoryDeps['list']> => mailToneFacts(mail?.store.tones() ?? [], about);
  const memory: NotchMemory | null = office?.memory ? attachNotchMemory({
    inbox, log,
    list: (about) => [...toneFacts(about), ...office.memory!.list(about)],
    forget: (id) => (id.startsWith('tone:') ? (mail?.store.forgetTone(id.slice('tone:'.length)) ?? false) : office.memory!.forget(id)),
  }) : null;
  const moves: NotchMoves = attachNotchMoves({ inbox, resting: () => surface.resting(), log });
  // Everything it does, on one sheet: day one ends on it, the settings lead to it, "what can you do" opens it.
  const canDo: NotchCanDo = attachNotchCanDo({ inbox });
  // The organisation: the people whose Jarvises this one may talk to. Only with the engine's switch on.
  if (deps.peers) {
    people = attachNotchPeople({
      inbox, link: deps.peers.link, store: new PeerStore(deps.peers.db), openPage: deps.peers.openPage, log,
      ...(deps.peers.work ? { work: deps.peers.work } : {}),
      ...(deps.peers.setup ? { setup: deps.peers.setup } : {}),
      ...(deps.peers.think ? { think: deps.peers.think } : {}),
      // A time that is free for two people: the owner's calendar, read the way the mail layer reads it. Asked
      // for when it is needed, so it does not matter that the mail layer is made after this.
      time: { calendar: (from: number, to: number) => (mail ? mail.calendar(from, to) : Promise.resolve(null)) },
      // On a call what arrives is held, and whoever sent it is told. The part that knows of calls is made after this.
      onCall: () => around?.onCall() ?? false,
      // The owner's chases, for a job that changes hands. Asked for when it is needed: that part is made after this.
      chases: () => standing,
      // The owner's agents, to send one to somebody, and to make one that somebody sent and the owner took on.
      agents: { list: () => agents?.list() ?? [], take: (sentence: string) => agents?.take(sentence) ?? false },
      // What was last circled and is still held, for "send this to Leo". Asked for when it is said: the part that holds it is made after this.
      look: () => { const held = put?.held() ?? null; return held ? { what: held.what, rows: held.rows, app: held.app } : null; },
      // A file that arrived is held by the notch like one that was dropped on it, with the same card.
      ...(deps.peers.files ? { files: { ...deps.peers.files, arrived: (file: { name: string; bytes: Uint8Array; from: string; place: string | null }) => drop?.arrived(file) ?? false } } : {}),
      ...(deps.peers.noClock ? { noClock: true } : {}),
    });
  }
  // What is said with a line up is tried as an answer to that line (./said.ts). An instruction's own lines are read by ./asks.ts.
  const saidLine = attachNotchSaid({ inbox, line: () => surface.current().line, skip: (item) => item.startsWith('ask:'), log });
  const openPage = office?.openPage;
  const prefs: NotchPrefs | null = settings ? attachNotchPrefs({
    inbox, settings, log,
    setSound: (on) => surface.setSound(on),
    keys: office?.keys,
    voice: office?.voice,
    see: where ? (stage) => where.see(stage) : undefined,
    moves: (stage) => moves.open(stage),
    canDo: (stage) => canDo.open(stage),
    dayOne: deps.dayOne ? () => dayOne?.again() : undefined,
    // Listening to calls: whether it is offered, and whether the other side is heard.
    calls: deps.calls ? { row: () => calls?.settingsRow() ?? null, set: (name, value) => calls?.setWord(name, value) ?? false } : undefined,
    // Noticing: whether it offers one thing in the window the person is in.
    notice: deps.notice ? { row: () => notice?.settingsRow() ?? null, set: (name, value) => notice?.setWord(name, value) ?? false } : undefined,
    connections: office?.connections,
    connect: office?.connect,
    // A page of the dashboard when it can be opened at one, the dashboard itself when not.
    openDashboard: openPage || deps.openDashboard
      ? (sidecarId, page) => { if (page && openPage) openPage(sidecarId, page); else deps.openDashboard?.(sidecarId); }
      : undefined,
  }) : null;
  if (deps.asks) {
    const emergency = deps.emergency;
    asks = attachNotchAsks(inbox, {
      ledger: new NotchLedger(deps.asks.db),
      turns: deps.asks.turns,
      modelReady: deps.asks.modelReady,
      remember: deps.asks.remember,
      understand: deps.asks.understand,
      point: deps.asks.point,
      // "Watch me", "done", "run it on nine rows", "undo that": the notch does these itself (pass 10).
      // And "put it here as a table", with a thing held.
      // "Tell me when Sam replies", "get Sam's answer by Friday": an eye, a chase (pass 11).
      // "Every Monday send Sam the numbers": an agent. An eye and a chase are asked before it,
      // because "tell me when" and "get Sam's answer" are theirs.
      // First of all: with a draft of a reply open, what is said is what that reply is to say.
      // Last, what only opens something of the notch's own: its memory, its settings, its connections, how it moves (pass 12).
      // Before all of them: while day one waits to hear the person, whatever they say is its answer.
      // Before an eye and a chase: "tell Leo ..." is a word to Leo when Leo's Jarvis is one this one talks to (./people.ts).
      // The parts are read when something is said, not now: several of them are made further down.
      side: (text, how) => notchSide({ dayOne, mail: mail?.mail ?? null, put, teach, people, standing, agents, memory, calls, prefs, moves, canDo, saidLine }, text, how),
      // After all of them: words that name somebody of the organisation and are none of the fixed ones are
      // read by the model (./people-read.ts). Only what `side` left: while day one waits to hear the person,
      // whatever they say is its answer and never gets here.
      read: (text) => people?.read(text) ?? null,
      keys: () => saidLine.keys(),
      // Who the owner writes with: a name that was heard and is close to one of theirs is read back (./names.ts).
      people: () => mail?.store.people() ?? [],
      // And who is in the organisation: a name that is exactly one of theirs is not read back as somebody else's.
      here: () => people?.names() ?? [],
      unheard: (why) => dayOne?.unheard(why) ?? false,
      pointed: (shown) => dayOne?.pointed(shown),
      // The quiet links at the foot of Home: each opens over it, and Home is back when it is closed.
      more: {
        buttons: () => [
          ...(memory ? [{ id: 'memory', label: 'Memory', quiet: true }] : []),
          ...(prefs && office?.connections ? [{ id: 'connections', label: 'Connections', quiet: true }] : []),
          ...(prefs ? [{ id: 'settings', label: 'Settings', quiet: true }] : []),
          ...(deps.openDashboard ? [{ id: 'dashboard', label: 'Dashboard', quiet: true }] : []),
        ],
        press: async (stage, button) => {
          if (button === 'memory' && memory) { await memory.open(stage); return 'stay'; }
          if (button === 'connections' && prefs) { await prefs.connections(stage); return 'stay'; }
          if (button === 'settings' && prefs) return (await prefs.settings(stage)) === 'leave' ? 'leave' : 'stay';
          if (button === 'dashboard' && deps.openDashboard) { deps.openDashboard(stage.from()); return 'leave'; }
          return null;
        },
      },
      // What the assistant built in a turn is an agent like any other: switched on and named here.
      afterTurn: (since) => agents?.adopt(since),
      standing: {
        rows: () => { const row = agents?.row(); return [...(people?.rows() ?? []), ...(row ? [row] : []), ...(standing?.rows() ?? []), ...(calls?.rows() ?? [])]; },
        open: async (stage, row) => {
          if (row === 'people') await people?.open(stage);
          else if (row === 'people-server') await people?.server(stage);
          else if (row === 'agents') await agents?.open(stage);
          else if (row === 'eyes' || row === 'chases') await standing?.open(stage, row);
          else if (row === 'calls') await calls?.open(stage, row);
        },
      },
      learned: teach ? { row: () => teach!.row(), open: (stage) => teach!.open(stage) } : undefined,
      undoJob: jobs ? (jobId) => jobs!.undo(jobId) : undefined,
      undoRow,
      // On a call: Home says so, and has the way to have it listened to when it is not.
      call: { row: () => around?.callRow() ?? null, open: async (stage) => { await around?.callOpen(stage); } },
      paused: emergency ? () => emergency.getState() !== 'normal' : undefined,
      raiseApproval: (approvalId) => approvals.raise(approvalId),
      // While a call is listened to, the microphone is the call's. On any other call the talk keys work.
      callHeard: () => calls?.listening() ?? false,
      stillFor: () => presence?.stillFor() ?? 0,
      // The instruction is over: what it was still asking for is asked no more. Closed as the system:
      // it went through `deny`, and every turn that ended was written in the audit as the owner's no
      // on the notch (the review of 26 November 2026).
      withdrawApproval: (approvalId) => { void deps.withdraw(approvalId).catch(() => {}); },
      attention: () => surface.act({ gesture: 'shake' }),
      nod: () => surface.act({ gesture: 'nodg', kick: 240 }),
      reach: (aim) => surface.act({ lip: 'reach', aim }),
      openDashboard: deps.openDashboard,
      today: () => notchTodayBlocks(notchToday(todayDeps)),
      see: where ? { row: () => where.row(), open: (stage) => where.see(stage) } : undefined,
      // Replies that are prepared wait in Home, one row for all of them (pass 7).
      mail: deps.mail ? { row: () => mail?.mail.homeRow() ?? null, open: async (stage) => { await mail?.mail.open(stage); } } : undefined,
      // The quiet hours are changed where they are shown. Ending them lets what waited speak.
      quiet: quiet ? notchQuietHome(quiet, () => inbox.calmed()) : undefined,
      log,
    });
    // Look at this (pass 9). It is joined to talking, because the same keys
    // are held for both: what is said while a thing is circled is about it.
    if (deps.asks.look) {
      const owner = asks;
      lookAt = attachNotchLook(deps.asks.look.port, {
        inbox,
        // Nothing was said with it: the question is the notch's own, not the owner's word.
        ask: (text, files) => { owner.shown(text, files); },
        talking: (sidecarId) => talk?.open(sidecarId) ?? false,
        modelReady: deps.asks.look.modelReady ?? deps.asks.modelReady,
        paused: emergency ? () => emergency.getState() !== 'normal' : undefined,
        // What was shown is held for a while, and a place pointed at meanwhile is where it goes (pass 10).
        // On day one, the first look anyone takes is the lesson, and nothing else comes of it.
        shown: (sidecarId, looked) => dayOne?.shown(looked) === true || (put?.shown(sidecarId, looked) ?? false),
        // The blink is the shutter, and what was circled is swallowed.
        seen: () => surface.act({ gesture: 'blink', kick: 230 }),
        log,
      });
    }
    // What is said while a dropped file waits for its question is about that file: the words take it.
    talk = attachNotchTalk(deps.asks.talkPort, { asks, stt: deps.asks.stt, look: lookAt ?? undefined, held: () => drop?.claim() ?? [], log });
    // A file dropped on the notch (pass 9) waits for its question: one of three offered, typed, or said.
    const owner = asks;
    drop = attachNotchDrop(surface, inbox, {
      // A button's words are the notch's own; what was typed in the field is the owner's.
      ask: (text, files, said) => { if (said) owner.typed(text, files); else owner.shown(text, files); },
      tell: (parts, mood) => { owner.tell(parts, mood); },
      // For somebody in the organisation: the file goes on as it was dropped (./people-files.ts).
      ...(people ? { send: { to: () => people!.fileTargets(), file: (to: string, file: { name: string; bytes: Uint8Array }) => people!.sendFile(to, file) } } : {}),
      paused: emergency ? () => emergency.getState() !== 'normal' : undefined,
      // A file that arrived from somebody is read by itself, and what it is is said with its arrival.
      ...(deps.gist ? { gist: deps.gist } : {}),
      // On day one, the first file anyone drops is the lesson, and is asked about as any file is.
      taken: () => dayOne?.gave(),
      log,
    });
  }
  const promises = deps.promises;
  const stopPromises = promises ? attachNotchPromises(inbox, { executor: promises.executor }) : () => {};
  // A fixture promise is kept by writing one line, not by a model turn.
  const appendFixtureLog = promises?.appendFixtureLog;
  if (promises && appendFixtureLog) {
    promises.executor.setOriginRunner(NOTCH_FIXTURE_ORIGIN, notchFixturePromiseRun(appendFixtureLog));
  }
  const stopPause = deps.emergency
    ? attachNotchPause(surface, inbox, {
      controller: deps.emergency,
      restFace: where ? () => where.face() : undefined,
      changed: where ? () => where.refresh() : undefined,
      log,
    })
    : () => {};
  const questions: NotchQuestions | null = deps.questions
    ? attachNotchQuestions(inbox, { ...deps.questions, openDashboard: deps.openDashboard, log })
    : null;
  questions?.sync();
  const questionTimer = questions ? setInterval(guarded('looking for questions', () => questions.sync()), NOTCH_QUESTION_LOOK_MS) : null;
  questionTimer?.unref?.();
  if (deps.mail) {
    const emergency = deps.emergency;
    const paused = emergency ? () => emergency.getState() !== 'normal' : undefined;
    mail = attachMailLayer(inbox, { ...deps.mail, paused, log });
    if (deps.standing) {
      const kept = attachNotchStanding({
        inbox, db: deps.mail.db, mail: mail.standing, paused, log,
        // Without a connection a follow-up that is due is held, and goes out when the connection is back.
        offline: () => (around ? !around.online() : false),
        eye: (on) => { eyeKept = on; paintEye(); },
        fired: () => surface.act({ gesture: 'pop' }),
        ...(deps.standing.chaseWaitMs ? { waitMs: deps.standing.chaseWaitMs } : {}),
      });
      standing = kept;
      if (!deps.standing.noClock) {
        standingTimer = setInterval(() => { void kept.tick().catch((error) => log(`[notch] a chase's step failed: ${error instanceof Error ? error.message : String(error)}`)); }, NOTCH_STANDING_TICK_MS);
        standingTimer.unref?.();
      }
    }
  }
  // Pass 8, the rest of it: the calendar as a source, calls and the connection, and the lines of the day.
  let soon: NotchSoon | null = null;
  let around: NotchAround | null = null;
  const dayTimers: ReturnType<typeof setInterval>[] = [];
  if (deps.day && settings) {
    const layer = mail;
    const asleep = (): boolean => (deps.emergency ? deps.emergency.getState() !== 'normal' : false);
    if (layer) {
      soon = attachNotchSoon(inbox, {
        calendar: (from, to) => layer.calendar(from, to), now: dayNow, log,
        // Before a call: what is held about the one other person it is with. From the calls that were
        // written down, the mail that was waited on, and what is remembered. Nothing is fetched or asked.
        notes: (meeting) => notchBeforeNotes(meeting, {
          people: () => layer.store.people(),
          calls: () => (calls?.store.recent(20) ?? []).flatMap((call) => (call.notes ? [{ at: call.startedAt, with: call.notes.with, summary: call.notes.summary, actions: call.notes.actions }] : [])),
          mail: (address) => layer.store.withPerson(address).map((row) => ({ at: row.messageAt, about: row.about, subject: row.subject, state: row.state })),
          facts: office?.memory ? (about) => office.memory!.list(about).map((fact) => ({ text: `${fact.about} ${fact.text}`.trim() })) : undefined,
        }),
      });
    }
    if (deps.day.around && deps.calls) {
      const emergency = deps.emergency;
      const kept = attachNotchCalls(deps.calls.port, {
        inbox, db: deps.calls.db, settings, log,
        listen: deps.calls.listen, stt: deps.calls.stt, think: deps.calls.think,
        // The follow-up goes the way a chase's mail goes: in the thread with that person, or as a new mail.
        mail: layer ? { find: (who) => layer.standing.find(who), send: (plan) => layer.standing.send(plan), went: (plan, since) => layer.standing.went(plan, since), owner: () => layer.standing.owner() } : undefined,
        paused: asleep,
        onPause: emergency ? (listener) => { emergency.subscribe((state) => listener(state !== 'normal')); } : undefined,
        eye: (on) => { eyeCall = on; paintEye(); },
        now: dayNow,
      });
      calls = kept;
      kept.sweep();
      if (!deps.calls.noClock) { callTimer = setInterval(guarded('clearing old calls', () => kept.sweep()), 3_600_000); callTimer.unref?.(); }
    }
    if (deps.day.around) {
      around = attachNotchAround(surface, inbox, deps.day.around, {
        meetingNow: () => soon?.meetingNow() ?? false,
        asleep,
        listen: calls ? {
          offer: (stage, sidecarId) => calls!.offer(stage, sidecarId), ended: () => calls!.ended(),
          // For Home's row on a call: whether it is listened to, and the way to have it listened to after all.
          listening: () => calls!.listening(), can: () => calls!.can(), start: (stage, sidecarId) => calls!.start(stage, sidecarId),
        } : undefined,
        // What could not be read while there was no connection is read now, and the follow-ups that were
        // held go out: how many went is what "Back online" says.
        backOnline: () => { void layer?.look('glance'); return standing?.released() ?? 0; },
        clock: deps.clock,
        now: dayNow,
        log,
      });
    }
    const lines = new Set(['morning', 'evening', 'back', NOTCH_MAIL_ITEM]);
    day = attachNotchDay(inbox, {
      settings,
      done: (since, until) => notchDoneBetween(todayDeps, since, until).length,
      // What needs the person: everything in the count that is not one of these lines or a meeting, and every reply that is drafted.
      waiting: () => inbox.waiting().filter((item) => !lines.has(item.id) && !item.id.startsWith('soon:')).length + (layer?.store.ready().length ?? 0),
      away: () => presence?.isAway() ?? false,
      morningSaid: () => presence?.morningSaid(),
      // What was promised for today and not kept: the evening offers to move it.
      slipped: deps.promises?.slipped && deps.promises.move
        ? { today: (since, until) => deps.promises!.slipped!(since, until), move: (ids, at) => deps.promises!.move!(ids, at) }
        : undefined,
      // What the morning line opens: the receipts of the night, with Undo where a thing can be taken back.
      overnight: {
        blocks: (since) => notchTodayBlocks(notchDoneBetween(todayDeps, since, dayNow()), 'Nothing was done overnight.'),
        undo: (row) => {
          if (row.startsWith('job:')) { if (!jobs) return null; jobs.undo(row.slice(4)); return 'left'; }
          return undoRow(row);
        },
      },
      mail: layer ? { newSince: (at) => layer.mail.newSince(at), told: () => layer.mail.told(), open: (stage) => layer.mail.open(stage) } : undefined,
      calendar: soon ? { ahead: () => soon!.ahead(), look: () => soon!.look() } : undefined,
      now: dayNow,
      log,
    });
    if (!deps.day.noClock) {
      const theDay = day;
      const meetings = soon;
      // Every half minute: what is ten minutes away. Every minute: the evening line, and anything that waited
      // for the quiet hours to end. Every five minutes: the calendar itself, so that a meeting made a
      // quarter of an hour ahead is still said ten minutes before.
      let ticks = 0;
      const every = setInterval(guarded('the clock of the day', () => {
        ticks++;
        if (asleep()) return;
        meetings?.tick();
        if (ticks % 2 === 0) { theDay.tick(); inbox.calmed(); }
        if (ticks % 10 === 2) void meetings?.look().catch((error) => log(`[notch] the calendar could not be looked at: ${error instanceof Error ? error.message : String(error)}`));
      }), 30_000);
      every.unref?.();
      dayTimers.push(every);
    }
  }
  // Noticing: in the window the person is in, one thing offered, when their hands rest (./notice.ts).
  if (deps.notice && settings && where && deps.asks) {
    const emergency = deps.emergency;
    const kept = attachNotchNotice({
      inbox, settings, log,
      // The bare desktop is no window of a program: there is nothing in it to do for them.
      front: () => (where.onDesktop() === true ? null : where.front()),
      still: () => where.still(),
      // Where nothing could be said, nothing is looked at: asleep, away, the quiet hours, a call.
      maySpeak: () => !(emergency && emergency.getState() !== 'normal') && !(presence?.isAway() ?? false) && !(quiet?.now() ?? false) && !(around?.onCall() ?? false),
      busy: () => surface.current().line !== null,
      see: deps.notice.see, read: deps.notice.read, think: deps.notice.think,
      // It points before it speaks: a mark over the thing, and the notch leans toward it.
      mark: deps.notice.mark, unmark: deps.notice.unmark,
      toward: (aim) => surface.act({ lip: 'reach', aim }),
      run: (text) => { asks?.offered(text); },
      now: dayNow,
    });
    notice = kept;
    if (!deps.notice.noClock) {
      noticeTimer = setInterval(() => { void kept.tick().catch((error) => log(`[notch] noticing failed: ${error instanceof Error ? error.message : String(error)}`)); }, 2000);
      noticeTimer.unref?.();
    }
  }
  const news = attachNotchNews(inbox, {
    openFailures: deps.openFailures, log,
    // An agent's failure is said as its own, and has a way out when the product names a safe one: the
    // notch's Connections for a sign-in, and the run again.
    agent: (flowId) => { const agent = agents?.store.get(flowId) ?? null; return agent ? { name: agent.name } : null; },
    connections: prefs ? (stage) => prefs.connections(stage) : undefined,
    run: deps.agents ? (flowId) => deps.agents!.workflows.run(flowId) : undefined,
    paused: deps.emergency ? () => deps.emergency!.getState() !== 'normal' : undefined,
  });
  news.sync();
  const failureTimer = setInterval(guarded('looking for failures', () => news.sync()), NOTCH_FAILURE_LOOK_MS);
  failureTimer.unref?.();
  // The task manager is made later in the daemon's start: ask until it is there.
  let taskTries = 0;
  const taskTimer = deps.onTaskEnded ? setInterval(guarded('asking to hear the tasks end', () => {
    // Counted first: one that keeps failing is given up like one that is never there.
    if (++taskTries > 120) clearInterval(taskTimer!);
    if (deps.onTaskEnded!(news.taskEnded)) clearInterval(taskTimer!);
  }), 500) : null;
  taskTimer?.unref?.();
  const recordFixtureFailure = deps.recordFixtureFailure;
  const fixtures = createNotchFixtures({
    failure: recordFixtureFailure ? () => { const said = recordFixtureFailure(); news.sync(); return said; } : undefined,
    approvalManager: deps.approvalManager,
    approveAsDashboard: deps.approveAsDashboard,
    toolRegistry: deps.toolRegistry,
    approvalOnNotch: () => {
      const showing = inbox.showing();
      const prefix = approvals.itemId('');
      return showing?.startsWith(prefix) ? showing.slice(prefix.length) : null;
    },
    deliverApproval: deps.deliverApproval,
    promises: promises && appendFixtureLog
      ? { create: promises.create, look: () => promises.executor.checkAndAnnounce() }
      : undefined,
  });

  const look = (): void => {
    try {
      approvals.sync();
    } catch (error) {
      log(`[notch] looking for what waits failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  look();
  const timer = setInterval(look, deps.lookMs ?? NOTCH_APPROVAL_LOOK_MS);
  // Looking must not keep the process alive.
  timer.unref?.();

  // Day one (pass 12). Made last: it leans on the look, the mail layer and the way to a sign-in.
  if (deps.dayOne && settings && asks) {
    const emergency = deps.emergency;
    const layer = mail;
    const made = attachNotchDayOne({
      inbox, settings, clock: deps.clock, log,
      ...deps.dayOne,
      canLook: () => lookAt !== null,
      canDrop: () => drop !== null,
      canPoint: () => deps.asks?.point !== undefined,
      isWhere: whereQuestion,
      onDesktop: where ? () => where.onDesktop() : undefined,
      canDo: (stage, more) => canDo.open(stage, more),
      mail: layer && office?.connect ? {
        reached: () => layer.reached(),
        open: async (sidecarId) => { await office.connect!('gmail', sidecarId); },
      } : undefined,
      paused: emergency ? () => emergency.getState() !== 'normal' : undefined,
    });
    dayOne = made;
    // A notch has come up: on a brain that is due it, day one begins a moment later.
    surface.onHello(() => made.cameUp());
  }

  whole = true;
  return {
    inbox, approvals, news, questions, suggestions: attachNotchSuggestions(inbox), fixtures, asks, where, talk, look: lookAt, drop, mail, quiet, presence, around, soon,
    jobs, catcher, teach, put, memory, prefs, moves, dayOne, agents, notice, people,
    // A notch that was stopped tells the person nothing: what it would have said goes where it went before there was a notch.
    showing: () => !stopped && surface.listening() > 0,
    stop,
  };

  /**
   * Stops looking, and takes the notch from whatever has it. Each part by
   * itself: one that fails to stop does not keep the others going, and one
   * that was not made yet when the making failed has nothing to stop.
   */
  function stop(): void {
    stopped = true;
    const steps: (() => void)[] = [
      // The clocks first, so that nothing new is started while the rest is stopped.
      () => clearInterval(timer), () => clearInterval(failureTimer),
      () => { if (taskTimer) clearInterval(taskTimer); },
      () => { if (questionTimer) clearInterval(questionTimer); },
      () => { if (standingTimer) clearInterval(standingTimer); },
      () => { if (callTimer) clearInterval(callTimer); },
      () => { if (noticeTimer) clearInterval(noticeTimer); },
      () => { if (agentsTimer) clearInterval(agentsTimer); },
      () => { for (const one of jobTimers) clearInterval(one); },
      () => { for (const one of dayTimers) clearInterval(one); },
      // What is on the notch ends where it is: a yes whose window is still running sends nothing.
      () => inbox.stop(),
      () => stopPromises(), () => stopPause(),
      () => asks?.stop(),
      () => people?.stop(),
      () => dayOne?.stop(),
      () => lookAt?.stop(),
      () => drop?.stop(),
      () => where?.stop(),
      () => mail?.stop(),
      () => presence?.stop(),
      () => around?.stop(),
      () => jobs?.stop(),
      () => catcher?.stop(),
      () => teach?.stop(),
      () => put?.stop(),
      () => standing?.stop(),
      () => calls?.stop(),
      () => notice?.stop(),
      () => agents?.stop(),
    ];
    for (const step of steps) {
      try {
        step();
      } catch (error) {
        // A part the making had not reached yet is not there to be stopped: that is no failure. On a notch
        // that was made whole every part is there, and the same error is a part that failed to stop.
        if (!whole && error instanceof ReferenceError) continue;
        log(`[notch] a part of the notch did not stop: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
