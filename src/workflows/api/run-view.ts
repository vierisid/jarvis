import type { FlowRun } from '../db/repos/flow-run';

/**
 * The most step data one run carries in an API answer. The engine keeps up to 10 MB per run, and a
 * list of runs would multiply that by its page, so a run past this answers with each step's status
 * and type only. `stepsTruncated` says so; the run's own record is unchanged.
 */
export const RUN_STEPS_RESPONSE_BYTES = 1_000_000;
const STEPS_LISTED = 200;

export function boundedRunSteps<T extends Pick<FlowRun, 'steps'>>(run: T): T & { stepsTruncated?: true } {
  if (!run.steps || Buffer.byteLength(JSON.stringify(run.steps)) <= RUN_STEPS_RESPONSE_BYTES) return run;
  const outline = Object.entries(run.steps).slice(0, STEPS_LISTED).map(([name, raw]) => {
    const step = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    // The worker stores { output: StepOutput }; read the status through that envelope.
    const inner = step.output && typeof step.output === 'object' && typeof (step.output as Record<string, unknown>).status === 'string'
      ? step.output as Record<string, unknown> : step;
    return [name, { ...(typeof inner.type === 'string' ? { type: inner.type } : {}), ...(typeof inner.status === 'string' ? { status: inner.status } : {}) }];
  });
  return { ...run, steps: Object.fromEntries(outline), stepsTruncated: true };
}
