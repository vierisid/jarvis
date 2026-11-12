/**
 * Real things made on request, for trying the notch by hand.
 *
 * `jarvis notch fixture <kind>` makes one. Unlike the demo's moments
 * (./demo.ts), these are not sample sentences: each is a real record in the
 * product's own store, found by the notch the way it would find any other,
 * and answered through the product's own code. That is the point of them:
 * the path under test is the real one.
 *
 * What each one does when it is approved or runs is fixed here and harmless:
 *
 *   approval  an approval to read this computer's name and system (the
 *             get_system_info tool). Approving it reads them. Nothing changes.
 *   payment   an approval that says it is a payment of a sample amount. It is
 *             a declared intent with nothing behind it: approving it in the
 *             dashboard moves no money and runs nothing.
 *   failure   one failure in the product's own list of open failures, worded
 *             by the product ("The notch test failed, and Jarvis cannot tell
 *             whether it took effect."). Nothing failed. It stays in the
 *             dashboard's list until it is dismissed there.
 *   promise   a promise due in two minutes (or `--in <seconds>`). Keeping it
 *             adds one line to notch-fixture.log in the data directory, and
 *             that is all: no model is asked. One line per time it ran, so
 *             the file is the proof that it ran once.
 *
 * The route that reaches this is behind the demo gate (./demo-gate.ts): a
 * secret, never on a hosted install, and absent with the notch switch off.
 */
import type { ApprovalManager, ApprovalRequest } from '../authority/approval.ts';

/** What every fixture's records are marked with, so they can be told from real ones. */
export const NOTCH_FIXTURE_AGENT = 'notch-fixture';
/**
 * Where a fixture promise says it was created from. The executor runs
 * commitments from here with the fixture's own runner in place of a model
 * turn. Neither the HTTP route nor the model's tool can write this value, so
 * such a commitment can only be made by this file.
 */
export const NOTCH_FIXTURE_ORIGIN = 'notch_fixture';
/** The file a fixture promise adds its line to, inside the data directory. */
export const NOTCH_FIXTURE_LOG = 'notch-fixture.log';

export interface NotchFixtureDeps {
  approvalManager: Pick<ApprovalManager, 'createRequest'>;
  /** Shows a new approval wherever approvals are shown: the dashboard card, and a chat card if a channel is set up. */
  deliverApproval?: (request: ApprovalRequest) => Promise<void> | void;
  /** Records the test failure. Comes back with its sentence. Absent when it cannot be recorded. */
  failure?: () => string;
  /** Promises. Absent when the executor that keeps them is not there. */
  promises?: {
    create(what: string, options: { when_due: number; assigned_to: string; created_from: string }): { id: string; when_due: number | null };
    /** Has the executor look now, so the promise is announced on time and not at its next sweep. */
    look(): void;
  };
  now?: () => number;
}

/** How long until a fixture promise is due, when not said. */
export const NOTCH_FIXTURE_PROMISE_IN_S = 120;

const two = (n: number): string => String(n).padStart(2, '0');
const hms = (at: number): string => {
  const d = new Date(at);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

/**
 * What keeping a fixture promise does: one line into the log, saying when and
 * which. `append` is the file write, handed in so this file touches no disk.
 */
export function notchFixturePromiseRun(append: (line: string) => void, now: () => number = Date.now) {
  return (commitment: { id: string; what: string }): string => {
    append(`${new Date(now()).toISOString()} ${commitment.id} ${commitment.what}\n`);
    return `Wrote one line into ${NOTCH_FIXTURE_LOG}.`;
  };
}

export interface NotchFixtures {
  kinds(): string[];
  /** Makes one. Comes back with a sentence saying what was made; throws one saying why not. */
  make(kind: string, options: { in?: number }): Promise<string>;
}

/** The agent the fixture approvals are asked for: the default assistant, at its shipped level. */
const PRINCIPAL = { agentRoleId: 'personal-assistant', agentAuthorityLevel: 5 };

export function createNotchFixtures(deps: NotchFixtureDeps): NotchFixtures {
  const deliver = async (request: ApprovalRequest): Promise<void> => {
    try {
      await deps.deliverApproval?.(request);
    } catch (error) {
      // The approval exists either way; the notch finds it by looking.
      console.warn('[notch] a fixture approval could not be shown on the dashboard:', error instanceof Error ? error.message : error);
    }
  };

  const kinds: Record<string, (options: { in?: number }) => Promise<string> | string> = {
    async approval() {
      const request = deps.approvalManager.createRequest({
        agentId: NOTCH_FIXTURE_AGENT, agentName: 'Notch fixture',
        toolName: 'get_system_info', toolArguments: {},
        actionCategory: 'read_data', urgency: 'normal',
        reason: 'read_data requires user approval',
        context: 'Agent attempted: get_system_info({})',
        // Run when it is approved, whichever surface approves it.
        executionMode: 'deferred',
        principal: PRINCIPAL,
      });
      await deliver(request);
      return `An approval is waiting (${request.id.slice(0, 8)}): read this computer's name and system. Approving it reads them and changes nothing.`;
    },
    async payment() {
      const request = deps.approvalManager.createRequest({
        agentId: NOTCH_FIXTURE_AGENT, agentName: 'Notch fixture',
        // A declared intent: the approval system runs nothing for it.
        toolName: 'request_approval', toolArguments: {},
        actionCategory: 'make_payment', urgency: 'urgent',
        reason: 'Pay $40.00 to Northwind (a test, no money moves)',
        context: '',
        executionMode: 'deferred',
        principal: PRINCIPAL,
      });
      await deliver(request);
      return `A payment approval is waiting (${request.id.slice(0, 8)}). It is a test: approving it in the dashboard moves no money.`;
    },
  };
  const failure = deps.failure;
  if (failure) kinds.failure = () => `A test failure is in the list of open failures: "${failure()}" Dismiss it in the dashboard when you are done.`;
  const promises = deps.promises;
  if (promises) {
    kinds.promise = (options) => {
      const now = (deps.now ?? Date.now)();
      const seconds = options.in ?? NOTCH_FIXTURE_PROMISE_IN_S;
      const due = now + seconds * 1000;
      // The time is in its words so that two made in the same minute are two
      // promises, not one said twice.
      const made = promises.create(`Notch test promise of ${hms(now)}`, { when_due: due, assigned_to: 'jarvis', created_from: NOTCH_FIXTURE_ORIGIN });
      promises.look();
      return `A promise is due at ${hms(due)}, in ${seconds} seconds (${made.id.slice(0, 8)}). Keeping it adds one line to ${NOTCH_FIXTURE_LOG} in the data directory.`;
    };
  }

  return {
    kinds: () => Object.keys(kinds),
    async make(kind, options) {
      const make = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
      if (!make) throw new Error(`No fixture is called "${kind.slice(0, 60)}"`);
      return make(options);
    },
  };
}
