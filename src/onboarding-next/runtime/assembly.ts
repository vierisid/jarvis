/** Complete host assembly. External services are selected by the server; clients
 * supply neither scope, database, model nor release permission. */
import type { Database } from 'bun:sqlite';
import type { ComposeDeps } from '../../actions/tools/workflow-composer';
import { getWorkflowDb } from '../../workflows/db';
import { createJourneyProvider, createSettingsJourneyPersistence } from '../journey';
import type { LegacyStatus } from '../journey/types';
import { createSetupProvider } from '../setup';
import type { SetupPorts } from '../setup/types';
import { createGoogleProvider } from '../google';
import type { GoogleBinding } from '../google/types';
import { createInterviewSessionProvider, createSettingsInterviewStore } from '../interview-session';
import type { InterviewerPort } from '../interview-session/types';
import { createInterviewProfileProvider, createCanonicalInterviewProfileStore } from '../interview-profile';
import { createTourProvider } from '../tour';
import type { RoomStatus } from '../tour/types';
import type { TourStep } from '../tour/steps';
import { createActivationIntentProvider, type IntentServices } from '../activation-intent';
import { createComposeDraftProvider, createSqliteDraftStore, initializeComposeDraftStore, type Intent } from '../compose-draft';
import { createBuildJobsProvider, createSqliteBuildStore, initializeBuildJobStore } from '../build-jobs';
import { createDraftResultProvider, createSqliteResultReader, createDraftCompletionGuard } from '../result';
import type { Binder, Capability, Context, Scope, Provider } from './contract';
import { RuntimeError } from './runtime';
import { getGoalApplication } from '../../goals/application-service';
import { createInitialGoalPlanner, saveInitialInterviewGoal } from './initial-goal';
import { getDb } from '../../vault/schema';

export interface OnboardingAssemblyPorts {
  owner: Scope;
  database: Database;
  authorize(request: Request): Scope | null;
  readLegacy(): LegacyStatus;
  setup: Omit<SetupPorts<Context>, 'authorize'> | ((context: Context) => Omit<SetupPorts<Context>, 'authorize'>);
  google(scope: Scope): GoogleBinding | null | Promise<GoogleBinding | null>;
  interviewer: InterviewerPort;
  intent(scope: Scope, context: Context): IntentServices | null;
  composer(): ComposeDeps;
  planInitialGoal?(text: string): Promise<import('../../goals/proposal').GoalProposal>;
  resolveContext(intent: Intent, signal?: AbortSignal): Promise<Record<string, unknown>>;
  roomStatus(scope: Scope, step: TourStep): RoomStatus | Promise<RoomStatus>;
  /** Pure service readiness, never an external request. */
  ready(): boolean;
  workerIntervalMs?: number;
}

/** Explicit provisioning happens at host startup, never in a status probe. */
export function createOnboardingAssembly(ports: OnboardingAssemblyPorts) {
  const db = ports.database, owner = Object.freeze({ ...ports.owner });
  initializeBuildJobStore(db);
  initializeComposeDraftStore(db);
  const buildStore = createSqliteBuildStore(db), draftStore = createSqliteDraftStore(db);
  const reader = createSqliteResultReader(db);
  const finish = createDraftCompletionGuard({ reader, readJob: (scope, jobId) => buildStore.result(scope, jobId) });
  const generation = crypto.randomUUID();
  const workerContexts = new WeakSet<Context>();
  const lifetime = new AbortController();
  let running = false, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | null = null;
  const current = () => !stopped && getWorkflowDb() === db && ports.ready();
  const authorize = (context: Context): Scope | null => {
    if (!current() || context.signal.aborted) return null;
    const resolved = workerContexts.has(context) && running ? owner : ports.authorize(context.request);
    return resolved?.actorId === owner.actorId && resolved.projectId === owner.projectId ? owner : null;
  };
  const guard = (context: Context) => {
    if (!authorize(context)) throw new RuntimeError('unauthorized', 401);
    return owner;
  };
  const settingsPersistence = createSettingsJourneyPersistence({ databaseForScope: scope => {
    if (!current() || scope.actorId !== owner.actorId || scope.projectId !== owner.projectId) throw new Error('Binding unavailable');
    return db;
  }, readLegacy: ports.readLegacy });
  const prepareGoal = createInitialGoalPlanner(text => {
    if (!ports.planInitialGoal) throw Error('Goal planner unavailable');
    return ports.planInitialGoal(text);
  });
  const persistence: typeof settingsPersistence = {
    transaction(scope, operation) {
      return getGoalApplication().transaction(() => settingsPersistence.transaction(scope, tx => operation({ ...tx, write(record) {
        tx.write(record);
        // The goal and journey finish share the canonical SQLite transaction.
        if (record.snapshot.stepId === 'exited' && record.snapshot.interviewState === 'done') {
          if (getDb() !== db) throw new Error('Profile vault unavailable');
          saveInitialInterviewGoal(record.snapshot);
        }
      } })));
    },
  };
  const journey = (context: Context) => createJourneyProvider({ authorize: () => authorize(context), persistence, validateFinish: finish,
    prepareExit: async (_scope, snapshot) => prepareGoal(snapshot, () => { guard(context); if (getDb() !== db) throw Error('Vault changed'); }) });
  async function acknowledge(context: Context, command: Parameters<ReturnType<typeof createJourneyProvider>['acknowledge']>[0]['command']) {
    for (let attempt = 0; attempt < 4; attempt++) {
      guard(context);
      const provider = journey(context), read = await provider.read();
      if (read.availability !== 'ready') throw new RuntimeError('provider_unavailable', 503);
      const result = await provider.acknowledge({ journeyId: read.snapshot.journeyId,
        expectedRevision: read.snapshot.revision, requestId: crypto.randomUUID(), command });
      if (result.availability === 'ready') return result;
      if (result.reason !== 'conflict') throw new RuntimeError('provider_unavailable', 503);
    }
    throw new RuntimeError('conflict', 409);
  }
  const setup = (context: Context) => createSetupProvider<Context>({ ...(typeof ports.setup === 'function' ? ports.setup(context) : ports.setup), authorize });
  const google = createGoogleProvider<Context>({ authorize, resolve: ports.google });
  const profile = createInterviewProfileProvider({ enabled: true,
    store: createCanonicalInterviewProfileStore({ owner, database: () => { if (!current()) throw new Error('Binding unavailable'); return db; } }) });
  const interview = createInterviewSessionProvider<Context>({ enabled: true, authorize,
    store: createSettingsInterviewStore(() => { if (!current()) throw new Error('Binding unavailable'); return db; }),
    interviewer: ports.interviewer, profile });
  const tour = createTourProvider<Context>({ enabled: true, authorize,
    journeyFor: (_scope, context) => journey(context), roomStatus: ports.roomStatus });
  const intent = createActivationIntentProvider<Context>({ enabled: true, authorize, servicesFor: ports.intent });
  const draft = createComposeDraftProvider<Context>({ enabled: true, authorize,
    servicesFor: (_scope, context) => current() ? {
      id: generation, store: draftStore, access: async () => !!authorize(context),
      validate: (submission, signal) => intent.validate(context, submission, signal),
      resolveContext: ports.resolveContext, composer: ports.composer,
    } : null });
  const build = createBuildJobsProvider<Context>({ enabled: true, authorize,
    servicesFor: (_scope, context) => current() ? {
      id: generation, store: buildStore, access: async () => !!authorize(context), journey: journey(context),
      validate: (submission, signal) => intent.validate(context, submission, signal),
      draft: { compose: (input, control) => draft.compose(context, input, control), reconcile: input => draft.reconcile(context, input) },
    } : null });
  const resultServices = new WeakMap<Context, import('../result/types').Services>();
  const result = createDraftResultProvider<Context>({ enabled: true, authorize,
    servicesFor: (_scope, context) => {
      if (!current()) return null;
      let services = resultServices.get(context);
      if (!services) {
        services = { id: generation, access: async () => !!authorize(context), reader,
          journey: { ...journey(context), canFinishDraft: true }, build: { read: input => build.read(context, input) } };
        resultServices.set(context, services);
      }
      return services;
    } });

  function wake() {
    if (!running || stopped || pending) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    // A durable job belongs to the server, never the submitting HTTP signal.
    const context: Context = { request: new Request('http://onboarding-worker.invalid/'), scope: owner, signal: lifetime.signal };
    workerContexts.add(context);
    pending = (async () => {
      if (current()) await build.runNext(context);
    })().catch(() => { /* Durable job state remains the recovery authority. */ }).finally(() => {
      workerContexts.delete(context);
      pending = null;
      if (running && !stopped) {
        timer = setTimeout(wake, Math.max(50, ports.workerIntervalMs ?? 1000));
        timer.unref?.();
      }
    });
  }
  const probe = (context: Context) => ({ ready: !!authorize(context), reason: 'provider_unavailable' as const });
  const binder = (operations: Provider['operations']): Binder => () => ({ probe, operations });
  const bindings: Partial<Record<Capability, Binder>> = {
    'journey.v1': binder({ 'journey.read': async (_input, c) => journey(c).read(), 'journey.transition': async (input, c) => journey(c).transition(input as Parameters<ReturnType<typeof createJourneyProvider>['transition']>[0]) }),
    'setup.v1': binder({ 'setup.read': async (_input, c) => setup(c).read(c), 'setup.complete': async (input, c) => {
      const value = await setup(c).complete(c, input);
      if (value.ready) {
        const read = await journey(c).read();
        if (read.availability === 'ready' && read.snapshot.setupState !== 'completed') await acknowledge(c, { type: 'setup_completed' });
      }
      return value;
    } }),
    'google-state.v1': binder({ 'google.read': async (_input, c) => google.read(c), 'google.begin': async (_input, c) => google.begin(c),
      'google.cancel': async (input, c) => {
        if (!input || typeof input !== 'object' || !('attemptId' in input) || typeof input.attemptId !== 'string') throw new RuntimeError('invalid_request', 400);
        return google.cancel(c, input.attemptId);
      }, 'google.callback': async (input, c) => {
        if (!input || typeof input !== 'object' || !('state' in input) || typeof input.state !== 'string'
          || ('code' in input && typeof input.code !== 'string') || ('error' in input && typeof input.error !== 'string')) throw new RuntimeError('invalid_request', 400);
        return google.callback(c, input as { state: string; code?: string; error?: string });
      } }),
    'interview-profile.v1': binder({}),
    'interview-session.v1': binder({ 'interview.command': async (input, c) => {
      const value = await interview.request(c, input);
      if (value.kind === 'ok' && (value.snapshot.phase === 'done' || value.snapshot.phase === 'skipped')) {
        const read = await journey(c).read();
        if (read.availability === 'ready' && read.snapshot.interviewState !== value.snapshot.phase)
          await acknowledge(c, { type: 'interview_finished', state: value.snapshot.phase });
      }
      return value;
    } }),
    'tour.v1': binder({ 'tour.command': async (input, c) => tour.request(c, input) }),
    'activation-intent.v1': binder({ 'intent.validate': async (input, c) => intent.validate(c, input, c.signal) }),
    'compose-draft.v1': binder({}),
    'build-job.v1': binder({ 'build.submit': async (input, c) => { const value = await build.submit(c, input); if (value.availability === 'ready') wake(); return value; },
      'build.read': async (input, c) => build.read(c, input), 'build.cancel': async (input, c) => build.cancel(c, input) }),
    'draft-result.v1': binder({ 'result.read': async (input, c) => result.read(c, input) }),
  };
  return {
    bindings,
    start() { if (stopped) throw new Error('Onboarding assembly disposed'); running = true; wake(); },
    stop() { stopped = true; running = false; lifetime.abort(); if (timer) clearTimeout(timer); timer = undefined; },
    async idle() { if (pending) await pending; },
  };
}
