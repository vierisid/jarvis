import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '../workflows/db';
import { getDb } from '../vault/schema';
import { createSuggestion } from '../vault/awareness';
import { createGoal } from '../vault/goals';
import { getFlow } from '../workflows/db/repos/flow';
import { getFlowVersion, updateDraftVersion } from '../workflows/db/repos/flow-version';
import { configureWorkflowReadiness } from '../workflows/db/repos/flow-readiness';
import { getWorkflowComposition } from '../workflows/db/repos/workflow-composition';
import { sampleCatalog } from '../workflows/runtime/test-fixtures';
import { digest } from '../workflows/runtime/effect-context';
import { PreparedOpportunities } from './prepared-opportunities';
import { recoverCompositionLeases } from './composition-leases';
import type { PreparedAssessment, PreparedIdentity, PreparedQualificationGate } from './prepared-contracts';
import type { ComposerLlmClient } from '../actions/tools/workflow-composer';
import { BriefCapabilities } from '../brief/capabilities';
import { registerPreparedOpportunities } from '../brief/registrations/prepared-opportunities';
import { createPreparedOpportunityRoutes } from '../brief/prepared-opportunity-routes';
import { loadPreparedQualityGate } from './prepared-quality-adapter';

let dir: string, path: string, workers: PreparedOpportunities[];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jarvis-f09-')); path = join(dir, 'test.db'); initWorkflowDb(path); workers = [];
  configureWorkflowReadiness({ pieces: sampleCatalog() }); });
afterEach(async () => { for (const worker of workers) worker.stop(); await Promise.all(workers.map(w => w.idle())); closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); });
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
function provider(llm: ComposerLlmClient = { async chat() { return { text: JSON.stringify(graph()) }; } }, quality: PreparedQualificationGate | null = gate(), timeout = 120_000) {
  const worker = new PreparedOpportunities(getWorkflowDb(), timeout); workers.push(worker);
  worker.configure(() => ({ llm, pieceRegistry: sampleCatalog() }), quality); return worker;
}
async function prepared(worker: PreparedOpportunities, id: string) { const initial = worker.ensure(id); await worker.idle(); return worker.get(initial.proposalId); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test('one source creates one exact locked disabled snapshot across processing and restart', async () => {
  const s = source(); let calls = 0;
  const p = provider({ async chat() { calls++; return { text: JSON.stringify(graph()) }; } });
  const first = p.ensure(s.id), duplicate = p.ensure(s.id); expect(first.proposalId).toBe(duplicate.proposalId);
  const other = provider(); other.kick(); await Promise.all([p.idle(), other.idle()]);
  const view = p.get(first.proposalId); expect(view.state).toBe('ready'); expect(view.canApprove).toBe(true); expect(calls).toBe(1);
  expect(view.goal?.goalId).toBe(s.goal.id); expect(view.evidence[0]?.id).toBe('capture-one');
  expect(getWorkflowComposition(view.compositionId!)!.state).toBe('VALIDATED');
  expect(getFlow(view.workflow!.flowId)!.status).toBe('DISABLED');
  expect(getFlow(view.workflow!.flowId)!.published_version_id).toBeNull();
  expect(getFlowVersion(view.workflow!.versionId)!.state).toBe('LOCKED');
  expect(() => updateDraftVersion(view.workflow!.versionId, { displayName: 'Changed' })).toThrow('LOCKED');
  expect(getDb().query('SELECT id FROM flow_run').all()).toHaveLength(0);
  expect(getDb().query('SELECT id FROM workflow_job').all()).toHaveLength(0);
  expect(getDb().query('SELECT id FROM suggestion_feedback').all()).toHaveLength(0);
  p.stop(); other.stop(); closeWorkflowDb(); initWorkflowDb(path); configureWorkflowReadiness({ pieces: sampleCatalog() });
  const restarted = provider(); expect((await prepared(restarted, s.id)).proposalId).toBe(first.proposalId);
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(1);
});

for (const stage of ['compose', 'qualify'] as const) test(`dismissal during ${stage} cannot return a visible ready proposal`, async () => {
  const s = source(), entered = deferred<void>(), finish = deferred<void>();
  const quality = gate(); quality.prepare = async identity => { if (stage === 'qualify') { entered.resolve(); await finish.promise; } return qualified(identity); };
  const p = provider({ async chat() { if (stage === 'compose') { entered.resolve(); await finish.promise; } return { text: JSON.stringify(graph()) }; } }, quality);
  const initial = p.ensure(s.id); await entered.promise;
  expect(p.dismiss(initial.proposalId, initial.revision).state).toBe('dismissed');
  finish.resolve(); await p.idle(); expect(p.get(initial.proposalId).state).toBe('dismissed');
  expect(p.get(initial.proposalId).canApprove).toBe(false);
  expect(getDb().query("SELECT id FROM flow WHERE status = 'ENABLED' OR published_version_id IS NOT NULL").all()).toHaveLength(0);
  if (stage === 'compose') expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(0);
  expect(getDb().query('SELECT id FROM suggestion_feedback').all()).toHaveLength(0);
});

test('legacy dismissal prevents draft attachment', async () => {
  const s = source(), entered = deferred<void>(), finish = deferred<void>();
  const p = provider({ async chat() { entered.resolve(); await finish.promise; return { text: JSON.stringify(graph()) }; } });
  const initial = p.ensure(s.id); await entered.promise;
  getDb().run('UPDATE awareness_suggestions SET dismissed = 1 WHERE id = ?', [s.id]);
  finish.resolve(); await p.idle(); expect(p.get(initial.proposalId).state).toBe('dismissed');
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(0);
});

for (const reason of ['goal', 'version', 'binding', 'quality-missing'] as const) test(`ready is withdrawn when ${reason} changes`, async () => {
  const s = source(), quality = gate(), p = provider(undefined, quality), view = await prepared(p, s.id);
  expect(view.state).toBe('ready');
  if (reason === 'goal') getDb().run('UPDATE goals SET updated_at = updated_at + 1 WHERE id = ?', [s.goal.id]);
  if (reason === 'version') getDb().run('UPDATE flow_version SET trigger = ? WHERE id = ?', [JSON.stringify({ name: 'trigger', type: 'EMPTY' }), view.workflow!.versionId]);
  if (reason === 'binding') quality.recheck = saved => ({ current: { ...saved.qualification, verdict: 'blocked', reasons: [{ code: 'binding_unavailable', severity: 'blocked', message: 'Reconnect the selected account.' }] }, stale: true });
  if (reason === 'quality-missing') quality.readiness = () => false;
  expect(p.get(view.proposalId).canApprove).toBe(false); expect(p.get(view.proposalId).state).not.toBe('ready');
});

for (const kind of ['unconfirmed', 'unlinked'] as const) test(`specific missing setup blocks ${kind} jobs without model calls`, async () => {
  const s = source('one', kind !== 'unconfirmed', kind !== 'unlinked'); let calls = 0;
  const p = provider({ async chat() { calls++; return { text: '{}' }; } });
  const view = await prepared(p, s.id); expect(view.state).toBe('blocked'); expect(calls).toBe(0);
  expect(view.blockers[0]!.message).toContain(kind === 'unconfirmed' ? 'Confirm the recurring job' : 'related active goal');
});

test('qualification for another snapshot is refused', async () => {
  const s = source(), quality = gate(); quality.prepare = async identity => { const result = qualified(identity); result.qualification.snapshot.versionId = 'other'; return result; };
  const view = await prepared(provider(undefined, quality), s.id); expect(view.state).toBe('blocked'); expect(view.canApprove).toBe(false);
});

test('background preparation has a durable daily budget across worker restart', async () => {
  const sources = Array.from({ length: 5 }, (_, i) => source(String(i))); let calls = 0;
  const p = provider({ async chat() { calls++; return { text: JSON.stringify(graph()) }; } });
  p.start(); await p.idle(); expect(calls).toBe(3);
  p.stop(); const next = provider({ async chat() { calls++; return { text: '{}' }; } }); next.start(); await next.idle();
  expect(calls).toBe(3); expect(getDb().query('SELECT id FROM prepared_opportunity_attempts').all()).toHaveLength(3);
  expect((await next.read({})).state).toBe('ready'); expect(sources).toHaveLength(5);
});

test('timeout and expired leases are blocked, never automatically recomposed', async () => {
  const s = source(); let calls = 0;
  const p = provider({ async chat() { calls++; return new Promise(() => {}); } }, gate(), 20);
  const view = await prepared(p, s.id); expect(view.state).toBe('blocked'); expect(calls).toBe(1);
  p.kick(); await p.idle(); expect(calls).toBe(1);
  getDb().run("UPDATE prepared_opportunities SET state = 'running', lease_token = 'expired', lease_until = 0 WHERE id = ?", [view.proposalId]);
  recoverCompositionLeases(getDb(), 'prepared_opportunities'); expect(p.get(view.proposalId).state).toBe('blocked');
});

test('retry archives the previous snapshot and refuses stale or terminal commands', async () => {
  const s = source(); const p = provider({ async chat() { return { text: '{}' }; } });
  const view = await prepared(p, s.id); expect(view.state).toBe('blocked');
  const again = p.retry(view.proposalId, view.revision); expect(again.revision).not.toBe(view.revision);
  expect(() => p.dismiss(view.proposalId, view.revision)).toThrow('changed'); await p.idle();
  expect(getDb().query('SELECT revision FROM prepared_opportunity_history').all()).toEqual([{ revision: view.revision }]);
  expect(() => p.retry(again.proposalId, again.revision)).toThrow('attempt limit');
  p.dismiss(again.proposalId, again.revision); expect(() => p.retry(again.proposalId, again.revision)).toThrow('resolved');
});

test('sample outputs never reach public preparation data or subsequent model requests', async () => {
  const s = source(), p = provider(), view = await prepared(p, s.id);
  getDb().run('UPDATE flow_version SET sample_data = ?, sample_input = ? WHERE id = ?', ['{"secret":"UNTRUSTED_CAPTURE"}', '{"secret":"UNTRUSTED_CAPTURE"}', view.workflow!.versionId]);
  expect(JSON.stringify(p.get(view.proposalId))).not.toContain('UNTRUSTED_CAPTURE');
  p.configure(() => ({ pieceRegistry: sampleCatalog(), llm: { async chat(req) { expect(JSON.stringify(req)).not.toContain('UNTRUSTED_CAPTURE'); return { text: JSON.stringify(graph()) }; } } }), gate());
  const retry = p.retry(view.proposalId, view.revision); await p.idle(); expect(p.get(retry.proposalId).state).toBe('ready');
});

test('missing optional Q13 compiles and prevents inference and activation', async () => {
  const p = provider(undefined, null); expect(p.readiness()).toBe('unavailable');
  expect(() => p.ensure(source().id)).toThrow('Q-13'); p.start(); await p.idle();
  expect(getDb().query('SELECT id FROM workflow_composition').all()).toHaveLength(0);
  expect(await loadPreparedQualityGate({ authority: null, tool: () => null, targets: () => [] })).toBeNull();
});

test('API gates, strict writes, concurrency tokens and no-store responses', async () => {
  const p = provider(), s = source(), json = (data: unknown, status = 200) => Response.json(data, { status });
  const req = (body: unknown, id = '') => Object.assign(new Request('http://localhost/api/brief/prepared-opportunities', {
    method: 'POST', body: JSON.stringify(body) }), { params: { id } });
  const base = '/api/brief/prepared-opportunities';
  const off = createPreparedOpportunityRoutes(new BriefCapabilities(registerPreparedOpportunities(p)), json, p);
  expect((await off[base]!.POST!(req({ opportunityId: s.id }))).status).toBe(503);
  const missing = createPreparedOpportunityRoutes(new BriefCapabilities(), json);
  expect((await missing[base]!.POST!(req({ opportunityId: s.id }))).status).toBe(501);
  const routes = createPreparedOpportunityRoutes(new BriefCapabilities(registerPreparedOpportunities(p), ['preparedOpportunities']), json, p);
  expect((await routes[base]!.POST!(req({ opportunityId: s.id, qualification: 'ready' }))).status).toBe(400);
  const response = await routes[base]!.POST!(req({ opportunityId: s.id })); expect(response.status).toBe(202);
  expect(response.headers.get('Cache-Control')).toBe('no-store'); const view = await response.json(); await p.idle();
  expect((await routes[`${base}/:id/dismiss`]!.POST!(req({ revision: 'old' }, view.proposalId))).status).toBe(409);
  expect(Object.keys(routes)).not.toContain(`${base}/:id/approve`);
});


test('a changed confirmed job cannot attach the old composition', async () => {
  const s = source(), entered = deferred<void>(), finish = deferred<void>();
  const p = provider({ async chat() { entered.resolve(); await finish.promise; return { text: JSON.stringify(graph()) }; } });
  const initial = p.ensure(s.id); await entered.promise;
  getDb().run('UPDATE opportunity_hypotheses SET validation = ? WHERE suggestion_id = ?', [JSON.stringify({ ...s.validation, job: 'Review only invoices from October' }), s.id]);
  finish.resolve(); await p.idle(); expect(p.get(initial.proposalId).state).toBe('blocked');
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(0);
});

test('attachment transaction failure leaves no orphan flow, and explicit retry succeeds', async () => {
  const s = source(), p = provider();
  getDb().exec("CREATE TRIGGER reject_prepared_version BEFORE INSERT ON flow_version BEGIN SELECT RAISE(ABORT, 'private failure'); END");
  const view = await prepared(p, s.id); expect(view.state).toBe('blocked');
  expect(JSON.stringify(view)).not.toContain('private failure'); expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(0);
  getDb().exec('DROP TRIGGER reject_prepared_version');
  p.retry(view.proposalId, view.revision); await p.idle(); expect(p.get(view.proposalId).state).toBe('ready');
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(1);
});

test('storage failures withdraw readiness, and recovery fences the abandoned inference', async () => {
  const s = source(), finish = deferred<{ text: string }>(); let calls = 0;
  const p = provider({ async chat() { calls++; return finish.promise; } }, gate(), 20);
  const view = p.ensure(s.id); await Bun.sleep(5);
  getDb().exec("CREATE TRIGGER reject_prepared_writes BEFORE UPDATE ON prepared_opportunities BEGIN SELECT RAISE(ABORT, 'private failure'); END");
  await p.idle(); expect(p.readiness()).toBe('unavailable');
  expect(() => p.ensure(s.id)).toThrow('Q-13');
  getDb().exec('DROP TRIGGER reject_prepared_writes'); p.kick(); await p.idle();
  expect(p.readiness()).toBe('ready'); expect(p.get(view.proposalId).state).toBe('blocked');
  finish.resolve({ text: JSON.stringify(graph()) }); await Bun.sleep(5);
  expect(calls).toBe(1); expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(0);
});

test('full queue rejects an explicit retry without losing its saved revision', async () => {
  const s = source('retry', false), p = provider(), blocked = await prepared(p, s.id);
  const validated = source('validated').validation;
  getDb().run('UPDATE opportunity_hypotheses SET validation = ? WHERE suggestion_id = ?', [JSON.stringify(validated), s.id]);
  for (let i = 0; i < 20; i++) p.ensure(source(`queued-${i}`).id);
  expect(() => p.retry(blocked.proposalId, blocked.revision)).toThrow('queue is full');
  expect(p.get(blocked.proposalId).revision).toBe(blocked.revision);
  p.stop(); await p.idle();
});

// Runs against the actual Q-13 implementation after integration, never a substitute qualifier.
// Kept optional because F-09's compile/merge dependency is only F-01.
test.skipIf(process.env.JARVIS_TEST_PREPARED_Q13 !== '1')('real Q13 dry-run qualifies the exact disabled version and blocks missing fixtures', async () => {
  const { buildEngineBundle } = await import('../workflows/runner/engine-runtime/build');
  const { buildAllJarvisPieces } = await import('../workflows/runner/engine-runtime/build-pieces');
  const { PieceCatalog } = await import('../workflows/runtime/piece-catalog');
  const { AuthorityEngine } = await import('../authority/engine');
  const bundle = await buildEngineBundle(); await buildAllJarvisPieces();
  const catalog = new PieceCatalog(sampleCatalog().list().map(entry => ({ ...entry, name: '@jarvispieces/piece-' + entry.name })));
  configureWorkflowReadiness({ pieces: catalog });
  const quality = await loadPreparedQualityGate({ authority: new AuthorityEngine({ default_level: 7, governed_categories: ['send_email', 'send_message'],
    overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }), tool: () => null, targets: () => [] }, bundle.bundlePath);
  expect(quality).not.toBeNull();
  const previousDataDir = process.env.JARVIS_WORKFLOW_DATA_DIR; process.env.JARVIS_WORKFLOW_DATA_DIR = dir;
  try {
    const p = provider(undefined, quality); let needsReply = false;
    p.configure(() => ({ pieceRegistry: catalog, llm: { async chat() {
      const value = graph(); value.trigger.nextAction.settings.pieceName = '@jarvispieces/piece-jarvis-notify';
      if (needsReply) value.trigger.nextAction = { name: 'draft', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-ask', actionName: 'ask', input: { prompt: 'Draft a report' } }, nextAction: value.trigger.nextAction } as any;
      return { text: JSON.stringify(value) };
    } } }), quality);
    const ready = await prepared(p, source('real-ready').id);
    expect(ready.blockers).toEqual([]); expect(ready.state).toBe('ready'); expect(ready.previewBasis).toBe('sandbox_sample');
    expect(getFlow(ready.workflow!.flowId)!.status).toBe('DISABLED');
    const saved = getDb().query<{ assessment: string }, [string]>('SELECT assessment FROM prepared_opportunities WHERE id = ?').get(ready.proposalId)!;
    expect(JSON.parse(saved.assessment).request.sample).toMatchObject({ status: 'SUCCEEDED', simulated: [{ step: 'report', service: 'notify' }] });
    expect(getDb().query('SELECT id FROM flow_run').all()).toHaveLength(0);
    needsReply = true; const blocked = await prepared(p, source('real-blocked').id);
    expect(blocked.state).toBe('blocked'); expect(blocked.canApprove).toBe(false);
    expect(blocked.blockers.some(b => b.code === 'sample_failed')).toBe(true);
    getDb().run('UPDATE goals SET updated_at = updated_at + 1 WHERE id = ?', [ready.goal!.goalId]);
    expect(p.get(ready.proposalId).state).toBe('stale');
  } finally { await quality?.close?.(); if (previousDataDir === undefined) delete process.env.JARVIS_WORKFLOW_DATA_DIR; else process.env.JARVIS_WORKFLOW_DATA_DIR = previousDataDir; }
}, 300_000);


test('publishing through another surface cannot leave an approval-eligible proposal', async () => {
  const p = provider(), view = await prepared(p, source().id);
  getDb().run('UPDATE flow SET published_version_id = ? WHERE id = ?', [view.workflow!.versionId, view.workflow!.flowId]);
  expect(p.get(view.proposalId)).toMatchObject({ state: 'blocked', canApprove: false, blockers: [{ code: 'already_published', message: expect.any(String) }] });
});
