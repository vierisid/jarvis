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
import type { NotchAsks, NotchAsksDeps } from './asks.ts';
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
import { attachNotchDrop, type NotchDrop } from './drop.ts';
import { attachNotchDay, type NotchDay } from './day.ts';
import { attachMailLayer, type NotchMailLayer, type NotchMailLayerDeps } from './mail/attach.ts';
import { NOTCH_MAIL_ITEM } from './mail/notch.ts';
import { NotchPresence } from './presence.ts';
import { NotchQuiet, notchQuietHome } from './quiet.ts';
import { NotchSettings } from './settings.ts';
import { attachNotchSoon, type NotchSoon } from './soon.ts';
import type { NotchClock } from './stage.ts';
import type { NotchSurface } from './surface.ts';
import { attachNotchSuggestions } from './suggestions.ts';
import type { NotchSuggestions } from './suggestions.ts';
import { notchDoneBetween, notchToday, notchTodayBlocks, notchTodayScript } from './today.ts';
import { attachNotchCatch, type NotchCatch, type NotchCatchDeps, type NotchCatchPort } from './catch.ts';
import { attachNotchJobs, type NotchJobHands, type NotchJobs } from './jobs.ts';
import { attachNotchPut, type NotchPutDeps, type NotchPutter } from './put.ts';
import { attachNotchTeach, type NotchTeach, type NotchTeachDeps } from './teach.ts';

export interface NotchRealDeps {
  /** Something else has the notch for now (a demo moment is playing). */
  busy?: () => boolean;
  approvalManager: Pick<ApprovalManager, 'getPending' | 'getRequest' | 'getHistory' | 'createRequest'>;
  /** Approves through the product's one decision function, as the notch. */
  approve(requestId: string): Promise<ApprovalDecisionOutcome>;
  /** Denies through the same function, as the notch: what Esc on an approval's line does. */
  deny(requestId: string): Promise<ApprovalDecisionOutcome>;
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
  where?: { port: NotchWherePort; watching?: () => boolean };
  /**
   * Mail (pass 7): Jarvis looks at the mailbox by itself, prepares a reply
   * where a person is waiting, and puts it on the notch. Everything it needs
   * of the product: the database, the notch's own browser tab, the model.
   */
  mail?: Omit<NotchMailLayerDeps, 'paused' | 'log' | 'noClock'> & { noClock?: boolean };
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
  /** Whether the person is there, when pass 8 is on. */
  presence: NotchPresence | null;
  /** Calls and the connection, when a desktop app can tell. */
  around: NotchAround | null;
  /** Meetings coming up, when the calendar can be reached. */
  soon: NotchSoon | null;
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

export function attachNotchReal(surface: NotchSurface, deps: NotchRealDeps): NotchReal {
  const log = deps.log ?? ((line: string) => console.log(line));
  // Made after the inbox it puts its lines in; Today and the place the person is in both reach it.
  let mail: NotchMailLayer | null = null;
  // Made after the inbox they play on; Today lists what they did.
  let jobs: NotchJobs | null = null;
  let catcher: NotchCatch | null = null;
  let teach: NotchTeach | null = null;
  let put: NotchPutter | null = null;
  const todayDeps = {
    executedApprovals: (limit: number) => deps.approvalManager.getHistory({ status: 'executed', limit }),
    keptPromises: deps.promises ? () => deps.promises!.kept() : undefined,
    sentMail: (since: number) => mail?.sentSince(since) ?? [],
    jobs: (since: number) => jobs?.done(since) ?? [],
  };
  // Made after the inbox, which opens it: yes at rest with nothing waiting.
  let asks: NotchAsks | null = null;
  const today = notchTodayScript(todayDeps);
  // Pass 8: whether the person is there, and their quiet hours. Made before the inbox, which asks them
  // whether a line may come up; what they set off is made after it and reached through these.
  const dayNow = deps.day?.now ?? Date.now;
  const settings = deps.day ? new NotchSettings(deps.day.db) : null;
  const quiet = settings ? new NotchQuiet(settings, dayNow) : null;
  let day: NotchDay | null = null;
  let calmed: () => void = () => {};
  const presence = settings ? new NotchPresence({
    settings,
    calm: () => calmed(),
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
      const every = setInterval(() => learned.tick(), 30_000);
      every.unref?.();
      jobTimers.push(every);
    }
  }
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
      side: teach ? (text) => put?.route(text) ?? teach!.route(text) : undefined,
      learned: teach ? { row: () => teach!.row(), open: (stage) => teach!.open(stage) } : undefined,
      undoJob: jobs ? (jobId) => jobs!.undo(jobId) : undefined,
      paused: emergency ? () => emergency.getState() !== 'normal' : undefined,
      raiseApproval: (approvalId) => approvals.raise(approvalId),
      // The instruction is over: what it was still asking for is asked no more.
      withdrawApproval: (approvalId) => { void deps.deny(approvalId).catch(() => {}); },
      attention: () => surface.act({ gesture: 'shake' }),
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
        ask: (text, files) => { owner.typed(text, files); },
        talking: (sidecarId) => talk?.open(sidecarId) ?? false,
        modelReady: deps.asks.look.modelReady ?? deps.asks.modelReady,
        paused: emergency ? () => emergency.getState() !== 'normal' : undefined,
        // What was shown is held for a while, and a place pointed at meanwhile is where it goes (pass 10).
        shown: put ? (sidecarId, looked) => put!.shown(sidecarId, looked) : undefined,
        log,
      });
    }
    // What is said while a dropped file waits for its question is about that file: the words take it.
    talk = attachNotchTalk(deps.asks.talkPort, { asks, stt: deps.asks.stt, look: lookAt ?? undefined, held: () => drop?.claim() ?? [], log });
    // A file dropped on the notch (pass 9) waits for its question: one of three offered, typed, or said.
    const owner = asks;
    drop = attachNotchDrop(surface, inbox, {
      ask: (text, files) => { owner.typed(text, files); },
      tell: (parts, mood) => { owner.tell(parts, mood); },
      paused: emergency ? () => emergency.getState() !== 'normal' : undefined,
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
  const questionTimer = questions ? setInterval(() => questions.sync(), NOTCH_QUESTION_LOOK_MS) : null;
  questionTimer?.unref?.();
  if (deps.mail) {
    const emergency = deps.emergency;
    mail = attachMailLayer(inbox, { ...deps.mail, paused: emergency ? () => emergency.getState() !== 'normal' : undefined, log });
  }
  // Pass 8, the rest of it: the calendar as a source, calls and the connection, and the lines of the day.
  let soon: NotchSoon | null = null;
  let around: NotchAround | null = null;
  const dayTimers: ReturnType<typeof setInterval>[] = [];
  if (deps.day && settings) {
    const layer = mail;
    const asleep = (): boolean => (deps.emergency ? deps.emergency.getState() !== 'normal' : false);
    if (layer) soon = attachNotchSoon(inbox, { calendar: (from, to) => layer.calendar(from, to), now: dayNow, log });
    if (deps.day.around) {
      around = attachNotchAround(surface, inbox, deps.day.around, {
        meetingNow: () => soon?.meetingNow() ?? false,
        asleep,
        // What could not be read while there was no connection is read now.
        backOnline: () => { void layer?.look('glance'); },
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
      const every = setInterval(() => {
        ticks++;
        if (asleep()) return;
        meetings?.tick();
        if (ticks % 2 === 0) { theDay.tick(); inbox.calmed(); }
        if (ticks % 10 === 2) void meetings?.look();
      }, 30_000);
      every.unref?.();
      dayTimers.push(every);
    }
  }
  const news = attachNotchNews(inbox, { openFailures: deps.openFailures, log });
  news.sync();
  const failureTimer = setInterval(() => news.sync(), NOTCH_FAILURE_LOOK_MS);
  failureTimer.unref?.();
  // The task manager is made later in the daemon's start: ask until it is there.
  let taskTries = 0;
  const taskTimer = deps.onTaskEnded ? setInterval(() => {
    if (deps.onTaskEnded!(news.taskEnded) || ++taskTries > 120) clearInterval(taskTimer!);
  }, 500) : null;
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

  return {
    inbox, approvals, news, questions, suggestions: attachNotchSuggestions(inbox), fixtures, asks, where, talk, look: lookAt, drop, mail, quiet, presence, around, soon,
    jobs, catcher, teach, put,
    showing: () => surface.listening() > 0,
    stop: () => {
      clearInterval(timer); clearInterval(failureTimer);
      if (taskTimer) clearInterval(taskTimer);
      if (questionTimer) clearInterval(questionTimer);
      stopPromises(); stopPause();
      asks?.stop();
      lookAt?.stop();
      drop?.stop();
      where?.stop();
      mail?.stop();
      presence?.stop();
      around?.stop();
      jobs?.stop();
      catcher?.stop();
      teach?.stop();
      put?.stop();
      for (const timer of jobTimers) clearInterval(timer);
      for (const timer of dayTimers) clearInterval(timer);
    },
  };
}
