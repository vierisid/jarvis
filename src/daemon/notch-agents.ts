/**
 * What the notch's agents (pass 11, src/notch/agents.ts) need of the product:
 * its workflow composer, and the switches of a workflow. An agent IS a
 * workflow. Nothing here builds one of its own: a sentence goes to the same
 * composer the assistant and the dashboard use, and what comes back is saved
 * the way they save it.
 *
 * Nothing in src/notch reaches for these itself (src/notch/real.ts).
 */
import type { Database } from 'bun:sqlite';
import { workflowActions, type ManageWorkflowDeps } from '../actions/tools/manage-workflow.ts';
import { runWithOrigin } from '../llm/origin.ts';
import { NotchAgentStore, type NotchAgentWorkflows } from '../notch/agents.ts';
import type { NotchRealDeps } from '../notch/real.ts';
import { agentRunEnds, type AgentRung } from '../workflows/runtime/agent-rung.ts';

export interface NotchAgentOptions {
  db: Database;
  /** What the product's own workflow tool was built with, once it has been: the composer, the piece catalog, the trigger manager. */
  workflowDeps(): ManageWorkflowDeps | null;
}

const short = (value: unknown, max = 160): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The first reason a composition or a readiness check gave, in a line. */
function firstReason(result: Record<string, unknown>): string {
  const setup = result.setup as { nextQuestion?: unknown; fields?: { message?: unknown }[]; missingConnectors?: unknown[] } | undefined;
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (setup?.missingConnectors?.length) return `it needs a connector that is not installed: ${short(setup.missingConnectors.join(', '), 100)}`;
  return short(setup?.fields?.[0]?.message ?? setup?.nextQuestion ?? errors[0] ?? 'it could not be built');
}

export function notchAgentWorkflows(options: NotchAgentOptions): NotchAgentWorkflows {
  const actions = () => {
    const deps = options.workflowDeps();
    if (!deps) throw new Error('workflows are not ready yet');
    return workflowActions(deps);
  };
  const attempt = <T>(work: () => T): { ok: true; value: T } | { ok: false; why: string } => {
    try { return { ok: true, value: work() }; } catch (error) { return { ok: false, why: short(error instanceof Error ? error.message : error) }; }
  };
  return {
    async build(sentence) {
      let result: Record<string, unknown>;
      try {
        // The owner asked for it, at their desk: not held behind background work.
        result = await runWithOrigin('user', () => actions().compose(sentence.replace(/[.\s]+$/, '').slice(0, 80), sentence));
      } catch (error) {
        return { ok: false, why: short(error instanceof Error ? error.message : error) };
      }
      const flow = result.flow as { id?: unknown; name?: unknown } | undefined;
      if (result.ok !== true || typeof flow?.id !== 'string') return { ok: false, why: firstReason(result) };
      const ready = (result.validation as { readyToRun?: unknown } | undefined)?.readyToRun === true;
      return { ok: true, flowId: flow.id, job: short(flow.name, 90) || sentence, ready, missing: ready ? '' : firstReason(result) };
    },
    enable(flowId) {
      const done = attempt(() => actions().publish(flowId));
      return done.ok ? { ok: true } : done;
    },
    pause(flowId, paused) {
      return attempt(() => actions().setStatus(flowId, paused ? 'DISABLED' : 'ENABLED')).ok;
    },
    run(flowId) {
      const done = attempt(() => actions().run(flowId));
      return done.ok ? { ok: true } : done;
    },
    async remove(flowId) {
      try { await actions().remove(flowId); return true; } catch (error) {
        // Already gone is gone.
        return /not found/i.test(error instanceof Error ? error.message : '');
      }
    },
    look(flowId) {
      const seen = actions().look(flowId);
      return seen ? { job: short(seen.name, 90), enabled: seen.enabled } : null;
    },
    runs: (flowId, limit) => agentRunEnds(flowId, limit),
  };
}

export function notchAgentDeps(options: NotchAgentOptions): NonNullable<NotchRealDeps['agents']> {
  return { db: options.db, workflows: notchAgentWorkflows(options) };
}

/**
 * The rung a workflow stands on, for the product's check of every step
 * (WorkflowAuthorityDependencies.agentRung). Read from the notch's own table
 * at each ask, so a rung changed on the notch holds from the next step on.
 * Null with the notch off: then no workflow is an agent, and nothing changes.
 */
export function notchAgentRung(db: Database, on: boolean): (flowId: string) => AgentRung | null {
  if (!on) return () => null;
  let store: NotchAgentStore | null = null;
  return (flowId) => {
    try {
      store ??= new NotchAgentStore(db);
      return store.rung(flowId);
    } catch {
      // The table cannot be read: the workflow is judged as any other.
      return null;
    }
  };
}
