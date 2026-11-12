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
import { NOTCH_APPROVAL_LOOK_MS, attachNotchApprovals } from './approvals.ts';
import type { NotchApprovals } from './approvals.ts';
import type { CommitmentEvent, CommitmentRunner } from '../daemon/commitment-executor.ts';
import { NOTCH_FIXTURE_ORIGIN, createNotchFixtures, notchFixturePromiseRun } from './fixtures.ts';
import type { NotchFixtures } from './fixtures.ts';
import { NotchInbox } from './inbox.ts';
import { attachNotchPause } from './pause.ts';
import type { NotchPauseDeps } from './pause.ts';
import { attachNotchPromises } from './promises.ts';
import type { NotchClock } from './stage.ts';
import type { NotchSurface } from './surface.ts';
import { notchTodayScript } from './today.ts';

export interface NotchRealDeps {
  /** Something else has the notch for now (a demo moment is playing). */
  busy?: () => boolean;
  approvalManager: Pick<ApprovalManager, 'getPending' | 'getRequest' | 'getHistory' | 'createRequest'>;
  /** Approves through the product's one decision function, as the notch. */
  approve(requestId: string): Promise<ApprovalDecisionOutcome>;
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
  /** The product's pause: Esc twice pauses through it, and the notch shows its state whoever changed it. */
  emergency?: NotchPauseDeps['controller'];
  /** The clock the lines on the notch run on. Tests give one they can wind forward. */
  clock?: NotchClock;
  log?: (line: string) => void;
}

export interface NotchReal {
  inbox: NotchInbox;
  approvals: NotchApprovals;
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
  const fixtures = createNotchFixtures({
    approvalManager: deps.approvalManager,
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
    inbox, approvals, fixtures,
    showing: () => surface.listening() > 0,
    stop: () => { clearInterval(timer); stopPromises(); stopPause(); },
  };
}
