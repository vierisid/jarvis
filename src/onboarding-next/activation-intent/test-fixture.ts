import { createActivationIntentProvider, intentScopeId } from './index.ts';
import type { ContextRef, IntentServices, Issue, Scope, Submission } from './types.ts';
export const owner = { actorId: 'owner', projectId: 'project' };
export const submission = (prompt = 'Draft a summary of the notes I select.'): Submission => ({ action: 'create',
  request: { schemaVersion: 1, requestId: 'request-1', intentVersion: 1, prompt, contextRefs: [] }, answers: {} });
export const ref = (kind: string, id = kind): ContextRef => ({ kind, id });
export const issue = (id = 'notes', code: Issue['code'] = 'missing_context'): Issue => ({ id, kind: code === 'missing_connection' ? 'connection' : 'detail',
  code, label: `Choose ${id}`, message: `Select or provide ${id} to continue.`, blocking: code !== 'placeholder' });
/** Deterministic trusted-service fixture, never registered in production. */
export function fixture() {
  const calls: string[] = []; let scope: Scope | null = owner;
  const services: IntentServices = {
    id: 'canonical-store-1',
    async access() { calls.push('access'); return 'ready'; },
    async resolve(ref) { calls.push('resolve'); return { availability: 'ready', reference: { scopeId: intentScopeId(owner), ref, revision: 'v1' } }; },
    async assess() { calls.push('assess'); return { schemaVersion: 1, issues: [] }; },
  };
  const deps = { enabled: true, authorize: () => scope, servicesFor: () => services };
  return { calls, services, deps, provider: createActivationIntentProvider(deps), setScope: (value: Scope | null) => { scope = value; } };
}
