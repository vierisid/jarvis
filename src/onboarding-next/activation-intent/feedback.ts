import type { IntentResult } from './types.ts';
/** Merge this feedback patch into the existing U07 model. The host retains draft
 * text and advances its feedback revision. Omitted issues preserve correction
 * fields during recoverable failures. Validation never reports job acceptance. */
export function activationFeedback(result: IntentResult) {
  if (result.availability !== 'ready') {
    if (result.reason === 'service_unavailable' || result.reason === 'cancelled') return {
      availability: 'ready' as const, phase: 'ready' as const,
      message: 'Validation could not finish. Your request is retained; try Create again.' };
    if (result.reason === 'invalid_request' || result.reason === 'request_too_large') return {
      availability: 'ready' as const, phase: 'invalid' as const,
      message: 'Review your request and shorten any long answers, then try Create again. Your text is retained.' };
    return { availability: result.availability, phase: 'ready' as const, issues: [],
      message: 'Workflow validation is unavailable. Your request is retained; explore Jarvis first or restore access.' };
  }
  // Unsupported requested nodes do not disable editing/resubmitting a different request.
  return { availability: 'ready' as const,
    phase: result.state === 'unsupported' ? 'needs_input' as const : result.state,
    issues: result.issues.map(({ id, kind, label, message, reference }) => ({ id, kind, label, message,
      ...(reference ? { reference: { ...reference } } : {}) })),
    message: result.state === 'ready' ? result.issues.length
      ? 'This can become a disabled draft with the listed placeholders. Resolve them before running it.'
      : 'The request is ready for draft creation. No workflow has been created yet.'
      : 'Review the details below. Your original request is retained.' };
}
