import { getWorkflowDb, initWorkflowDb } from '../../workflows/db';
import { DEFAULT_IDS } from '../../workflows/db/schema';
import { createFlow } from '../../workflows/db/repos/flow';
import { createDraftVersion } from '../../workflows/db/repos/flow-version';
import { configureWorkflowReadiness } from '../../workflows/db/repos/flow-readiness';
import { sampleCatalog } from '../../workflows/runtime/test-fixtures';
import { hash, scopeId } from './input';
import { createSqliteResultReader } from './reader';
import type { Job, Journey, Scope, Services } from './types';
export function fixture(path = ':memory:') {
  const db = initWorkflowDb(path), owner: Scope = { actorId: 'owner', projectId: DEFAULT_IDS.project };
  configureWorkflowReadiness({ pieces: sampleCatalog() });
  // Structural B09 receipt fixture. The optional integration test uses its real writer.
  db.exec(`CREATE TABLE onboarding_draft_receipt (actor_id TEXT, project_id TEXT, request_id TEXT, digest TEXT,
    composition_id TEXT, flow_id TEXT, version_id TEXT, PRIMARY KEY(actor_id, project_id, request_id))`);
  const compositionId = 'composition-1';
  db.run(`INSERT INTO workflow_composition (id, project_id, specification, state, previous_response, created, updated)
    VALUES (?, ?, '{}', 'VALIDATED', 'PRIVATE MODEL OUTPUT', 1, 1)`, [compositionId, owner.projectId]);
  const flow = createFlow({ projectId: owner.projectId, status: 'DISABLED', metadata: { compositionRecordId: compositionId } });
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Meeting follow-up', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: 'draft', type: 'PIECE', displayName: 'Draft follow-up',
      settings: { pieceName: 'jarvis-ask', actionName: 'ask', input: { prompt: 'Summarize the supplied meeting notes.' } } },
  } });
  const job: Job = { schemaVersion: 1, scopeId: scopeId(owner), journeyId: 'journey-1', jobId: 'job-1', requestId: 'request-1',
    requestDigest: hash('request'), revision: 7, outcome: 'succeeded', resolution: 'saved', cancellation: 'not_requested', artifact: null };
  job.artifact = { scopeId: job.scopeId, requestId: job.requestId, requestDigest: job.requestDigest,
    compositionRecordId: compositionId, flowId: flow.id, versionId: version.id };
  db.run('INSERT INTO onboarding_draft_receipt VALUES (?, ?, ?, ?, ?, ?, ?)',
    [owner.actorId, owner.projectId, job.requestId, job.requestDigest, compositionId, flow.id, version.id]);
  const journey: Journey = { schemaVersion: 1, scopeId: job.scopeId, journeyId: job.journeyId, revision: 4,
    stepId: 'build', completion: 'active', jobId: job.jobId, buildRequestId: job.requestId, draft: null };
  const writes: unknown[] = [];
  const services: Services = { id: 'binding-1', reader: createSqliteResultReader(db), access: async () => true,
    build: { read: async () => ({ availability: 'ready', status: structuredClone(job) }) },
    journey: { canFinishDraft: true, read: async () => ({ availability: 'ready', snapshot: structuredClone(journey) }),
      acknowledge: async input => {
        writes.push(input);
        if (input.expectedRevision !== journey.revision) return { availability: 'unavailable' };
        journey.revision++; journey.stepId = 'result'; journey.draft = { flowId: input.command.flowId, versionId: input.command.versionId };
        return { availability: 'ready', snapshot: structuredClone(journey) };
      } } };
  return { db, owner, flow, version, job, journey, writes, services, rebind() { services.reader = createSqliteResultReader(getWorkflowDb()); } };
}
export const input = { schemaVersion: 1, jobId: 'job-1' };
