import type { Assessment, IntentResult, Submission } from './types.ts';
export const LIMITS = Object.freeze({ promptChars: 2000, bodyBytes: 32768, refs: 20, answers: 20, answerChars: 2000, issues: 20 });
type Reason = Extract<IntentResult, { availability: 'unavailable' | 'unsupported' }>['reason'];
export class IntentError extends Error {
  constructor(readonly reason: Reason, readonly unsupported = false) { super(reason); }
}
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const id = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
export const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const identifier = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(v);
export function parseSubmission(value: unknown): Submission {
  if (!object(value) || !keys(value, ['action', 'request', 'answers']) || value.action !== 'create'
    || !object(value.request) || !object(value.answers)) throw new IntentError('invalid_request');
  const r = value.request;
  if (r.schemaVersion !== 1 || r.intentVersion !== 1) throw new IntentError('unsupported_version', true);
  if (!keys(r, ['schemaVersion', 'intentVersion', 'requestId', 'prompt', 'contextRefs']) || !id(r.requestId)
    || typeof r.prompt !== 'string' || !Array.isArray(r.contextRefs) || r.contextRefs.length > LIMITS.refs
    || Object.keys(value.answers).length > LIMITS.answers) throw new IntentError('invalid_request');
  const refs = new Set<string>();
  for (const ref of r.contextRefs) {
    if (!object(ref) || !keys(ref, ['kind', 'id']) || !identifier(ref.kind) || !id(ref.id)) throw new IntentError('invalid_request');
    const key = JSON.stringify([ref.kind, ref.id]);
    if (refs.has(key)) throw new IntentError('invalid_request');
    refs.add(key);
  }
  for (const [key, answer] of Object.entries(value.answers)) {
    if (!identifier(key) || ['constructor', 'prototype', '__proto__'].includes(key)
      || typeof answer !== 'string') throw new IntentError('invalid_request');
  }
  // Do not truncate a user's request or silently discard unknown properties.
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > LIMITS.bodyBytes) throw new IntentError('request_too_large');
  return structuredClone(value) as unknown as Submission;
}
export function parseAssessment(value: unknown): Assessment {
  const fail = () => { throw new IntentError('service_unavailable'); };
  if (!object(value) || !keys(value, ['schemaVersion', 'issues']) || value.schemaVersion !== 1
    || !Array.isArray(value.issues) || value.issues.length > LIMITS.issues) return fail();
  const seen = new Set<string>();
  for (const issue of value.issues) {
    if (!object(issue) || !keys(issue, ['id', 'kind', 'code', 'label', 'message', 'blocking']) || !identifier(issue.id)
      || ['constructor', 'prototype', '__proto__'].includes(issue.id as string)
      || seen.has(issue.id as string) || !['detail', 'connection'].includes(issue.kind as string)
      || !['missing_detail', 'missing_context', 'missing_connection', 'unsupported_node', 'placeholder'].includes(issue.code as string)
      || !id(issue.label) || typeof issue.message !== 'string' || !issue.message.trim() || issue.message.length > 500
      || typeof issue.blocking !== 'boolean' || issue.blocking !== (issue.code !== 'placeholder')) return fail();
    seen.add(issue.id as string);
  }
  return structuredClone(value) as unknown as Assessment;
}
