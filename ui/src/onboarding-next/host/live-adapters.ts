import type { ComponentType } from 'react';
import { interviewSuggestions, type InterviewFact, type InterviewSuggestions } from './activation-suggestions';
import { uuid } from '../../lib/uuid';
import { createTourViewAdapter } from '../../../../src/onboarding-next/tour/view-adapter';
import type { TourResult } from '../../../../src/onboarding-next/tour/types';
import type { WorkspaceState } from '../../../../src/onboarding-next/tour/sandbox';
import type { Snapshot as InterviewSnapshot } from '../../../../src/onboarding-next/interview-session/types';
import type { GoogleSnapshot } from '../../../../src/onboarding-next/google/types';
import type { ActivationDraft, ActivationRequest } from '../views/activation';
import type { ResultCanvasProps } from '../views/result';
import { savedResult, type ResultModel } from '../views/result/model';
import { acceptStatus, isTerminal } from '../views/build/state';
import { createDraftStore } from './drafts';
import { parseJourney } from './policy';
import { Unavailable } from './transport';
import type { Configuration, Context, FeatureAdapter, Operation, Transport } from './contract';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200;
function fail(): never { throw new Unavailable(); }
export interface LiveOnboardingPorts {
  transport: Transport;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  available(): boolean;
  workspace(): WorkspaceState;
  tour: { renderer: Parameters<typeof createTourViewAdapter>[0]['renderer']; pebble: Parameters<typeof createTourViewAdapter>[0]['pebble'] };
  Canvas: ComponentType<ResultCanvasProps>;
  Setup: ComponentType<Record<string, unknown>>;
  /** This trusted host validates and opens the returned provider URL. */
  openGoogle(url: string): void;
  openWorkflow(selection: { flowId: string; versionId: string }, view?: 'workflow-draft' | 'workflow-runs' | 'workflow-context'): Promise<void>;
  /** Host reads the canonical profile API, which excludes forgotten/superseded facts. */
  readInterviewFacts?(signal: AbortSignal): Promise<InterviewFact[]>;
  pollMs?: number;
}
/** Real transport adapters. Provider responses alone advance progress; local
 * storage retains only user text and uncertain request identities. */
export function createLiveOnboardingAdapters(ports: LiveOnboardingPorts): Configuration['adapters'] {
  let identity: string | null = null;
  const check = (c: Context) => {
    const key = JSON.stringify([c.journey.scopeId, c.journey.journeyId]);
    if (!ports.available() || c.signal.aborted || (identity !== null && identity !== key)) fail();
    identity = key;
  };
  const store = (c: Context) => { check(c); return createDraftStore(ports.storage, c.journey.scopeId, c.journey.journeyId); };
  async function call(c: Context, operation: Operation, input: Record<string, unknown> = {}) {
    check(c); const result = await ports.transport.call(operation, input, c.signal); check(c); return result;
  }
  async function navigate(c: Context, command: Record<string, unknown>, requestId = uuid()) {
    const j = c.journey;
    return parseJourney(await call(c, 'journey.transition', { journeyId: j.journeyId, expectedRevision: j.revision, requestId, command }));
  }
  function binding(create: () => FeatureAdapter) { return { available: ports.available, create }; }
  function polling() {
    let timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
    const listeners = new Set<() => void>();
    const notify = () => { if (!disposed) listeners.forEach(fn => fn()); };
    return { notify, schedule(active: boolean) { clearTimeout(timer); if (active && !disposed) timer = setTimeout(notify, ports.pollMs ?? 1000); },
      subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
      dispose() { disposed = true; clearTimeout(timer); listeners.clear(); } };
  }
  let tour: FeatureAdapter | undefined;
  const tourListeners = new Set<() => void>();
  let stopTour: (() => void) | undefined;
  const tourBinding = binding(() => ({
    available: ports.available,
    async read(c) {
      check(c);
      tour ??= createTourViewAdapter({ scopeId: c.journey.scopeId, workspace: ports.workspace(), available: ports.available,
        ...ports.tour, call: async (input, signal) => ports.transport.call('tour.command', input, signal) as Promise<TourResult> });
      stopTour ??= tour.subscribe?.(() => tourListeners.forEach(fn => fn()));
      return tour.read(c);
    },
    async command(c, action, input) { check(c); if (!tour) fail(); await tour!.command(c, action, input); },
    subscribe(fn: () => void) { tourListeners.add(fn); return () => { tourListeners.delete(fn); }; },
    dispose() { stopTour?.(); stopTour = undefined; tour?.dispose?.(); tour = undefined; tourListeners.clear(); },
  }));
  let activationFeedback: Record<string, unknown> = {}, activationRevision = 0;
  let suggestions: InterviewSuggestions = { suggestions: [] }, suggestionState: 'ready' | 'unavailable' = 'ready';
  function activation(c: Context) {
    const data = store(c).read('activation') ?? { prompt: '', contextRefs: [], answers: {} };
    if (typeof data.prompt !== 'string' || !Array.isArray(data.contextRefs) || !object(data.answers)) fail();
    const draft = { prompt: data.prompt, contextRefs: data.contextRefs, answers: data.answers };
    return { model: { journeyId: c.journey.journeyId, revision: c.journey.revision + activationRevision,
      availability: 'ready', phase: 'ready', draft, interview: { ...suggestions, state: suggestionState }, ...activationFeedback, ...(data.pendingRequest ? { pendingRequest: data.pendingRequest } : {}) } };
  }
  let resultRevision = 0;
  function resultModel(c: Context, result: unknown): ResultModel {
    return { scopeId: c.journey.scopeId, journeyId: c.journey.journeyId, jobId: c.journey.jobId ?? '',
      requestId: c.journey.buildRequestId ?? '', revision: ++resultRevision, theme: ports.workspace().theme, result };
  }
  return {
    'legacy-provider-setup': binding(() => ({ available: ports.available,
      read: async c => ({ model: { setup: await call(c, 'setup.read') }, ports: { View: ports.Setup } }),
      async command(c, action) {
        if (action === 'back') { await navigate(c, { type: 'navigate', stepId: 'explain' }); return; }
        if (action !== 'complete') fail();
        const value = await call(c, 'setup.complete', { action: 'complete_setup' });
        if (!object(value) || value.ready !== true) fail();
        const fresh = parseJourney(await call(c, 'journey.read'));
        await navigate({ ...c, journey: fresh }, { type: 'navigate', stepId: 'google' });
      },
    })),
    google: binding(() => {
      const poll = polling(); let snapshot: GoogleSnapshot | null = null;
      function accept(value: unknown) {
        if (!object(value) || value.schemaVersion !== 1 || value.provider !== 'google' || !id(value.streamId)
          || !Number.isSafeInteger(value.revision) || !object(value.connection)
          || !['idle', 'pending', 'connected', 'cancelled', 'expired', 'error', 'unavailable'].includes(value.connection.state)) fail();
        const next = value as unknown as GoogleSnapshot;
        if (snapshot?.streamId === next.streamId && next.revision < snapshot.revision) fail();
        if (next.connection.state === 'pending' && !id(next.connection.attemptId)) fail();
        if (next.connection.state === 'connected' && (typeof next.connection.accountLabel !== 'string' || typeof next.connection.grantedAccessSummary !== 'string')) fail();
        snapshot = next; poll.schedule(next.connection.state === 'pending'); return next;
      }
      return { available: ports.available, ...poll,
        async read(c) { return { model: { connection: accept(await call(c, 'google.read')).connection } }; },
        async command(c, action, input) {
          if (action === 'connect') {
            const result = await call(c, 'google.begin');
            if (!object(result)) fail(); accept(result.snapshot);
            if (result.launch) {
              if (!object(result.launch) || !id(result.launch.attemptId) || typeof result.launch.url !== 'string') fail();
              ports.openGoogle(result.launch.url);
            }
          } else if (action === 'cancel') {
            if (!object(input) || !id(input.attemptId) || snapshot?.connection.state !== 'pending' || input.attemptId !== snapshot.connection.attemptId) fail();
            accept(await call(c, 'google.cancel', { attemptId: input.attemptId }));
          } else if (['skip', 'continue'].includes(action)) {
            const current = accept(await call(c, 'google.read'));
            if (current.connection.state === 'pending') accept(await call(c, 'google.cancel', { attemptId: current.connection.attemptId }));
            poll.schedule(false);
          } else fail();
        },
      };
    }),
    interview: binding(() => {
      const poll = polling(); let snapshot: InterviewSnapshot | null = null, pending: Promise<void> | null = null, error = false;
      function accept(v: unknown) {
        if (!object(v) || v.kind !== 'ok' || !object(v.snapshot)) fail();
        const s = v.snapshot;
        if (s.schemaVersion !== 1 || !id(s.sessionId) || !id(s.turnId) || !Number.isSafeInteger(s.cursor)
          || !['connecting', 'ready', 'thinking', 'error', 'done', 'skipped'].includes(s.phase)
          || !Array.isArray(s.messages) || s.messages.some((m: unknown) => !object(m) || !id(m.id) || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string')
          || !Array.isArray(s.confirmedFactIds) || !s.confirmedFactIds.every(id)) fail();
        if (snapshot && (s.sessionId !== snapshot.sessionId || s.cursor < snapshot.cursor)) fail();
        snapshot = s as InterviewSnapshot; error = false; return snapshot;
      }
      function drive(c: Context, command: Record<string, unknown>) {
        if (pending) return;
        pending = call(c, 'interview.command', command).then(accept).then(() => {}).catch(() => { error = true; })
          .finally(() => { pending = null; poll.notify(); });
      }
      function present(c: Context) {
        const drafts = store(c); let draft = drafts.read('interview') ?? { text: '', clientRequestId: uuid() };
        if (typeof draft.text !== 'string' || !id(draft.clientRequestId)) fail();
        if (snapshot?.messages.some(m => m.role === 'user' && m.clientRequestId === draft.clientRequestId)) {
          draft = { text: '', clientRequestId: uuid() }; drafts.save('interview', draft);
        }
        return { model: { sessionId: snapshot?.sessionId ?? null, turnId: snapshot?.turnId ?? null, cursor: snapshot?.cursor ?? 0,
          phase: error ? 'error' : pending && snapshot ? 'thinking' : snapshot?.phase ?? 'connecting', messages: snapshot?.messages ?? [], draft,
          confirmedFactIds: snapshot?.confirmedFactIds ?? null, farewell: snapshot?.farewell,
          recovery: snapshot?.pendingAnswer ? { kind: 'answer', answer: snapshot.pendingAnswer } : { kind: 'session' },
          navigation: { revision: c.journey.revision, kind: 'ready' } } };
      }
      return { available: ports.available, ...poll,
        async read(c) {
          if (!snapshot && !pending && !error) drive(c, { type: 'start' });
          else if (snapshot && !pending && !error) accept(await call(c, 'interview.command', { type: 'read', sessionId: snapshot.sessionId }));
          poll.schedule(!!pending || snapshot?.phase === 'thinking'); return present(c);
        },
        setDraft(c, text) { if (typeof text !== 'string' || text.length > 16384 || pending) fail(); store(c).save('interview', { text, clientRequestId: uuid() }); return present(c); },
        async command(c, action, input) {
          if (action === 'skip') { accept(await call(c, 'interview.command', { type: 'skip', sessionId: snapshot?.sessionId ?? null })); return; }
          if (action === 'answer') {
            const draft = store(c).read('interview');
            if (!object(input) || !draft || input.sessionId !== snapshot?.sessionId || input.turnId !== snapshot?.turnId
              || input.clientRequestId !== draft.clientRequestId || input.text !== draft.text) fail();
            drive(c, { type: 'answer', sessionId: input.sessionId, turnId: input.turnId, clientRequestId: input.clientRequestId, text: input.text });
          } else if (action === 'retry') {
            // Reconcile before retrying: a lost response may already have committed.
            if (!snapshot) { error = false; drive(c, { type: 'start' }); return; }
            accept(await call(c, 'interview.command', { type: 'read', sessionId: snapshot.sessionId }));
            const draft = store(c).read('interview');
            if (snapshot.phase === 'error') drive(c, { type: 'retry', sessionId: snapshot.sessionId });
            else if (snapshot.phase === 'ready' && draft && !snapshot.messages.some(m => m.clientRequestId === draft.clientRequestId)) {
              drive(c, { type: 'answer', sessionId: snapshot.sessionId, turnId: snapshot.turnId,
                clientRequestId: draft.clientRequestId, text: draft.text });
            }
          }
          else fail();
        },
      };
    }),
    tour: tourBinding, 'pebble-tour': tourBinding,
    activation: binding(() => ({ available: ports.available, async read(c) {
      check(c); suggestions = { suggestions: [] }; suggestionState = 'ready';
      if (c.journey.interviewState === 'done' && ports.readInterviewFacts) {
        try {
          const facts = await ports.readInterviewFacts(c.signal); check(c);
          suggestions = interviewSuggestions(facts);
        } catch { check(c); suggestionState = 'unavailable'; }
      }
      return activation(c);
    },
      setDraft(c, value) {
        if (!object(value) || typeof value.prompt !== 'string' || value.prompt.length > 2000 || !Array.isArray(value.contextRefs) || !object(value.answers)) fail();
        if (store(c).read('activation')?.pendingRequest) fail();
        store(c).save('activation', { prompt: value.prompt, contextRefs: value.contextRefs, answers: value.answers }); return activation(c);
      },
      async command(c, action, input) {
        if (action !== 'create' || !object(input) || input.journeyId !== c.journey.journeyId || !object(input.request) || !object(input.answers)) fail();
        const request = input.request as ActivationRequest;
        const draft = store(c).read('activation');
        if (!draft || request.prompt !== draft.prompt || JSON.stringify(request.contextRefs) !== JSON.stringify(draft.contextRefs)
          || JSON.stringify(input.answers) !== JSON.stringify(draft.answers)) fail();
        if (draft.pendingRequest && JSON.stringify(draft.pendingRequest) !== JSON.stringify({ request, answers: input.answers })) fail();
        store(c).save('activation', { ...draft, pendingRequest: { request, answers: input.answers } });
        const submission = { action: 'create', request, answers: input.answers };
        const assessed = await call(c, 'intent.validate', submission);
        if (!object(assessed) || assessed.availability !== 'ready' || !['invalid', 'needs_input', 'ready', 'unsupported'].includes(assessed.state) || !Array.isArray(assessed.issues)) fail();
        if (assessed.state !== 'ready') {
          activationRevision++; activationFeedback = { phase: assessed.state === 'unsupported' ? 'invalid' : assessed.state, issues: assessed.issues };
          store(c).save('activation', { prompt: draft.prompt, contextRefs: draft.contextRefs, answers: draft.answers }); return;
        }
        if (!object(assessed.intent) || assessed.intent.scopeId !== c.journey.scopeId || !id(assessed.intent.intentId)) fail();
        const accepted = await call(c, 'build.submit', { schemaVersion: 1, journeyId: c.journey.journeyId, intentId: assessed.intent.intentId, submission });
        if (!object(accepted) || accepted.availability !== 'ready' || accepted.status?.requestId !== request.requestId
          || accepted.status?.journeyId !== c.journey.journeyId || accepted.status?.scopeId !== c.journey.scopeId) fail();
        activationFeedback = {}; activationRevision++;
      },
    })),
    build: binding(() => {
      const poll = polling();
      return { available: ports.available, ...poll,
        async read(c) {
          const j = c.journey;
          if (!j.buildRequestId) fail();
          const value = await call(c, 'build.read', { schemaVersion: 1, ...(j.jobId ? { jobId: j.jobId } : { requestId: j.buildRequestId }) });
          if (!object(value) || value.availability !== 'ready' || !object(value.status)) fail();
          const s = value.status;
          if (s.scopeId !== j.scopeId || s.journeyId !== j.journeyId || s.requestId !== j.buildRequestId || (j.jobId && s.jobId !== j.jobId)) fail();
          const status = acceptStatus(null, s as any, s.jobId); if (!status) fail();
          let reference;
          if (s.resolution === 'saved') {
            const result = await call(c, 'result.read', { schemaVersion: 1, jobId: s.jobId });
            const saved = savedResult(resultModel({ ...c, journey: { ...j, jobId: s.jobId } }, result));
            if (saved) reference = saved.reference;
          }
          poll.schedule(!isTerminal(status));
          const draft = store(c).read('activation');
          return { model: { journeyId: j.journeyId, jobId: s.jobId, requestId: s.requestId, revision: j.revision,
            title: 'Your first workflow', prompt: draft?.prompt ?? '', availability: 'ready', transport: 'connected', status,
            cancellation: s.cancellation, result: reference ? { state: 'ready', reference } : { state: 'pending' },
            actions: { cancel: !isTerminal(status), resume: true, retry: isTerminal(status) && s.resolution === 'none',
              explore: isTerminal(status), provide_input: status!.outcome === 'needs_input', openResult: !!reference } } };
        },
        async command(c, action, input) {
          if (!object(input) || input.journeyId !== c.journey.journeyId || input.requestId !== c.journey.buildRequestId || !id(input.commandId)) fail();
          if (action === 'cancel') {
            const value = await call(c, 'build.cancel', { schemaVersion: 1, requestId: input.requestId });
            if (!object(value) || value.availability !== 'ready') fail();
          } else if (action === 'resume') return;
          else if (action === 'open_result') {
            const saved = savedResult(resultModel(c, await call(c, 'result.read', { schemaVersion: 1, jobId: c.journey.jobId })));
            if (!saved || JSON.stringify(saved.reference) !== JSON.stringify(input.result)) fail();
            // B10 acknowledges the actual artifact and owns the result transition.
          } else if (['retry', 'provide_input', 'explore'].includes(action)) {
            const fresh = parseJourney(await call(c, 'journey.read'));
            if (fresh.jobId || fresh.buildRequestId) fail();
            const data = store(c).read('activation');
            if (data) store(c).save('activation', { prompt: data.prompt, contextRefs: data.contextRefs, answers: data.answers });
            await navigate({ ...c, journey: fresh }, action === 'explore' ? { type: 'explore' } : { type: 'navigate', stepId: 'activation' }, input.commandId);
          } else fail();
        },
      };
    }),
    result: binding(() => ({ available: ports.available,
      async read(c) {
        if (!c.journey.jobId || !c.journey.buildRequestId) fail();
        const result = await call(c, 'result.read', { schemaVersion: 1, jobId: c.journey.jobId });
        const model = resultModel(c, result), saved = savedResult(model);
        if (saved && (saved.flowId !== c.journey.draft?.flowId || saved.versionId !== c.journey.draft?.versionId)) fail();
        return { model: { ...model }, ports: { Canvas: ports.Canvas, requestText: store(c).read('activation')?.prompt ?? '' } };
      },
      async command(c, action, input) {
        if (!object(input) || input.scopeId !== c.journey.scopeId || input.journeyId !== c.journey.journeyId || input.jobId !== c.journey.jobId) fail();
        const saved = savedResult(resultModel(c, await call(c, 'result.read', { schemaVersion: 1, jobId: c.journey.jobId })));
        if (!saved) fail();
        if (action === 'finish') {
          if (!saved!.continuation) fail();
          parseJourney(await call(c, 'journey.transition', saved!.continuation!.input));
        } else if (action === 'open_workflow') {
          if (!saved!.continuation) fail();
          const view = input.view ?? 'workflow-draft';
          if (!['workflow-draft', 'workflow-runs', 'workflow-context'].includes(view)) fail();
          parseJourney(await call(c, 'journey.transition', saved!.continuation!.input));
          await ports.openWorkflow(saved!.workflow.selection, view);
        }
        else if (!['review', 'refresh'].includes(action)) fail();
      },
    })),
  };
}
