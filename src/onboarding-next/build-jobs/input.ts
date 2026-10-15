import { createHash } from 'node:crypto';
import { BuildError, type Scope, type Submission, type SubmitInput } from './types';
export const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const scopeId = (s: Scope) => hash([s.actorId, s.projectId]);
export const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
export const digest = (s: Submission) => hash([s.request.schemaVersion, s.request.intentVersion, s.request.requestId,
  s.request.prompt, s.request.contextRefs.map(r => [r.kind, r.id]), Object.entries(s.answers).sort(([a], [b]) => a.localeCompare(b))]);
export function parseSubmit(value: unknown): SubmitInput {
  try {
    const text = JSON.stringify(value);
    if (!text || Buffer.byteLength(text) > 30 * 1024) throw new Error();
    const v: unknown = JSON.parse(text);
    if (!object(v) || !keys(v, ['schemaVersion', 'journeyId', 'intentId', 'submission']) || v.schemaVersion !== 1
      || !id(v.journeyId) || !id(v.intentId) || !object(v.submission) || !keys(v.submission, ['action', 'request', 'answers'])) throw new Error();
    const s = v.submission, r = s.request;
    if (s.action !== 'create' || !object(r) || !keys(r, ['schemaVersion', 'intentVersion', 'requestId', 'prompt', 'contextRefs'])
      || r.schemaVersion !== 1 || r.intentVersion !== 1 || !id(r.requestId) || typeof r.prompt !== 'string' || !r.prompt.trim() || r.prompt.length > 2000
      || !Array.isArray(r.contextRefs) || r.contextRefs.length > 20 || r.contextRefs.some(x => !object(x) || !keys(x, ['kind', 'id']) || !id(x.kind) || !id(x.id))
      || !object(s.answers) || Object.keys(s.answers).length > 20
      || Object.entries(s.answers).some(([k, x]) => !id(k) || typeof x !== 'string' || x.length > 2000)) throw new Error();
    return v as unknown as SubmitInput;
  } catch { throw new BuildError('invalid_request'); }
}
export function parseRead(value: unknown): { jobId?: string; requestId?: string; after: number } {
  if (!object(value) || !keys(value, ['schemaVersion', 'jobId', 'requestId', 'after']) || value.schemaVersion !== 1
    || (id(value.jobId) === id(value.requestId)) || (value.jobId !== undefined && !id(value.jobId))
    || (value.requestId !== undefined && !id(value.requestId))
    || (value.after !== undefined && (!Number.isSafeInteger(value.after) || (value.after as number) < 0))) throw new BuildError('invalid_request');
  return { jobId: value.jobId as string | undefined, requestId: value.requestId as string | undefined, after: (value.after as number) ?? 0 };
}
