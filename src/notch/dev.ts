/**
 * What the notch has for trying it by hand, and nothing else (fix 02, step 6).
 *
 * The fixed test items of ./fixtures.ts are made here, beside the notch and
 * not inside it: the daemon makes them only while the demo gate is open
 * (./demo-gate.ts), and then hands them to the fixture route (./routes.ts).
 * With the gate shut nothing here is made, and nothing of it is in what the
 * notch is given (`NotchRealDeps`) or hands back (`NotchReal`).
 */
import type { ApprovalRequest } from '../authority/approval.ts';
import type { ToolRegistry } from '../actions/tools/registry.ts';
import type { CommitmentRunner } from '../daemon/commitment-executor.ts';
import { NOTCH_FIXTURE_ORIGIN, createNotchFixtures, notchFixturePromiseRun, type NotchFixtureDeps, type NotchFixtures } from './fixtures.ts';
import type { NotchDemoGateState } from './demo-gate.ts';
import type { NotchReal } from './real.ts';

/** What the test items are made from, of the product. */
export interface NotchDevGiven {
  approvalManager: NotchFixtureDeps['approvalManager'];
  /** Approves as a click on the dashboard card does. */
  approveAsDashboard?: (requestId: string) => Promise<{ status: string }>;
  /** The brain's own tools, once loaded: the shell command fixture is filed against the real one. */
  toolRegistry?: () => ToolRegistry | null | undefined;
  /** Shows a new approval wherever approvals are shown. */
  deliverApproval?: (request: ApprovalRequest) => Promise<void> | void;
  /** Makes one test failure in the product's own failure list, and comes back with its sentence. */
  recordFailure?: () => string;
  /**
   * Promises: the executor that keeps them, how one is made, and the line a fixture promise writes when it is
   * kept. Without them there is no promise fixture.
   */
  promises?: {
    executor: { checkAndAnnounce(): void; setOriginRunner(origin: string, run: CommitmentRunner): void };
    create: NonNullable<NotchFixtureDeps['promises']>['create'];
    appendLog(line: string): void;
  };
}

/**
 * The fixed test items for a notch that was made. The failure item has the news look at once, so that it is
 * said; the elsewhere item decides the fixture approval the notch is showing, when it shows one. A fixture
 * promise is kept by writing one line, not by a model turn.
 */
export function attachNotchDev(real: Pick<NotchReal, 'inbox' | 'approvals' | 'news'>, given: NotchDevGiven): NotchFixtures {
  const { promises, recordFailure } = given;
  if (promises) promises.executor.setOriginRunner(NOTCH_FIXTURE_ORIGIN, notchFixturePromiseRun((line) => promises.appendLog(line)));
  return createNotchFixtures({
    failure: recordFailure ? () => { const said = recordFailure(); real.news.sync(); return said; } : undefined,
    approvalManager: given.approvalManager,
    approveAsDashboard: given.approveAsDashboard,
    toolRegistry: given.toolRegistry,
    approvalOnNotch: () => {
      const showing = real.inbox.showing();
      const prefix = real.approvals.itemId('');
      return showing?.startsWith(prefix) ? showing.slice(prefix.length) : null;
    },
    deliverApproval: given.deliverApproval,
    promises: promises ? { create: promises.create, look: () => promises.executor.checkAndAnnounce() } : undefined,
  });
}

/**
 * The fixed test items, only while the demo gate is open and there is a notch: null otherwise, and then what
 * they are made from is not even asked for.
 */
export function notchDevFor(gate: NotchDemoGateState, real: Pick<NotchReal, 'inbox' | 'approvals' | 'news'> | null, given: () => NotchDevGiven): NotchFixtures | null {
  if (gate !== 'open' || !real) return null;
  return attachNotchDev(real, given());
}
