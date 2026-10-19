import { digest, hash, id, parseRead, parseSubmit, scopeId } from './input';
import { terminal, type Job } from './store';
import { BuildError, type Artifact, type Dependencies, type DraftInput, type DraftResult, type IntentResult,
  type JourneyCommand, type Result, type Scope, type SubmitInput } from './types';
export type * from './types';
export { createSqliteBuildStore, initializeBuildJobStore } from './store';

const fail = (error: unknown): Result => ({ availability: error instanceof BuildError && ['disabled', 'binding_missing'].includes(error.reason)
  ? 'unsupported' : 'unavailable', reason: error instanceof BuildError ? error.reason : 'storage_unavailable' });
async function safe(fn: () => Promise<Result>): Promise<Result> { try { return await fn(); } catch (e) { return fail(e); } }
async function bounded<T>(operation: () => Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation(), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BuildError('provider_unavailable')), ms);
  })]); } finally { clearTimeout(timer); }
}
const draftInput = (input: SubmitInput): DraftInput => ({ schemaVersion: 1, intentId: input.intentId, submission: structuredClone(input.submission) });
const policyKeys = ['publish', 'enable', 'run', 'grantTools', 'linkGoal'] as const;
function checkIntent(result: IntentResult, input: SubmitInput, scope: Scope): boolean {
  if (result.availability !== 'ready') throw new BuildError('provider_unavailable');
  if (result.state !== 'ready' || !result.intent) return false;
  const i = result.intent;
  if (i.schemaVersion !== 1 || i.intentVersion !== 1 || i.intentId !== input.intentId || i.scopeId !== scopeId(scope)
    || i.requestDigest !== digest(input.submission) || digest({ action: 'create', request: i.request, answers: i.answers }) !== i.requestDigest
    || i.creationPolicy.artifact !== 'disabled_draft' || policyKeys.some(k => i.creationPolicy[k] !== false)) throw new BuildError('intent_changed');
  return true;
}
function artifactOf(result: DraftResult, job: Job): Artifact | null {
  if (result.availability !== 'ready') throw new BuildError('provider_unavailable');
  if (result.state === 'absent' || result.state === 'pending') return null;
  if (result.state !== 'saved') throw new BuildError('provider_unavailable');
  const a = result.artifact;
  if (!a || a.scopeId !== scopeId(job.owner) || a.requestId !== job.input.submission.request.requestId || a.requestDigest !== job.digest
    || ![a.flowId, a.versionId, a.compositionRecordId].every(id)) throw new BuildError('provider_unavailable');
  return { scopeId: a.scopeId, requestId: a.requestId, requestDigest: a.requestDigest,
    flowId: a.flowId, versionId: a.versionId, compositionRecordId: a.compositionRecordId };
}

/** Dormant provider. The host explicitly dispatches run/runNext with a fresh SERVER
 * worker context. HTTP submit/read/cancel never inherit ownership of model work. */
export function createBuildJobsProvider<C>(deps: Dependencies<C>) {
  const leaseMs = Math.max(30, Math.min(60_000, deps.leaseMs ?? 30_000));
  const timeoutMs = Math.max(10, Math.min(600_000, deps.timeoutMs ?? 120_000));
  const maxAttempts = Math.max(1, Math.min(5, Math.floor(deps.maxAttempts ?? 3)));
  const active = new Map<string, AbortController>();
  async function open(context: C) {
    if (deps.enabled !== true) throw new BuildError('disabled');
    const scope = await bounded(() => Promise.resolve(deps.authorize(context)));
    if (!scope || !id(scope.actorId) || !id(scope.projectId)) throw new BuildError('unauthorized');
    const owner = Object.freeze({ ...scope }), services = deps.servicesFor(owner, context);
    if (!services || !id(services.id)) throw new BuildError('binding_missing');
    const store = services.store, generation = services.id;
    const binding = () => {
      const live = deps.servicesFor(owner, context);
      if (deps.enabled !== true || !live || live.id !== generation || live.store !== store) throw new BuildError('binding_missing');
      store.current();
    };
    const guard = async () => {
      binding();
      const now = await bounded(() => Promise.resolve(deps.authorize(context)));
      if (!now || now.actorId !== owner.actorId || now.projectId !== owner.projectId) throw new BuildError('unauthorized');
      if (!await bounded(() => services.access())) throw new BuildError('unauthorized');
      const after = await bounded(() => Promise.resolve(deps.authorize(context)));
      if (!after || after.actorId !== owner.actorId || after.projectId !== owner.projectId) throw new BuildError('unauthorized');
      binding();
    };
    await guard();
    return { owner, services, store, binding, guard };
  }
  type Environment = Awaited<ReturnType<typeof open>>;
  async function journeyRead(e: Environment, journeyId?: string) {
    await e.guard();
    if (!e.services.journey) throw new BuildError('journey_unavailable');
    const r = await bounded(() => e.services.journey!.read());
    await e.guard();
    if (r.availability !== 'ready' || !r.snapshot || r.snapshot.scopeId !== scopeId(e.owner)
      || !id(r.snapshot.journeyId) || (journeyId !== undefined && r.snapshot.journeyId !== journeyId)) throw new BuildError('journey_unavailable');
    return r.snapshot;
  }
  async function acknowledge(e: Environment, journeyId: string, revision: number, command: JourneyCommand) {
    await e.guard();
    await bounded(() => e.services.journey!.acknowledge({ journeyId, expectedRevision: revision,
      requestId: `build-${hash([journeyId, revision, command])}`, command }));
    await e.guard(); // A lost acknowledgement is recovered from the next read.
  }
  async function reserve(e: Environment, input: SubmitInput) {
    const requestId = input.submission.request.requestId;
    for (let n = 0; n < 4; n++) {
      if (e.store.readCancellation(e.owner, requestId)) throw new BuildError('request_cancelled');
      const accepted = e.store.read(e.owner, { requestId });
      if (accepted) {
        if (accepted.digest !== digest(input.submission) || accepted.input.journeyId !== input.journeyId) throw new BuildError('conflict');
        return; // Another submitter finished while this one was validating/reserving.
      }
      const s = await journeyRead(e, input.journeyId);
      if (s.buildRequestId === requestId && !s.jobId) return;
      if (s.buildRequestId || s.jobId || s.draft) throw new BuildError('journey_unavailable');
      await acknowledge(e, s.journeyId, s.revision, { type: 'reserve_build', buildRequestId: requestId });
    }
    throw new BuildError('journey_unavailable');
  }
  async function synchronize(e: Environment, id: string) {
    for (let n = 0; n < 4; n++) {
      const j = e.store.read(e.owner, { jobId: id })!;
      if (j.journeySync === 'settled') return;
      const s = await journeyRead(e, j.input.journeyId);
      const requestId = j.input.submission.request.requestId;
      const latest = e.store.read(e.owner, { jobId: id })!;
      if (latest.revision !== j.revision) continue;
      if (s.jobId === id && s.draft && j.artifact && s.draft.flowId === j.artifact.flowId && s.draft.versionId === j.artifact.versionId) {
        e.store.synced(e.owner, id, 'settled'); return;
      }
      const outcome = j.outcome === 'cancelled' ? 'cancelled' : 'failed';
      if (terminal(j) && j.resolution === 'none' && s.buildHistory?.some(h => h.jobId === id && h.buildRequestId === requestId && h.outcome === outcome)) {
        e.store.synced(e.owner, id, 'settled'); return;
      }
      let command: JourneyCommand;
      if (s.buildRequestId === requestId && s.jobId === null && !s.draft) command = { type: 'build_started', buildRequestId: requestId, jobId: id };
      else if (s.jobId === id && s.buildRequestId === requestId && !s.draft) {
        if (!terminal(j)) { e.store.synced(e.owner, id, 'started'); return; }
        command = j.artifact ? { type: 'draft_saved', jobId: id, flowId: j.artifact.flowId, versionId: j.artifact.versionId }
          : { type: 'build_finished_without_draft', buildRequestId: requestId, jobId: id, outcome };
      } else throw new BuildError('journey_unavailable');
      await acknowledge(e, s.journeyId, s.revision, command);
    }
    throw new BuildError('journey_unavailable');
  }
  const trySync = async (e: Environment, id: string) => {
    try { await synchronize(e, id); } catch { e.binding(); e.store.retrySync(e.owner, id); }
  };

  async function recoverCancellation(e: Environment, requestId: string): Promise<Result> {
    try {
      for (let n = 0; n < 4; n++) {
        const r = e.store.reconcileCancellation(e.owner, requestId);
        if (r.settled) break;
        const s = await journeyRead(e, r.journeyId);
        if (s.buildHistory?.some(h => h.buildRequestId === requestId && h.jobId === null && h.outcome === 'cancelled')) {
          e.store.syncCancellation(e.owner, requestId, true); break;
        }
        if (s.buildRequestId !== requestId || s.jobId !== null || s.draft) throw new BuildError('journey_unavailable');
        // The durable rejection prevents delayed acceptance. Reconcile the same
        // authoritative job store before releasing this exact no-job reservation.
        e.store.reconcileCancellation(e.owner, requestId);
        await acknowledge(e, s.journeyId, s.revision, {
          type: 'build_finished_without_draft', buildRequestId: requestId, jobId: null, outcome: 'cancelled',
        });
      }
    } catch { e.binding(); }
    if (!e.store.reconcileCancellation(e.owner, requestId).settled) e.store.syncCancellation(e.owner, requestId, false);
    await e.guard();
    return e.store.cancellationResult(e.owner, requestId);
  }

  async function run(context: C, input: unknown, signal?: AbortSignal): Promise<Result> {
    return safe(async () => {
      const ref = parseRead(input), e = await open(context);
      const previous = e.store.read(e.owner, ref);
      if (!previous) {
        if (ref.requestId && e.store.readCancellation(e.owner, ref.requestId)) return recoverCancellation(e, ref.requestId);
        throw new BuildError('not_found');
      }
      if (terminal(previous)) { await trySync(e, previous.id); await e.guard(); return e.store.result(e.owner, previous.id, ref.after); }
      if (signal?.aborted) throw new BuildError('interrupted');
      const job = e.store.claim(e.owner, previous.id, leaseMs, timeoutMs);
      if (!job) return e.store.result(e.owner, previous.id, ref.after);
      const token = job.token!, controller = new AbortController(), activeKey = `${scopeId(e.owner)}:${job.id}`;
      active.set(activeKey, controller);
      let rejectStop!: (error: BuildError) => void;
      const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
      const interrupt = () => { controller.abort(); rejectStop(new BuildError('interrupted')); };
      signal?.addEventListener('abort', interrupt, { once: true });
      const abortListener = () => rejectStop(new BuildError('claim_lost'));
      controller.signal.addEventListener('abort', abortListener, { once: true });
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const heartbeat = setInterval(() => {
        try { e.binding(); if (!e.store.renew(e.owner, job.id, token, leaseMs)) throw new BuildError('claim_lost'); }
        catch { controller.abort(); }
      }, Math.max(10, Math.floor(leaseMs / 3)));
      const live = async () => {
        await e.guard();
        if (e.store.now() >= job.deadline!) throw new BuildError('timeout');
        if (controller.signal.aborted || !e.store.mayCommit(e.owner, job.id, token)) throw new BuildError('claim_lost');
      };
      const reconcile = async () => {
        await e.guard();
        if (!e.services.draft) throw new BuildError('provider_unavailable');
        const r = await bounded(() => e.services.draft!.reconcile(draftInput(job.input)));
        await e.guard(); return artifactOf(r, job);
      };
      async function settle() {
        const artifact = await reconcile();
        const updated = e.store.read(e.owner, { jobId: job!.id })!;
        if (artifact || updated.cancellation === 'requested' || updated.stopReason) e.store.finish(e.owner, job!.id, token, artifact);
        return artifact;
      }
      try {
        const work = async () => {
          // A fresh lease invalidates every older worker before absence is interpreted.
          const found = await settle();
          if (found || terminal(e.store.read(e.owner, { jobId: job.id })!)) return;
          await synchronize(e, job.id);
          await live();
          if (!e.services.validate || !e.services.draft) throw new BuildError('provider_unavailable');
          if (e.store.now() >= job.deadline!) throw new BuildError('timeout');
          e.store.phase(e.owner, job.id, token, 'understanding', 0);
          const validation = await e.services.validate(structuredClone(job.input.submission), controller.signal);
          await live();
          let ready: boolean;
          try { ready = checkIntent(validation, job.input, e.owner); }
          catch (error) { if (!(error instanceof BuildError) || error.reason !== 'intent_changed') throw error; ready = false; }
          if (!ready) {
            e.store.stop(e.owner, job.id, token, 'needs_input', ['Review your request, selected context and required connections.']);
            await settle(); return;
          }
          if (!e.store.attempt(e.owner, job.id, token, maxAttempts)) {
            e.store.stop(e.owner, job.id, token, 'attempt_limit'); await settle(); return;
          }
          e.store.phase(e.owner, job.id, token, 'building', 1);
          const result = await e.services.draft.compose(draftInput(job.input), {
            signal: controller.signal,
            mayCommit() {
              try { e.binding(); return !controller.signal.aborted && e.store.mayCommit(e.owner, job.id, token); } catch { return false; }
            },
            onPhase(phase, sequence) {
              e.binding(); if (!controller.signal.aborted) e.store.phase(e.owner, job.id, token, phase, sequence);
            },
          });
          await live();
          if (!(result.availability === 'ready' && result.state === 'saved')) {
            e.store.stop(e.owner, job.id, token, result.availability !== 'ready' && ['needs_input', 'intent_changed'].includes(result.reason) ? 'needs_input' : 'composition_failed');
          }
          const artifact = await settle(); // Only the durable authorized reader can confirm success.
          if (!artifact && !terminal(e.store.read(e.owner, { jobId: job.id })!)) {
            e.store.stop(e.owner, job.id, token, 'composition_failed'); await settle();
          }
        };
        deadlineTimer = setTimeout(() => {
          try { e.binding(); e.store.stop(e.owner, job.id, token, 'timeout'); } catch { /* Cannot claim absence on a failed write. */ }
          rejectStop(new BuildError('timeout')); controller.abort();
        }, Math.max(1, job.deadline! - e.store.now()));
        await Promise.race([work(), stopped]);
      } catch (error) {
        controller.abort(); // Fence local late completions even if a provider ignores abort.
        if (error instanceof BuildError && error.reason === 'timeout') {
          e.store.stop(e.owner, job.id, token, 'timeout');
          try { await settle(); } catch { e.store.defer(e.owner, job.id, token, 'provider_unavailable'); }
        } else if (error instanceof BuildError && (error.reason === 'interrupted' || signal?.aborted)) {
          e.store.defer(e.owner, job.id, token, 'interrupted');
        } else {
          // Provider throws may be lost post-commit acknowledgements. Fence first, then reconcile.
          e.store.stop(e.owner, job.id, token, 'composition_failed');
          try { await settle(); } catch { e.store.defer(e.owner, job.id, token, 'provider_unavailable'); }
        }
      } finally {
        clearInterval(heartbeat); clearTimeout(deadlineTimer);
        signal?.removeEventListener('abort', interrupt); controller.signal.removeEventListener('abort', abortListener);
        if (active.get(activeKey) === controller) active.delete(activeKey);
      }
      await trySync(e, job.id); await e.guard();
      return e.store.result(e.owner, job.id, ref.after);
    });
  }
  return {
    capability: 'build-job.v1' as const,
    submit: (context: C, input: unknown) => safe(async () => {
      const parsed = parseSubmit(input), e = await open(context);
      if (e.store.readCancellation(e.owner, parsed.submission.request.requestId)) throw new BuildError('request_cancelled');
      const prior = e.store.read(e.owner, { requestId: parsed.submission.request.requestId });
      if (prior) {
        if (prior.digest !== digest(parsed.submission) || prior.input.journeyId !== parsed.journeyId) throw new BuildError('conflict');
        await trySync(e, prior.id); await e.guard(); return e.store.result(e.owner, prior.id);
      }
      if (!e.services.validate || !e.services.draft) throw new BuildError('provider_unavailable');
      // Abort validation that outlives its bound so a slow assessment does not keep working unobserved.
      const validation = new AbortController();
      let checked: IntentResult;
      try { checked = await bounded(() => e.services.validate!(structuredClone(parsed.submission), validation.signal)); }
      catch (error) { validation.abort(); throw error; }
      await e.guard();
      if (!checkIntent(checked, parsed, e.owner)) throw new BuildError('needs_input');
      await reserve(e, parsed); await e.guard();
      const job = e.store.accept(e.owner, parsed);
      await trySync(e, job.id); await e.guard(); return e.store.result(e.owner, job.id);
    }),
    read: (context: C, input: unknown) => safe(async () => {
      const ref = parseRead(input), e = await open(context), job = e.store.read(e.owner, ref);
      if (!job) {
        if (ref.requestId && e.store.readCancellation(e.owner, ref.requestId)) return e.store.cancellationResult(e.owner, ref.requestId);
        throw new BuildError('not_found');
      }
      return e.store.result(e.owner, job.id, ref.after);
    }),
    cancel: (context: C, input: unknown) => safe(async () => {
      const ref = parseRead(input), e = await open(context);
      let job = e.store.read(e.owner, ref);
      if (!job && ref.requestId) {
        if (!e.store.readCancellation(e.owner, ref.requestId)) {
          const s = await journeyRead(e);
          // An acceptance may have won while we were reading the reservation.
          job = e.store.read(e.owner, ref);
          if (!job) {
            if (s.buildRequestId !== ref.requestId || s.jobId !== null || s.draft) throw new BuildError('not_found');
            const fenced = e.store.fenceRequest(e.owner, ref.requestId, s.journeyId);
            if ('job' in fenced) job = fenced.job;
          }
        }
        if (!job) return recoverCancellation(e, ref.requestId);
      }
      if (!job) throw new BuildError('not_found');
      e.store.cancel(e.owner, job.id);
      active.get(`${scopeId(e.owner)}:${job.id}`)?.abort();
      // Cancellation is only a request. The host's next worker pass reconciles it.
      return e.store.result(e.owner, job.id, ref.after);
    }),
    run,
    async runNext(context: C, signal?: AbortSignal): Promise<Result | null> {
      try {
        const e = await open(context), next = e.store.pending(e.owner, 1)[0];
        const job = next ? e.store.read(e.owner, { jobId: next }) : null, cancellation = e.store.pendingCancellation(e.owner);
        const ref = cancellation && (!job || cancellation.retryAfter <= job.retryAfter)
          ? { requestId: cancellation.requestId } : job ? { jobId: job.id } : null;
        return ref ? run(context, { schemaVersion: 1, ...ref }, signal) : null;
      } catch (error) { return fail(error); }
    },
  };
}
