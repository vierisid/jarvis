// Deterministic service doubles for local verification; never production bindings.
import { digest, scopeId } from './input';
import type { Artifact, DraftControl, DraftResult, JourneyCommand, JourneyPort, JourneySnapshot, Scope, Services, SubmitInput } from './types';
import type { BuildStore } from './store';
export const scope: Scope = { actorId: 'owner', projectId: 'project' };
export const input = (requestId = 'request-1'): SubmitInput => ({ schemaVersion: 1, journeyId: 'journey-1', intentId: 'intent-1',
  submission: { action: 'create', request: { schemaVersion: 1, intentVersion: 1, requestId,
    prompt: 'Draft a meeting follow-up from my supplied notes.', contextRefs: [] }, answers: { notes: 'We agreed to ship on Friday.' } } });
export function fixture(store: BuildStore, owner = scope) {
  let snapshot: JourneySnapshot = { scopeId: scopeId(owner), journeyId: 'journey-1', revision: 0,
    buildRequestId: null, jobId: null, draft: null, buildHistory: [] };
  const acknowledgements: JourneyCommand[] = [];
  const journey: JourneyPort = {
    async read() { return { availability: 'ready', snapshot: structuredClone(snapshot) }; },
    async acknowledge(r) {
      if (r.expectedRevision !== snapshot.revision) return { availability: 'unavailable' };
      const c = r.command;
      acknowledgements.push(c);
      if (c.type === 'reserve_build') {
        if (snapshot.buildRequestId || snapshot.jobId || snapshot.draft) return { availability: 'unavailable' };
        snapshot.buildRequestId = c.buildRequestId;
      } else if (c.type === 'build_started') snapshot.jobId = c.jobId;
      else if (c.type === 'draft_saved') snapshot.draft = { flowId: c.flowId, versionId: c.versionId };
      else { snapshot.buildHistory!.push({ buildRequestId: c.buildRequestId, jobId: c.jobId, outcome: c.outcome }); snapshot.jobId = null; snapshot.buildRequestId = null; }
      snapshot.revision++; return { availability: 'ready', snapshot: structuredClone(snapshot) };
    },
  };
  let artifact: Artifact | null = null, calls = 0;
  let lastControl: DraftControl | undefined;
  const services: Services = { id: 'binding-1', store, access: async () => true, journey,
    async validate(s) { return { availability: 'ready', state: 'ready', intent: { schemaVersion: 1, intentVersion: 1,
      intentId: 'intent-1', scopeId: scopeId(owner), requestDigest: digest(s), request: s.request, answers: s.answers,
      creationPolicy: { artifact: 'disabled_draft', publish: false, enable: false, run: false, grantTools: false, linkGoal: false } } }; },
    draft: {
      async compose(value, control) {
        calls++; lastControl = control;
        if (!control.mayCommit()) return { availability: 'unavailable', reason: 'claim_lost' };
        artifact ??= { scopeId: scopeId(owner), requestId: value.submission.request.requestId, requestDigest: digest(value.submission),
          flowId: 'flow-1', versionId: 'version-1', compositionRecordId: 'composition-1' };
        return { availability: 'ready', state: 'saved', artifact };
      },
      async reconcile(): Promise<DraftResult> { return artifact ? { availability: 'ready', state: 'saved', artifact } : { availability: 'ready', state: 'absent' }; },
    },
  };
  return { services, acknowledgements, snapshot: () => snapshot, calls: () => calls, control: () => lastControl,
    artifact: () => artifact, setArtifact: (value: Artifact | null) => { artifact = value; } };
}
export function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
