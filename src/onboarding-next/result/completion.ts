import { identity, object, parseJob } from './input';
import type { Journey, Reader, Scope } from './types';

/** Bind to B01's validateFinish. Reads must be synchronous, on the same database
 * as the journey transaction; never adapt the asynchronous HTTP/job provider.
 * readJob is the authoritative B08 store.result(scope, jobId) projection. */
export function createDraftCompletionGuard(deps: {
  reader: Reader;
  readJob(scope: Scope, jobId: string): unknown;
}) {
  return (scope: Scope, journey: Journey, resource: unknown): boolean => {
    try {
      if (!deps.reader.inTransaction(resource) || !journey.jobId || !journey.draft) return false;
      const result = deps.readJob(scope, journey.jobId);
      if (!object(result) || result.availability !== 'ready') return false;
      const job = parseJob(result.status, scope, { schemaVersion: 1, jobId: journey.jobId });
      if (job.journeyId !== journey.journeyId || job.scopeId !== journey.scopeId || job.requestId !== journey.buildRequestId) return false;
      const draft = deps.reader.read(scope, job);
      if (draft.state !== 'saved' || !identity(draft.artifact, job) || draft.activation !== 'disabled' || draft.versionState !== 'DRAFT') return false;
      const a = draft.artifact;
      return a.flowId === journey.draft.flowId && a.versionId === journey.draft.versionId
        && (!job.artifact || (a.flowId === job.artifact.flowId && a.versionId === job.artifact.versionId
          && a.compositionRecordId === job.artifact.compositionRecordId));
    } catch { return false; }
  };
}
