/**
 * Trust per workflow: the rung an agent stands on (notch pass 11, decision F:
 * "Trust is per workflow: each agent has its own identity and rung").
 *
 * Authority decides per category of action, the same for every workflow. A
 * rung is the owner's own word about ONE workflow, given on the notch:
 *
 *   asks first        every step that acts asks, whatever Authority would
 *                     have let go. A new agent starts here.
 *   tells you after   a step Authority would only have ASKED about goes
 *                     without asking, and the owner is told when the run is
 *                     over.
 *   acts alone        the same, and nothing is said unless something fails.
 *
 * What a rung can never do:
 *   - turn a refusal into a yes. Only an ask is ever let go.
 *   - let money or a deletion go. Those always ask ("Money always asks").
 *   - let go of anything but a write, a mail or a message. A command, an
 *     install, a setting, a click whose effect cannot be told: those are
 *     Authority's alone, at every rung.
 *   - overrule a gate that asked for its own reasons (a review of an
 *     uncertain click, a refund). Those are applied after this, and win.
 *
 * Where the rung is kept is not here. It is kept by the notch, in a table
 * only an answer on the notch writes (src/notch/agents.ts), and asked for
 * through `WorkflowAuthorityDependencies.agentRung`. A workflow's own
 * metadata would be the wrong place: the assistant can write that, and what
 * the assistant can write, a page it read can talk it into writing.
 */
import type { ActionCategory } from '../../roles/authority';
import { listRuns } from '../db/repos/flow-run';

export const AGENT_RUNGS = ['asks first', 'tells you after', 'acts alone'] as const;
export type AgentRung = (typeof AGENT_RUNGS)[number];

export const isAgentRung = (value: unknown): value is AgentRung => (AGENT_RUNGS as readonly unknown[]).includes(value);

/** What a rung above the first may let go without asking. Nothing else, ever. */
const MAY_GO: ReadonlySet<ActionCategory> = new Set<ActionCategory>(['write_data', 'send_email', 'send_message']);

/**
 * A decision as one agent's rung changes it. `categories` is every category
 * the effect reaches: all of them must be ones a rung may let go, or none is.
 */
export function applyAgentRung<D extends { allowed: boolean; requiresApproval: boolean; reason: string }>(
  decision: D, rung: AgentRung | null | undefined, categories: readonly ActionCategory[],
): D {
  // Not an agent of the notch's, or refused: nothing changes.
  if (!rung || !decision.allowed) return decision;
  if (rung === 'asks first') {
    // Reading is not acting. Everything else is shown first.
    if (decision.requiresApproval || categories.every((category) => category === 'read_data')) return decision;
    return { ...decision, requiresApproval: true, reason: `${decision.reason}; this agent asks first` };
  }
  if (!decision.requiresApproval || categories.length === 0 || !categories.every((category) => MAY_GO.has(category))) return decision;
  return { ...decision, requiresApproval: false, reason: `${decision.reason}; the owner lets this agent do that without asking (${rung})` };
}

/** How a run ended, as an agent's record counts it. */
export type AgentRunEnd = 'ok' | 'bad' | 'open';

/**
 * How a workflow's latest runs ended, newest first: whether, never what. No
 * step, input or output leaves this function.
 */
export function agentRunEnds(flowId: string, limit = 12): { id: string; end: AgentRunEnd; at: number }[] {
  return listRuns({ flowId, limit: Math.max(1, Math.min(50, limit)), offset: 0 }).map((run) => {
    const end: AgentRunEnd = run.status === 'SUCCEEDED' ? 'ok' : run.status === 'QUEUED' || run.status === 'RUNNING' || run.status === 'PAUSED' ? 'open' : 'bad';
    return { id: run.id, end, at: run.finishTime ?? run.startTime ?? 0 };
  });
}
