import { createHash } from 'node:crypto';
import { CREATION_POLICY } from './types.ts';
import type { ContextRef, IntentDependencies, IntentResult, Issue, Reference, Scope, Submission } from './types.ts';
import { id, IntentError, keys, LIMITS, object, parseAssessment, parseSubmission } from './validation.ts';
export type * from './types.ts';
export { LIMITS } from './validation.ts';
export { CREATION_POLICY } from './types.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const intentScopeId = (scope: Scope) => hash([scope.actorId, scope.projectId]);
function reply(submission: Submission, issues: Issue[], state: 'invalid' | 'needs_input' | 'unsupported'): IntentResult {
  return { availability: 'ready', schemaVersion: 1, state, submission, issues, intent: null };
}
const unavailableRef = (ref: ContextRef, index: number): Issue => ({ id: `reference-${index}`, kind: ref.kind === 'connection' ? 'connection' : 'detail',
  code: ref.kind === 'connection' ? 'missing_connection' : 'missing_context', label: 'Review this selection', reference: { ...ref },
  message: 'This selection is unavailable or changed. Remove it and review your request before trying again.', blocking: true });

/** Stateless, default-off validation. B08 owns job idempotency/persistence;
 * B09 owns planning and saving a disabled draft. A serialized ready result is
 * not authorization: consumers must revalidate against live scoped services. */
export function createActivationIntentProvider<C>(deps: IntentDependencies<C>) {
  return {
    capability: 'activation-intent.v1' as const,
    async validate(context: C, input: unknown, signal?: AbortSignal): Promise<IntentResult> {
      try {
        if (deps.enabled !== true) throw new IntentError('disabled', true);
        const submission = parseSubmission(input);
        const scope = await deps.authorize(context);
        if (!scope || !id(scope.actorId) || !id(scope.projectId)) throw new IntentError('unauthorized');
        const owner = Object.freeze({ ...scope }), scopeId = intentScopeId(owner);
        const services = deps.servicesFor(owner, context);
        if (!services || !id(services.id)) throw new IntentError('binding_missing', true);
        const bindingId = services.id;
        const guard = async () => {
          if (signal?.aborted) throw new IntentError('cancelled');
          const now = await deps.authorize(context);
          if (signal?.aborted) throw new IntentError('cancelled');
          if (!now || now.actorId !== owner.actorId || now.projectId !== owner.projectId
            || deps.servicesFor(owner, context)?.id !== bindingId) throw new IntentError('unauthorized');
        };
        const check = async () => {
          await guard();
          const access = await services.access(signal);
          if (access !== 'ready') throw new IntentError(access === 'forbidden' ? 'unauthorized' : 'capability_unavailable', access === 'unsupported');
          await guard();
        };
        await check();
        const longAnswers: Issue[] = Object.entries(submission.answers).filter(([, value]) => value.length > LIMITS.answerChars)
          .map(([id]) => ({ id, kind: 'detail', code: 'missing_detail', label: 'Shorten this answer', blocking: true,
            message: `Keep this answer within ${LIMITS.answerChars} characters. Your text has been retained.` }));
        if (longAnswers.length) return reply(submission, longAnswers, 'invalid');
        const prompt = submission.request.prompt;
        if (!prompt.trim() || prompt.length > LIMITS.promptChars) return reply(submission, [{ id: 'prompt', kind: 'detail',
          code: 'missing_detail', label: 'Describe your routine', blocking: true,
          message: !prompt.trim() ? 'Enter the task you want to turn into a workflow.' : `Keep the request within ${LIMITS.promptChars} characters. Your text has been retained.` }], 'invalid');
        const resolve = async (ref: ContextRef): Promise<Reference | null> => {
          const result: unknown = await services.resolve(structuredClone(ref), signal);
          if (!object(result)) throw new IntentError('service_unavailable');
          if (result.availability === 'unsupported' || result.availability === 'unavailable') {
            if (!keys(result, ['availability'])) throw new IntentError('service_unavailable');
            return null;
          }
          const r = result.reference;
          if (result.availability !== 'ready' || !keys(result, ['availability', 'reference']) || !object(r)
            || !keys(r, ['scopeId', 'ref', 'revision']) || !object(r.ref) || !keys(r.ref, ['kind', 'id'])
            || !id(r.revision)) throw new IntentError('service_unavailable');
          if (r.scopeId !== scopeId || r.ref.kind !== ref.kind || r.ref.id !== ref.id) return null;
          return structuredClone(r) as unknown as Reference;
        };
        const references: Reference[] = [], missing: Issue[] = [];
        for (const [i, ref] of submission.request.contextRefs.entries()) {
          await check(); const r = await resolve(ref);
          if (r) references.push(r); else missing.push(unavailableRef(ref, i));
        }
        await check();
        if (missing.length) return reply(submission, missing, 'needs_input');
        const assessment = parseAssessment(await services.assess({ ...structuredClone(submission), references: structuredClone(references),
          creationPolicy: { ...CREATION_POLICY } }, signal));
        // Context and grants can change while assessment is awaiting a service.
        for (const [i, previous] of references.entries()) {
          await check(); const now = await resolve(previous.ref);
          if (!now || now.revision !== previous.revision) missing.push(unavailableRef(previous.ref, i));
        }
        await check();
        if (missing.length) return reply(submission, missing, 'needs_input');
        const issues = assessment.issues;
        if (issues.some(i => i.code === 'unsupported_node')) return reply(submission, issues, 'unsupported');
        if (issues.some(i => i.blocking)) return reply(submission, issues, 'needs_input');
        // Object insertion order is irrelevant; exact text and reference order are not.
        const request = submission.request;
        const requestDigest = hash([request.schemaVersion, request.intentVersion, request.requestId, request.prompt,
          request.contextRefs.map(r => [r.kind, r.id]), Object.entries(submission.answers).sort(([a], [b]) => a.localeCompare(b))]);
        const intentId = hash([scopeId, bindingId, requestDigest, references.map(r => [r.scopeId, r.ref.kind, r.ref.id, r.revision]),
          issues.map(i => [i.id, i.kind, i.code, i.label, i.message, i.blocking])]);
        return { availability: 'ready', schemaVersion: 1, state: 'ready', submission, issues,
          intent: { schemaVersion: 1, intentVersion: 1, scopeId, intentId, requestDigest, request: structuredClone(request),
            answers: structuredClone(submission.answers), references, qualifications: structuredClone(issues), creationPolicy: { ...CREATION_POLICY } } };
      } catch (error) {
        return { availability: error instanceof IntentError && error.unsupported ? 'unsupported' : 'unavailable',
          reason: error instanceof IntentError ? error.reason : 'service_unavailable' };
      }
    },
  };
}
