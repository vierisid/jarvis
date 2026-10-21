import type { LLMManager } from '../../llm/manager.ts';
import { createInterviewSession, prepareInterviewTurn, type InterviewSession } from '../../daemon/onboarding-interviewer.ts';
import { normalizeFacts, validScope, InterviewProfileError } from './provider.ts';
import type { Scope } from './types.ts';

/** Structurally supplies B04's staged interviewer without importing B04.
 * The host selects the model from authenticated scope; no registration here. */
export function createStagedInterviewer(deps: { llmForScope(scope: Scope): LLMManager }) {
  return {
    create: () => createInterviewSession({ initialGoal: true }),
    async prepare(input: { scope: Scope; session: InterviewSession; answer: string | null; turnId: string; signal: AbortSignal }) {
      if (!validScope(input.scope)) throw new InterviewProfileError('invalid_input');
      input.signal.throwIfAborted();
      const prepared = await prepareInterviewTurn(input.session, deps.llmForScope(input.scope), input.answer, input.signal);
      // Reject malformed model facts before persisting the prepared checkpoint,
      // allowing B04's retry to regenerate rather than retry an unsavable batch.
      return { ...prepared, facts: normalizeFacts(prepared.facts) };
    },
  };
}
