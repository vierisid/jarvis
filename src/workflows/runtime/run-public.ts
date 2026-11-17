/**
 * A run as the API hands it to a screen. The stored run keeps the engine's
 * whole error report for the failed step: the piece's message, then a stack
 * trace with server and engine paths, then the retry guidance. A screen shows
 * the cause only (`failureCause`); the report stays in the server's stored
 * record and logs. The server's own readers (`runFailure`) use the stored run.
 */
import { failureCause } from '../../failures/cause';
import type { FlowRun } from '../db/repos/flow-run';
import { expressionFailureGuidance, loopInputFailure } from './expression-failure';

/** The reason a screen shows: the fixed advice for an expression that failed on its data, else the step's own cause. */
function readableCause(message: unknown): string | null {
  return loopInputFailure(message)?.text('A loop in this workflow') ?? expressionFailureGuidance(message) ?? failureCause(message);
}

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => !!value && typeof value === 'object' && !Array.isArray(value);

const stepLike = (value: Record_): boolean => typeof value.type === 'string' && typeof value.status === 'string';

/** One step output with its error message reduced to the cause; the same object when it has none. */
function cleanStep(value: unknown): unknown {
  if (!isRecord(value)) return value;
  // The worker stores `{ output: StepOutput }`; loop children can hold the StepOutput itself.
  const inner = isRecord(value.output) && stepLike(value.output) && Object.keys(value).length === 1 ? value.output : value;
  let step = inner;
  if (stepLike(inner) && inner.errorMessage !== undefined && inner.errorMessage !== null) {
    const cause = readableCause(inner.errorMessage);
    step = { ...inner, errorMessage: cause ?? 'The step failed.' };
  }
  if (stepLike(inner) && inner.type === 'LOOP_ON_ITEMS' && isRecord(inner.output) && Array.isArray(inner.output.iterations)) {
    const iterations = inner.output.iterations.map(cleanSteps);
    if (iterations.some((iteration, i) => iteration !== (inner.output as { iterations: unknown[] }).iterations[i])) {
      step = { ...step, output: { ...inner.output, iterations } };
    }
  }
  if (step === inner) return value;
  return inner === value ? step : { ...value, output: step };
}

function cleanSteps(steps: unknown): unknown {
  if (!isRecord(steps)) return steps;
  let changed: Record_ | null = null;
  for (const [name, step] of Object.entries(steps)) {
    const cleaned = cleanStep(step);
    if (cleaned !== step) (changed ??= { ...steps })[name] = cleaned;
  }
  return changed ?? steps;
}

export function publicRun<T extends FlowRun>(run: T): T {
  const failed = run.failedStep;
  const steps = cleanSteps(run.steps);
  const message = failed?.errorMessage;
  if (steps === run.steps && message === undefined) return run;
  return { ...run, steps: steps as T['steps'],
    ...(failed && message !== undefined ? { failedStep: { ...failed, errorMessage: readableCause(message) ?? 'The step failed.' } } : {}) };
}
