import { createHash } from 'node:crypto';
import { ResultError, type Identity, type Job, type ReadInput, type Scope } from './types';
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const scopeId = (s: Scope) => hash([s.actorId, s.projectId]);
export const object = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
export const id = (x: unknown): x is string => typeof x === 'string' && !!x.trim() && x.length <= 200;
// Workflow identifiers follow the existing engine grammar, independently of request IDs.
export const nodeId = (x: unknown): x is string => typeof x === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(x)
  && !['connections', '__proto__', 'prototype', 'constructor'].includes(x);
const digest = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const keys = (x: Record<string, unknown>, allowed: string[]) => Object.keys(x).every(k => allowed.includes(k));
export function parseInput(x: unknown): ReadInput {
  if (!object(x)) throw new ResultError('invalid_request');
  if (x.schemaVersion !== 1) throw new ResultError('unsupported_version');
  if (!keys(x, ['schemaVersion', 'jobId', 'requestId', 'selectedNodeId', 'expected'])
    || (id(x.jobId) === id(x.requestId)) || (x.jobId !== undefined && !id(x.jobId))
    || (x.requestId !== undefined && !id(x.requestId))
    || (x.selectedNodeId !== undefined && !nodeId(x.selectedNodeId))) throw new ResultError('invalid_request');
  if (x.expected !== undefined && (!object(x.expected)
    || !keys(x.expected, ['flowId', 'versionId', 'compositionRecordId', 'contentRevision'])
    || !['flowId', 'versionId', 'compositionRecordId'].every(k => id(x.expected[k]))
    || (x.expected.contentRevision !== undefined && !digest(x.expected.contentRevision)))) throw new ResultError('invalid_request');
  return structuredClone(x) as ReadInput;
}
export function identity(x: unknown, job: Pick<Job, 'scopeId' | 'requestId' | 'requestDigest'>): x is Identity {
  return object(x) && x.scopeId === job.scopeId && x.requestId === job.requestId && x.requestDigest === job.requestDigest
    && ['flowId', 'versionId', 'compositionRecordId'].every(k => id(x[k]));
}
export function parseJob(x: unknown, owner: Scope, input: ReadInput): Job {
  if (!object(x) || x.schemaVersion !== 1 || x.scopeId !== scopeId(owner)
    || !['jobId', 'requestId', 'journeyId'].every(k => id(x[k])) || !digest(x.requestDigest)
    || !Number.isSafeInteger(x.revision) || x.revision < 0
    || !['queued', 'working', 'needs_input', 'succeeded', 'failed', 'cancelled'].includes(x.outcome)
    || !['pending', 'unknown', 'none', 'saved'].includes(x.resolution)
    || !['not_requested', 'requested', 'acknowledged'].includes(x.cancellation)
    || (input.jobId !== undefined && input.jobId !== x.jobId) || (input.requestId !== undefined && input.requestId !== x.requestId)
    || (x.artifact !== null && !identity(x.artifact, x as Job))) throw new ResultError('identity_mismatch');
  // Events, errors, missing-input payloads and any future private fields never escape.
  return { schemaVersion: 1, scopeId: x.scopeId, journeyId: x.journeyId, jobId: x.jobId, requestId: x.requestId,
    requestDigest: x.requestDigest, revision: x.revision, outcome: x.outcome, resolution: x.resolution,
    cancellation: x.cancellation, artifact: x.artifact === null ? null : {
      scopeId: x.artifact.scopeId, requestId: x.artifact.requestId, requestDigest: x.artifact.requestDigest,
      flowId: x.artifact.flowId, versionId: x.artifact.versionId, compositionRecordId: x.artifact.compositionRecordId,
    } };
}
