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
import { NOTCH_APPROVAL_LOOK_MS, attachNotchApprovals } from './approvals.ts';
import type { NotchApprovals } from './approvals.ts';
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
import type { NotchClock } from './stage.ts';
import type { NotchSurface } from './surface.ts';
import { attachNotchSuggestions } from './suggestions.ts';
import type { NotchSuggestions } from './suggestions.ts';
import { notchTodayScript } from './today.ts';

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
  /** Whether a notch page is up: then the notch tells the person, and the toasts need not. */
  showing(): boolean;
  /** Stops looking. */
  stop(): void;
}

export function attachNotchReal(surface: NotchSurface, deps: NotchRealDeps): NotchReal {
  const log = deps.log ?? ((line: string) => console.log(line));
  const inbox = new NotchInbox(surface, {
    busy: deps.busy,
    clock: deps.clock,
    log,
    home: notchTodayScript({
      executedApprovals: (limit) => deps.approvalManager.getHistory({ status: 'executed', limit }),
      keptPromises: deps.promises ? () => deps.promises!.kept() : undefined,
    }),
  });
  const approvals = attachNotchApprovals(inbox, {
    approvalManager: deps.approvalManager,
    approve: deps.approve,
    deny: deps.deny,
    openDashboard: deps.openDashboard,
    log,
  });
  const promises = deps.promises;
  const stopPromises = promises ? attachNotchPromises(inbox, { executor: promises.executor }) : () => {};
  // A fixture promise is kept by writing one line, not by a model turn.
  const appendFixtureLog = promises?.appendFixtureLog;
  if (promises && appendFixtureLog) {
    promises.executor.setOriginRunner(NOTCH_FIXTURE_ORIGIN, notchFixturePromiseRun(appendFixtureLog));
  }
  const stopPause = deps.emergency ? attachNotchPause(surface, inbox, { controller: deps.emergency, log }) : () => {};
  const questions: NotchQuestions | null = deps.questions
    ? attachNotchQuestions(inbox, { ...deps.questions, openDashboard: deps.openDashboard, log })
    : null;
  questions?.sync();
  const questionTimer = questions ? setInterval(() => questions.sync(), NOTCH_QUESTION_LOOK_MS) : null;
  questionTimer?.unref?.();
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
    inbox, approvals, news, questions, suggestions: attachNotchSuggestions(inbox), fixtures,
    showing: () => surface.listening() > 0,
    stop: () => {
      clearInterval(timer); clearInterval(failureTimer);
      if (taskTimer) clearInterval(taskTimer);
      if (questionTimer) clearInterval(questionTimer);
      stopPromises(); stopPause();
    },
  };
}
