import { hash, id, identity, object, parseInput, parseJob, scopeId } from './input';
import { ResultError, type Dependencies, type Job, type Journey, type ReadInput, type Result, type SavedDraft, type Scope, type Transition } from './types';
export { createSqliteResultReader } from './reader';
export { createDraftCompletionGuard } from './completion';
export type * from './types';

/** Inert/default-off factory. It never submits, retries, cancels or runs work. */
export function createDraftResultProvider<C>(deps: Dependencies<C>) {
  const timeoutMs = Math.max(5, Math.min(5000, deps.readTimeoutMs ?? 5000));
  async function bounded<T>(work: () => T | Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ResultError('provider_unavailable')), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  async function open(context: C) {
    if (!deps.enabled) throw new ResultError('disabled');
    const authorized = await bounded(() => deps.authorize(context));
    if (!authorized || !authorized.actorId || !authorized.projectId) throw new ResultError('unauthorized');
    const owner: Scope = { actorId: authorized.actorId, projectId: authorized.projectId };
    const services = deps.servicesFor(owner, context);
    if (!services) throw new ResultError('binding_missing');
    const { id: generation, reader, build, journey } = services;
    if (!build) throw new ResultError('provider_unavailable');
    const binding = () => {
      const latest = deps.servicesFor(owner, context);
      if (!latest || latest.id !== generation || latest.reader !== reader || latest.build !== build || latest.journey !== journey) throw new ResultError('binding_missing');
      reader.current();
    };
    const guard = async () => {
      binding();
      if (!(await bounded(() => services.access()))) throw new ResultError('unauthorized');
      const current = await bounded(() => deps.authorize(context));
      if (!current || current.actorId !== owner.actorId || current.projectId !== owner.projectId) throw new ResultError('unauthorized');
      binding();
    };
    await guard();
    return { owner, reader, build, journey, guard };
  }
  function saved(job: Job, draft: SavedDraft, input: ReadInput): void {
    if (!identity(draft.artifact, job) || (job.artifact && ['flowId', 'versionId', 'compositionRecordId'].some(k =>
      job.artifact![k as keyof typeof job.artifact] !== draft.artifact[k as keyof typeof draft.artifact]))) throw new ResultError('identity_mismatch');
    if (input.expected && ['flowId', 'versionId', 'compositionRecordId'].some(k =>
      input.expected![k as keyof typeof input.expected] !== draft.artifact[k as keyof typeof draft.artifact])) throw new ResultError('version_changed');
    if (input.expected?.contentRevision && input.expected.contentRevision !== draft.contentRevision) throw new ResultError('result_changed');
    if (draft.activation !== 'disabled' || draft.versionState !== 'DRAFT') throw new ResultError('activation_changed');
  }
  return { capability: 'draft-result.v1' as const,
    async read(context: C, raw: unknown): Promise<Result> {
      try {
        const input = parseInput(raw), e = await open(context);
        const lookup = { schemaVersion: 1 as const, ...(input.jobId ? { jobId: input.jobId } : { requestId: input.requestId! }) };
        const result = await bounded(() => e.build.read(lookup));
        await e.guard();
        if (!object(result) || result.availability !== 'ready') throw new ResultError(object(result) && result.reason === 'not_found' ? 'not_found' : 'provider_unavailable');
        if ('requestCancellation' in result) {
          const c = result.requestCancellation;
          if (!object(c) || !input.requestId || c.schemaVersion !== 1 || c.scopeId !== scopeId(e.owner)
            || c.requestId !== input.requestId || !id(c.journeyId) || c.jobId !== null || c.resolution !== 'none'
            || ![1, 2].includes(c.revision) || !['requested', 'acknowledged'].includes(c.cancellation)) throw new ResultError('identity_mismatch');
          if (input.expected) throw new ResultError('incomplete_result');
          return { availability: 'ready', state: 'no_draft', jobId: null, requestId: c.requestId,
            outcome: c.cancellation === 'acknowledged' ? 'cancelled' : null, cancellation: c.cancellation, revision: c.revision };
        }
        const job = parseJob(result.status, e.owner, input);
        const read = () => {
          const draft = e.reader.read(e.owner, job);
          if (draft.state === 'saved') saved(job, draft, input);
          return draft;
        };
        let draft = read();
        if (draft.state !== 'saved') {
          if (input.expected || job.artifact || job.resolution === 'saved' || job.outcome === 'succeeded') throw new ResultError('incomplete_result');
          const none = job.resolution === 'none' && ['failed', 'cancelled', 'needs_input'].includes(job.outcome);
          return { availability: 'ready', state: none ? 'no_draft' : 'pending', jobId: job.jobId, requestId: job.requestId,
            outcome: job.outcome, cancellation: job.cancellation, revision: job.revision };
        }
        // Recover the progress acknowledgement after a saved-draft/lost-response race.
        // This never finishes onboarding; only an explicit journey.transition does.
        let snapshot: Journey | undefined;
        let sync: 'settled' | 'pending' | 'unavailable' = e.journey ? 'pending' : 'unavailable';
        if (e.journey) {
          try {
            for (let attempt = 0; attempt < 3; attempt++) {
              const r = await bounded(() => e.journey!.read()); await e.guard();
              const s = r.snapshot;
              if (r.availability !== 'ready' || !s || s.schemaVersion !== 1 || s.scopeId !== job.scopeId || s.journeyId !== job.journeyId
                || !Number.isSafeInteger(s.revision) || s.revision < 0) break;
              if (s.jobId !== job.jobId || s.buildRequestId !== job.requestId) break;
              if (s.draft) {
                if (s.draft.flowId === draft.artifact.flowId && s.draft.versionId === draft.artifact.versionId) { snapshot = s; sync = 'settled'; }
                break;
              }
              if (attempt === 2) break;
              const fresh = read();
              if (fresh.state !== 'saved') break;
              const a = fresh.artifact;
              // No timeout race around the mutation: the journey owns authorization,
              // revision checks and durable replay of this internal acknowledgement.
              await e.journey.acknowledge({ journeyId: job.journeyId, expectedRevision: s.revision,
                requestId: `result:${hash([job.jobId, a.flowId, a.versionId, s.revision])}`,
                command: { type: 'draft_saved', jobId: job.jobId, flowId: a.flowId, versionId: a.versionId } });
              await e.guard();
            }
          } catch { /* A saved draft remains recoverable while progress sync is unavailable. */ }
        }
        await e.guard();
        draft = read(); // Never return an old graph after an asynchronous authorization/acknowledgement.
        if (draft.state !== 'saved') throw new ResultError('incomplete_result');
        const a = draft.artifact;
        const continuation: Transition | null = e.journey?.canFinishDraft === true && snapshot?.completion === 'active' && snapshot.stepId === 'result' ? {
          operation: 'journey.transition', input: { journeyId: job.journeyId, expectedRevision: snapshot.revision,
            requestId: `result-finish:${hash([job.jobId, snapshot.revision])}`, command: { type: 'finish' } },
        } : null;
        return { availability: 'ready', state: 'saved', schemaVersion: 1, scopeId: job.scopeId, journeyId: job.journeyId, jobId: job.jobId, requestId: job.requestId,
          compositionRecordId: a.compositionRecordId, flowId: a.flowId, versionId: a.versionId, contentRevision: draft.contentRevision,
          jobRevision: job.revision, outcome: job.outcome, cancellation: job.cancellation,
          title: draft.title, graph: draft.graph, selectedNodeId: input.selectedNodeId && draft.nodeIds.includes(input.selectedNodeId) ? input.selectedNodeId : null,
          readiness: draft.readiness, missingBindings: draft.missingBindings, activation: 'disabled', versionState: 'DRAFT',
          reference: { jobId: job.jobId, requestId: job.requestId, compositionRecordId: a.compositionRecordId,
            flowId: a.flowId, versionId: a.versionId, readiness: draft.readiness.ready ? 'ready' : 'needs_input', activation: 'disabled' },
          recovery: { operation: 'result.read', input: { schemaVersion: 1, jobId: job.jobId,
            expected: { compositionRecordId: a.compositionRecordId, flowId: a.flowId, versionId: a.versionId } } },
          workflow: { room: 'workflow', selection: { flowId: a.flowId, versionId: a.versionId } },
          journey: { sync, completion: snapshot?.completion ?? null }, continuation };
      } catch (error) {
        const reason = error instanceof ResultError ? error.reason : 'provider_unavailable';
        return { availability: reason === 'disabled' || reason === 'unsupported_version' ? 'unsupported' : 'unavailable', reason };
      }
    },
  };
}
