import { hasUiVerificationScope } from '../action-verification';
import { ActionOutcomeError, type ActionFailure } from '../action-outcome';
import { getMachineScope } from '../machine-scope';
import { WorkflowCancellationError } from '../../workflows/runtime/cancellation-error';

/** Preserve chat's legacy text, but never turn a workflow refusal into success. */
export function browserActionFailure(message: string, effect: ActionFailure['effect'] = 'not_started'): string {
  if (getMachineScope() || hasUiVerificationScope()) throw new ActionOutcomeError({
    status: effect === 'not_started' ? 'blocked' : 'unknown',
    code: effect === 'not_started' ? 'BROWSER_ACTION_REFUSED' : 'BROWSER_ACTION_UNCERTAIN', message, effect,
  });
  return message;
}

export function browserActionError(error: unknown): string {
  if (error instanceof ActionOutcomeError || error instanceof WorkflowCancellationError) throw error;
  return browserActionFailure(`Error: ${error instanceof Error ? error.message : String(error)}`, 'may_have_occurred');
}
