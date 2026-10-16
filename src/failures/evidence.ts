/**
 * Q-19: typed evidence from a thrown error, for `projectFailure`. Only the
 * error's type and its typed fields decide the evidence; the message is kept
 * as detail and never parsed. An error with no typed shape is `unknown`.
 */
import { ActionOutcomeError, type ActionFailure } from '../actions/action-outcome';
import { LLMProviderError, type LLMErrorCode } from '../llm/provider';
import { HostedProxyError, type HostedErrorKind } from '../util/hosted-error';
import { SidecarRPCError } from '../sidecar/rpc';
import { WorkflowReadinessError } from '../workflows/db/repos/flow-readiness';
import { WorkflowCancellationError } from '../workflows/runtime/cancellation-error';
import type { FailureEvidence } from './projection';

const HOSTED: Record<HostedErrorKind, LLMErrorCode> = {
  quota_exhausted: 'quota_exhausted', content_policy: 'content_policy', restricted: 'restricted',
  model_not_in_plan: 'forbidden', inactive: 'restricted', generic: 'unknown',
};

/** An AI step keeps its provider's error code on its effect record as `PROVIDER_<CODE>`. */
export const PROVIDER_OUTCOME_PREFIX = 'PROVIDER_';
/** Provider answers that refused the request: it processed nothing. */
const PROVIDER_REFUSALS = new Set<LLMErrorCode>(['background_throttled', 'auth', 'forbidden', 'rate_limit', 'bad_request', 'unsupported_tools',
  'not_found', 'quota_exhausted', 'content_policy', 'restricted']);

/**
 * A provider failure as a typed outcome for an effect record, or null when the
 * error is not a provider's. A refusal processed nothing; a network, server or
 * unknown failure may have been processed (and billed).
 */
export function providerOutcome(error: unknown): ActionFailure | null {
  const evidence = failureEvidence(error);
  if (evidence.source !== 'provider') return null;
  return { status: 'error', code: `${PROVIDER_OUTCOME_PREFIX}${evidence.code.toUpperCase()}`, message: evidence.message ?? evidence.code,
    effect: PROVIDER_REFUSALS.has(evidence.code) ? 'not_started' : 'may_have_occurred' };
}

/** The provider code an effect outcome carries, or null. */
export function providerCode(outcomeCode: string): LLMErrorCode | null {
  return outcomeCode.startsWith(PROVIDER_OUTCOME_PREFIX) ? outcomeCode.slice(PROVIDER_OUTCOME_PREFIX.length).toLowerCase() as LLMErrorCode : null;
}

export function failureEvidence(error: unknown): FailureEvidence {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ActionOutcomeError) return { source: 'action', outcome: error.outcome };
  if (error instanceof LLMProviderError) {
    return { source: 'provider', code: error.code, message,
      ...(error.code === 'background_throttled' && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) };
  }
  if (error instanceof HostedProxyError) return { source: 'provider', code: HOSTED[error.kind] ?? 'unknown', message };
  if (error instanceof WorkflowReadinessError) {
    return { source: 'readiness', issues: error.readiness.issues.map(issue => ({ code: issue.code, message: issue.message })) };
  }
  // The run had already started: anything it dispatched before the cancel may have completed.
  if (error instanceof WorkflowCancellationError) return { source: 'cancellation', dispatched: true, message };
  if (error instanceof SidecarRPCError) {
    // A handler that is not there never ran; any other sidecar error may have followed a partial effect.
    const absent = error.code === 'METHOD_NOT_FOUND';
    return { source: 'action', outcome: { status: absent ? 'blocked' : 'unknown', code: error.code, message,
      effect: absent ? 'not_started' : 'may_have_occurred' } };
  }
  return { source: 'unknown', message };
}
