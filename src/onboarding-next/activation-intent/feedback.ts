import type { IntentResult } from './types.ts';
/** U07 structural feedback only. The host retains draft text and advances its
 * feedback revision. Validation never becomes U07's accepted/job-started state. */
export function activationFeedback(result: IntentResult) {
  if (result.availability !== 'ready') return { availability: result.availability, phase: 'ready' as const, issues: [],
    message: 'Workflow validation is unavailable. Your request is retained; try again or explore Jarvis first.' };
  // Unsupported requested nodes do not disable editing/resubmitting a different request.
  return { availability: 'ready' as const,
    phase: result.state === 'unsupported' ? 'needs_input' as const : result.state,
    issues: result.issues.map(({ id, kind, label, message }) => ({ id, kind, label, message })),
    message: result.state === 'ready' ? result.issues.length
      ? 'This can become a disabled draft with the listed placeholders. Resolve them before running it.'
      : 'The request is ready for draft creation. No workflow has been created yet.'
      : 'Review the details below. Your original request is retained.' };
}
