import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, getWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../../workflows/db';
import { configureWorkflowReadiness } from '../../workflows/db/repos/flow-readiness';
import { sampleCatalog } from '../../workflows/runtime/test-fixtures';
import { createStagedInterviewer } from '../interview-profile';
import type { LLMManager } from '../../llm/manager';
import { createOnboardingAssembly } from './assembly';
import { createOnboardingRuntime } from './runtime';
import { createOnboardingRoutes, OPERATION_PATHS } from './routes';
import { runtimeModules } from './generated/catalog';
import type { Operation } from './contract';
import { findGoals } from '../../vault/goals';
import { ProfileSettings } from '../../brief/profile-settings';
import { DEFAULT_CONFIG } from '../../config/types';

let assembly: ReturnType<typeof createOnboardingAssembly>;
let routes: ReturnType<typeof createOnboardingRoutes>;
let interviewReply: (() => Promise<any>) | undefined;
let modelCalls = 0, connected = true, setupCompleted: number | null = null;
let planSignals: AbortSignal[] = [], planHang = false;
const owner = { actorId: DEFAULT_IDS.user, projectId: DEFAULT_IDS.project };
const authorize = (r: Request) => connected && r.headers.get('cookie') === 'local-test=owner' ? owner : null;
const request = (path: string, body?: unknown, signal?: AbortSignal) => new Request('http://localhost' + path,
  { method: body ? 'POST' : 'GET', signal, headers: { cookie: 'local-test=owner', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
function runtime(integration = true) {
  return createOnboardingRuntime({ enabled: true, modules: runtimeModules, bindings: assembly.bindings,
    authorize, installMode: () => 'self', ...(integration ? { authorizeIntegration: () => true } : {}) });
}
async function call(operation: Operation, input: unknown = {}, signal?: AbortSignal) {
  const path = '/api/onboarding-next/v1' + OPERATION_PATHS[operation];
  const response = await routes[path]!.POST!(request(path, { schemaVersion: 1, input }, signal));
  expect(response.status).toBe(200);
  return (await response.json()).result;
}
async function journey() { const r = await call('journey.read'); expect(r.availability).toBe('ready'); return r.snapshot; }
async function navigate(stepId: string) {
  const j = await journey();
  const r = await call('journey.transition', { journeyId: j.journeyId, expectedRevision: j.revision,
    requestId: crypto.randomUUID(), command: { type: 'navigate', stepId } });
  expect(r.availability).toBe('ready');
}
beforeEach(() => { planSignals = []; planHang = false;
  closeWorkflowDb(); initWorkflowDb(':memory:');
  interviewReply = undefined; modelCalls = 0; connected = true; setupCompleted = 42;
  const catalog = sampleCatalog(); configureWorkflowReadiness({ pieces: catalog });
  assembly = createOnboardingAssembly({ owner, database: getWorkflowDb(), authorize,
    readLegacy: () => ({ setup_completed: false, setup_skipped_profile: false, profile_completed: false,
      tutorial_completed: false, tutorial_dismissed: false, tutorial_progress_step: null }),
    setup: { store: { read: () => ({ installMode: 'self', configured: true, completedAt: setupCompleted }),
      completeHosted: () => setupCompleted ??= 42 }, services: { read: async () => 'running', start: async () => {} } },
    google: () => ({ id: 'isolated-google', owner, installMode: 'self', readGrant: async () => ({ state: 'absent' }) }),
    interviewer: createStagedInterviewer({ llmForScope: () => ({ hasConversationTier: () => false,
      chatTier: async () => interviewReply ? interviewReply() : ({ content: 'What repeats each week?', model: 'isolated-model', usage: { input_tokens: 0, output_tokens: 0 }, finish_reason: 'stop', tool_calls: [] }),
    } as unknown as LLMManager) }),
    intent: () => ({ id: 'isolated-intent', access: async () => 'ready', resolve: async () => ({ availability: 'unavailable' }),
      assess: async () => ({ schemaVersion: 1, issues: [] }) }),
    composer: () => ({ pieceRegistry: catalog, maxAttempts: 1, llm: { chat: async () => {
      modelCalls++; return { text: JSON.stringify({ displayName: 'Weekly brief', trigger: { name: 'trigger', type: 'EMPTY',
        nextAction: { name: 'draft', type: 'PIECE', settings: { pieceName: 'jarvis-ask', actionName: 'ask', input: { prompt: 'Prepare a weekly brief.' } } } } }) };
    } } }),
    planInitialGoal: async (_text, signal) => { planSignals.push(signal);
      // Like chatTier, a hanging model call ends when its signal aborts.
      if (planHang) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return { objective: { title: 'Sales objective', description: 'Grow the brand', success_criteria: '50 orders a month', time_horizon: 'quarterly' },
      key_results: [{ title: '50 monthly orders', description: 'Grow orders', success_criteria: '50 orders in a month' }, { title: 'Weekly sales review', description: 'Review sales', success_criteria: 'Weekly report in use' }],
      milestones: [{ key_result_index: 0, title: 'Establish baseline', description: 'Read current orders' }, { key_result_index: 1, title: 'Prepare report', description: 'Use provided sales totals' }] }; },
    resolveContext: async () => ({}), roomStatus: () => 'ready', ready: () => true, workerIntervalMs: 50,
  });
  assembly.start(); routes = createOnboardingRoutes(runtime());
});
afterEach(async () => { assembly.stop(); await assembly.idle(); closeWorkflowDb(); });

test('complete bindings keep production release closed and identify isolated integration truthfully', async () => {
  const path = '/api/onboarding-next/v1/status';
  const ordinary = await runtime(false).status(request(path));
  expect(ordinary.supported).toBe(true); expect(ordinary.ready).toBe(false);
  expect(ordinary.released).toBe(false); expect(ordinary.reason).toBe('release_blocked');
  const local = await runtime().status(request(path));
  expect(local.ready).toBe(true); expect(local.integration).toBe(true); expect(local.released).toBe(false);
  expect(modelCalls).toBe(0);
});

test('authenticated real routes advance onboarding, dispatch a durable job and hand off one disabled draft', async () => {
  expect((await journey()).stepId).toBe('welcome');
  await navigate('explain');
  expect((await call('setup.complete', { action: 'complete_setup' })).ready).toBe(true);
  expect((await journey()).setupState).toBe('completed');
  await navigate('google'); expect((await call('google.read')).connection.state).toBe('idle');
  await navigate('interview');
  expect((await call('interview.command', { type: 'skip', sessionId: null })).snapshot.phase).toBe('skipped');
  expect((await journey()).interviewState).toBe('skipped');
  await navigate('tour');
  const tour = (await call('tour.command', { type: 'read' })).snapshot;
  expect((await call('tour.command', { type: 'navigate', sessionId: tour.sessionId, revision: tour.revision,
    requestId: crypto.randomUUID(), from: tour.stepId, action: 'skip' })).availability).toBe('ready');
  expect((await journey()).stepId).toBe('activation');
  const submission = { action: 'create', request: { schemaVersion: 1, intentVersion: 1, requestId: 'stable-request',
    prompt: 'Prepare a weekly brief.', contextRefs: [] }, answers: {} };
  const intent = await call('intent.validate', submission); expect(intent.state).toBe('ready');
  const input = { schemaVersion: 1, journeyId: (await journey()).journeyId, intentId: intent.intent.intentId, submission };
  const disconnected = new AbortController();
  const accepted = await call('build.submit', input, disconnected.signal);
  disconnected.abort();
  const replay = await call('build.submit', input); expect(replay.status.jobId).toBe(accepted.status.jobId);
  const ref = { schemaVersion: 1, jobId: accepted.status.jobId };
  let saved;
  for (let i = 0; i < 100; i++) {
    saved = await call('result.read', ref);
    if (saved.state === 'saved') break;
    await Bun.sleep(20);
  }
  expect(saved.state).toBe('saved'); expect(saved.activation).toBe('disabled'); expect(saved.versionState).toBe('DRAFT');
  expect(modelCalls).toBe(1);
  expect(getWorkflowDb().query('SELECT id FROM flow').all()).toHaveLength(1);
  expect(getWorkflowDb().query('SELECT id FROM flow_run').all()).toHaveLength(0);
  expect((await call('journey.transition', saved.continuation.input)).snapshot.completion).toBe('completed');
  expect((await journey()).draft).toEqual({ flowId: saved.flowId, versionId: saved.versionId });
});

test('revoked credentials and client scope injection cannot reach a write', async () => {
  connected = false;
  const path = '/api/onboarding-next/v1/journey/read';
  expect((await routes[path]!.POST!(request(path, { schemaVersion: 1, input: {} }))).status).toBe(401);
  connected = true;
  expect((await routes[path]!.POST!(request(path, { schemaVersion: 1, input: { actorId: 'other' } }))).status).toBe(400);
  expect(getWorkflowDb().query('SELECT id FROM onboarding_build_job').all()).toHaveLength(0);
  expect(modelCalls).toBe(0);
});

// UI controller + live adapters + real authenticated routes/provider stores.
// Only model/Google and render ports are substituted at their declared boundaries.
import { createLiveOnboardingAdapters } from '../../../ui/src/onboarding-next/host/live-adapters';
import { createTransport } from '../../../ui/src/onboarding-next/host/transport';
import { createSession } from '../../../ui/src/onboarding-next/host/session';
import { viewModules } from '../../../ui/src/onboarding-next/host/generated/catalog';
function uiHost(options: { storage?: Map<string, string>; loseSubmit?: boolean; loseAnswer?: 'before' | 'after' } = {}) {
  const values = options.storage ?? new Map<string, string>();
  let loseSubmit = options.loseSubmit ?? false;
  let loseAnswer = options.loseAnswer;
  const transport = createTransport(async (path, init) => {
    const handler = routes[path]?.[init?.method === 'POST' ? 'POST' : 'GET'];
    if (!handler) return new Response('not found', { status: 404 });
    const answer = path.endsWith('/interview/command') && JSON.parse(String(init?.body ?? '{}')).input?.type === 'answer';
    if (answer && loseAnswer === 'before') { loseAnswer = undefined; throw new Error('Connection lost before send'); }
    const response = await handler(new Request('http://localhost' + path, { ...init, headers: { ...init?.headers, cookie: 'local-test=owner' } }));
    if (answer && loseAnswer === 'after') { loseAnswer = undefined; throw new Error('Response lost after answer'); }
    if (loseSubmit && path.endsWith('/build/submit')) { loseSubmit = false; throw new Error('Response lost after durable acceptance'); }
    return response;
  });
  const adapters = createLiveOnboardingAdapters({ transport, available: () => true,
    readInterviewFacts: async () => new ProfileSettings(DEFAULT_CONFIG).profile().interviewFacts ?? [],
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } },
    workspace: () => ({ roomId: 'today', selectedObject: null, theme: 'light', sidebar: 'rail', chat: { open: false, conversationId: null } }),
    tour: { renderer: { isolation: 'fixture-only', renderRoom: () => ({ status: 'ready', content: null }) },
      pebble: { isolation: 'tutorial-sandbox', Surface: () => null } },
    Canvas: () => null, Setup: () => null, openGoogle: () => { throw new Error('External OAuth is outside this test'); },
    openWorkflow: async () => {}, pollMs: 20,
  });
  return createSession({ enabled: true, integration: true, modules: viewModules, transport, adapters });
}
async function settle(host: ReturnType<typeof uiHost>, condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition() && !host.state().busy) return; await Bun.sleep(20); }
  expect(host.state()).toMatchObject({ blocked: false }); expect(condition()).toBe(true);
}
async function toActivation(host: ReturnType<typeof uiHost>) {
  await host.start(); expect(host.state().view).toBe('welcome');
  await host.act(host.key(), 'continue'); expect(host.state().view).toBe('explainer');
  await host.act(host.key(), 'continue'); expect(host.state().view).toBe('legacy-provider-setup');
  await host.act(host.key(), 'complete'); expect(host.state().view).toBe('google');
  await host.act(host.key(), 'skip'); expect(host.state().view).toBe('interview');
  await settle(host, () => !host.state().busy);
  await host.act(host.key(), 'skip'); await settle(host, () => !host.state().busy);
  await host.act(host.key(), 'continue'); expect(host.state().view).toBe('tour');
  const tour = host.state().presentation!.model;
  await host.act(host.key(), 'skip', { action: 'skip', sessionId: tour.sessionId, revision: tour.revision, from: tour.stepId });
  expect(host.state().view).toBe('activation');
}

test('live UI adapters retain request identity after a lost submit response and resume the exact saved draft', async () => {
  const storage = new Map<string, string>(); let host = uiHost({ storage, loseSubmit: true });
  try {
    await toActivation(host);
    host.draft(host.key(), { prompt: 'Prepare a weekly brief.', contextRefs: [], answers: {} });
    const j = host.state().journey!;
    await host.act(host.key(), 'create', { action: 'create', journeyId: j.journeyId, revision: j.revision,
      request: { schemaVersion: 1, intentVersion: 1, requestId: 'ui-stable-request', prompt: 'Prepare a weekly brief.', contextRefs: [] }, answers: {} });
    expect(host.state().blocked).toBe(true);
    expect([...storage.values()].some(v => v.includes('ui-stable-request'))).toBe(true);
    host.dispose(); host = uiHost({ storage }); await host.start();
    await settle(host, () => host.state().view === 'result' || !!(host.state().presentation?.model.result as any)?.reference);
    if (host.state().view === 'build') {
      const m = host.state().presentation!.model;
      await host.act(host.key(), 'open_result', { action: 'open_result', journeyId: j.journeyId, requestId: 'ui-stable-request',
        jobId: m.jobId, commandId: 'open-result', result: (m.result as any).reference });
    }
    expect(host.state().view).toBe('result'); expect(host.state().blocked).toBe(false);
    const saved = host.state().presentation!.model.result as any;
    expect(saved.activation).toBe('disabled'); expect(saved.requestId).toBe('ui-stable-request');
    await host.act(host.key(), 'finish', { action: 'finish', scopeId: saved.scopeId, journeyId: saved.journeyId, jobId: saved.jobId });
    expect(host.state().mode).toBe('complete'); expect(modelCalls).toBe(1);
    expect(getWorkflowDb().query('SELECT id FROM flow').all()).toHaveLength(1);
    expect(getWorkflowDb().query('SELECT id FROM flow_run').all()).toHaveLength(0);
  } finally { host.dispose(); }
});


test('a completed interview reaches the dashboard with Profile context and exactly one goal through real routes', async () => {
  await navigate('explain'); await call('setup.complete', { action: 'complete_setup' });
  await navigate('google'); await navigate('interview');
  const start = await call('interview.command', { type: 'start' });
  const summary = 'Grow the Cornish surf brand to 50 orders per month by December';
  interviewReply = async () => ({ content: '', model: 'isolated-model', usage: { input_tokens: 0, output_tokens: 0 }, finish_reason: 'tool_calls', tool_calls: [
    { id: 'facts', name: 'record_profile_facts', arguments: { facts: [
      { theme: 'work', summary: 'Runs a Cornish surf apparel brand' },
      { theme: 'goals', summary, raw_quote: 'I want 50 orders a month by December.' },
      { theme: 'rhythm', summary: 'Prepare a Friday sales report' },
    ] } },
    { id: 'wrap', name: 'wrap_interview', arguments: { farewell: 'Your context is saved. Continue to the tour.' } },
  ] });
  const finished = await call('interview.command', { type: 'answer', sessionId: start.snapshot.sessionId,
    turnId: start.snapshot.turnId, clientRequestId: 'answer-first', text: 'I run a Cornish surf brand. I want 50 orders a month by December. That is everything for now.' });
  expect(finished.snapshot.phase).toBe('done');
  expect(new ProfileSettings(DEFAULT_CONFIG).profile().interviewFacts).toHaveLength(3);
  expect(findGoals()).toHaveLength(0);
  await navigate('tour'); const tour = (await call('tour.command', { type: 'read' })).snapshot;
  await call('tour.command', { type: 'navigate', sessionId: tour.sessionId, revision: tour.revision,
    requestId: 'skip-tour', from: tour.stepId, action: 'skip' });
  const host = uiHost(); await host.start();
  try {
    const personalized = host.state().presentation!.model.interview as any;
    expect(personalized.goal).toBe(summary);
    expect(personalized.suggestions[0].label).toBe('Prepare a Friday sales report');
    const prompt = personalized.suggestions[0].prompt;
    expect(prompt).toContain(summary); expect(prompt).toContain('Runs a Cornish surf apparel brand');
    host.draft(host.key(), { prompt, contextRefs: [], answers: {} });
    await host.refresh(); expect((host.state().presentation!.model.draft as any).prompt).toBe(prompt);
    const assessed = await call('intent.validate', { action: 'create', request: { schemaVersion: 1, intentVersion: 1,
      requestId: 'personalized-request', prompt, contextRefs: [] }, answers: {} });
    expect(assessed.state).toBe('ready'); expect(assessed.intent.request.prompt).toBe(prompt);
  } finally { host.dispose(); }
  const j = await journey(); const exit = { journeyId: j.journeyId, expectedRevision: j.revision, requestId: 'explore', command: { type: 'explore' } };
  // A client that leaves mid-plan cancels the model call in flight and commits nothing.
  planHang = true; const leave = new AbortController();
  const path = '/api/onboarding-next/v1' + OPERATION_PATHS['journey.transition'];
  const abandoned = routes[path]!.POST!(request(path, { schemaVersion: 1, input: { ...exit, requestId: 'explore-abandoned' } }, leave.signal));
  for (let i = 0; i < 200 && planSignals.length === 0; i++) await new Promise(r => setTimeout(r, 0));
  expect(planSignals).toHaveLength(1); expect(planSignals[0]!.aborted).toBe(false);
  leave.abort();
  expect(planSignals[0]!.aborted).toBe(true);
  expect((await abandoned).status).not.toBe(200);
  expect((await journey()).stepId).toBe('activation'); expect(findGoals()).toHaveLength(0);
  planHang = false; planSignals = [];
  getWorkflowDb().exec("CREATE TRIGGER reject_initial_goal BEFORE INSERT ON goals BEGIN SELECT RAISE(ABORT, 'goal write failed'); END");
  expect((await call('journey.transition', exit)).availability).toBe('unavailable');
  expect((await journey()).stepId).toBe('activation'); expect(findGoals()).toHaveLength(0);
  getWorkflowDb().exec('DROP TRIGGER reject_initial_goal');
  expect((await call('journey.transition', exit)).snapshot.stepId).toBe('exited');
  await call('journey.transition', exit);
  // The planner receives the bounded deadline signal, still live after the plan returned.
  expect(planSignals.length).toBe(1); expect(planSignals[0]).toBeInstanceOf(AbortSignal); expect(planSignals[0]!.aborted).toBe(false);
  expect(findGoals()).toHaveLength(5); expect(findGoals().find(g => g.level === 'objective')).toMatchObject({ title: summary, status: 'active' });
  expect(findGoals().every(g => g.status === 'active')).toBe(true);
  expect((await journey()).completion).toBe('explored');
});


test.each(['before', 'after'] as const)('live interview retry recovers a lost answer %s acceptance without duplicate turns', async loseAnswer => {
  const host = uiHost({ loseAnswer });
  try {
    await host.start(); await host.act(host.key(), 'continue'); await host.act(host.key(), 'continue');
    await host.act(host.key(), 'complete'); await host.act(host.key(), 'skip');
    await settle(host, () => host.state().presentation?.model.phase === 'ready');
    host.draft(host.key(), 'I run a Cornish surf brand.');
    const m = host.state().presentation!.model as any;
    await host.act(host.key(), 'answer', { sessionId: m.sessionId, turnId: m.turnId, ...m.draft });
    await settle(host, () => host.state().presentation?.model.phase === 'error');
    expect((host.state().presentation!.model.draft as any).text).toBe('I run a Cornish surf brand.');
    await host.act(host.key(), 'retry', { kind: 'session' });
    await settle(host, () => host.state().presentation?.model.phase === 'ready');
    const recovered = host.state().presentation!.model as any;
    expect(recovered.draft.text).toBe('');
    expect(recovered.messages.filter((m: any) => m.role === 'user')).toHaveLength(1);
  } finally { host.dispose(); }
});
