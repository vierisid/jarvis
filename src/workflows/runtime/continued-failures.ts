/**
 * A run that finished although a step failed: the step had "Continue on
 * failure" on, so the engine went on and ended the run SUCCEEDED. The step's
 * own record still says FAILED. Runs shows the run as finished with a failed
 * step rather than as a clean success. Derived on read from the run's step
 * trace, never stored.
 */
import { getFlowVersion } from '../db/repos/flow-version';
import { walkFlowNodes } from '../db/flow-graph';
import type { FlowRun } from '../db/repos/flow-run';

export interface ContinuedFailure {
  name: string;
  displayName: string;
}

const MAX_STEPS = 500;

type Envelope = { status?: unknown; type?: unknown; output?: unknown };

/** The run row keeps each step as `{ output: envelope }`; a loop round keeps the envelope itself. */
function envelope(record: object): Envelope {
  const wrapped = (record as { output?: unknown }).output;
  return !('status' in record) && wrapped !== null && typeof wrapped === 'object' && 'status' in wrapped ? wrapped as Envelope : record as Envelope;
}

function failedRecords(steps: Record<string, unknown>, out: string[], budget: { left: number }, depth = 0): void {
  for (const [name, record] of Object.entries(steps)) {
    if (budget.left-- <= 0 || record === null || typeof record !== 'object') return;
    const step = envelope(record);
    if (step.status === 'FAILED') out.push(name);
    // A loop keeps each round's steps under `output.iterations`.
    const iterations = step.type === 'LOOP_ON_ITEMS' && depth < 8 && step.output !== null && typeof step.output === 'object'
      ? (step.output as { iterations?: unknown }).iterations : undefined;
    if (Array.isArray(iterations)) {
      for (const round of iterations) if (round !== null && typeof round === 'object') failedRecords(round as Record<string, unknown>, out, budget, depth + 1);
    }
  }
}

/**
 * Whether a run's raw step trace holds a FAILED step, here or in a loop round,
 * without reading anything else. A trace too large to read to the end counts
 * as failed, so a caller never treats an unread step as clean.
 */
export function hasFailedStep(steps: unknown): boolean {
  if (steps === null || typeof steps !== 'object' || Array.isArray(steps)) return false;
  const found: string[] = [], budget = { left: MAX_STEPS };
  failedRecords(steps as Record<string, unknown>, found, budget);
  return found.length > 0 || budget.left < 0;
}

/** The failed steps of a SUCCEEDED run, once each, in step order; empty for any other run. */
export function continuedFailures(run: FlowRun): ContinuedFailure[] {
  if (run.status !== 'SUCCEEDED' || !run.steps) return [];
  const found: string[] = [];
  failedRecords(run.steps, found, { left: MAX_STEPS });
  if (!found.length) return [];
  const names = new Map(walkFlowNodes(getFlowVersion(run.flowVersionId)?.trigger).map(node => [node.name, node.displayName ?? node.name]));
  const seen = new Set<string>();
  return found.filter(name => !seen.has(name) && seen.add(name)).map(name => ({ name, displayName: names.get(name) ?? name }));
}

/** How a run that finished with failed steps reads: "Finished with a failed step", or the count when there are several. */
export function continuedFailureHeadline(count: number): string {
  return count === 1 ? 'Finished with a failed step' : `Finished with ${count} failed steps`;
}
