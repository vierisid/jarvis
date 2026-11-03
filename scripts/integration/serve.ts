/** Loopback integration assembly. Canonical stores, routes and controllers;
 * deterministic model replies and no external Google/device/service effects.
 * Run only with an explicit new HOME and LOCAL_INTEGRATION_DIR. */
import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import html from '../../ui/local-integration.html';
import { initWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../../src/workflows/db';
import { DEFAULT_CONFIG } from '../../src/config/types';
import { createApiRoutes, setCorsOrigin, type ApiContext } from '../../src/daemon/api-routes';
import { configureHostedDashboard } from '../../src/daemon/hosted-dashboard';
import { createWorkflowRoutes } from '../../src/workflows/api/routes';
import { createOnboardingAssembly } from '../../src/onboarding-next/runtime/assembly';
import { createOnboardingRuntime } from '../../src/onboarding-next/runtime/runtime';
import { runtimeModules } from '../../src/onboarding-next/runtime/generated/catalog';
import { createStagedInterviewer } from '../../src/onboarding-next/interview-profile';
import { LLMManager } from '../../src/llm/manager';
import { AgentOrchestrator } from '../../src/agents/orchestrator';
import { PreparedOpportunities } from '../../src/awareness/prepared-opportunities';
import { OpportunityActivation } from '../../src/brief/opportunity-activation';
import { loadPreparedQualityGate } from '../../src/awareness/prepared-quality-adapter';
import { buildEngineBundle } from '../../src/workflows/runner/engine-runtime/build';
import { buildAllJarvisPieces } from '../../src/workflows/runner/engine-runtime/build-pieces';
import { TriggerManager } from '../../src/workflows/runner/triggers/manager';
import { WorkflowEventBus } from '../../src/workflows/runtime/event-bus';
import { SandboxApi } from '../../src/workflows/sandbox-api/server';
import { CredentialResolver } from '../../src/workflows/credentials/adapter';
import { EngineRuntime } from '../../src/workflows/runner/engine-runtime/engine-runtime';
import { EngineFlowExecutor } from '../../src/workflows/runner/engine-runtime/engine-flow-executor';
import { Worker } from '../../src/workflows/queue/worker';
import { createRunFlowHandler } from '../../src/workflows/runner/handler';
import { publishFlowVersion } from '../../src/workflows/db/repos/flow-publication';
import { PieceCatalog, metadataToCatalogEntry } from '../../src/workflows/runtime/piece-catalog';
import { seedOpportunity } from './opportunity-fixture';
import { sampleCatalog } from '../../src/workflows/runtime/test-fixtures';
import { configureWorkflowReadiness } from '../../src/workflows/db/repos/flow-readiness';
import { PanelSessionStore, PANEL_SESSION_COOKIE } from '../../src/sidecar/panel-sessions';
import { getCookie } from '../../src/util/cookie';
import { BriefCapabilities, type BriefRegistration } from '../../src/brief/capabilities';
import { BriefConversationProvider } from '../../src/brief/conversations';
import { BriefChatTransport } from '../../src/brief/chat-transport';
import { BriefAttachmentProvider } from '../../src/brief/attachments';
import { BriefCompositionProvider } from '../../src/brief/composition';
import { GoalMeasurements } from '../../src/brief/goal-measurements';
import { Outcomes } from '../../src/brief/outcomes';
import { MemoryStream } from '../../src/brief/memory-stream';
import { MemoryUsageLedger } from '../../src/vault/memory-usage';
import { MemoryForget } from '../../src/brief/memory-forget';
import { WorkflowContext } from '../../src/brief/workflow-context';
import { WorkflowRemoval } from '../../src/brief/workflow-removal';
import { ConnectedWorkspace } from '../../src/brief/connected-workspace';
import { ProfileSettings } from '../../src/brief/profile-settings';
import { DecisionQueue } from '../../src/brief/decisions';
import { DecisionDocuments } from '../../src/brief/decision-documents';
import { documentFactBindings } from '../../src/brief/decision-document-bindings';
import { Recommendations } from '../../src/brief/recommendations';
import { nextActionPlanner } from '../../src/brief/recommendation-planner';
import { ApprovalManager } from '../../src/authority/approval';
import { DeferredExecutor } from '../../src/authority/deferred-executor';
import { AuditTrail } from '../../src/authority/audit';
import { AuthorityEngine } from '../../src/authority/engine';
import { EmergencyController, setActiveEmergencyController } from '../../src/authority/emergency';
import { ToolRegistry } from '../../src/actions/tools/registry';
import { createGoal } from '../../src/vault/goals';
import { createEntity } from '../../src/vault/entities';
import { createFact } from '../../src/vault/facts';
import { createWorkItem } from '../../src/goals/work-items';
import { createFlow } from '../../src/workflows/db/repos/flow';
import { createDraftVersion } from '../../src/workflows/db/repos/flow-version';
import { saveUserSection, loadUserSection } from '../../src/daemon/user-settings';
import { registerChatState } from '../../src/brief/registrations/chat-state';
import { registerNavigationCompatibility } from '../../src/brief/registrations/navigation-compatibility';
import { registerReconciliation } from '../../src/brief/registrations/reconciliation';
import { registerOnboarding } from '../../src/brief/registrations/onboarding';

const supplied = process.env.LOCAL_INTEGRATION_DIR;
if (!supplied || !process.env.HOME || resolve(process.env.HOME) !== join(resolve(supplied), 'home')) throw Error('Use a dedicated integration HOME');
const directory = resolve(supplied); mkdirSync(directory, { recursive: true }); mkdirSync(join(directory, 'home'), { recursive: true });
// Exercises the normal, prebuilt production entry against isolated real routes.
// Hosted identity and model replies are synthetic; this is not fleet acceptance.
const hostedUi = process.env.LOCAL_INTEGRATION_UI === 'hosted';
const productionUi = resolve(import.meta.dir, '../../ui/dist');
if (hostedUi && !existsSync(join(productionUi, 'index.html'))) throw Error('Run bun run build:ui first');
process.env.JARVIS_HOME = join(directory, 'home', '.jarvis');
process.env.JARVIS_SECRETS_DIR = join(directory, 'secrets');
for (const key of ['PROFILE_SETTINGS', 'WORKFLOW_REMOVAL']) process.env[`JARVIS_BRIEF_${key}`] = '1';
// Defense against an accidental new external request in a tested path.
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: any, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('External network disabled in local integration');
  return nativeFetch(input, init);
}, { preconnect: nativeFetch.preconnect }) as typeof fetch;
const port = Number(process.env.LOCAL_INTEGRATION_PORT ?? 3198), origin = `http://localhost:${port}`;
setCorsOrigin(origin);
initWorkflowDb(join(directory, 'vault.sqlite'));
const db = getWorkflowDb(), config = structuredClone(DEFAULT_CONFIG), catalog = new PieceCatalog(sampleCatalog().list().map(entry => ({ ...entry, name: '@jarvispieces/piece-' + entry.name })));
if (hostedUi) { config.daemon.listen = 'unix:/synthetic/hosted.sock'; configureHostedDashboard(config); }
config.daemon.port = port;
config.onboarding = { setup_completed_at: 42, tutorial_completed_at: null };
configureWorkflowReadiness({ pieces: catalog });
const sessions = new PanelSessionStore(), bootstrap = crypto.randomUUID();
writeFileSync(join(directory, 'bootstrap-url.txt'), `${origin}/__local/session/${bootstrap}`, { mode: 0o600 });
const authorize = (request: Request) => sessions.get(getCookie(request, PANEL_SESSION_COOKIE) ?? '') ? { actorId: DEFAULT_IDS.user, projectId: DEFAULT_IDS.project } : null;
let modelCalls = 0;
const llm = new LLMManager();
llm.registerProvider({ name: 'local-deterministic', async chat() { modelCalls++; return { content: 'What repeats each week?', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'local', finish_reason: 'stop' }; },
  async *stream() { yield { type: 'text', text: 'Local integration reply.' } as const; }, async listModels() { return ['local']; } });
llm.setTierMap({ medium: { provider: 'local-deterministic', model: 'local' } });
const compose = { pieceRegistry: catalog, maxAttempts: 1, llm: { async chat() { modelCalls++; return { text: JSON.stringify({ displayName: 'Weekly brief', trigger: { name: 'trigger', type: 'EMPTY',
  nextAction: { name: 'draft', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-ask', actionName: 'ask', input: { prompt: 'Prepare a weekly brief.' } } } } }) }; } } };
const composition = new BriefCompositionProvider(db); composition.configure(() => compose);
const conversations = new BriefConversationProvider(db);
const chat = new BriefChatTransport({ db, send: (socket, frame) => socket.send(JSON.stringify(frame)), runner: { ready: () => true,
  stream(input) { return { onComplete: async () => {}, stream: (async function* () { modelCalls++; input.signal.throwIfAborted();
    yield { type: 'text', text: `Local reply: ${input.text}` } as const;
    yield { type: 'done', response: { content: `Local reply: ${input.text}`, tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'local', finish_reason: 'stop' } } as const;
  })() }; } } });
const attachments = new BriefAttachmentProvider(db), goals = new GoalMeasurements(db), outcomes = new Outcomes(db), usage = new MemoryUsageLedger(db, () => true); usage.start();
const forget = new MemoryForget(db, () => true), memory = new MemoryStream(db, usage, forget, () => true), context = new WorkflowContext(db, DEFAULT_IDS.project, () => true);
const removal = new WorkflowRemoval(db); removal.start({ refresh: async () => {} });
const profile = new ProfileSettings(config); // No TTS service: the real provider reports restart_required.
const connections = new ConnectedWorkspace(db, { devices: () => [], google: () => ({ mode: 'none', authenticated: false, reconnect: false, canSetup: false }), channels: () => ({}), pieces: () => catalog, hosted: () => hostedUi }, DEFAULT_IDS.project, DEFAULT_IDS.user, () => true);
const approvalManager = new ApprovalManager(), audit = new AuditTrail(), deferred = new DeferredExecutor(approvalManager, audit);
deferred.setToolRegistry(new ToolRegistry());
const authority = new AuthorityEngine({ default_level: config.authority.default_level, governed_categories: [], overrides: [], context_rules: [], learning: { ...config.authority.learning }, emergency_state: 'normal' }), emergency = new EmergencyController(); setActiveEmergencyController(emergency);
const bundle = await buildEngineBundle(); await buildAllJarvisPieces();
process.env.JARVIS_WORKFLOW_DATA_DIR = directory;
const sandbox = new SandboxApi({ services: { credentialResolver: new CredentialResolver(), llmChat: async request => {
  modelCalls++; return { text: `Local workflow reply: ${request.prompt}` };
} } });
await sandbox.start({ port: 0 });
const engine = new EngineRuntime({ api: sandbox, bundlePath: bundle.bundlePath, expectedDigest: bundle.digest });
const metadata = await engine.acquire({ runId: 'local-metadata', projectId: DEFAULT_IDS.project });
try { catalog.upsert(metadataToCatalogEntry(await metadata.extractPieceMetadata({ pieceName: '@jarvispieces/piece-jarvis-test', pieceVersion: '0.0.1' }))); }
finally { await metadata.release(); }
const workflowWorker = new Worker({ handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(engine) }) }, pollIntervalMs: 100, log: () => {} });
workflowWorker.start();
if (!existsSync(join(directory, 'echo-seeded'))) {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Local engine echo', trigger: { name: 'trigger', type: 'EMPTY', nextAction: {
    name: 'echo', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-test', pieceVersion: '0.0.1', actionName: 'echo', input: { value: { message: 'Local integration echo' } } },
  } } });
  publishFlowVersion(flow.id, version.id); writeFileSync(join(directory, 'echo-seeded'), flow.id);
}
const quality = await loadPreparedQualityGate({ authority, tool: () => null, targets: () => [] }, bundle.bundlePath, bundle.digest);
if (!quality) throw Error('Local Q13 qualifier is unavailable');
const prepared = new PreparedOpportunities(db), activation = new OpportunityActivation(db);
prepared.configure(() => ({ pieceRegistry: catalog, llm: { async chat() { modelCalls++; return { text: JSON.stringify({ displayName: 'Local invoice review',
  trigger: { name: 'trigger', type: 'EMPTY', nextAction: { name: 'report', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-notify', actionName: 'notify', input: { message: 'Draft report', channels: ['dashboard'] } } } } }) }; } } }), quality);
const triggers = new TriggerManager({ eventBus: new WorkflowEventBus(), log: () => {} });
activation.configure(prepared, triggers);
const decisionDeps = { approvalManager, deferredExecutor: deferred }, decisions = new DecisionQueue(db, decisionDeps), documents = new DecisionDocuments(db, decisions, decisionDeps, documentFactBindings()), recommendations = new Recommendations(db, decisions, nextActionPlanner());
const providers = { preparedOpportunities: prepared, opportunityActivation: activation, conversations, chatTransport: chat, chatAttachments: attachments, chatProgress: chat, workflowComposition: composition, compositionIngredients: composition,
  decisions, decisionEdits: documents, recommendations, goalMeasurements: goals, outcomes, memoryStream: memory, memoryUsage: usage, memoryForget: forget, workflowContext: context, workflowRemoval: removal, connections, profileSettings: profile };
const registrations: BriefRegistration[] = [ ...Object.entries(providers).map(([id, provider]) => ({ id, provider }) as BriefRegistration), ...registerChatState(conversations, chat),
  ...registerNavigationCompatibility(() => ({ destinations: true, guardedNavigation: true, roomIntents: true, notificationsOutsideChat: true })),
  ...registerReconciliation(() => ({ snapshots: true, sharedSocket: true, identityLifecycle: true })),
  ...registerOnboarding(() => ({ targets: true, progress: true, draftHandoff: true })) ];
const capabilities = new BriefCapabilities(registrations, registrations.map(r => r.id));
const assembly = createOnboardingAssembly({ owner: { actorId: DEFAULT_IDS.user, projectId: DEFAULT_IDS.project }, database: db, authorize,
  readLegacy: () => ({ setup_completed: false, setup_skipped_profile: false, profile_completed: false, tutorial_completed: false, tutorial_dismissed: false, tutorial_progress_step: null }),
  setup: { store: { read: () => ({ installMode: 'self', configured: true, completedAt: 42 }), completeHosted: () => 42 }, services: { read: async () => 'running', start: async () => {} } },
  google: () => ({ id: 'local-google-unconnected', owner: { actorId: DEFAULT_IDS.user, projectId: DEFAULT_IDS.project }, installMode: 'self', readGrant: async () => ({ state: 'absent' }) }),
  interviewer: createStagedInterviewer({ llmForScope: () => llm }), intent: () => ({ id: 'local-intent', access: async () => 'ready', resolve: async () => ({ availability: 'unavailable' }), assess: async () => ({ schemaVersion: 1, issues: [] }) }),
  composer: () => compose, resolveContext: async () => ({}), roomStatus: () => 'ready', ready: () => true, workerIntervalMs: 100 });
assembly.start();
const onboarding = createOnboardingRuntime({ enabled: true, modules: runtimeModules, bindings: assembly.bindings, authorize, installMode: () => 'self', authorizeIntegration: () => true });
const orchestrator = new AgentOrchestrator(); orchestrator.setLLMManager(llm);
const ctx = { config, daemonStartedAt: Date.now(), healthMonitor: { getHealth: () => ({ status: 'healthy' }) },
  agentService: { getLLMManager: () => llm, getOrchestrator: () => orchestrator, getTaskManager: () => null },
  sidecarManager: { resolvePanelSession: (id: string) => sessions.get(id), getSidecars: () => [], getAllSidecars: () => [], listSidecars: () => [] },
  approvalManager, deferredExecutor: deferred, authorityEngine: authority, auditTrail: audit, emergencyController: emergency,
  wsService: { broadcastApprovalUpdate: () => {}, broadcast: () => {} },
  briefPreparedOpportunities: prepared, briefOpportunityActivation: activation, briefCapabilities: capabilities, briefConversations: conversations, briefAttachments: attachments, briefWorkflowComposition: composition,
  briefDecisions: decisions, briefDecisionDocuments: documents, briefRecommendations: recommendations, briefGoalMeasurements: goals, briefOutcomes: outcomes,
  briefMemoryStream: memory, briefMemoryUsage: usage, briefMemoryForget: forget, briefWorkflowRemoval: removal, briefWorkflowContext: context, briefConnections: connections,
  briefProfileSettings: profile, onboardingNext: onboarding } as unknown as ApiContext;
if (!existsSync(join(directory, 'seeded'))) {
  const goal = createGoal('Make weekly planning easier', 'objective', { status: 'active' });
  createGoal('Review the weekly brief', 'key_result', { parent_id: goal.id, status: 'active' });
  createGoal('Finish initial setup', 'objective', { status: 'completed' });
  createFact(createEntity('person', 'Local Owner').id, 'preferred_editor', 'Notepad', { source: 'manual' });
  createWorkItem({ title: 'Review the local integration report', goalId: goal.id });
  const flow = createFlow(); createDraftVersion({ flowId: flow.id, displayName: 'Existing local draft', trigger: { name: 'trigger', type: 'EMPTY' } });
  saveUserSection('onboarding', { setup_completed_at: 42, tutorial_completed_at: hostedUi ? 42 : null,
    ...(hostedUi ? { setup_skipped_profile: true } : {}) });
  writeFileSync(join(directory, 'seeded'), 'Only synthetic local data.');
}
if (!existsSync(join(directory, 'opportunity-seeded'))) { const suggestion = seedOpportunity(); prepared.ensure(suggestion); await prepared.idle(); writeFileSync(join(directory, 'opportunity-seeded'), suggestion); }
if (hostedUi) config.onboarding = loadUserSection('onboarding') as typeof config.onboarding;
const raw = { ...createApiRoutes(ctx), ...createWorkflowRoutes({ pieceRegistry: catalog, briefCapabilities: capabilities, briefWorkflowContext: context, sharedPiecesDir: null }) } as Record<string, Record<string, (req: Request) => Response | Promise<Response>>>;
const routes: Record<string, any> = {};
for (const [path, handlers] of Object.entries(raw)) routes[path] = Object.fromEntries(Object.entries(handlers).map(([method, handle]) => [method, async (req: Request) => {
  if (!authorize(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['GET', 'HEAD'].includes(req.method) && req.headers.get('origin') && req.headers.get('origin') !== origin) return new Response(null, { status: 403 });
  try { return await handle(req); } catch (error) { console.error(path, error); return Response.json({ error: 'Local integration service unavailable' }, { status: 503 }); }
}]));
routes['/__local/session/:key'] = { GET: (req: Request & { params: { key: string } }) => req.params.key === bootstrap
  ? new Response(null, { status: 302, headers: { Location: hostedUi ? '/' : '/?brief=1#/brief/today', 'Set-Cookie': `${PANEL_SESSION_COOKIE}=${sessions.create('local-enrolled-device').id}; HttpOnly; SameSite=Strict; Path=/` } })
  : new Response(null, { status: 404 }) };
const localSockets = new Set<import('bun').ServerWebSocket<{ sessionId: string }>>(), localActionResults: unknown[] = [];
routes['/__local/room-action'] = { POST: (req: Request) => {
  if (!authorize(req) || req.headers.get('origin') !== origin) return new Response(null, { status: 403 });
  const resultId = crypto.randomUUID();
  for (const socket of localSockets) socket.send(JSON.stringify({ type: 'notification', timestamp: Date.now(), payload: {
    source: 'room_action', room: 'settings', action: 'switch_tab', args: { tab: 'llm' }, resultFrom: 'dashboard', resultId, expiresInMs: 10000 } }));
  return Response.json({ resultId });
} };
routes['/__local/state'] = { GET: (req: Request) => authorize(req) ? Response.json({ modelCalls, localActionResults, flows: db.query('SELECT id,status FROM flow').all(), runs: db.query('SELECT id,status FROM flow_run').all(), sockets: server.pendingWebSockets, capabilities: capabilities.snapshot() }) : new Response(null, { status: 401 }) };
routes['/'] = hostedUi ? () => new Response(Bun.file(join(productionUi, 'index.html'))) : html;
const server = Bun.serve<{ sessionId: string }>({ hostname: '127.0.0.1', port, routes, development: false,
  fetch(req, server) {
    const pathname = new URL(req.url).pathname;
    if (hostedUi && req.method === 'GET' && /^\/[\w.-]+\.(js|css|svg)$/.test(pathname))
      return new Response(Bun.file(join(productionUi, pathname.slice(1))));
    if (new URL(req.url).pathname === '/ws' && authorize(req)) {
      const id = getCookie(req, PANEL_SESSION_COOKIE)!;
      if (server.upgrade(req, { data: { sessionId: id } })) return;
    }
    return new Response('Not found', { status: 404 });
  }, websocket: {
    open(socket) { localSockets.add(socket); sessions.socketOpened((socket.data as any).sessionId, socket); },
    async message(socket, raw) { try { const frame = JSON.parse(String(raw)); if (frame.type === 'room_action_result') localActionResults.push(frame.payload); else await chat.handle(frame, socket, capabilities); } catch {} },
    close(socket) { localSockets.delete(socket); chat.detach(socket); sessions.socketClosed((socket.data as any).sessionId, socket); },
  } });
const stop = async () => { await workflowWorker.stop(); await engine.shutdown(); await sandbox.stop(); activation.stop(); await prepared.close(); await activation.idle(); await triggers.stop(); assembly.stop(); composition.stop(); chat.stop(); removal.stop(); await Promise.all([assembly.idle(), composition.idle(), chat.idle()]); server.stop(true); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
console.log(`Local integration listening on ${origin}. Bootstrap URL saved in the isolated data directory.`);
