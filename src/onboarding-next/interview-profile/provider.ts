import { createHash } from 'node:crypto';
import type { CommitInput, Fact, Receipt, Scope, Store } from './types.ts';

export class InterviewProfileError extends Error {
  constructor(readonly code: 'unavailable' | 'invalid_input' | 'conflict' | 'stale' | 'profile_changed' | 'storage_unavailable') {
    super(code);
  }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const themes = new Set(['identity', 'work', 'projects', 'goals', 'ambitions', 'communication', 'rhythm', 'tools', 'scope']);
export function validScope(scope: Scope): boolean {
  return !!scope && identity(scope.actorId) && identity(scope.projectId);
}
/** Match the canonical writer's case-insensitive (theme, summary) identity. */
export const factId = (scope: Scope, fact: Fact) => `if1_${hash([scope.actorId, scope.projectId, fact.theme.toLowerCase(), fact.summary.toLowerCase()])}`;
export const receiptKey = (scope: Scope, attemptId: string) => `onboarding-next.interview-profile.v1.${hash([scope.actorId, scope.projectId, attemptId])}`;

export function normalizeFacts(value: unknown): Fact[] {
  if (!Array.isArray(value) || value.length > 128) throw new InterviewProfileError('invalid_input');
  return value.map(f => {
    if (!object(f) || typeof f.theme !== 'string' || !themes.has(f.theme.trim().toLowerCase())
      || typeof f.summary !== 'string' || !f.summary.trim() || f.summary.trim().length > 120
      || (f.raw_quote !== undefined && (typeof f.raw_quote !== 'string' || f.raw_quote.length > 4000))) {
      throw new InterviewProfileError('invalid_input');
    }
    return { theme: f.theme.trim().toLowerCase(), summary: f.summary.trim(),
      ...(typeof f.raw_quote === 'string' && f.raw_quote.trim() ? { raw_quote: f.raw_quote.trim() } : {}) };
  });
}
function readReceipt(value: unknown): Receipt | null {
  if (value === null) return null;
  if (!object(value) || value.schemaVersion !== 1 || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)
    || !Array.isArray(value.confirmedFactIds) || value.confirmedFactIds.length > 128
    || value.confirmedFactIds.some(id => typeof id !== 'string' || !/^if1_[a-f0-9]{64}$/.test(id))
    || new Set(value.confirmedFactIds).size !== value.confirmedFactIds.length) throw new InterviewProfileError('storage_unavailable');
  return value as unknown as Receipt;
}

/** Inert, default-off factory. Only a successful atomic canonical write can
 * acknowledge an ID. No model counts, inferred fields or configured objects. */
export function createInterviewProfileProvider(deps: { enabled?: boolean; store?: Store }) {
  return {
    capability: 'interview-profile.v1' as const,
    async commit(input: CommitInput): Promise<{ confirmedFactIds: string[] }> {
      try {
        if (deps.enabled !== true || !deps.store) throw new InterviewProfileError('unavailable');
        if (!input || !validScope(input.scope) || ![input.sessionId, input.turnId, input.clientRequestId, input.attemptId].every(identity)
          || typeof input.wrap !== 'boolean' || typeof input.isCurrent !== 'function' || !input.signal) throw new InterviewProfileError('invalid_input');
        const scope = { ...input.scope }, facts = normalizeFacts(input.facts);
        const ids = [...new Set(facts.map(f => factId(scope, f)))];
        const digest = hash([input.sessionId, input.turnId, input.clientRequestId, facts, input.wrap]);
        const key = receiptKey(scope, input.attemptId);
        const check = () => {
          if (input.signal.aborted || !input.isCurrent()) throw new InterviewProfileError('stale');
        };
        check();
        return deps.store.transaction(scope, tx => {
          check();
          const previous = readReceipt(tx.readReceipt(key));
          if (previous && previous.digest !== digest) throw new InterviewProfileError('conflict');
          const persisted = () => new Set((tx.readProfile()?.interview_facts ?? []).map(f => factId(scope, f)));
          if (previous) {
            // Reconcile the current canonical state. Never resurrect forgotten or
            // externally corrected facts from a receipt or repeat an old effect.
            const actual = persisted();
            if (JSON.stringify(previous.confirmedFactIds) !== JSON.stringify(ids)
              || ids.some(id => !actual.has(id)) || (input.wrap && tx.readProfile()?.completed_at == null)) {
              throw new InterviewProfileError('profile_changed');
            }
            check();
            return { confirmedFactIds: [...ids] };
          }
          const actual = persisted();
          for (const fact of facts) {
            const id = factId(scope, fact);
            if (actual.has(id)) continue;
            check();
            tx.append(fact);
            // Read back through the canonical store, not the writer's promise.
            if (!persisted().has(id)) throw new InterviewProfileError('storage_unavailable');
            actual.add(id);
          }
          if (input.wrap) {
            check();
            tx.wrap();
            if (tx.readProfile()?.completed_at == null) throw new InterviewProfileError('storage_unavailable');
          }
          check();
          tx.writeReceipt(key, { schemaVersion: 1, digest, confirmedFactIds: ids });
          check();
          return { confirmedFactIds: [...ids] };
        });
      } catch (error) {
        // No text, model output, profile contents or database errors in telemetry.
        throw error instanceof InterviewProfileError ? error : new InterviewProfileError('storage_unavailable');
      }
    },
  };
}
