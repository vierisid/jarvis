import { AwarenessService } from '../awareness/service';
import type { JarvisConfig } from '../config/types';
import type { LLMManager } from '../llm/manager';
import { BriefCapabilities } from '../brief/capabilities';
import { registerQuietAwareness } from '../brief/registrations/quiet-awareness';
import { createApiRoutes, type ApiContext } from './api-routes';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AwarenessDeliveryPolicy, type AwarenessDeliveryDependencies } from './awareness-delivery-policy';
import type { AwarenessEvent, Suggestion } from '../awareness/types';
import type { WSMessage } from '../comms/websocket';
import { WebSocketService } from './ws-service';
import { WorkflowEventBus } from '../workflows/runtime/event-bus';
import { AWARENESS_EVENT_TYPE_MAP } from '../workflows/runtime/event-types';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '../workflows/db';
import { createFlow, setPublishedVersion, updateFlowStatus } from '../workflows/db/repos/flow';
import { createDraftVersion, lockVersion } from '../workflows/db/repos/flow-version';
import { configureWorkflowReadiness } from '../workflows/db/repos/flow-readiness';
import { sampleCatalog } from '../workflows/runtime/test-fixtures';
import { TriggerManager } from '../workflows/runner/triggers/manager';
import { createCapture, getRecentSuggestions } from '../vault/awareness';
import { getOpportunity, getOpportunityMetrics, refreshOpportunity } from '../awareness/opportunities';
import { OpportunityDelivery } from '../awareness/opportunity-delivery';
import type { ApprovalRequest } from '../authority/approval';

const suggestion: Suggestion = { id: 'opportunity-one', type: 'automation', title: 'Review invoices', body: 'Three observed episodes.', triggerCaptureId: 'capture-one', context: {} };
function fixture(flag: string | undefined = '1', accepted = 1) {
  const messages: WSMessage[] = [], calls = { research: 0, reactor: 0, coalescer: 0, voice: 0, desktop: 0, channels: 0 };
  const eventBus = new WorkflowEventBus();
  const deps: AwarenessDeliveryDependencies = {
    sockets: {
      getServer: () => ({ getClientCount: () => accepted, broadcastWithReceipt: message => { messages.push(message); return accepted; } }),
      broadcastAwarenessEvent: event => { messages.push({ type: 'notification', payload: { source: 'awareness_event', event }, timestamp: event.timestamp }); },
      broadcastNotification: text => { messages.push({ type: 'chat', payload: { text }, timestamp: Date.now() }); },
      broadcastProactiveVoice: async () => { calls.voice++; },
    },
    channels: { getManager: () => ({ listChannels: () => ['telegram'] }),
      broadcastToAll: async () => { calls.channels++; },
      tryBroadcastToChannels: async () => { calls.channels++; return { delivered: ['telegram'], failed: [] }; } },
    desktop: () => { calls.desktop++; return true; },
    reactor: { react: async () => { calls.reactor++; return true; } },
    coalescer: { addEvent: () => { calls.coalescer++; } }, eventBus,
    agent: () => ({ handleMessage: async () => { calls.research++; return 'A synthetic solution long enough to announce.'; }, lastTurnRequestedApproval: () => false }),
  };
  return { policy: new AwarenessDeliveryPolicy(deps, flag), deps, calls, messages, eventBus };
}
function event(type: AwarenessEvent['type']): AwarenessEvent {
  if (type === 'context_changed') return { schemaVersion: 1, type, timestamp: 1234, data: { fromApp: 'Mail', toApp: 'Editor', fromWindow: 'Inbox', toWindow: 'Code' } };
  if (type === 'session_ended') return { schemaVersion: 1, type, timestamp: 1234, data: { sessionId: 'session-one', apps: ['Editor'] } };
  return { type, timestamp: 1234, data: { errorText: 'Synthetic screen error', appName: 'Editor', appCategory: 'code_editor', compositeScore: 0.9,
    ocrPreview: 'Synthetic screen content', title: 'Review this', body: 'A retained suggestion', durationMs: 400000 } };
}
const sourceOf = (message: WSMessage) => (message.payload as { source?: string } | null)?.source;

for (const type of ['error_detected', 'struggle_detected', 'stuck_detected', 'suggestion_ready', 'context_changed'] as const) {
  test(`quiet ${type} preserves its workflow event and card signal without automatic assistance`, async () => {
    const f = fixture(), observed: unknown[] = [], input = event(type);
    f.eventBus.subscribe(AWARENESS_EVENT_TYPE_MAP[type]!, e => { observed.push(e); });
    f.policy.handleEvent(input); await Bun.sleep(0);
    expect(observed).toEqual([{ ...input.data, _timestamp: 1234 }]);
    expect(f.messages).toHaveLength(1); expect(f.messages[0]!.type).toBe('notification');
    expect(f.calls).toEqual({ research: 0, reactor: 0, coalescer: 0, voice: 0, desktop: 0, channels: 0 });
  });
}

for (const accepted of [0, 1]) test(`quiet opportunity transport with ${accepted} accepting sockets never opens chat or falls back to another channel`, async () => {
  const f = fixture('1', accepted);
  expect(await f.policy.deliverOpportunity(suggestion)).toBe(accepted ? 'websocket' : null);
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]).toMatchObject({ type: 'notification', payload: { source: 'awareness_event', event: { type: 'suggestion_ready', data: { id: suggestion.id, opportunityId: suggestion.id } } } });
  expect(f.calls).toEqual({ research: 0, reactor: 0, coalescer: 0, voice: 0, desktop: 0, channels: 0 });
});

test('quiet opportunity event is published once; outbox delivery does not republish it', async () => {
  const f = fixture(), observed: unknown[] = [];
  f.eventBus.subscribe('awareness.suggestion_ready', e => { observed.push(e); });
  f.policy.handleEvent({ type: 'suggestion_ready', data: { id: suggestion.id, opportunityId: suggestion.id }, timestamp: 1234 });
  expect(f.messages).toHaveLength(0);
  await f.policy.deliverOpportunity(suggestion);
  expect(observed).toHaveLength(1); expect(f.messages).toHaveLength(1); expect(f.calls.coalescer).toBe(0);
});

for (const flag of [undefined, '0', 'true', 'yes']) test(`flag ${String(flag)} keeps legacy delivery available for rollback`, async () => {
  const f = fixture(flag ?? '0'); expect(f.policy.quiet).toBe(false);
  // Pass undefined explicitly: fixture's default is quiet for all other tests.
  const policy = new AwarenessDeliveryPolicy(f.deps, flag);
  policy.handleEvent(event('error_detected')); await Bun.sleep(0);
  expect(f.calls.reactor).toBe(1); expect(f.calls.research).toBe(1); expect(f.calls.voice).toBe(1); expect(f.calls.desktop).toBe(1);
  expect(f.messages.some(m => m.type === 'chat')).toBe(true);
});

test('an enabled workflow still receives quiet awareness events through its real trigger manager', async () => {
  initWorkflowDb(':memory:'); configureWorkflowReadiness({ pieces: sampleCatalog() });
  const f = fixture(), manager = new TriggerManager({ eventBus: f.eventBus, log: () => {} });
  try {
    const flow = createFlow(), version = createDraftVersion({ flowId: flow.id, displayName: 'Explicit error subscription', trigger: {
      name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'jarvis-trigger', triggerName: 'on_event', input: { eventType: 'awareness.error_detected' } },
    } });
    lockVersion(version.id); setPublishedVersion(flow.id, version.id); updateFlowStatus(flow.id, 'ENABLED');
    await manager.start(); f.policy.handleEvent(event('error_detected'));
    expect(getWorkflowDb().query('SELECT id FROM workflow_job').all()).toHaveLength(1);
    expect(f.calls.research).toBe(0); expect(f.calls.reactor).toBe(0); expect(f.messages.every(m => m.type !== 'chat')).toBe(true);
  } finally { await manager.stop(); closeWorkflowDb(); }
});

async function connect(service: WebSocketService) {
  const server = service.getServer(); server.setInsecureOpenAccess(true); server.start();
  const port = (server as unknown as { server: { port: number } }).server.port;
  const received: WSMessage[] = [], client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  client.addEventListener('message', e => { received.push(JSON.parse(String(e.data))); });
  await new Promise<void>((resolve, reject) => { client.addEventListener('open', () => resolve(), { once: true }); client.addEventListener('error', reject, { once: true }); });
  return { received, close() { client.close(); server.stop(); } };
}
async function waitFor(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5); expect(check()).toBe(true); }

for (const quiet of [false, true]) test(`governed approval, emergency and execution failure remain visible with chat closed (quiet=${quiet})`, async () => {
  const ws = new WebSocketService(0, { setDelegationCallback() {} } as any), connection = await connect(ws);
  const f = fixture(quiet ? '1' : '0'); ws.broadcastProactiveVoice = async () => { f.calls.voice++; }; f.deps.sockets = ws;
  try {
    // This client opens no conversation and subscribes to no chat stream.
    await f.policy.deliverOpportunity(suggestion);
    ws.broadcastApprovalRequest({ id: 'approval-one', agent_id: 'agent', agent_name: 'Agent', tool_name: 'send_email', tool_arguments: '{}',
      action_category: 'send_email', urgency: 'urgent', reason: 'Review recipient', context: '{}', status: 'pending', execution_mode: 'inline',
      created_at: 1234, decided_at: null, decided_by: null, executed_at: null, execution_result: null } satisfies ApprovalRequest);
    ws.broadcastEmergencyState('paused');
    ws.broadcastWorkflowEvent({ type: 'workflow_failed', workflowId: 'flow-one', executionId: 'run-one', data: { error: 'Synthetic execution failure' }, timestamp: 1234 });
    await waitFor(() => connection.received.some(m => m.type === 'workflow_event'));
    expect(connection.received.some(m => sourceOf(m) === 'approval_request')).toBe(true);
    expect(connection.received.some(m => sourceOf(m) === 'emergency_state')).toBe(true);
    expect(connection.received.find(m => m.type === 'workflow_event')?.payload).toMatchObject({ workflowId: 'flow-one', executionId: 'run-one' });
    expect(connection.received.some(m => m.type === 'notification' && sourceOf(m) === 'awareness_event')).toBe(true);
    expect(connection.received.some(m => m.type === 'chat')).toBe(!quiet);
  } finally { connection.close(); }
});

test('offline quiet delivery retains its durable inbox and retries the same identity after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-f11-')), path = join(directory, 'vault.db');
  let worker: OpportunityDelivery | undefined; let connection: Awaited<ReturnType<typeof connect>> | undefined;
  let now = Date.now();
  try {
    initWorkflowDb(path);
    for (let days = 1; days <= 3; days++) createCapture({ timestamp: now - days * 86400000, pixelChangePct: 0.5, appName: 'Accounting', windowTitle: 'Overdue invoices' });
    const item = refreshOpportunity()!, offline = fixture('1', 0);
    worker = new OpportunityDelivery(s => offline.policy.deliverOpportunity(s), () => now);
    await worker.flush(); await worker.flush();
    expect(getOpportunity(item.id)?.id).toBe(item.id); expect(getOpportunityMetrics().delivered).toBe(0);
    expect(offline.messages).toHaveLength(1); expect(offline.calls.channels).toBe(0);
    await worker.stop(); closeWorkflowDb(); initWorkflowDb(path);
    const ws = new WebSocketService(0, { setDelegationCallback() {} } as any); connection = await connect(ws);
    const online = fixture(); ws.broadcastProactiveVoice = async () => { online.calls.voice++; }; online.deps.sockets = ws;
    const workflowEvents: unknown[] = []; online.eventBus.subscribe('awareness.suggestion_ready', e => { workflowEvents.push(e); });
    worker = new OpportunityDelivery(s => online.policy.deliverOpportunity(s), () => now);
    await worker.flush(); expect(getOpportunityMetrics().delivered).toBe(0);
    now += 300000; await worker.flush(); await worker.flush();
    await waitFor(() => connection!.received.some(m => m.type === 'notification'));
    const cards = connection.received.filter(m => m.type === 'notification' && sourceOf(m) === 'awareness_event');
    expect(cards).toHaveLength(1); expect(cards[0]!.payload).toMatchObject({ event: { data: { id: item.id, opportunityId: item.id } } });
    expect(connection.received.some(m => m.type === 'chat' || m.type.startsWith('tts_') || m.type === 'brief_chat_audio')).toBe(false);
    expect(getRecentSuggestions()[0]).toMatchObject({ id: item.id, delivered: 1, delivery_channel: 'websocket' });
    expect(getOpportunityMetrics().delivered).toBe(1); expect(workflowEvents).toHaveLength(0);
    expect(online.calls.voice).toBe(0); expect(online.calls.desktop).toBe(0);
  } finally { await worker?.stop(); connection?.close(); closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); }
});


test.each([undefined, '0', 'true', '1'])('quiet capability accurately reports flag %s independently of other Brief features', async flag => {
  const f = fixture(flag ?? '0'), policy = new AwarenessDeliveryPolicy(f.deps, flag);
  const capabilities = new BriefCapabilities(registerQuietAwareness(policy), policy.quiet ? ['quietAwareness'] : []);
  const routes = createApiRoutes({ briefCapabilities: capabilities } as ApiContext);
  const route = routes['/api/brief/capabilities'] as { GET: () => Response };
  const response = route.GET(), body = await response.json();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(body.capabilities.quietAwareness).toMatchObject({ supported: true, ready: true, enabled: flag === '1', state: 'ready', reason: flag === '1' ? null : 'disabled' });
  expect(body.capabilities.preparedOpportunities.enabled).toBe(false);
  expect(body.capabilities.conversations.enabled).toBe(false);
});


test('real screen capture still stores awareness evidence and emits a quiet error event', async () => {
  initWorkflowDb(':memory:');
  const f = fixture(), errors: unknown[] = [];
  f.eventBus.subscribe('awareness.error_detected', value => { errors.push(value); });
  const service = new AwarenessService({ awareness: {
    enabled: true, capture_interval_ms: 15000, min_change_threshold: 0.02,
    cloud_vision_enabled: false, cloud_vision_cooldown_ms: 30000, cloud_vision_ambient_cooldown_ms: 900000,
    stuck_threshold_ms: 300000, suggestion_rate_limit_ms: 60000,
    retention: { full_hours: 24, key_moment_hours: 72 }, struggle_grace_ms: 120000,
    struggle_cooldown_ms: 180000, overlay_autolaunch: false,
  } } as JarvisConfig, {} as LLMManager, value => f.policy.handleEvent(value));
  try {
    await service.start();
    await service.handleSidecarEvent('fixture-sidecar', { type: 'sidecar_event', event_type: 'screen_capture', timestamp: Date.now(),
      payload: { capture_id: 'error-capture', image_path: '/fixture/error.png', pixel_change_pct: 0.9,
        app_name: 'Terminal', window_title: 'Build', ocr_text: 'Error: connection failed while compiling synthetic project' } });
    expect(getWorkflowDb().query('SELECT id FROM screen_captures').all()).toHaveLength(1);
    expect(errors).toHaveLength(1); expect(f.messages.some(m => m.type === 'notification')).toBe(true);
    expect(f.messages.some(m => m.type === 'chat')).toBe(false);
    expect(f.calls).toEqual({ research: 0, reactor: 0, coalescer: 0, voice: 0, desktop: 0, channels: 0 });
  } finally { await service.stop(); closeWorkflowDb(); }
});
