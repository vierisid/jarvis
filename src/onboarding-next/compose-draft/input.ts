import { createHash } from 'node:crypto';
import { DraftError, type DraftInput, type Scope, type Submission } from './types';
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const scopeId = (scope: Scope) => hash([scope.actorId, scope.projectId]);
export const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
export const digest = (s: Submission) => hash([s.request.schemaVersion, s.request.intentVersion, s.request.requestId,
  s.request.prompt, s.request.contextRefs.map(r => [r.kind, r.id]), Object.entries(s.answers).sort(([a], [b]) => a.localeCompare(b))]);
/** Bound and snapshot before the first await. Reject instead of silently dropping fields. */
export function parseInput(value: unknown): DraftInput {
  try {
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json) > 40 * 1024) throw new Error();
    const v: unknown = JSON.parse(json);
    if (!object(v) || !keys(v, ['schemaVersion', 'intentId', 'submission']) || v.schemaVersion !== 1 || !id(v.intentId)
      || !object(v.submission) || !keys(v.submission, ['action', 'request', 'answers'])) throw new Error();
    const s = v.submission, r = s.request;
    if (s.action !== 'create' || !object(r) || !keys(r, ['schemaVersion', 'requestId', 'intentVersion', 'prompt', 'contextRefs'])
      || r.schemaVersion !== 1 || r.intentVersion !== 1 || !id(r.requestId) || typeof r.prompt !== 'string'
      || !r.prompt.trim() || r.prompt.length > 2000 || !Array.isArray(r.contextRefs) || r.contextRefs.length > 20
      || r.contextRefs.some(x => !object(x) || !keys(x, ['kind', 'id']) || !id(x.kind) || !id(x.id))
      || !object(s.answers) || Object.keys(s.answers).length > 20
      || Object.entries(s.answers).some(([k, x]) => !id(k) || typeof x !== 'string' || x.length > 2000)) throw new Error();
    return v as unknown as DraftInput;
  } catch { throw new DraftError('invalid_request'); }
}
