/** Transport completion is distinct from action completion, and neither proves
 * a business outcome. Shared by daemon tools, durable receipts and pieces. */
export type ActionFailure = {
  status: 'blocked' | 'error' | 'unknown';
  code: string;
  message: string;
  /** An error response can follow a partial effect. Never infer safe retry. */
  effect: 'not_started' | 'may_have_occurred';
};
export type ActionOutcome = { status: 'succeeded' } | ActionFailure;

export class ActionOutcomeError extends Error {
  constructor(public readonly outcome: ActionFailure) {
    // An outcome can arrive over the wire with an empty message. Falling back
    // to the code keeps every consumer -- a durable record, a model-visible
    // tool result, a failed step -- from reporting a failure as blank text.
    super(outcome.message || `${outcome.status}: ${outcome.code}`);
    this.name = 'ActionOutcomeError';
  }
}

export function isActionOutcome(value: unknown): value is ActionOutcome {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.status === 'succeeded') return true;
  return (v.status === 'blocked' || v.status === 'error' || v.status === 'unknown')
    && typeof v.code === 'string' && v.code.length > 0
    && typeof v.message === 'string'
    && (v.effect === 'not_started' || v.effect === 'may_have_occurred');
}

export function assertActionSucceeded(outcome: ActionOutcome): void {
  if (outcome.status !== 'succeeded') throw new ActionOutcomeError(outcome);
}
