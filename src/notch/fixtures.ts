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
 *
 * The route that reaches this is behind the demo gate (./demo-gate.ts): a
 * secret, never on a hosted install, and absent with the notch switch off.
 */
import type { ApprovalManager, ApprovalRequest } from '../authority/approval.ts';

/** What every fixture's records are marked with, so they can be told from real ones. */
export const NOTCH_FIXTURE_AGENT = 'notch-fixture';

export interface NotchFixtureDeps {
  approvalManager: Pick<ApprovalManager, 'createRequest'>;
  /** Shows a new approval wherever approvals are shown: the dashboard card, and a chat card if a channel is set up. */
  deliverApproval?: (request: ApprovalRequest) => Promise<void> | void;
  /** More fixtures, by kind. Each comes back with a sentence saying what was made. */
  more?: Record<string, (options: { in?: number }) => Promise<string> | string>;
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
    ...deps.more,
  };

  return {
    kinds: () => Object.keys(kinds),
    async make(kind, options) {
      const make = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
      if (!make) throw new Error(`No fixture is called "${kind.slice(0, 60)}"`);
      return make(options);
    },
  };
}
