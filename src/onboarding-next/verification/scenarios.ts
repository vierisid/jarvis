import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { initWorkflowDb, getWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../../workflows/db';
import { configureWorkflowReadiness } from '../../workflows/db/repos/flow-readiness';
import { sampleCatalog } from '../../workflows/runtime/test-fixtures';
import { getUserProfile } from '../../vault/user-profile';
import { containedFile, loadProvider, ROOT } from './discovery';
import { CORE, FULL, PROVIDERS, TASKS } from './matrix';

/** Real providers, SQLite, composer and readiness. Only leaf inference, account,
 * setup-service and room observations are deterministic fixtures. Never registered. */
export async function scenario(id: string, directory: string, root = ROOT) {
  const full = id.startsWith('journey/'), task = TASKS.find(t => id.includes(t.id)) ?? TASKS[0];
  const mode = id.split('/').at(-1)!;
  const modules: Record<string, any> = {};
  for (const owner of full ? FULL.filter(v => v !== 'ON-B-11') : CORE) modules[owner] = await loadProvider(owner, root);
  const owner = { actorId: 'verification-owner', projectId: DEFAULT_IDS.project };
  const dbPath = resolve(directory, 'fixture.sqlite'), catalog = sampleCatalog();
  let now = Date.now(), calls = 0, networkAttempts = 0, authorized = true, foreign = false, injected = false;
  let draftStore: any, buildStore: any, journey: any, intent: any, draft: any, build: any, result: any;
  const trace: { step: string; observation: unknown }[] = [];
  const record = (step: string, observation: unknown) => { trace.push({ step, observation }); };
  const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket;
  globalThis.fetch = Object.assign(async () => { networkAttempts++; throw Error('No network in deterministic verification'); }, { preconnect: originalFetch.preconnect });
  globalThis.WebSocket = class { constructor() { networkAttempts++; throw Error('No sockets in deterministic verification'); } } as never;
  const scope = () => authorized ? foreign ? { ...owner, actorId: 'verification-other' } : owner : null;
  const ready = (value: any) => { assert.equal(value.availability, 'ready', JSON.stringify(value)); return value; };
  const snapshot = async () => ready(await journey.read()).snapshot;
  let setup: any, google: any, interview: any, tour: any, http: ((operation: string, input: any) => Promise<any>) | undefined;
  async function transition(command: any, internal = false) {
    const s = await snapshot(), input = { journeyId: s.journeyId, expectedRevision: s.revision, requestId: crypto.randomUUID(), command };
    const r = internal ? await journey.acknowledge(input) : http ? await http('journey.transition', input) : await journey.transition(input);
    return ready(r).snapshot;
  }
  function bind() {
    const db = getWorkflowDb();
    draftStore = modules['ON-B-09'].createSqliteDraftStore(db);
    buildStore = modules['ON-B-08'].createSqliteBuildStore(db, { now: () => now });
    const reader = modules['ON-B-10'].createSqliteResultReader(db);
    journey = modules['ON-B-01'].createJourneyProvider({ authorize: scope,
      persistence: modules['ON-B-01'].createSettingsJourneyPersistence({ databaseForScope: () => db,
        readLegacy: () => ({ setup_completed: !full, setup_skipped_profile: false, profile_completed: !full, tutorial_completed: false, tutorial_dismissed: false, tutorial_progress_step: null }) }),
      validateFinish: modules['ON-B-10'].createDraftCompletionGuard({ reader, readJob: (s: any, jobId: string) => buildStore.result(s, jobId) }),
    });
    intent = modules['ON-B-07'].createActivationIntentProvider({ enabled: true, authorize: scope, servicesFor: () => ({ id: 'fixture-intent',
      access: async () => 'ready', resolve: async () => ({ availability: 'unavailable' }), assess: async () => ({ schemaVersion: 1,
        issues: mode === 'missing' ? [{ id: 'prerequisite', kind: task.missing, code: task.missing === 'connection' ? 'missing_connection' : 'missing_context', label: 'Supply the prerequisite', message: 'Explicit input is required.', blocking: true }] : [] }),
    }) });
    draft = modules['ON-B-09'].createComposeDraftProvider({ enabled: true, authorize: scope, servicesFor: () => ({ id: 'fixture-draft', store: draftStore,
      access: async () => true, validate: (s: unknown) => intent.validate(null, s), resolveContext: async () => ({}),
      composer: () => ({ pieceRegistry: catalog, maxAttempts: 1, llm: { chat: async () => {
        calls++; if (mode === 'model-failure') throw Error('Deliberate model fixture failure');
        return { text: JSON.stringify({ displayName: task.title, trigger: { name: 'trigger', type: 'EMPTY', nextAction: {
          name: 'draft', type: 'PIECE', settings: { pieceName: mode === 'unsupported-node' ? 'nonexistent-piece' : 'jarvis-ask', actionName: 'ask', input: { prompt: task.prompt } },
        } } }) };
      } } }),
    }) });
    const buildServices = { id: 'fixture-build', store: buildStore, journey, access: async () => true,
      validate: (s: unknown) => intent.validate(null, s), draft: { reconcile: (i: unknown) => draft.reconcile(null, i), compose: async (i: any, control: any) => {
        const ref = { schemaVersion: 1, requestId: i.submission.request.requestId };
        if (mode === 'cancel-before-save') await build.cancel(null, ref);
        if (mode === 'timeout') now += 130000;
        const r = await draft.compose(null, i, control);
        if (mode === 'cancel-after-save') await build.cancel(null, ref);
        if (mode === 'crash-after-save' && !injected) {
          injected = true;
          getWorkflowDb().exec("CREATE TRIGGER verification_crash BEFORE UPDATE ON onboarding_build_job BEGIN SELECT RAISE(ABORT, 'simulated lost worker'); END");
        }
        return r;
      } },
    };
    build = modules['ON-B-08'].createBuildJobsProvider({ enabled: true, authorize: scope, servicesFor: () => buildServices });
    const services = { id: 'fixture-result', access: async () => true, reader, journey, build: { read: (i: unknown) => build.read(null, i) } };
    result = modules['ON-B-10'].createDraftResultProvider({ enabled: true, authorize: scope, servicesFor: () => services });
  }
  const reopen = async () => {
    const before = await snapshot(); closeWorkflowDb(); initWorkflowDb(dbPath); configureWorkflowReadiness({ pieces: catalog }); bind();
    assert.deepEqual(await snapshot(), before); record('refresh', { stepId: before.stepId, revision: before.revision });
  };
  async function bindFull() {
    const setupState = () => JSON.parse((getWorkflowDb().query("SELECT value FROM settings WHERE key='verification.setup'").get() as any).value);
    let running = false;
    setup = modules['ON-B-02'].createSetupProvider({ authorize: scope, store: {
      read: setupState, completeHosted: () => { const value = setupState(); value.completedAt ??= 42;
        getWorkflowDb().run("UPDATE settings SET value=? WHERE key='verification.setup'", [JSON.stringify(value)]); return value.completedAt; },
    }, services: { read: async () => running ? 'running' : 'stopped', start: async () => { running = true; } } });
    google = modules['ON-B-03'].createGoogleProvider({ authorize: scope, resolve: () => ({ id: 'fixture-google', owner,
      installMode: mode === 'self-configured' ? 'self' : 'hosted', hostedConnectUrl: 'https://example.test/never-open',
      readGrant: async () => mode === 'skip-google-interview' ? { state: 'absent' } : { state: 'verified', accountLabel: 'fixture@example.test', scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'] },
    }) });
    let answer = 0;
    const profile = modules['ON-B-05'].createInterviewProfileProvider({ enabled: true, store: modules['ON-B-05'].createCanonicalInterviewProfileStore({ owner, database: getWorkflowDb }) });
    interview = modules['ON-B-04'].createInterviewSessionProvider({ enabled: true, authorize: scope, store: modules['ON-B-04'].createSettingsInterviewStore(getWorkflowDb), profile,
      interviewer: modules['ON-B-05'].createStagedInterviewer({ llmForScope: () => ({ hasConversationTier: () => false, chatTier: async () => ({
        content: answer++ === 0 ? 'What work repeats each week?' : '', model: 'deterministic-fixture', usage: { input_tokens: 0, output_tokens: 0 }, finish_reason: 'stop',
        tool_calls: answer === 1 ? [] : [{ id: 'fact', name: 'record_profile_facts', arguments: { facts: [{ theme: 'work', summary: 'Prepares weekly follow-ups' }] } }, { id: 'wrap', name: 'wrap_interview', arguments: { farewell: 'Thanks.' } }],
      }) }) }),
    });
    tour = modules['ON-B-06'].createTourProvider({ enabled: true, authorize: scope, journeyFor: () => ({ read: () => journey.read(), acknowledge: (i: unknown) => journey.acknowledge(i), transition: (i: unknown) => journey.transition(i) }), roomStatus: () => 'ready' });
    const { createOnboardingRuntime } = await import(await containedFile(root, 'src/onboarding-next/runtime/runtime.ts'));
    const { createOnboardingRoutes, OPERATION_PATHS } = await import(await containedFile(root, 'src/onboarding-next/runtime/routes.ts'));
    const operations: Record<string, (i: any) => Promise<any>> = {
      'journey.read': () => journey.read(), 'journey.transition': i => journey.transition(i),
      'setup.read': () => setup.read(null), 'setup.complete': i => setup.complete(null, i),
      'google.read': () => google.read(null), 'google.begin': () => google.begin(null),
      'google.cancel': i => google.cancel(null, i), 'google.callback': i => google.callback(null, i),
      'interview.command': i => interview.request(null, i), 'tour.command': i => tour.request(null, i),
      'intent.validate': i => intent.validate(null, i), 'build.submit': i => build.submit(null, i),
      'build.read': i => build.read(null, i), 'build.cancel': i => build.cancel(null, i), 'result.read': i => result.read(null, i),
    };
    const definitions = PROVIDERS.filter(p => p[0] !== 'ON-B-12');
    const runtime = createOnboardingRuntime({ enabled: true, authorize: scope, installMode: () => mode === 'self-configured' ? 'self' : 'hosted',
      // Explicit synthetic permission for an isolated in-process route fixture only.
      candidate: { frontend: 'fixture', backend: 'fixture', sidecar: 'fixture' }, authorizeRelease: async () => true,
      modules: definitions.map(([id, , capability, requires]) => ({ manifest: { schemaVersion: 1, id, kind: 'provider', entry: './index.ts', provides: [capability], requires: [...requires] }, load: async () => modules[id] })),
      bindings: Object.fromEntries(definitions.map(([, , capability]) => [capability, () => ({ probe: () => ({ ready: true, reason: 'ready' }), operations: Object.fromEntries(Object.entries(operations).map(([name, fn]) => [name, (i: any) => fn(i)])) })])),
    });
    const routes = createOnboardingRoutes(runtime);
    http = async (operation, input) => {
      const path = '/api/onboarding-next/v1' + OPERATION_PATHS[operation];
      const response = await routes[path].POST(new Request(`http://fixture.invalid${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, input }) }));
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).result;
    };
  }
  try {
    initWorkflowDb(dbPath); configureWorkflowReadiness({ pieces: catalog });
    modules['ON-B-09'].initializeComposeDraftStore(getWorkflowDb()); modules['ON-B-08'].initializeBuildJobStore(getWorkflowDb()); bind();
    if (full) {
      getWorkflowDb().run("INSERT INTO settings(key,value,updated_at) VALUES('verification.setup',?,0)", [JSON.stringify({ installMode: mode === 'self-configured' ? 'self' : 'hosted', configured: true, completedAt: mode === 'self-configured' ? 42 : null })]);
      await bindFull(); assert.equal((await snapshot()).stepId, 'welcome'); await reopen();
      await transition({ type: 'navigate', stepId: 'explain' });
      assert.equal((await http!('setup.complete', { action: 'complete_setup' })).ready, true);
      await transition({ type: 'setup_completed' }, true); await reopen();
      await transition({ type: 'navigate', stepId: 'google' });
      await reopen();
      const connection = await http!('google.read', {}); assert.equal(connection.connection.state, mode === 'skip-google-interview' ? 'idle' : 'connected');
      await transition({ type: 'navigate', stepId: 'interview' });
      await reopen();
      let completed;
      if (mode === 'skip-google-interview') completed = await http!('interview.command', { type: 'skip', sessionId: null });
      else { const opened = await http!('interview.command', { type: 'start' }); assert.equal(opened.snapshot.phase, 'ready');
        await reopen(); const resumed = await http!('interview.command', { type: 'read', sessionId: opened.snapshot.sessionId });
        assert.equal(resumed.snapshot.turnId, opened.snapshot.turnId);
        completed = await http!('interview.command', { type: 'answer', sessionId: opened.snapshot.sessionId, turnId: opened.snapshot.turnId, clientRequestId: 'answer-1', text: 'I prepare weekly follow-ups. Please wrap up.' }); }
      assert.equal(completed.snapshot.phase, mode === 'skip-google-interview' ? 'skipped' : 'done');
      assert.equal(getUserProfile()?.interview_facts?.length ?? 0, mode === 'skip-google-interview' ? 0 : 1);
      await transition({ type: 'interview_finished', state: completed.snapshot.phase }, true);
      await transition({ type: 'navigate', stepId: 'tour' }); await reopen();
      for (const step of modules['ON-B-06'].TOUR_STEPS) {
        const s = ready(await http!('tour.command', { type: 'read' })).snapshot; assert.equal(s.stepId, step);
        ready(await http!('tour.command', { type: 'navigate', sessionId: s.sessionId, revision: s.revision, requestId: crypto.randomUUID(), from: s.stepId, action: step === 'pebble' ? 'finish' : 'next' }));
        await reopen();
      }
      assert.equal((await snapshot()).stepId, 'activation'); assert.equal((await snapshot()).completion, 'active');
      if (mode === 'tour-replay') {
        const before = getUserProfile(), s = ready(await http!('tour.command', { type: 'read' })).snapshot;
        const replay = ready(await http!('tour.command', { type: 'replay', sessionId: s.sessionId, revision: s.revision, requestId: 'replay' })).snapshot;
        assert.equal(replay.stepId, 'today');
        ready(await http!('tour.command', { type: 'navigate', sessionId: replay.sessionId, revision: replay.revision, requestId: 'skip-replay', from: replay.stepId, action: 'skip' }));
        assert.deepEqual(getUserProfile(), before); assert.equal((await snapshot()).stepId, 'activation');
      }
      record('full-provider-path', { setup: 'persisted', connection: connection.connection.state, interview: completed.snapshot.phase, tour: 'done', transport: 'actual B11 in-process HTTP; fixture auth/services' });
      if (mode === 'explore-first') { await transition({ type: 'explore' }); assert.equal((await snapshot()).completion, 'explored'); }
    } else await transition({ type: 'tour_finished', state: 'done' }, true);
    if (mode !== 'explore-first') {
      const submission = { action: 'create', request: { schemaVersion: 1, intentVersion: 1, requestId: 'verification-request', prompt: task.prompt, contextRefs: [] }, answers: {} };
      const checked = await intent.validate(null, submission);
      if (mode === 'missing') {
        assert.equal(checked.state, 'needs_input'); assert.equal(checked.intent, null); assert.equal(checked.issues[0].kind, task.missing);
        assert.notEqual((await build.submit(null, { schemaVersion: 1, journeyId: (await snapshot()).journeyId, intentId: 'unqualified', submission })).availability, 'ready');
        assert.equal(calls, 0); record('truthful-missing-prerequisite', { state: checked.state, kind: checked.issues[0].kind });
      } else {
        assert.equal(checked.state, 'ready'); const input = { schemaVersion: 1, journeyId: (await snapshot()).journeyId, intentId: checked.intent.intentId, submission };
        const accepted = ready(await (http ? http('build.submit', input) : build.submit(null, input))); const ref = { schemaVersion: 1, jobId: accepted.status.jobId };
        if (mode === 'double-submit') { const retry = await Promise.all([build.submit(null, input), build.submit(null, structuredClone(input))]); assert.ok(retry.every(r => r.status.jobId === ref.jobId)); }
        if (mode === 'changed-body') { const changed = structuredClone(input); changed.submission.request.prompt += ' Changed'; assert.equal((await build.submit(null, changed)).reason, 'conflict'); }
        if (mode === 'lost-acceptance') { await reopen(); assert.equal(ready(await build.read(null, { schemaVersion: 1, requestId: submission.request.requestId })).status.jobId, ref.jobId); }
        if (mode === 'crash-before-save') { assert.ok(buildStore.claim(owner, ref.jobId, 30000, 120000)); await reopen(); now += 30001; }
        await build.run(null, ref);
        if (mode === 'crash-after-save') getWorkflowDb().exec('DROP TRIGGER verification_crash');
        await reopen(); now += 30001; await build.run(null, ref);
        const observed = ready(await build.read(null, ref)); record('reconciled-job', observed.status);
        const noDraft = ['cancel-before-save', 'model-failure', 'timeout', 'unsupported-node'].includes(mode);
        if (noDraft) {
          assert.ok(['cancelled', 'failed', 'needs_input'].includes(observed.status.outcome), JSON.stringify(observed.status));
          assert.equal(observed.status.resolution, 'none'); assert.equal((await result.read(null, ref)).state, 'no_draft');
        } else {
          const saved = ready(await (http ? http('result.read', ref) : result.read(null, ref))); assert.equal(saved.state, 'saved');
          assert.equal(saved.graph.nextAction.settings.input.prompt, task.prompt);
          assert.deepEqual((await result.read(null, saved.recovery.input)).reference, saved.reference);
          assert.equal((await build.submit(null, input)).status.jobId, ref.jobId); assert.equal(calls, 1);
          if (mode === 'foreign-owner') {
            foreign = true; assert.deepEqual(await result.read(null, ref), { availability: 'unavailable', reason: 'not_found' }); foreign = false;
            authorized = false; assert.equal((await result.read(null, ref)).reason, 'unauthorized'); authorized = true;
          }
          if (mode === 'finish-recheck') {
            getWorkflowDb().run("UPDATE flow SET status='ENABLED' WHERE id=?", [saved.flowId]);
            assert.equal((await journey.transition(saved.continuation.input)).reason, 'result_unavailable');
            getWorkflowDb().run("UPDATE flow SET status='DISABLED' WHERE id=?", [saved.flowId]);
          }
          if (mode === 'deleted-result') { getWorkflowDb().run('DELETE FROM flow WHERE id=?', [saved.flowId]); assert.equal((await result.read(null, ref)).reason, 'artifact_unavailable'); }
          else { assert.ok(saved.continuation); ready(await journey.transition(saved.continuation.input)); assert.equal((await snapshot()).completion, 'completed'); }
          record('exact-disabled-result', { jobId: ref.jobId, flowId: saved.flowId, versionId: saved.versionId, graph: saved.graph, reference: saved.reference });
        }
      }
    }
    const flows: any[] = getWorkflowDb().query('SELECT id,status,published_version_id FROM flow').all();
    const empty = ['missing', 'cancel-before-save', 'model-failure', 'timeout', 'unsupported-node', 'deleted-result', 'explore-first'].includes(mode);
    assert.equal(flows.length, empty ? 0 : 1); assert.ok(flows.every(f => f.status === 'DISABLED' && f.published_version_id === null));
    const runs = getWorkflowDb().query('SELECT id FROM flow_run').all(); assert.equal(runs.length, 0); assert.equal(networkAttempts, 0);
    if (mode === 'missing') assert.equal(getWorkflowDb().query('SELECT id FROM onboarding_build_job').all().length, 0);
    record('persisted-safety', { flows, runs: runs.length, networkAttempts, fixtureModelCalls: calls });
    // Export a closed, standalone snapshot. The working WAL may checkpoint again
    // when prepared statements are finalized at process exit.
    getWorkflowDb().run('VACUUM INTO ?', [resolve(directory, 'saved.sqlite')]);
    return { trace, database: 'saved.sqlite', leafServices: 'deterministic fixtures; no live Google/model/device', externalEffects: 0 };
  } finally { closeWorkflowDb(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; }
}
