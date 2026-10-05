import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initDatabase } from '../vault/schema.ts';
import { createGoal, updateGoalStatus } from '../vault/goals.ts';
import { closeWorkflowDb, DEFAULT_IDS, initWorkflowDb } from '../workflows/db/index.ts';
import { setEncryptionKey } from '../workflows/db/encryption.ts';
import { configureWorkflowReadiness, versionReadiness } from '../workflows/db/repos/flow-readiness.ts';
import { createFlow } from '../workflows/db/repos/flow.ts';
import { createDraftVersion, lockVersion, setSampleDataEntry, updateDraftVersion, type FlowTriggerNode } from '../workflows/db/repos/flow-version.ts';
import { createFlowRun } from '../workflows/db/repos/flow-run.ts';
import { upsertConnection } from '../workflows/db/repos/app-connection.ts';
import { createCompositionJournal } from '../workflows/db/repos/workflow-composition.ts';
import { saveWorkflowEffect } from '../workflows/db/repos/workflow-effect.ts';
import { PieceCatalog } from '../workflows/runtime/piece-catalog.ts';
import { CredentialResolver } from '../workflows/credentials/adapter.ts';
import { WorkflowEventBuffer } from '../workflows/runtime/event-buffer.ts';
import { buildSandboxServiceBackends } from '../workflows/runtime/service-backends.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { AuditTrail } from '../authority/audit.ts';
import { EmergencyController } from '../authority/emergency.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import type { ToolGate } from '../actions/tools/registry.ts';
import type { ExecutionTarget } from '../util/execution-environment.ts';
import {
  briefBindings, briefReadiness, DRY_RUNNER, drySupport, JOB_CONSTRAINTS, liveQualificationServices, observePreparedProposal,
  qualifyPreparedProposal, recheckQualification, versionDigest,
  type DrySample, type QualificationRequest, type QualificationServices,
} from './prepared-qualification.ts';

const GMAIL = '@activepieces/piece-gmail';
const JARVIS = '@jarvispieces/piece-jarvis-';
const field = (name: string, type: string, required = true, sourceType?: string) =>
  ({ name, label: name, type, required, ...(sourceType ? { sourceType } : {}) }) as any;
const action = (name: string, fields: unknown[]) => ({ name, displayName: name, description: '', inputSchema: { fields } }) as any;
const mail = [field('receiver', 'json', true, 'ARRAY'), field('subject', 'string'), field('body', 'long_text')];
const catalog = new PieceCatalog([
  { name: GMAIL, displayName: 'Gmail', description: '', auth: { type: 'OAUTH2' },
    actions: { send_email: action('send_email', mail), gmail_create_draft: action('gmail_create_draft', mail) } },
  { name: '@activepieces/piece-http', displayName: 'HTTP', description: '', actions: { send_request: action('send_request', [field('url', 'string')]) } },
  { name: JARVIS + 'context', displayName: '', description: '', actions: {
    commitments_list: action('commitments_list', []), vault_search: action('vault_search', [field('query', 'string')]) } },
  { name: JARVIS + 'ask', displayName: '', description: '', actions: { ask: action('ask', [field('prompt', 'long_text')]) } },
  { name: JARVIS + 'notify', displayName: '', description: '', actions: { notify: action('notify', [field('message', 'long_text'), field('channels', 'json', false, 'ARRAY')]) } },
  { name: JARVIS + 'tool', displayName: '', description: '', actions: { invoke: action('invoke', [field('toolName', 'string'), field('params', 'json', false, 'OBJECT')]) } },
]);
const WRITE_FILE = { params: [{ name: 'path', type: 'string', required: true }, { name: 'content', type: 'string', required: true },
  { name: 'target', type: 'string', required: false }] };

const authorityConfig = (overrides: Partial<AuthorityConfig> = {}): AuthorityConfig => ({ default_level: 7,
  governed_categories: ['send_email', 'send_message'], overrides: [], context_rules: [],
  learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal', ...overrides });

let authority: AuthorityEngine;
let registry: ToolRegistry;
let targets: ExecutionTarget[];
const services = (): QualificationServices => liveQualificationServices({ authority, tool: name => registry.get(name) ?? null,
  targets: () => targets, now: () => 1_700_000_000_000 });

beforeEach(() => {
  initDatabase(':memory:');
  initWorkflowDb(':memory:');
  setEncryptionKey(Buffer.alloc(32, 0x71));
  configureWorkflowReadiness({ pieces: catalog, tool: name => name === 'write_file' ? WRITE_FILE : null });
  authority = new AuthorityEngine(authorityConfig());
  registry = new ToolRegistry();
  registry.register({ name: 'write_file', category: 'file-ops', description: 'Synthetic write', execute: async () => 'saved',
    parameters: { path: { type: 'string', description: 'path', required: true }, content: { type: 'string', description: 'content', required: true } } });
  targets = [{ id: '', name: 'This computer', os: 'linux', isHost: true },
    { id: 'sidecar-studio', name: 'Studio PC', os: 'windows', connected: false, capabilities: ['filesystem'] }];
  connect('billing-gmail');
});
afterEach(() => { closeWorkflowDb(); });

function connect(externalId: string, status: 'ACTIVE' | 'ERROR' = 'ACTIVE', secret = 'synthetic-token') {
  upsertConnection({ externalId, pieceName: GMAIL, displayName: 'Billing inbox', pieceVersion: '0.0.1',
    type: 'OAUTH2', status, value: { access_token: secret } as any });
}

const step = (name: string, pieceName: string, actionName: string, input: Record<string, unknown>, nextAction?: FlowTriggerNode): FlowTriggerNode =>
  ({ name, type: 'PIECE', settings: { pieceName, pieceVersion: '0.0.1', actionName, input }, ...(nextAction ? { nextAction } : {}) });
const schedule = (nextAction: FlowTriggerNode): FlowTriggerNode =>
  ({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input: { cron_expression: '0 9 * * 1' } }, nextAction });
const SEND = { auth: '{{connections.billing-gmail}}', receiver: ['ana@cedar.test'], subject: 'Invoice 1042', body: '{{draft.text}}' };
/** Weekly invoice follow-up: read commitments, draft with AI, send with Gmail. */
const followUp = (send: Record<string, unknown> = {}) => schedule(
  step('commitments', JARVIS + 'context', 'commitments_list', {},
    step('draft', JARVIS + 'ask', 'ask', { prompt: 'Draft a short follow-up for {{commitments}}' },
      step('send_followup', GMAIL, 'send_email', { ...SEND, ...send }))));

function prepare(trigger: FlowTriggerNode) {
  const goal = createGoal('Collect overdue invoices', 'objective', { status: 'active' });
  const journal = createCompositionJournal({ schemaVersion: 1, name: 'Invoice follow-up',
    description: 'Draft follow-ups for overdue invoices and send them after I approve' });
  journal.finish('VALIDATED', []);
  const flow = createFlow({ metadata: { compositionRecordId: journal.id } });
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Invoice follow-up', trigger });
  return { goal, journal, flow, version };
}

/** A proposal as F-09 would build it for the prepared version. */
function proposal(p: ReturnType<typeof prepare>, overrides: Partial<QualificationRequest> = {}): QualificationRequest {
  const facts = observePreparedProposal({ ...base(p), bindings: [] }, services());
  return { ...base(p), bindings: briefBindings(facts.bindings), ...overrides };
}
function base(p: ReturnType<typeof prepare>): QualificationRequest {
  return {
    proposalId: 'proposal-1', revision: 'r1',
    evidence: [{ kind: 'observation', id: 'capture-1', revision: null }],
    goal: { goalId: p.goal.id, revision: String(p.goal.updated_at) },
    compositionId: p.journal.id,
    workflow: { flowId: p.flow.id, versionId: p.version.id, versionDigest: versionDigest(p.version.trigger) },
    bindings: [], constraints: JOB_CONSTRAINTS.invoice_review,
    preview: { basis: 'illustrative_template', runId: null, effects: [{ step: 'send_followup', approval: 'asks_first', sample: 'none' }] },
    sample: null,
  };
}
const codes = (request: QualificationRequest) => qualifyPreparedProposal(request, services()).reasons.map(r => r.code);
/** A successful dry-run record for the prepared version, as `PreparedDryRunner` writes it. */
const sampleFor = (p: ReturnType<typeof prepare>, simulated: DrySample['simulated']): DrySample => ({ runner: DRY_RUNNER,
  flowId: p.flow.id, versionId: p.version.id, versionDigest: versionDigest(p.version.trigger), fixtureId: 'week-41', fixtureDigest: 'f',
  status: 'SUCCEEDED', error: null, simulated, outputs: {} });

describe('prepared proposal qualification', () => {
  test('a complete proposal is ready and names the exact snapshot it qualified', () => {
    const p = prepare(followUp());
    const result = qualifyPreparedProposal(proposal(p), services());
    expect(result.reasons).toEqual([]);
    expect(result.verdict).toBe('ready');
    expect(result.snapshot).toMatchObject({ proposalId: 'proposal-1', revision: 'r1', flowId: p.flow.id, versionId: p.version.id,
      versionDigest: versionDigest(p.version.trigger), bindings: [{ kind: 'connection', id: 'billing-gmail', availability: 'ready' }] });
    expect(result.snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(briefReadiness(result)).toEqual({ state: 'ready', checkedAt: 1_700_000_000_000 });
  });

  test('a missing or placeholder recipient is never ready, including the empty list readiness accepts', () => {
    const empty = prepare(followUp({ receiver: [] }));
    expect(versionReadiness(empty.flow.id, empty.version.id).ready).toBe(true);
    const result = qualifyPreparedProposal(proposal(empty), services());
    expect(result.verdict).toBe('blocked');
    expect(result.reasons).toContainEqual({ code: 'recipient_missing', severity: 'blocked', step: 'send_followup', message: 'send_followup has no recipient' });
    for (const receiver of [['<client email>'], ['ana@example.com'], ['TBD']]) {
      expect(codes(proposal(prepare(followUp({ receiver }))))).toEqual(['recipient_missing']);
    }
    // A recipient taken from the trigger is resolved, and checked, at dispatch.
    expect(codes(proposal(prepare(followUp({ receiver: ['{{trigger.from}}'] }))))).toEqual([]);
  });

  test('an unavailable account or machine is never ready', () => {
    const p = prepare(followUp());
    const ready = proposal(p);
    connect('billing-gmail', 'ERROR');
    expect(codes(ready)).toEqual(expect.arrayContaining(['version_not_ready', 'binding_unavailable', 'binding_changed']));
    expect(codes(proposal(prepare(followUp({ auth: '{{connections.missing-inbox}}' }))))).toEqual(
      expect.arrayContaining(['version_not_ready', 'binding_unavailable']));

    const offline = prepare(schedule(step('save', JARVIS + 'tool', 'invoke',
      { toolName: 'write_file', params: { path: '/reports/weekly.md', content: 'Report', target: 'Studio PC' } })));
    const extra = { sample: sampleFor(offline, [{ step: 'save', service: 'tool' }]),
      preview: { basis: 'illustrative_template' as const, runId: null, effects: [{ step: 'save', approval: 'runs_automatically' as const, sample: 'none' as const }] } };
    const result = qualifyPreparedProposal(proposal(offline, extra), services());
    expect(result.reasons).toEqual([{ code: 'binding_unavailable', severity: 'blocked', step: 'save', message: 'Machine sidecar-studio is unavailable: Studio PC is offline' }]);
    targets[1]!.connected = true;
    expect(qualifyPreparedProposal(proposal(offline, extra), services()).verdict).toBe('ready');
  });

  test('an unsafe or inaccurate preview is never ready', () => {
    const p = prepare(followUp());
    const preview = (effects: NonNullable<QualificationRequest['preview']>['effects'], basis: 'illustrative_template' | 'sandbox_sample' | 'verified_output' = 'illustrative_template', runId: string | null = null) =>
      proposal(p, { preview: { basis, runId, effects } });
    // Claims the email was already sent.
    expect(codes(preview([{ step: 'send_followup', approval: 'asks_first', sample: 'completed' }]))).toEqual(['preview_misstated']);
    // Says it sends automatically when it asks, or leaves the send out.
    expect(codes(preview([{ step: 'send_followup', approval: 'runs_automatically', sample: 'none' }]))).toEqual(['preview_misstated']);
    expect(codes(preview([]))).toEqual(['preview_misstated']);
    expect(codes(preview([{ step: 'send_followup', approval: 'asks_first', sample: 'none' }, { step: 'draft', approval: 'asks_first', sample: 'none' }]))).toEqual(['preview_misstated']);
    // A sandbox sample the dry runner cannot produce, and verified output with no run behind it.
    expect(codes(preview([{ step: 'send_followup', approval: 'asks_first', sample: 'simulated' }], 'sandbox_sample'))).toEqual(
      ['preview_unsupported', 'preview_unsupported', 'preview_misstated']);
    expect(codes(preview([{ step: 'send_followup', approval: 'asks_first', sample: 'none' }], 'verified_output', 'run-that-never-happened'))).toEqual(['preview_unsupported']);
    // Says it asks first when Authority would send without asking.
    authority = new AuthorityEngine(authorityConfig({ governed_categories: [] }));
    expect(codes(proposal(p))).toEqual(['constraint_violated', 'preview_misstated']);
  });

  test('verified output needs a successful run proven to have used this exact version', () => {
    const p = prepare(followUp());
    const run = createFlowRun({ flowId: p.flow.id, flowVersionId: p.version.id, status: 'SUCCEEDED' });
    const verified = proposal(p, { preview: { basis: 'verified_output', runId: run.id, effects: [{ step: 'send_followup', approval: 'asks_first', sample: 'completed' }] } });
    // A draft is edited in place, so a run without effect records proves nothing about its graph.
    expect(codes(verified)).toEqual(['preview_unsupported', 'preview_misstated']);
    saveWorkflowEffect({ id: 'wfe_q13', runId: run.id, projectId: DEFAULT_IDS.project, flowId: p.flow.id, versionId: p.version.id,
      versionDigest: versionDigest(p.version.trigger), stepName: 'send_followup', executionPath: [], route: 'piece', toolName: 'gmail_send_email',
      actionCategory: 'send_email', requestDigest: 'r', arguments: {}, target: {}, provenance: {} as any, decision: 'approved' as any,
      reason: '', status: 'succeeded', approvalId: null, waitpointId: null, createdAt: 1 } as any);
    expect(qualifyPreparedProposal(verified, services()).verdict).toBe('ready');
    lockVersion(p.version.id);
    const lockedRun = createFlowRun({ flowId: p.flow.id, flowVersionId: p.version.id, status: 'SUCCEEDED' });
    expect(codes(proposal(p, { preview: { basis: 'verified_output', runId: lockedRun.id, effects: [{ step: 'send_followup', approval: 'asks_first', sample: 'none' }] } }))).toEqual([]);
  });

  test('a recheck over unchanged inputs is identical; a relevant change makes the qualification stale', () => {
    const p = prepare(followUp());
    const request = proposal(p);
    const first = qualifyPreparedProposal(request, services());
    expect(qualifyPreparedProposal(request, services())).toEqual(first);
    // Not relevant: editor sample data lives beside the graph, and a token refresh keeps the account.
    setSampleDataEntry(p.version.id, 'draft', { text: 'Sample' });
    connect('billing-gmail', 'ACTIVE', 'refreshed-token');
    expect(recheckQualification(first, request, services())).toEqual({ current: first, stale: false });

    const authorityChanged = (() => { authority = new AuthorityEngine(authorityConfig({ governed_categories: ['send_message'] })); return recheckQualification(first, request, services()); })();
    expect(authorityChanged.stale).toBe(true);
    expect(authorityChanged.current.verdict).toBe('blocked');
    expect(briefReadiness(authorityChanged.current, authorityChanged.stale).state).toBe('stale');
    authority = new AuthorityEngine(authorityConfig());
    expect(recheckQualification(first, request, services()).stale).toBe(false);

    connect('billing-gmail', 'ERROR');
    expect(recheckQualification(first, request, services()).stale).toBe(true);
    connect('billing-gmail', 'ACTIVE');
    expect(recheckQualification(first, request, services()).stale).toBe(false);

    updateDraftVersion(p.version.id, { trigger: followUp({ subject: 'Invoice 1042, second reminder' }) });
    const edited = recheckQualification(first, request, services());
    expect(edited.stale).toBe(true);
    expect(edited.current.reasons.map(r => r.code)).toEqual(['version_changed']);
  });

  test('job constraints are checked against the graph', () => {
    const p = prepare(followUp());
    expect(codes(proposal(p, { constraints: [{ kind: 'forbid', categories: ['send_email'] }] }))).toEqual(['constraint_violated']);
    expect(codes(proposal(p, { constraints: [{ kind: 'recipients', allowed: ['bo@oak.test'] }] }))).toEqual(['constraint_violated']);
    expect(codes(proposal(p, { constraints: [{ kind: 'recipients', allowed: ['ANA@cedar.test'] }] }))).toEqual([]);
    const unverified = qualifyPreparedProposal(proposal(p, { constraints: [{ kind: 'unverified', text: 'Only invoices older than 30 days' }] }), services());
    expect(unverified.verdict).toBe('review_needed');
    expect(briefReadiness(unverified).state).toBe('blocked');

    // An ungoverned community piece cannot ask first.
    const http = prepare(schedule(step('post', '@activepieces/piece-http', 'send_request', { url: 'https://hooks.oak.test/invoices' })));
    const httpPreview = { basis: 'illustrative_template' as const, runId: null, effects: [{ step: 'post', approval: 'runs_automatically' as const, sample: 'none' as const }] };
    expect(codes(proposal(http, { constraints: [], preview: httpPreview }))).toEqual(['effect_ungoverned']);
    expect(codes(proposal(http, { preview: httpPreview }))).toEqual(['effect_ungoverned', 'constraint_violated']);
  });

  test('the goal, composition and version must be the ones prepared', () => {
    const p = prepare(followUp());
    const request = proposal(p);
    expect(codes({ ...request, goal: { goalId: p.goal.id, revision: 'older' } })).toEqual(['goal_changed']);
    expect(codes({ ...request, evidence: [], goal: null })).toEqual(['incomplete', 'incomplete']);
    expect(codes({ ...request, workflow: { ...request.workflow!, versionId: prepare(followUp()).version.id } })).toEqual(['version_missing']);
    const other = createCompositionJournal({ schemaVersion: 1, name: 'Unrelated', description: 'Something else' });
    expect(codes({ ...request, compositionId: other.id })).toEqual(['composition_unlinked']);
    updateGoalStatus(p.goal.id, 'paused');
    expect(codes(request)).toEqual(['goal_inactive']);
  });

  test('a graph the dry runner supports needs a successful sample of this exact version', () => {
    const notifyOnly = prepare(schedule(step('commitments', JARVIS + 'context', 'commitments_list', {},
      step('tell_me', JARVIS + 'notify', 'notify', { message: 'Follow up on {{commitments}}', channels: ['dashboard'] }))));
    expect(drySupport(notifyOnly.version.trigger)).toBeNull();
    expect(drySupport(followUp())).toBe(`send_followup uses ${GMAIL}, which the dry runner cannot simulate`);
    const effects = [{ step: 'tell_me', approval: 'asks_first' as const, sample: 'simulated' as const }];
    const request = proposal(notifyOnly, { preview: { basis: 'sandbox_sample', runId: null, effects } });
    expect(codes(request)).toEqual(['sample_missing', 'preview_unsupported', 'preview_misstated']);
    const sample = sampleFor(notifyOnly, [{ step: 'commitments', service: 'context' }, { step: 'tell_me', service: 'notify' }]);
    expect(codes({ ...request, sample })).toEqual([]);
    expect(codes({ ...request, sample: { ...sample, versionDigest: 'other' } })).toEqual(['sample_mismatch']);
    expect(codes({ ...request, sample: { ...sample, status: 'FAILED', error: 'tell_me: message is required' } })).toEqual(['sample_failed']);
    expect(codes({ ...request, sample: { ...sample, runner: 'testing-run' as any } })).toEqual(['sample_unsafe']);
  });
});

describe('Authority predictions match the effect boundary', () => {
  const SEND_INPUT = { receiver: ['ana@cedar.test'], subject: 'Invoice 1042', body: 'Hello' };
  const writeFile = { piece: JARVIS + 'tool', action: 'invoke', input: { toolName: 'write_file', params: { path: '/tmp/q13', content: 'x' } },
    call: (b: any, ctx: any) => b.toolsInvoke({ toolName: 'write_file', params: { path: '/tmp/q13', content: 'x' } }, ctx) };
  const routes: Record<string, { piece: string; action: string; input: Record<string, unknown>; gate?: ToolGate;
    call: (b: any, ctx: any) => Promise<any> }> = {
    notify: { piece: JARVIS + 'notify', action: 'notify', input: { message: 'Hi', channels: ['dashboard'] },
      call: (b: any, ctx: any) => b.notify({ message: 'Hi', channels: ['dashboard'], priority: 'normal' }, ctx) },
    ask: { piece: JARVIS + 'ask', action: 'ask', input: { prompt: 'Summarise' }, call: (b: any, ctx: any) => b.llmChat({ prompt: 'Summarise' }, ctx) },
    context: { piece: JARVIS + 'context', action: 'vault_search', input: { query: 'ana' },
      call: (b: any, ctx: any) => b.contextProvider.vaultSearch({ query: 'ana' }, ctx) },
    tool: writeFile,
    'tool with mandatory review': { ...writeFile, gate: { actionCategory: 'write_data', confirm: 'always', intent: 'Review this write' } },
    'tool above its level': { ...writeFile, gate: { actionCategory: 'execute_command', confirm: 'above_level', intent: 'Run this as a command' } },
    gmail: { piece: GMAIL, action: 'send_email', input: { auth: '{{connections.billing-gmail}}', ...SEND_INPUT },
      call: (b: any, ctx: any) => b.pieceAuthorize({ piece: GMAIL, action: 'send_email', input: SEND_INPUT }, ctx) },
  };
  const seen = new Set<string>();
  const configs: Array<[string, Partial<AuthorityConfig>]> = [
    ['full level, nothing governed', { default_level: 10, governed_categories: [] }],
    ['sends governed', {}],
    ['level too low for email or files', { default_level: 1, governed_categories: [] }],
    ['level allows files but not commands', { default_level: 3, governed_categories: [] }],
    ['override denies messages', { default_level: 10, governed_categories: [], overrides: [{ action: 'send_message', allowed: false }] }],
    ['rule asks before every read', { default_level: 10, governed_categories: [],
      context_rules: [{ id: 'reads', action: 'read_data', condition: 'always', params: {}, effect: 'require_approval', description: 'Ask before reads' }] }],
  ];
  for (const [label, config] of configs) {
    test(`same decision for every route: ${label}`, async () => {
      for (const [name, route] of Object.entries(routes)) {
        authority = new AuthorityEngine(authorityConfig(config));
        registry.get('write_file')!.authorityGate = route.gate ? () => route.gate! : undefined;
        const flow = createFlow({});
        const version = createDraftVersion({ flowId: flow.id, displayName: 'Parity', trigger: { name: 'trigger', type: 'EMPTY',
          nextAction: step('action', route.piece, route.action, route.input) } });
        const predicted = observePreparedProposal({ proposalId: 'parity', revision: 'r', evidence: [], goal: null, compositionId: null,
          workflow: { flowId: flow.id, versionId: version.id, versionDigest: '' }, bindings: [], constraints: [], preview: null, sample: null },
        services()).steps.find(s => s.step === 'action')!.decision;
        const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
        const backends = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(),
          llmManager: { chat: async () => ({ content: 'reply' }) } as any, toolRegistry: registry, authorityEngine: authority,
          emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(),
          approvalManager: new ApprovalManager(), onWorkflowApproval: () => {},
          channelService: { getChannelStatus: () => ({}), getBroadcastRecipient: () => 'owner',
            sendWorkflowNotification: async () => {}, tryBroadcastToChannels: async () => ({ delivered: ['dashboard'], failed: [] }) } as any,
          wsService: { broadcastNotificationToDashboard: () => {} } as any });
        let actual: string;
        try {
          const reply = await route.call(backends, { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'action', executionPath: [] });
          actual = reply?.approval || reply?.dispatch === 'approval_required' ? 'approval' : 'auto';
        } catch (error) {
          if (!/Authority denied/.test(String(error))) throw error;
          actual = 'denied';
        }
        expect(`${name}: ${predicted}`).toBe(`${name}: ${actual}`);
        seen.add(actual);
      }
    });
  }
  test('the comparison above exercised allowed, approval and denied outcomes', () => {
    expect([...seen].sort()).toEqual(['approval', 'auto', 'denied']);
  });
});
