import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '../workflows/db';
import { getDb } from '../vault/schema';
import { createSuggestion } from '../vault/awareness';
import { createGoal } from '../vault/goals';
import { getFlow, updateFlowStatus, deleteFlow, setPublishedVersion } from '../workflows/db/repos/flow';
import { createDraftVersion, lockVersion } from '../workflows/db/repos/flow-version';
import { configureWorkflowReadiness } from '../workflows/db/repos/flow-readiness';
import { sampleCatalog } from '../workflows/runtime/test-fixtures';
import { PieceCatalog } from '../workflows/runtime/piece-catalog';
import { digest } from '../workflows/runtime/effect-context';
import { TriggerManager } from '../workflows/runner/triggers/manager';
import { WorkflowEventBus } from '../workflows/runtime/event-bus';
import { PreparedOpportunities } from '../awareness/prepared-opportunities';
import type { PreparedAssessment, PreparedIdentity, PreparedQualificationGate } from '../awareness/prepared-contracts';
import { OpportunityActivation, type ActivationTriggers } from './opportunity-activation';
import { createOpportunityActivationRoutes } from './opportunity-activation-routes';
import { BriefCapabilities } from './capabilities';
import { registerOpportunityActivation } from './registrations/opportunity-activation';
import { registerPreparedOpportunities } from './registrations/prepared-opportunities';

let dir: string, path: string, preparations: PreparedOpportunities[], actions: OpportunityActivation[], managers: TriggerManager[];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jarvis-f10-')); path = join(dir, 'db'); initWorkflowDb(path);
  preparations = []; actions = []; managers = []; configureWorkflowReadiness({ pieces: sampleCatalog() }); });
afterEach(async () => { actions.forEach(a => a.stop()); preparations.forEach(p => p.stop());
  await Promise.all(preparations.map(p => p.idle())); await Promise.all(managers.map(m => m.stop())); closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); });
const graph = () => ({ displayName: 'Invoice review', trigger: { name: 'trigger', type: 'EMPTY', nextAction: {
  name: 'report', type: 'PIECE', settings: { pieceName: 'jarvis-notify', actionName: 'notify', input: { message: 'Draft report', channels: ['dashboard'] } },
} } });
function source(key = 'one', confirmed = true, linked = true) {
  const goal = createGoal(`Review invoices ${key}`, 'objective', { status: 'active' });
  const hypothesis = { schemaVersion: 1, assessedAt: Date.now(), patternKey: `job-v1:invoice_review:${key}`, kind: 'invoice_review',
    job: { title: 'Review invoices', proposedOutcome: 'A checked list of unpaid invoices and draft follow-ups for approval.', question: 'Confirm the job?' },
    evidence: [{ captureId: `capture-${key}`, observedAt: 1, app: 'Mail', kind: 'invoice_review', cue: 'unpaid invoices' }],
    recurrence: { episodes: 3, distinctDays: 2, firstObservedAt: 1, lastObservedAt: 3, windowDays: 14, basis: 'observed_activity' },
    goalCandidates: [], feasibility: { status: 'unverified', requiredChecks: [], reason: 'Not checked' }, uncertainty: [],
  };
  const suggestion = createSuggestion({ type: 'automation', title: hypothesis.job.title, body: 'Observed invoice review', context: { opportunity: hypothesis } });
  const validation = confirmed ? { feedbackId: 'confirmed', job: hypothesis.job.title, expectedOutcome: hypothesis.job.proposedOutcome,
    goalLink: linked ? { goalId: goal.id, title: goal.title, reason: 'These invoices support this goal', basis: 'user_confirmed' } : null, confirmedAt: Date.now() } : null;
  getDb().run('INSERT INTO opportunity_hypotheses (suggestion_id, pattern_key, hypothesis, validation, created_at) VALUES (?, ?, ?, ?, ?)',
    [suggestion.id, hypothesis.patternKey, JSON.stringify(hypothesis), validation ? JSON.stringify(validation) : null, Date.now()]);
  return { id: suggestion.id, goal, validation };
}
function qualified(identity: PreparedIdentity): PreparedAssessment {
  return { request: { identity }, previewBasis: 'illustrative_template', qualification: { qualifier: 'prepared-qualification-v1', verdict: 'ready', reasons: [],
    snapshot: { proposalId: identity.proposalId, revision: identity.revision, ...identity.workflow, fingerprint: digest(identity), bindings: [] }, checkedAt: Date.now() } };
}
function gate(): PreparedQualificationGate { return { readiness: () => true, prepare: async identity => qualified(identity),
  recheck: saved => ({ current: structuredClone(saved.qualification), stale: false }) }; }

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fakeTriggers() {
  return { calls: 0, registered: false, async refresh() { this.calls++; this.registered = true; },
    registrationState(): ReturnType<ActivationTriggers['registrationState']> { return this.registered ? 'registered' : 'blocked'; } };
}
function activation(p: PreparedOpportunities, triggers: ActivationTriggers, lease = 30_000) {
  const a = new OpportunityActivation(getWorkflowDb(), lease); a.configure(p, triggers); actions.push(a); return a;
}
async function fixture(key = 'one', quality = gate(), event: boolean | 'engine' = false, scoped = false) {
  const s = source(key), p = new PreparedOpportunities(getWorkflowDb()); preparations.push(p);
  const catalog = scoped ? new PieceCatalog(sampleCatalog().list().map(e => ({ ...e, name: '@jarvispieces/piece-' + e.name }))) : sampleCatalog();
  configureWorkflowReadiness({ pieces: catalog });
  const value = graph();
  if (scoped) value.trigger.nextAction.settings.pieceName = '@jarvispieces/piece-jarvis-notify';
  if (event) Object.assign(value.trigger, { type: 'PIECE_TRIGGER', settings: event === 'engine'
    ? { pieceName: 'jarvis-trigger', triggerName: 'on_event', input: { eventType: 'test' } } : { pieceName: 'webhook', input: {} } });
  p.configure(() => ({ pieceRegistry: catalog, llm: { async chat() { return { text: JSON.stringify(value) }; } } }), quality);
  const initial = p.ensure(s.id); await p.idle(); const view = p.get(initial.proposalId); expect(view.state).toBe('ready');
  return { s, p, view };
}
function noRuns() {
  expect(getDb().query('SELECT id FROM flow_run').all()).toHaveLength(0);
  expect(getDb().query('SELECT id FROM workflow_job').all()).toHaveLength(0);
}

for (const event of [false, true]) test(`double approval activates only the reviewed version with ${event ? 'webhook' : 'manual'} registration`, async () => {
  const { p, view } = await fixture('one', gate(), event);
  const newer = createDraftVersion({ flowId: view.workflow!.flowId, displayName: 'Different draft', trigger: { name: 'trigger', type: 'EMPTY' } });
  const manager = new TriggerManager({ eventBus: new WorkflowEventBus(), log: () => {} }); managers.push(manager);
  const a = activation(p, manager), other = activation(p, manager);
  const first = a.submit(view.proposalId, view.revision, 'same', 'approve');
  const duplicate = other.submit(view.proposalId, view.revision, 'same', 'approve');
  const secondKey = other.submit(view.proposalId, view.revision, 'double-click', 'approve');
  expect(first.created).toBe(true); expect(duplicate.created).toBe(false); expect(secondKey.receipt.receiptId).toBe(first.receipt.receiptId);
  await Promise.all([a.idle(), other.idle()]);
  expect(a.get(view.proposalId).registration.state).toBe('registered');
  expect(getFlow(view.workflow!.flowId)).toMatchObject({ status: 'ENABLED', published_version_id: view.workflow!.versionId });
  expect(getFlow(view.workflow!.flowId)!.published_version_id).not.toBe(newer.id);
  expect(p.get(view.proposalId)).toMatchObject({ state: 'accepted', canApprove: false });
  expect(() => p.retry(view.proposalId, view.revision)).toThrow('resolved');
  expect(() => p.dismiss(view.proposalId, view.revision)).toThrow('accepted');
  expect(manager.list()).toHaveLength(event ? 1 : 0); noRuns();
  expect(getDb().query('SELECT id FROM brief_opportunity_actions').all()).toHaveLength(1);
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(1);
});

for (const change of ['revision','goal','version','connection','target','quality']) test(`changed ${change} refuses approval before publication`, async () => {
  const quality = gate(), { s, p, view } = await fixture('one', quality), triggers = fakeTriggers(), a = activation(p, triggers);
  if (change === 'goal') getDb().run('UPDATE goals SET updated_at = updated_at + 1 WHERE id = ?', [s.goal.id]);
  if (change === 'version') getDb().run('UPDATE flow_version SET trigger = ? WHERE id = ?', [JSON.stringify({ name: 'trigger', type: 'EMPTY' }), view.workflow!.versionId]);
  if (change === 'connection' || change === 'target') quality.recheck = saved => ({ current: { ...saved.qualification, verdict: 'blocked', reasons: [{ code: 'binding_unavailable', severity: 'blocked', message: 'Reconnect the selected binding' }] }, stale: true });
  if (change === 'quality') quality.readiness = () => false;
  expect(() => a.submit(view.proposalId, change === 'revision' ? 'old' : view.revision, 'key', 'approve')).toThrow();
  expect(getFlow(view.workflow!.flowId)).toMatchObject({ status: 'DISABLED', published_version_id: null });
  expect(getDb().query('SELECT id FROM brief_opportunity_actions').all()).toHaveLength(0); expect(triggers.calls).toBe(0); noRuns();
});

test('publication and decision roll back together when receipt persistence fails', async () => {
  const { p, view } = await fixture(), a = activation(p, fakeTriggers());
  getDb().exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON brief_opportunity_actions BEGIN SELECT RAISE(ABORT, 'PRIVATE receipt failure'); END");
  expect(() => a.submit(view.proposalId, view.revision, 'key', 'approve')).toThrow();
  expect(getFlow(view.workflow!.flowId)).toMatchObject({ status: 'DISABLED', published_version_id: null });
  expect(p.get(view.proposalId).state).toBe('ready');
  getDb().exec('DROP TRIGGER reject_receipt'); a.submit(view.proposalId, view.revision, 'key', 'approve'); await a.idle();
  expect(a.get(view.proposalId).registration.state).toBe('registered'); noRuns();
});

test('dismissal settles independently and supplies the next current ready proposal', async () => {
  const first = await fixture('first'), second = await fixture('second'); const a = activation(first.p, fakeTriggers());
  const result = a.submit(first.view.proposalId, first.view.revision, 'dismiss', 'dismiss');
  expect(result.receipt).toMatchObject({ decision: 'dismiss', workflow: null, registration: { state: 'not_required' }, nextProposalId: second.view.proposalId });
  expect(first.p.get(first.view.proposalId).state).toBe('dismissed');
  expect(a.submit(first.view.proposalId, first.view.revision, 'dismiss', 'dismiss').receipt.receiptId).toBe(result.receipt.receiptId);
  expect(() => a.submit(first.view.proposalId, first.view.revision, 'approve', 'approve')).toThrow('settled differently');
  expect(() => a.submit(second.view.proposalId, second.view.revision, 'dismiss', 'approve')).toThrow('settled differently');
  expect(getFlow(first.view.workflow!.flowId)!.status).toBe('DISABLED'); noRuns();
});

test('dismissal during preparation fences the late model result without publication', async () => {
  const entered = deferred<void>(), reply = deferred<{ text: string }>();
  const p = new PreparedOpportunities(getWorkflowDb()); preparations.push(p);
  p.configure(() => ({ pieceRegistry: sampleCatalog(), llm: { async chat() { entered.resolve(); return reply.promise; } } }), gate());
  const view = p.ensure(source().id); await entered.promise;
  const triggers = fakeTriggers(), a = activation(p, triggers);
  expect(a.submit(view.proposalId, view.revision, 'dismiss-pending', 'dismiss').receipt.decision).toBe('dismiss');
  reply.resolve({ text: JSON.stringify(graph()) }); await p.idle(); await a.idle();
  expect(p.get(view.proposalId)).toMatchObject({ state: 'dismissed', canApprove: false });
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(0); expect(triggers.calls).toBe(0); noRuns();
});

test('all duplicate request keys stay bound to their original proposal, revision and action', async () => {
  const first = await fixture('first'), second = await fixture('second'), a = activation(first.p, fakeTriggers());
  a.submit(first.view.proposalId, first.view.revision, 'first-key', 'approve');
  a.submit(first.view.proposalId, first.view.revision, 'second-key', 'approve');
  for (const key of ['first-key','second-key']) {
    expect(() => a.submit(second.view.proposalId, second.view.revision, key, 'approve')).toThrow('settled differently');
    expect(() => a.submit(first.view.proposalId, 'different', key, 'approve')).toThrow('settled differently');
    expect(() => a.submit(first.view.proposalId, first.view.revision, key, 'dismiss')).toThrow('settled differently');
  }
  await a.idle(); noRuns();
});

test('registration timeout returns a durable pending receipt, and process recovery never republishes', async () => {
  const { p, view } = await fixture(), entered = deferred<void>(), finish = deferred<void>(), triggers = fakeTriggers();
  triggers.refresh = async () => { triggers.calls++; entered.resolve(); await finish.promise; triggers.registered = true; };
  const a = activation(p, triggers, 20), initial = a.submit(view.proposalId, view.revision, 'key', 'approve');
  expect(initial.receipt.registration.state).toBe('pending'); await entered.promise;
  expect(a.submit(view.proposalId, view.revision, 'key', 'approve').receipt.receiptId).toBe(initial.receipt.receiptId); expect(triggers.calls).toBe(1);
  a.stop(); p.stop(); closeWorkflowDb(); initWorkflowDb(path); configureWorkflowReadiness({ pieces: sampleCatalog() });
  // No publication may be attempted again, even if the first response was lost.
  getDb().exec("CREATE TRIGGER no_republish BEFORE UPDATE OF published_version_id ON flow BEGIN SELECT RAISE(ABORT, 'republished'); END");
  getDb().run('UPDATE brief_opportunity_actions SET lease_until = 0');
  const restarted = new PreparedOpportunities(getWorkflowDb()); preparations.push(restarted);
  restarted.configure(() => ({ pieceRegistry: sampleCatalog(), llm: { async chat() { throw Error('Must not recompose'); } } }), gate());
  const recovered = activation(restarted, fakeTriggers()); recovered.start(); await recovered.idle();
  expect(recovered.get(view.proposalId)).toMatchObject({ receiptId: initial.receipt.receiptId, registration: { state: 'registered' }, currentActivation: 'enabled' });
  expect(recovered.submit(view.proposalId, view.revision, 'key', 'approve')).toMatchObject({ created: false, receipt: { receiptId: initial.receipt.receiptId } });
  finish.resolve(); await a.idle();
  expect(recovered.get(view.proposalId).registration.state).toBe('registered');
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(1); noRuns();
});

test('registration failure stays actionable and explicit retry uses the same receipt', async () => {
  const { p, view } = await fixture(), triggers = fakeTriggers(); triggers.refresh = async () => { triggers.calls++; throw Error('PRIVATE PROVIDER TOKEN'); };
  const a = activation(p, triggers), initial = a.submit(view.proposalId, view.revision, 'key', 'approve'); await a.idle();
  expect(a.get(view.proposalId).registration.state).toBe('blocked'); expect(JSON.stringify(a.get(view.proposalId))).not.toContain('PRIVATE');
  a.kick(); await a.idle(); expect(triggers.calls).toBe(1);
  triggers.refresh = async () => { triggers.calls++; triggers.registered = true; };
  expect(a.submit(view.proposalId, view.revision, 'key', 'approve').receipt.receiptId).toBe(initial.receipt.receiptId); await a.idle();
  expect(a.get(view.proposalId).registration.state).toBe('registered'); expect(triggers.calls).toBe(2); noRuns();
});

test('old blocked receipts cannot starve a new approval or later recovery observations', async () => {
  const { p, view } = await fixture(), triggers = fakeTriggers(), a = activation(p, triggers);
  for (let n = 0; n < 25; n++) getDb().run(`INSERT INTO brief_opportunity_actions
    (id, proposal_id, revision, decision, registration, flow_id, version_id, version_digest, created_at, updated_at)
    VALUES (?, ?, 'old', 'approve', 'blocked', ?, 'missing', 'missing', 1, 1)`, [`old-${n}`, `old-${n}`, `missing-${n}`]);
  const observed = new Set<string>();
  triggers.registrationState = (flowId?: string) => {
    if (flowId?.startsWith('missing-')) { observed.add(flowId); return 'blocked'; }
    return triggers.registered ? 'registered' : 'blocked';
  };
  a.submit(view.proposalId, view.revision, 'new', 'approve'); await a.idle();
  expect(a.get(view.proposalId).registration.state).toBe('registered'); expect(triggers.calls).toBe(1);
  a.kick(); await a.idle(); expect(observed.size).toBe(25); noRuns();
});

test('a silent registration refusal is never reported as registered', async () => {
  const { p, view } = await fixture(), triggers = fakeTriggers(); triggers.refresh = async () => { triggers.calls++; };
  const a = activation(p, triggers); a.submit(view.proposalId, view.revision, 'key', 'approve'); await a.idle();
  expect(a.get(view.proposalId).registration.state).toBe('blocked'); noRuns();
});

for (const change of ['pause','delete','republish']) test(`replaying approval after ${change} cannot restore the old workflow`, async () => {
  const { p, view } = await fixture(), a = activation(p, fakeTriggers());
  const initial = a.submit(view.proposalId, view.revision, 'key', 'approve'); await a.idle();
  if (change === 'pause') updateFlowStatus(view.workflow!.flowId, 'DISABLED');
  if (change === 'delete') deleteFlow(view.workflow!.flowId);
  if (change === 'republish') {
    const different = createDraftVersion({ flowId: view.workflow!.flowId, displayName: 'New version', trigger: { name: 'trigger', type: 'EMPTY' } });
    lockVersion(different.id); setPublishedVersion(view.workflow!.flowId, different.id);
  }
  const before = getFlow(view.workflow!.flowId);
  expect(a.submit(view.proposalId, view.revision, 'key', 'approve').receipt.receiptId).toBe(initial.receipt.receiptId); await a.idle();
  expect(a.get(view.proposalId).registration.state).toBe('blocked'); expect(getFlow(view.workflow!.flowId)).toEqual(before); noRuns();
});

test('samples and private diagnostics never appear in an activation receipt', async () => {
  const { p, view } = await fixture(), a = activation(p, fakeTriggers());
  getDb().run('UPDATE flow_version SET sample_data = ?, sample_input = ? WHERE id = ?', ['{"secret":"CAPTURE_CANARY"}','{"secret":"CAPTURE_CANARY"}',view.workflow!.versionId]);
  expect(JSON.stringify(a.submit(view.proposalId, view.revision, 'key', 'approve'))).not.toContain('CAPTURE_CANARY'); await a.idle();
  expect(JSON.stringify(a.get(view.proposalId))).not.toContain('CAPTURE_CANARY');
});

test('strict routes enforce both capability flags, provider identity and bounded streamed bodies', async () => {
  const { p, view } = await fixture(), a = activation(p, fakeTriggers());
  const registrations = [...registerPreparedOpportunities(p), ...registerOpportunityActivation(a)];
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const base = '/api/brief/opportunity-actions/:id';
  const request = (body: BodyInit | null) => Object.assign(new Request('http://localhost/actions', { method: 'POST', body }), { params: { id: view.proposalId } });
  const input = JSON.stringify({ revision: view.revision, idempotencyKey: 'key' });
  for (const flags of [[], ['opportunityActivation'], ['preparedOpportunities']] as const) {
    const routes = createOpportunityActivationRoutes(new BriefCapabilities(registrations, flags), json, a);
    expect((await routes[`${base}/approve`]!.POST!(request(input))).status).toBe(503);
  }
  expect((await createOpportunityActivationRoutes(new BriefCapabilities(), json)[`${base}/approve`]!.POST!(request(input))).status).toBe(501);
  const routes = createOpportunityActivationRoutes(new BriefCapabilities(registrations, ['preparedOpportunities','opportunityActivation']), json, a);
  for (const body of [null,'[]','{bad','null',new Uint8Array([0xff]),JSON.stringify({ revision: 1, idempotencyKey: 'key' }),JSON.stringify({ revision: view.revision, idempotencyKey: 'key', flowId: 'forged' })]) {
    expect((await routes[`${base}/approve`]!.POST!(request(body))).status).toBe(400);
  }
  expect((await routes[`${base}/approve`]!.POST!(request(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(2049)); c.close(); } })))).status).toBe(413);
  const result = await routes[`${base}/approve`]!.POST!(request(input)); expect(result.status).toBe(202); expect(result.headers.get('Cache-Control')).toBe('no-store');
  await a.idle(); const replay = await routes[`${base}/approve`]!.POST!(request(input)); expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ created: false, receipt: { registration: { state: 'registered' } } }); noRuns();
});


test('approval to activate does not grant Authority for a later notification', async () => {
  const { p, view } = await fixture('authority', gate(), false, true), a = activation(p, fakeTriggers());
  a.submit(view.proposalId, view.revision, 'key', 'approve'); await a.idle(); noRuns();
  const { createFlowRun } = await import('../workflows/db/repos/flow-run');
  const { buildSandboxServiceBackends } = await import('../workflows/runtime/service-backends');
  const { AuthorityEngine } = await import('../authority/engine');
  const { ApprovalManager } = await import('../authority/approval');
  const { AuditTrail } = await import('../authority/audit');
  const { EmergencyController } = await import('../authority/emergency');
  const { CredentialResolver } = await import('../workflows/credentials/adapter');
  const { ToolRegistry } = await import('../actions/tools/registry');
  const { WorkflowEventBuffer } = await import('../workflows/runtime/event-buffer');
  const approvals = new ApprovalManager(); let sends = 0;
  const backends = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), toolRegistry: new ToolRegistry(),
    llmManager: { async chat() { throw Error('No inference expected'); } } as any, eventBuffer: new WorkflowEventBuffer(),
    channelService: { getChannelStatus: () => ({}), getBroadcastRecipient: () => 'fixture',
      async sendWorkflowNotification() { throw Error('No delivery expected'); } } as any,
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: ['send_message'], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), approvalManager: approvals,
    wsService: { broadcastNotificationToDashboard() { sends++; } } as any,
  });
  const run = createFlowRun({ flowId: view.workflow!.flowId, flowVersionId: view.workflow!.versionId, status: 'RUNNING' });
  const result = await backends.notify!({ message: 'Draft report', channels: ['dashboard'], priority: 'normal' },
    { runId: run.id, projectId: getFlow(view.workflow!.flowId)!.project_id, stepName: 'report', executionPath: [] });
  expect(result).toHaveProperty('approval'); expect(approvals.getPending()).toHaveLength(1); expect(sends).toBe(0);
});

test.skipIf(process.env.JARVIS_TEST_PREPARED_Q13 !== '1')('actual Q13 qualification approves the exact prepared snapshot without executing it', async () => {
  const { buildEngineBundle } = await import('../workflows/runner/engine-runtime/build');
  const { buildAllJarvisPieces } = await import('../workflows/runner/engine-runtime/build-pieces');
  const { PieceCatalog } = await import('../workflows/runtime/piece-catalog');
  const { AuthorityEngine } = await import('../authority/engine');
  const { loadPreparedQualityGate } = await import('../awareness/prepared-quality-adapter');
  const bundle = await buildEngineBundle(); await buildAllJarvisPieces();
  const catalog = new PieceCatalog(sampleCatalog().list().map(e => ({ ...e, name: '@jarvispieces/piece-' + e.name })));
  configureWorkflowReadiness({ pieces: catalog });
  const quality = await loadPreparedQualityGate({ authority: new AuthorityEngine({ default_level: 7, governed_categories: ['send_email','send_message'],
    overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }), tool: () => null, targets: () => [] }, bundle.bundlePath);
  expect(quality).not.toBeNull();
  const previous = process.env.JARVIS_WORKFLOW_DATA_DIR; process.env.JARVIS_WORKFLOW_DATA_DIR = dir;
  try {
    const p = new PreparedOpportunities(getWorkflowDb()); preparations.push(p);
    p.configure(() => ({ pieceRegistry: catalog, llm: { async chat() {
      const value = graph(); value.trigger.nextAction.settings.pieceName = '@jarvispieces/piece-jarvis-notify'; return { text: JSON.stringify(value) };
    } } }), quality);
    const view = p.ensure(source().id); await p.idle(); expect(p.get(view.proposalId).state).toBe('ready');
    const manager = new TriggerManager({ eventBus: new WorkflowEventBus(), log: () => {} }); managers.push(manager);
    const a = activation(p, manager), approved = a.submit(view.proposalId, view.revision, 'real-q13', 'approve'); await a.idle();
    expect(a.get(view.proposalId)).toMatchObject({ registration: { state: 'registered' }, currentActivation: 'enabled' });
    expect(getFlow(approved.receipt.workflow!.flowId)!.published_version_id).toBe(approved.receipt.workflow!.versionId);
    expect(p.get(view.proposalId).state).toBe('accepted'); noRuns();
  } finally { await quality?.close?.(); if (previous === undefined) delete process.env.JARVIS_WORKFLOW_DATA_DIR; else process.env.JARVIS_WORKFLOW_DATA_DIR = previous; }
}, 300000);


for (const recover of [false, true]) test(`F10 review R1: reconciliation preserves backoff and ${recover ? 'observes recovery' : 'stops after exhaustion'}`, async () => {
  const { p, view } = await fixture('backoff', gate(), 'engine');
  let attempts = 0, retry!: () => void, scheduled = 0;
  const manager = new TriggerManager({ eventBus: new WorkflowEventBus(), log: () => {}, enableRetryDelaysMs: [61_337],
    engineRuntime: { async acquire() { return { async executeTriggerHook(hook: string) {
      if (hook === 'ON_ENABLE' && (++attempts === 1 || !recover)) throw Error('Temporary engine outage');
      return { listeners: [{ name: 'WEBHOOK', identifier: 'fixture' }] };
    }, async release() {} }; } } as any });
  managers.push(manager);
  let a = activation(p, manager); const schedule = globalThis.setTimeout;
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, delay: number, ...args: any[]) => {
    if (delay === 61_337) { scheduled++; retry = () => callback(...args); }
    return schedule(callback, delay, ...args);
  }) as typeof setTimeout);
  try {
    a.submit(view.proposalId, view.revision, 'backoff', 'approve'); await a.idle();
    expect(attempts).toBe(1); expect(scheduled).toBe(1);
    for (let i = 0; i < 3; i++) {
      getDb().run('UPDATE brief_opportunity_actions SET lease_until = 0'); a.kick(); await a.idle();
      expect(a.get(view.proposalId).registration.state).toBe('pending');
      expect(attempts).toBe(1); expect(scheduled).toBe(1);
    }
    a.stop(); a = activation(p, manager); // A replacement worker must preserve the observed retry.
    retry();
    // Let the scheduled retry settle without requesting another refresh.
    while (manager.registrationState(view.workflow!.flowId, view.workflow!.versionId) === 'pending') await new Promise(resolve => setTimeout(resolve, 0));
    getDb().run('UPDATE brief_opportunity_actions SET lease_until = 0'); a.kick(); await a.idle();
    expect(attempts).toBe(2); expect(a.get(view.proposalId).registration.state).toBe(recover ? 'registered' : 'blocked');
    expect(scheduled).toBe(1);
    if (!recover) {
      for (let i = 0; i < 3; i++) { getDb().run('UPDATE brief_opportunity_actions SET lease_until = 0'); a.kick(); await a.idle(); }
      expect(attempts).toBe(2);
      // An explicit same-key retry can intentionally start a new manager budget.
      a.submit(view.proposalId, view.revision, 'backoff', 'approve'); await a.idle();
      expect(attempts).toBe(3); expect(scheduled).toBe(2); expect(a.get(view.proposalId).registration.state).toBe('pending');
    }
    noRuns();
  } finally { timers.mockRestore(); }
});

test('F10 review R3: committed dismissal aborts a hung composer and starts queued preparation', async () => {
  const entered = deferred<void>(), reply = deferred<{ text: string }>(); let calls = 0, signal: AbortSignal | undefined;
  const p = new PreparedOpportunities(getWorkflowDb()); preparations.push(p);
  p.configure(() => ({ pieceRegistry: sampleCatalog(), llm: { async chat(input) {
    if (++calls === 1) { signal = input.signal; entered.resolve(); return reply.promise; }
    return { text: JSON.stringify(graph()) };
  } } }), gate());
  const first = p.ensure(source('dismiss-hung').id); await entered.promise;
  const next = p.ensure(source('queued').id), a = activation(p, fakeTriggers());
  try {
    a.submit(first.proposalId, first.revision, 'dismiss-hung', 'dismiss');
    expect(signal?.aborted).toBe(true);
    await p.idle();
    expect(p.get(next.proposalId).state).toBe('ready'); expect(calls).toBe(2);
    // An ignored cancellation may resolve later, but cannot attach another workflow.
    reply.resolve({ text: JSON.stringify(graph()) }); await new Promise(resolve => setTimeout(resolve, 0));
    expect(p.get(first.proposalId)).toMatchObject({ state: 'dismissed', workflow: null });
    expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(1); noRuns();
  } finally { reply.resolve({ text: JSON.stringify(graph()) }); }
});

test('F10 review R3: rolled-back dismissal leaves active preparation running', async () => {
  const entered = deferred<void>(), reply = deferred<{ text: string }>(); let signal: AbortSignal | undefined;
  const p = new PreparedOpportunities(getWorkflowDb()); preparations.push(p);
  p.configure(() => ({ pieceRegistry: sampleCatalog(), llm: { async chat(input) { signal = input.signal; entered.resolve(); return reply.promise; } } }), gate());
  const view = p.ensure(source('rollback-dismiss').id); await entered.promise;
  const a = activation(p, fakeTriggers());
  try {
    getDb().exec("CREATE TRIGGER reject_dismiss BEFORE INSERT ON brief_opportunity_actions BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
    expect(() => a.submit(view.proposalId, view.revision, 'dismiss', 'dismiss')).toThrow('receipt failure');
    expect(signal?.aborted).toBe(false); expect(p.get(view.proposalId).state).toBe('preparing');
    expect(getDb().query('SELECT id FROM brief_opportunity_actions').all()).toHaveLength(0);
    reply.resolve({ text: JSON.stringify(graph()) }); await p.idle();
    expect(p.get(view.proposalId).state).toBe('ready'); noRuns();
  } finally { reply.resolve({ text: JSON.stringify(graph()) }); }
});


test('F10 review R1: existing receipt schema upgrades without losing decisions or request keys', async () => {
  const { p, view } = await fixture('schema-upgrade'), triggers = fakeTriggers();
  const first = activation(p, triggers);
  const receipt = first.submit(view.proposalId, view.revision, 'before-upgrade', 'approve').receipt; await first.idle(); first.stop();
  // Reconstruct the first F10 schema, then open it with the corrected service.
  getDb().run('ALTER TABLE brief_opportunity_actions DROP COLUMN observed_pending');
  const upgraded = activation(p, triggers);
  expect(upgraded.submit(view.proposalId, view.revision, 'before-upgrade', 'approve')).toMatchObject({ created: false, receipt: { receiptId: receipt.receiptId } });
  expect(getDb().query('SELECT observed_pending FROM brief_opportunity_actions').get()).toEqual({ observed_pending: 0 });
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(1); noRuns();
});
