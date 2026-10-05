import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { initDatabase } from '../vault/schema.ts';
import { createGoal, updateGoalStatus } from '../vault/goals.ts';
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from '../workflows/db/index.ts';
import { setEncryptionKey } from '../workflows/db/encryption.ts';
import { configureWorkflowReadiness, versionReadiness } from '../workflows/db/repos/flow-readiness.ts';
import { createFlow } from '../workflows/db/repos/flow.ts';
import { createDraftVersion, lockVersion, setSampleDataEntry, updateDraftVersion, type FlowTriggerNode } from '../workflows/db/repos/flow-version.ts';
import { createFlowRun, updateRun } from '../workflows/db/repos/flow-run.ts';
import { upsertConnection } from '../workflows/db/repos/app-connection.ts';
import { createCompositionJournal } from '../workflows/db/repos/workflow-composition.ts';
import { saveWorkflowEffect } from '../workflows/db/repos/workflow-effect.ts';
import { PieceCatalog } from '../workflows/runtime/piece-catalog.ts';
import { GOVERNED_PIECE_ADAPTERS } from '../workflows/runtime/piece-effects.ts';
import { VERIFIED_MANIFESTS } from '../workflows/pieces-library/verified-manifests-generated.ts';
import { CredentialResolver } from '../workflows/credentials/adapter.ts';
import { WorkflowEventBuffer } from '../workflows/runtime/event-buffer.ts';
import { buildSandboxServiceBackends } from '../workflows/runtime/service-backends.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { AuditTrail } from '../authority/audit.ts';
import { EmergencyController } from '../authority/emergency.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { ToolRegistry, type ToolGate } from '../actions/tools/registry.ts';
import { writeFileTool } from '../actions/tools/builtin.ts';
import {
  briefBindings, briefReadiness, DELIVERIES, DRY_RUNNER, drySupport, JOB_CONSTRAINTS, liveQualificationServices, observePreparedProposal,
  qualifyPreparedProposal, recheckQualification, versionDigest,
  type DrySample, type QualificationRequest, type QualificationServices, type QualificationTarget, type StepFact,
} from './prepared-qualification.ts';

const GMAIL = '@activepieces/piece-gmail';
const CALENDAR = '@activepieces/piece-google-calendar';
const JARVIS = '@jarvispieces/piece-jarvis-';
const field = (name: string, type: string, required = true, sourceType?: string) =>
  ({ name, label: name, type, required, ...(sourceType ? { sourceType } : {}) }) as any;
const action = (name: string, fields: unknown[]) => ({ name, displayName: name, description: '', inputSchema: { fields } }) as any;
const mail = [field('receiver', 'json', true, 'ARRAY'), field('subject', 'string'), field('body', 'long_text')];
const catalog = new PieceCatalog([
  { name: GMAIL, displayName: 'Gmail', description: '', auth: { type: 'OAUTH2' },
    actions: { send_email: action('send_email', mail), gmail_create_draft: action('gmail_create_draft', mail) } },
  { name: CALENDAR, displayName: 'Google Calendar', description: '', auth: { type: 'OAUTH2' },
    actions: { create_google_calendar_event: action('create_google_calendar_event', [field('attendees', 'json', false, 'ARRAY')]) } },
  { name: '@activepieces/piece-http', displayName: 'HTTP', description: '', actions: { send_request: action('send_request', [field('url', 'string')]) } },
  { name: JARVIS + 'context', displayName: '', description: '', actions: {
    commitments_list: action('commitments_list', []), vault_search: action('vault_search', [field('query', 'string')]) } },
  { name: JARVIS + 'ask', displayName: '', description: '', actions: { ask: action('ask', [field('prompt', 'long_text')]) } },
  { name: JARVIS + 'notify', displayName: '', description: '', actions: { notify: action('notify', [field('message', 'long_text'), field('channels', 'json', false, 'ARRAY')]) } },
  { name: JARVIS + 'tool', displayName: '', description: '', actions: { invoke: action('invoke', [field('toolName', 'string'), field('params', 'json', false, 'JSON')]) } },
]);
const WRITE_FILE = { params: [{ name: 'path', type: 'string', required: true }, { name: 'content', type: 'string', required: true },
  { name: 'target', type: 'string', required: false }] };
const BASHRC = `${homedir()}/.bashrc`;

const authorityConfig = (overrides: Partial<AuthorityConfig> = {}): AuthorityConfig => ({ default_level: 7,
  governed_categories: ['send_email', 'send_message'], overrides: [], context_rules: [],
  learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal', ...overrides });

let authority: AuthorityEngine;
let registry: ToolRegistry;
let targets: QualificationTarget[];
let credentials: CredentialResolver | undefined;
const services = (): QualificationServices => liveQualificationServices({ authority, tool: name => registry.get(name) ?? null,
  targets: () => targets, credentials, now: () => 1_700_000_000_000 });

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
  credentials = undefined;
  connect('billing-gmail');
});
afterEach(() => { closeWorkflowDb(); });

function connect(externalId: string, status: 'ACTIVE' | 'ERROR' = 'ACTIVE', secret = 'synthetic-token', pieceName = GMAIL) {
  upsertConnection({ externalId, pieceName, displayName: 'Account', pieceVersion: '0.0.1',
    type: 'OAUTH2', status, value: { access_token: secret } as any });
}

const step = (name: string, pieceName: string, actionName: string, input: Record<string, unknown>, nextAction?: FlowTriggerNode): FlowTriggerNode =>
  ({ name, type: 'PIECE', settings: { pieceName, pieceVersion: '0.0.1', actionName, input }, ...(nextAction ? { nextAction } : {}) });
const schedule = (nextAction: FlowTriggerNode): FlowTriggerNode =>
  ({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input: { cron_expression: '0 9 * * 1' } }, nextAction });
/** A linear graph of the given steps after a manual trigger. */
const chain = (...steps: FlowTriggerNode[]): FlowTriggerNode => {
  for (let i = steps.length - 2; i >= 0; i--) steps[i]!.nextAction = steps[i + 1];
  return { name: 'trigger', type: 'EMPTY', ...(steps[0] ? { nextAction: steps[0] } : {}) };
};
const SEND = { auth: '{{connections.billing-gmail}}', receiver: ['ana@cedar.test'], subject: 'Invoice 1042', body: '{{draft.text}}' };
/** Weekly invoice follow-up: read commitments, draft with AI, send with Gmail. */
const followUp = (send: Record<string, unknown> = {}) => schedule(
  step('commitments', JARVIS + 'context', 'commitments_list', {},
    step('draft', JARVIS + 'ask', 'ask', { prompt: 'Draft a short follow-up for {{commitments}}' },
      step('send_followup', GMAIL, 'send_email', { ...SEND, ...send }))));
const saveFile = (params: unknown) => schedule(step('save', JARVIS + 'tool', 'invoke', { toolName: 'write_file', params }));

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
/** The facts for one prepared graph, by step name. */
const stepsOf = (trigger: FlowTriggerNode): Record<string, StepFact> => Object.fromEntries(
  observePreparedProposal(base(prepare(trigger)), services()).steps.map(s => [s.step, s]));
/** A successful dry-run record for the prepared version, as `PreparedDryRunner` writes it. */
const sampleFor = (p: ReturnType<typeof prepare>, simulated: DrySample['simulated']): DrySample => ({ runner: DRY_RUNNER,
  flowId: p.flow.id, versionId: p.version.id, versionDigest: versionDigest(p.version.trigger), fixtureId: 'week-41', fixtureDigest: 'f',
  status: 'SUCCEEDED', error: null, simulated, outputs: {} });
const effect = (runId: string, p: ReturnType<typeof prepare>, digestOf: unknown, stepName = 'send_followup') =>
  saveWorkflowEffect({ id: `wfe_${runId}_${stepName}`, runId, projectId: DEFAULT_IDS.project, flowId: p.flow.id, versionId: p.version.id,
    versionDigest: versionDigest(digestOf), stepName, executionPath: [], route: 'piece', toolName: 'gmail_send_email',
    actionCategory: 'send_email', requestDigest: 'r', arguments: {}, target: {}, provenance: {} as any, decision: 'approved' as any,
    reason: '', status: 'succeeded', approvalId: null, waitpointId: null, createdAt: 1 } as any);
const stepStatus = (runId: string, status: string) => updateRun(runId, { steps: { send_followup: { output: { status, output: {} } } } });
const saveEffects = (step: string, approval: 'asks_first' | 'runs_automatically') =>
  ({ basis: 'illustrative_template' as const, runId: null, effects: [{ step, approval, sample: 'none' as const }] });

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
    for (const receiver of [['<client email>'], ['ana@example.com'], ['TBD'], ['{email}']]) {
      expect(codes(proposal(prepare(followUp({ receiver }))))).toEqual(['recipient_missing']);
    }
    // Placeholder words must be the whole value, not part of a real address.
    expect(codes(proposal(prepare(followUp({ receiver: ['todo@acme.test'] }))))).toEqual([]);
    // A recipient taken from the trigger is resolved, and checked, at dispatch.
    expect(codes(proposal(prepare(followUp({ receiver: ['{{trigger.from}}'] }))))).toEqual([]);
  });

  test('who a delivery reaches is read per action, not per piece', () => {
    const facts = stepsOf(chain(
      step('forward', GMAIL, 'gmail_forward_message', { receiver: [], message_id: '{{trigger.id}}' }),
      step('reply', GMAIL, 'reply_to_email', { message_id: '{{trigger.id}}', body: 'Thanks' }),
      step('broadcast', '@activepieces/piece-slack', 'send_message_to_multiple_users', { recipients: [], username: 'Jarvis' }),
      step('post', '@activepieces/piece-slack', 'send_channel_message', { channel: 'C42', username: 'Jarvis', text: 'Hi' }),
      step('gist', '@activepieces/piece-github', 'github_create_gist', { filename: 'report.md', content: 'Report' }),
      step('hook', '@activepieces/piece-discord', 'send_message_webhook', { webhook_url: 'https://discord.test/api/webhooks/1/a', content: 'Hi' }),
      step('approve', '@activepieces/piece-discord', 'request_approval_message', { channel: '42', content: 'OK?' }),
      step('chat', '@activepieces/piece-telegram-bot', 'request_approval_message', { chat_id: '7', message: 'OK?' }),
      step('uninvite', CALENDAR, 'google_calendar_remove_attendee', { attendee_email: 'ana@cedar.test', event_id: 'e1' }),
    ));
    const state = (name: string) => facts[name]!.recipients?.state;
    // A forward carries a message to new people; it is not addressed by that message.
    expect(state('forward')).toBe('missing');
    expect(state('reply')).toBe('ok');
    // Slack's `username` is the bot's display name, not a recipient.
    expect(state('broadcast')).toBe('missing');
    expect(facts.post!.recipients).toEqual({ state: 'ok', literals: ['C42'] });
    for (const name of ['gist', 'hook', 'approve', 'chat', 'uninvite']) expect(`${name}: ${state(name)}`).toBe(`${name}: ok`);

    // A delivery no table describes is left to a person, not guessed.
    registry.register({ name: 'send_report', category: 'communication', description: 'Synthetic send', execute: async () => 'sent', parameters: {},
      workflowEffect: { category: 'send_email', target: () => ({}) } } as any);
    const tool = stepsOf(chain(step('mail', JARVIS + 'tool', 'invoke', { toolName: 'send_report', params: {} }))).mail!;
    expect(tool.unreviewable).toContain('Who send_report reaches is not modeled');
  });

  test('the recipient table covers exactly the verified delivery actions, by their manifest props', () => {
    const delivering = GOVERNED_PIECE_ADAPTERS.flatMap(adapter => [...(adapter.categories.send_email ?? []), ...(adapter.categories.send_message ?? [])]
      .map(name => ({ key: `${adapter.catalogId}:${name}`, props: VERIFIED_MANIFESTS[adapter.catalogId]?.actions.find(a => a.name === name)?.props })));
    expect(Object.keys(DELIVERIES).sort()).toEqual(delivering.map(d => d.key).sort());
    for (const { key, props } of delivering) {
      const delivery = DELIVERIES[key]!;
      for (const prop of [...(delivery.to ?? []), ...(delivery.cc ?? []), ...(delivery.continues ?? [])]) {
        expect(`${key} reads ${prop}: ${props?.includes(prop)}`).toBe(`${key} reads ${prop}: true`);
      }
    }
  });

  test('an unavailable account or machine is never ready', () => {
    const p = prepare(followUp());
    const ready = proposal(p);
    connect('billing-gmail', 'ERROR');
    expect(codes(ready)).toEqual(expect.arrayContaining(['version_not_ready', 'binding_unavailable', 'binding_changed']));
    expect(codes(proposal(prepare(followUp({ auth: '{{connections.missing-inbox}}' }))))).toEqual(
      expect.arrayContaining(['version_not_ready', 'binding_unavailable']));

    const offline = prepare(saveFile({ path: '/reports/weekly.md', content: 'Report', target: 'Studio PC' }));
    const extra = { sample: sampleFor(offline, [{ step: 'save', service: 'tool' }]), preview: saveEffects('save', 'runs_automatically') };
    const result = qualifyPreparedProposal(proposal(offline, extra), services());
    expect(result.reasons).toEqual([{ code: 'binding_unavailable', severity: 'blocked', step: 'save', message: 'Machine sidecar-studio is unavailable: Studio PC is offline' }]);
    targets[1]!.connected = true;
    expect(qualifyPreparedProposal(proposal(offline, extra), services()).verdict).toBe('ready');
  });

  test('a machine is looked up as dispatch looks it up, and must offer the capability the tool needs', () => {
    targets[1]!.connected = true;
    const machine = (target: string) => observePreparedProposal(base(prepare(saveFile({ path: '/reports/weekly.md', content: 'x', target }))), services())
      .bindings.map(b => `${b.id} ${b.availability}${b.reason ? `: ${b.reason}` : ''}`);
    // Case-insensitive, and a unique part of the name is enough.
    expect(machine('studio pc')).toEqual(['sidecar-studio ready']);
    expect(machine('Studio')).toEqual(['sidecar-studio ready']);
    // The brain's own host is not a sidecar a step can name.
    expect(machine('This computer')).toEqual(['This computer unavailable: no enrolled machine matches "This computer"']);
    targets.push({ id: 'sidecar-studio-2', name: 'Studio PC', os: 'macos', connected: true, capabilities: ['filesystem'] });
    expect(machine('Studio PC')).toEqual(['Studio PC unavailable: several machines match "Studio PC"']);
    targets.pop();
    targets[1]!.capabilities = ['desktop'];
    expect(machine('Studio PC')).toEqual(['sidecar-studio unavailable: Studio PC cannot run filesystem tools']);
    targets[1]!.capabilities = ['filesystem'];
    targets[1]!.unavailableCapabilities = ['filesystem'];
    expect(machine('Studio PC')).toEqual(['sidecar-studio unavailable: Studio PC cannot run filesystem tools']);
  });

  test('connections are checked with the rules readiness applies', () => {
    const binding = (auth: string) => observePreparedProposal(base(prepare(followUp({ auth }))), services())
      .bindings.map(b => `${b.id} ${b.availability}${b.reason ? `: ${b.reason}` : ''}`);
    connect('team-slack', 'ACTIVE', 'x', '@activepieces/piece-slack');
    expect(binding('{{connections.team-slack}}')).toEqual(['team-slack unavailable: Connection belongs to a different piece']);
    connect('shared', 'ACTIVE', 'x', GMAIL);
    connect('shared', 'ACTIVE', 'x', '@activepieces/piece-slack');
    expect(binding("{{connections['shared']}}")).toEqual(['shared unavailable: Connection external ID is ambiguous in this project']);
    expect(binding('{{connections.jarvis:google}}')).toEqual(['jarvis:google unavailable: Managed connection source is unavailable']);
    credentials = new CredentialResolver();
    credentials.register({ id: 'google', canResolve: id => id === 'jarvis:google', resolve: async () => null });
    expect(binding('{{connections.jarvis:google}}')).toEqual(['jarvis:google ready']);
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

  test('verified output needs a full successful run proven to have used this exact version', () => {
    const p = prepare(followUp());
    const verified = (runId: string, sample: 'none' | 'completed' = 'completed') =>
      proposal(p, { preview: { basis: 'verified_output', runId, effects: [{ step: 'send_followup', approval: 'asks_first', sample }] } });
    const run = createFlowRun({ flowId: p.flow.id, flowVersionId: p.version.id, status: 'SUCCEEDED' });
    // A draft is edited in place, so a run without effect records proves nothing about its graph.
    expect(codes(verified(run.id))).toEqual(['preview_unsupported', 'preview_misstated']);
    effect(run.id, p, p.version.trigger);
    // The record says dispatch was authorized; only the step's own status says the email went out.
    stepStatus(run.id, 'FAILED');
    expect(codes(verified(run.id))).toEqual(['preview_misstated']);
    stepStatus(run.id, 'SUCCEEDED');
    expect(qualifyPreparedProposal(verified(run.id), services()).verdict).toBe('ready');

    // A single-step test run is not a run of the workflow.
    const partial = createFlowRun({ flowId: p.flow.id, flowVersionId: p.version.id, status: 'SUCCEEDED', stepNameToTest: 'send_followup' });
    effect(partial.id, p, p.version.trigger);
    stepStatus(partial.id, 'SUCCEEDED');
    expect(codes(verified(partial.id))).toEqual(['preview_unsupported']);

    // Test the draft, edit it, publish: the old run's records name the old graph, LOCKED or not.
    const edited = followUp({ subject: 'Invoice 1042, final notice' });
    const before = createFlowRun({ flowId: p.flow.id, flowVersionId: p.version.id, status: 'SUCCEEDED' });
    effect(before.id, p, p.version.trigger);
    stepStatus(before.id, 'SUCCEEDED');
    updateDraftVersion(p.version.id, { trigger: edited });
    lockVersion(p.version.id);
    const pinned = (runId: string, sample: 'none' | 'completed') => ({ ...verified(runId, sample),
      workflow: { flowId: p.flow.id, versionId: p.version.id, versionDigest: versionDigest(edited) } });
    expect(codes(pinned(before.id, 'completed'))).toEqual(['preview_unsupported']);
    // Without records, a LOCKED version proves only runs that started after it last changed.
    const after = createFlowRun({ flowId: p.flow.id, flowVersionId: p.version.id, status: 'SUCCEEDED' });
    expect(codes(pinned(after.id, 'none'))).toEqual([]);
    getWorkflowDb().run('UPDATE flow_run SET created = created - 60000 WHERE id = ?', [after.id]);
    expect(codes(pinned(after.id, 'none'))).toEqual(['preview_unsupported']);
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
    const httpPreview = saveEffects('post', 'runs_automatically');
    expect(codes(proposal(http, { constraints: [], preview: httpPreview }))).toEqual(['effect_ungoverned']);
    expect(codes(proposal(http, { preview: httpPreview }))).toEqual(['effect_ungoverned', 'constraint_violated']);

    // forbid reaches every category a step touches, not only its worst.
    registry.get('write_file')!.authorityGate = writeFileTool.authorityGate;
    const rc = prepare(saveFile({ path: BASHRC, content: 'echo hi' }));
    expect(stepsOf(rc.version.trigger).save!.categories).toEqual(['execute_command', 'write_data']);
    expect(codes(proposal(rc, { constraints: [{ kind: 'forbid', categories: ['write_data'] }],
      sample: sampleFor(rc, [{ step: 'save', service: 'tool' }]), preview: saveEffects('save', 'runs_automatically') }))).toEqual(['constraint_violated']);
  });

  test('a shared third-party write that runs unasked needs review under a "for approval" job; a draft does not', () => {
    connect('team-calendar', 'ACTIVE', 'x', CALENDAR);
    authority = new AuthorityEngine(authorityConfig({ governed_categories: [] }));
    const invite = prepare(schedule(step('invite', CALENDAR, 'create_google_calendar_event',
      { auth: '{{connections.team-calendar}}', attendees: ['lead@oak.test'] })));
    const result = qualifyPreparedProposal(proposal(invite, { preview: saveEffects('invite', 'runs_automatically') }), services());
    expect(result.verdict).toBe('review_needed');
    expect(result.reasons).toEqual([{ code: 'constraint_unverified', severity: 'review_needed', step: 'invite',
      message: 'invite writes to google-calendar without asking; check that it reaches no one else' }]);
    const draft = prepare(schedule(step('draft', GMAIL, 'gmail_create_draft', { ...SEND, body: 'Hello' })));
    expect(codes(proposal(draft, { preview: saveEffects('draft', 'runs_automatically') }))).toEqual([]);
  });

  test('tool params are read as readiness and the engine read them', () => {
    registry.get('write_file')!.authorityGate = writeFileTool.authorityGate;
    const qualify = (params: unknown) => {
      const p = prepare(saveFile(params));
      return codes(proposal(p, { sample: sampleFor(p, [{ step: 'save', service: 'tool' }]), preview: saveEffects('save', 'runs_automatically') }));
    };
    // JSON text is parsed, so a shell-startup write is judged as the command it is, string or object.
    expect(qualify(JSON.stringify({ path: BASHRC, content: 'echo hi' }))).toEqual(['constraint_violated']);
    expect(qualify({ path: BASHRC, content: 'echo hi' })).toEqual(['constraint_violated']);
    // Parameters computed at run time hide both the decision and the machine.
    expect(qualify('{{trigger.params}}')).toEqual(['effect_unreviewable']);
    // write_file's gate reads only the path, so a drafted body still qualifies.
    expect(qualify({ path: '/reports/weekly.md', content: '{{trigger.body}}' })).toEqual([]);
    expect(qualify({ path: '{{trigger.path}}', content: 'Report' })).toEqual(['effect_unreviewable']);
    // That holds only while the gate ignores everything but the path.
    expect(writeFileTool.authorityGate!({ path: BASHRC, content: '' })).toEqual(writeFileTool.authorityGate!({ path: BASHRC, content: 'x'.repeat(50) }));
    expect(writeFileTool.authorityGate!({ path: '/reports/weekly.md', content: 'anything' })).toBeNull();
  });

  test('a time-of-day Authority rule makes the decision unknowable in advance', () => {
    authority = new AuthorityEngine(authorityConfig({ governed_categories: [], context_rules: [{ id: 'evenings', action: 'send_email',
      condition: 'time_range', params: { start_hour: 0, end_hour: 24 }, effect: 'require_approval', description: 'Ask in the evening' }] }));
    const result = qualifyPreparedProposal(proposal(prepare(followUp())), services());
    expect(result.verdict).toBe('review_needed');
    expect(result.reasons).toEqual([{ code: 'effect_unreviewable', severity: 'review_needed', step: 'send_followup',
      message: 'send_followup: Authority decides send_email by the time of day' }]);
  });

  test('a tool that is missing or chosen at run time is reported as such, not as an Authority refusal', () => {
    const missing = stepsOf(chain(step('lost', JARVIS + 'tool', 'invoke', { toolName: 'no_such_tool', params: {} }))).lost!;
    expect([missing.decision, missing.reason]).toEqual(['unavailable', 'tool no_such_tool is not installed']);
    const chosen = stepsOf(chain(step('any', JARVIS + 'tool', 'invoke', { toolName: '{{trigger.tool}}', params: {} }))).any!;
    expect([chosen.decision, chosen.unreviewable]).toEqual(['unknown', ['The tool is chosen at run time']]);
    const p = prepare(chain(step('lost', JARVIS + 'tool', 'invoke', { toolName: 'no_such_tool', params: {} })));
    const reasons = qualifyPreparedProposal(proposal(p, { preview: saveEffects('lost', 'runs_automatically') }), services()).reasons;
    expect(reasons.map(r => r.code)).toContain('effect_unavailable');
    expect(reasons.map(r => r.code)).not.toContain('authority_denied');
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
    const effects = [{ step: 'tell_me', approval: 'asks_first' as const, sample: 'simulated' as const }];
    const request = proposal(notifyOnly, { preview: { basis: 'sandbox_sample', runId: null, effects } });
    expect(codes(request)).toEqual(['sample_missing', 'preview_unsupported', 'preview_misstated']);
    const sample = sampleFor(notifyOnly, [{ step: 'commitments', service: 'context' }, { step: 'tell_me', service: 'notify' }]);
    expect(codes({ ...request, sample })).toEqual([]);
    expect(codes({ ...request, sample: { ...sample, versionDigest: 'other' } })).toEqual(['sample_mismatch']);
    expect(codes({ ...request, sample: { ...sample, status: 'FAILED', error: 'tell_me: message is required' } })).toEqual(['sample_failed']);
    expect(codes({ ...request, sample: { ...sample, runner: 'testing-run' as any } })).toEqual(['sample_unsafe']);
  });

  test('the dry runner refuses anything it cannot simulate, however deeply nested', () => {
    expect(drySupport(followUp())).toBe(`send_followup uses ${GMAIL}, which the dry runner cannot simulate`);
    const notify = step('tell_me', JARVIS + 'notify', 'notify', { message: 'Hi' });
    const router: FlowTriggerNode = { name: 'route', type: 'ROUTER', settings: { branches: [] },
      children: [notify, step('mail', GMAIL, 'send_email', SEND)] };
    expect(drySupport(chain(router))).toBe(`mail uses ${GMAIL}, which the dry runner cannot simulate`);
    const loop: FlowTriggerNode = { name: 'each', type: 'LOOP_ON_ITEMS', settings: { items: '{{trigger.items}}' },
      firstLoopAction: { name: 'script', type: 'CODE', settings: { sourceCode: { code: '', packageJson: '{}' } } } };
    expect(drySupport(chain(loop))).toBe('script is a CODE step');
    // The plumbing fixture reads a stored credential and the piece store.
    expect(drySupport(chain(step('check', JARVIS + 'validate', 'validate', { storeValue: 'x' }))))
      .toBe(`check uses ${JARVIS}validate, which the dry runner cannot simulate`);
    expect(stepsOf(chain(step('check', JARVIS + 'validate', 'validate', { storeValue: 'x' }))).check!.decision).toBe('ungoverned');
  });
});

describe('Authority predictions match the effect boundary', () => {
  const SEND_INPUT = { receiver: ['ana@cedar.test'], subject: 'Invoice 1042', body: 'Hello' };
  const FILE = { path: '/tmp/q13', content: 'x' };
  const writeFile = { piece: JARVIS + 'tool', action: 'invoke', input: { toolName: 'write_file', params: FILE },
    call: (b: any, ctx: any) => b.toolsInvoke({ toolName: 'write_file', params: FILE }, ctx) };
  const routes: Record<string, { piece: string; action: string; input: Record<string, unknown>; gate?: ToolGate;
    call: (b: any, ctx: any) => Promise<any> }> = {
    notify: { piece: JARVIS + 'notify', action: 'notify', input: { message: 'Hi', channels: ['dashboard'] },
      call: (b: any, ctx: any) => b.notify({ message: 'Hi', channels: ['dashboard'], priority: 'normal' }, ctx) },
    ask: { piece: JARVIS + 'ask', action: 'ask', input: { prompt: 'Summarise' }, call: (b: any, ctx: any) => b.llmChat({ prompt: 'Summarise' }, ctx) },
    context: { piece: JARVIS + 'context', action: 'vault_search', input: { query: 'ana' },
      call: (b: any, ctx: any) => b.contextProvider.vaultSearch({ query: 'ana' }, ctx) },
    tool: writeFile,
    // The engine parses JSON text before dispatch; the prediction must read it the same way.
    'tool with params as JSON text': { ...writeFile, input: { toolName: 'write_file', params: JSON.stringify(FILE) },
      gate: { actionCategory: 'execute_command', confirm: 'above_level', intent: 'Run this as a command' } },
    'tool with mandatory review': { ...writeFile, gate: { actionCategory: 'write_data', confirm: 'always', intent: 'Review this write' } },
    'tool above its level': { ...writeFile, gate: { actionCategory: 'execute_command', confirm: 'above_level', intent: 'Run this as a command' } },
    gmail: { piece: GMAIL, action: 'send_email', input: { auth: '{{connections.billing-gmail}}', ...SEND_INPUT },
      call: (b: any, ctx: any) => b.pieceAuthorize({ piece: GMAIL, action: 'send_email', input: SEND_INPUT }, ctx) },
  };
  // Each configuration must produce the outcomes listed, so no comparison is vacuous.
  const configs: Array<[string, Partial<AuthorityConfig>, string[]]> = [
    ['full level, nothing governed', { default_level: 10, governed_categories: [] }, ['auto', 'approval']],
    ['sends governed', {}, ['auto', 'approval']],
    ['level too low for email or files', { default_level: 1, governed_categories: [] }, ['auto', 'denied']],
    ['level allows files but not commands', { default_level: 3, governed_categories: [] }, ['auto', 'approval', 'denied']],
    ['override denies messages', { default_level: 10, governed_categories: [], overrides: [{ action: 'send_message', allowed: false }] }, ['auto', 'denied']],
    ['rule asks before every read', { default_level: 10, governed_categories: [],
      context_rules: [{ id: 'reads', action: 'read_data', condition: 'always', params: {}, effect: 'require_approval', description: 'Ask before reads' }] },
    ['auto', 'approval']],
  ];
  for (const [label, config, expected] of configs) {
    test(`same decision for every route: ${label}`, async () => {
      const outcomes = new Set<string>();
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
        outcomes.add(actual);
      }
      expect([...outcomes]).toEqual(expect.arrayContaining(expected));
    });
  }
});
