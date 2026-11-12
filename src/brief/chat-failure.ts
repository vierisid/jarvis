import { getLLMErrorCode, LLMProviderError } from '../llm/provider';
import { failureDetail, failureText, projectFailure } from '../failures/projection';

const providerCodes = new Set([
  'background_throttled', 'auth', 'forbidden', 'rate_limit', 'network', 'bad_request',
  'unsupported_tools', 'not_found', 'server', 'quota_exhausted', 'content_policy', 'restricted',
]);

/**
 * Only authored recovery copy crosses the chat boundary, never upstream bodies.
 * Only a model stream's typed error is a provider failure: anything else the
 * turn throws (speech, storage, a task) would otherwise be read for words like
 * "401" or "not found" and blamed on the AI provider.
 *
 * The hosted provider's own sentence for this account (`hostedDetail`: when
 * usage resumes, where to appeal, that a plan is needed) is authored copy too,
 * so it says what happened in place of the generic headline. A hosted `auth` is no active plan, not a
 * credential to fix in AI settings, so it gets a code of its own.
 */
export function briefChatFailure(error: unknown, toolsRan: boolean): { code: string; message: string } {
  const code = error instanceof LLMProviderError ? getLLMErrorCode(error) : 'unknown';
  if (!providerCodes.has(code)) return {
    code: 'generation_failed',
    message: toolsRan
      ? 'This response could not finish. Check what earlier actions did before sending another request.'
      : 'This response could not finish. You can send a new message to try again.',
  };
  const hosted = error instanceof LLMProviderError && error.hostedDetail ? failureDetail(error.hostedDetail) : '';
  if (hosted && code === 'auth') {
    return { code: 'provider_plan_inactive', message: `Your request failed. ${hosted} ${toolsRan
      ? 'Actions it had already taken may have gone through.' : 'Nothing was done.'} Check your plan in Billing.` };
  }
  const failure = projectFailure({ source: 'provider', code, ...(error instanceof Error ? { message: error.message } : {}) }, { label: 'Your request', sideEffects: toolsRan });
  // A model outside the hosted plan: waiting does not help.
  if (hosted && code === 'forbidden') {
    return { code: 'provider_forbidden', message: `Your request failed. ${hosted} ${failure.outcome} Choose another model, or check your plan in Billing.` };
  }
  // The detail already names where to appeal; the generic step would name a second place.
  if (hosted && code === 'restricted') {
    return { code: 'provider_restricted', message: `Your request failed. ${hosted} ${failure.outcome} You can also use your own AI provider.` };
  }
  return { code: `provider_${code}`, message: failureText(hosted ? { ...failure, headline: `Your request failed. ${hosted}` } : failure) };
}
