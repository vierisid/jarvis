import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '../workflows/db';
import { getDb } from '../vault/schema';
import { createSuggestion } from '../vault/awareness';
import { createGoal } from '../vault/goals';
import { deleteFlow, getFlow } from '../workflows/db/repos/flow';
import { getFlowVersion, updateDraftVersion } from '../workflows/db/repos/flow-version';
import { configureWorkflowReadiness } from '../workflows/db/repos/flow-readiness';
import { getWorkflowComposition } from '../workflows/db/repos/workflow-composition';
import { sampleCatalog } from '../workflows/runtime/test-fixtures';
import { digest } from '../workflows/runtime/effect-context';
import { acceptSuggestion, getCompositionRow, retrySuggestionComposition } from './suggestion-feedback';
import { SuggestionComposer } from './suggestion-composer';
import { PreparedOpportunities } from './prepared-opportunities';
import { recoverCompositionLeases } from './composition-leases';
import type { PreparedAssessment, PreparedIdentity, PreparedQualificationGate } from './prepared-contracts';
import type { ComposerLlmClient, ComposedFlow } from '../actions/tools/workflow-composer';
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
  // Hold lease time steady through synchronous DB setup. The real abort timer
  // must interrupt the entered model, not lose its lease before inference starts.
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now());
  try {
    const p = provider({ async chat() { calls++; return new Promise(() => {}); } }, gate(), 20);
    const view = await prepared(p, s.id); expect(view.state).toBe('blocked'); expect(calls).toBe(1);
    p.kick(); await p.idle(); expect(calls).toBe(1);
    getDb().run("UPDATE prepared_opportunities SET state = 'running', lease_token = 'expired', lease_until = 0 WHERE id = ?", [view.proposalId]);
    recoverCompositionLeases(getDb(), 'prepared_opportunities'); expect(p.get(view.proposalId).state).toBe('blocked');
  } finally { clock.mockRestore(); }
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
  expect(view.compositionId).not.toBeNull(); expect(getWorkflowComposition(view.compositionId!)!.state).toBe('VALIDATED');
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

const acceptance = { requestId: 'accept', reason: 'Prepare the invoice review', name: 'Invoice review',
  description: 'Review unpaid invoices', expectedOutcome: 'A list for review' };

for (const stage of ['queued', 'running', 'ready'] as const) test(`shared ownership rejects legacy acceptance when F09 is ${stage}`, async () => {
  const s = source(), entered = deferred<void>(), finish = deferred<void>(); let calls = 0;
  const p = provider({ async chat() { calls++; entered.resolve(); await finish.promise; return { text: JSON.stringify(graph()) }; } });
  const view = p.ensure(s.id);
  try {
    if (stage !== 'queued') await entered.promise;
    if (stage === 'ready') { finish.resolve(); await p.idle(); }
    expect(() => acceptSuggestion(s.id, acceptance)).toThrow('prepared proposal');
    expect(getCompositionRow(s.id)).toBeNull();
    expect(getDb().query('SELECT id FROM suggestion_feedback').all()).toHaveLength(0);
  } finally { finish.resolve(); await p.idle(); }
  expect(p.get(view.proposalId).state).toBe('ready'); expect(calls).toBe(1);
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(1);
});

test('legacy ownership survives a blocked F09 row and permits legacy retry', async () => {
  const s = source(); acceptSuggestion(s.id, acceptance);
  let calls = 0; const p = provider({ async chat() { calls++; return { text: '{}' }; } });
  const view = await prepared(p, s.id); expect(view.state).toBe('blocked'); expect(calls).toBe(0);
  const legacy = new SuggestionComposer(async () => ({ ok: true, flow: graph() as ComposedFlow, rawResponse: '{}' }));
  getDb().run("UPDATE suggestion_composition_jobs SET state = 'failed' WHERE suggestion_id = ?", [s.id]);
  retrySuggestionComposition(s.id, { requestId: 'retry', reason: 'Try again' });
  legacy.start(); try { await legacy.idle(); } finally { legacy.stop(); }
  expect(getCompositionRow(s.id)?.state).toBe('draft_ready');
  p.retry(view.proposalId, view.revision); await p.idle(); expect(calls).toBe(0);
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(1);
});

for (const winner of ['prepared', 'legacy'] as const) test(`old mixed queues reserve the ${winner} owner before either inference`, async () => {
  const s = source(); acceptSuggestion(s.id, acceptance);
  let preparedCalls = 0, legacyCalls = 0;
  const p = provider({ async chat() { preparedCalls++; return { text: JSON.stringify(graph()) }; } });
  const view = await prepared(p, s.id);
  // Simulate records created by the previous version, which had no shared reservation.
  getDb().run("UPDATE prepared_opportunities SET state = 'queued', error = NULL, created_at = ? WHERE id = ?", [winner === 'prepared' ? 1 : 3, view.proposalId]);
  getDb().run('UPDATE suggestion_composition_jobs SET created_at = 2 WHERE suggestion_id = ?', [s.id]);
  if (getDb().query("SELECT 1 FROM sqlite_master WHERE name = 'opportunity_composition_owners'").get()) getDb().run('DELETE FROM opportunity_composition_owners');
  const legacy = new SuggestionComposer(async () => { legacyCalls++; return { ok: true, flow: graph() as ComposedFlow, rawResponse: '{}' }; });
  legacy.start(); p.kick();
  try { await Promise.all([legacy.idle(), p.idle()]); } finally { legacy.stop(); }
  expect(preparedCalls).toBe(winner === 'prepared' ? 1 : 0); expect(legacyCalls).toBe(winner === 'legacy' ? 1 : 0);
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(1);
});

for (const failure of ['provider', 'model'] as const) test(`private ${failure} diagnostics stay in the linked journal`, async () => {
  const p = provider({ async chat() { if (failure === 'provider') throw Error('PRIVATE PROVIDER DIAGNOSTIC'); return { text: '{PRIVATE MODEL RESPONSE' }; } });
  const view = await prepared(p, source().id);
  expect(JSON.stringify(view)).not.toContain('PRIVATE'); expect(view.state).toBe('blocked');
  expect(view.compositionId).not.toBeNull();
  expect(JSON.stringify(getWorkflowComposition(view.compositionId!))).toContain('PRIVATE');
  const retry = p.retry(view.proposalId, view.revision); await p.idle();
  const old = getDb().query<{ snapshot: string }, [string]>('SELECT snapshot FROM prepared_opportunity_history WHERE revision = ?').get(view.revision)!;
  expect(JSON.parse(old.snapshot).composition_id).toBe(view.compositionId);
  expect(p.get(retry.proposalId).compositionId).not.toBe(view.compositionId);
});

test('pre-upgrade diagnostic text is sanitized when reading blocked proposals', async () => {
  const p = provider(), view = await prepared(p, source().id);
  getDb().run("UPDATE prepared_opportunities SET state = 'failed', assessment = NULL, error = 'PRIVATE OLD DIAGNOSTIC' WHERE id = ?", [view.proposalId]);
  expect(JSON.stringify(p.get(view.proposalId))).not.toContain('PRIVATE');
});

for (const ending of ['dismiss', 'timeout', 'shutdown'] as const) test(`journal is linked before inference and retained after ${ending}`, async () => {
  const entered = deferred<void>(), finish = deferred<{ text: string }>();
  const p = provider({ async chat() { entered.resolve(); return finish.promise; } }, gate(), ending === 'timeout' ? 50 : 120000);
  const view = p.ensure(source().id); await entered.promise;
  try {
    const journalId = p.get(view.proposalId).compositionId;
    expect(journalId).not.toBeNull(); expect(getWorkflowComposition(journalId!)).not.toBeNull();
    if (ending === 'dismiss') p.dismiss(view.proposalId, view.revision);
    if (ending === 'shutdown') p.stop();
    await p.idle(); expect(p.get(view.proposalId).compositionId).toBe(journalId);
  } finally { finish.resolve({ text: JSON.stringify(graph()) }); p.stop(); await p.idle(); }
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(0);
});

test('failure to bind the journal rolls back before inference', async () => {
  let calls = 0; const p = provider({ async chat() { calls++; return { text: JSON.stringify(graph()) }; } });
  getDb().exec("CREATE TRIGGER reject_journal_link BEFORE UPDATE OF composition_id ON prepared_opportunities WHEN NEW.composition_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'private link failure'); END");
  const view = await prepared(p, source().id);
  expect(view.state).toBe('blocked'); expect(calls).toBe(0);
  expect(getDb().query('SELECT id FROM workflow_composition').all()).toHaveLength(0);
});

for (const missing of ['workflow', 'version'] as const) test(`deleted ${missing} has a distinct recovery blocker`, async () => {
  const p = provider(), view = await prepared(p, source().id);
  if (missing === 'workflow') deleteFlow(view.workflow!.flowId);
  else getDb().run('DELETE FROM flow_version WHERE id = ?', [view.workflow!.versionId]);
  const current = p.get(view.proposalId);
  expect(current).toMatchObject({ state: 'blocked', canApprove: false, workflow: null });
  expect(current.blockers[0]?.code).toBe(missing === 'workflow' ? 'workflow_missing' : 'workflow_version_missing');
  expect(current.compositionId).toBe(view.compositionId);
});


test('legacy inference cannot attach after old mixed records resolve to prepared ownership', async () => {
  const s = source(); acceptSuggestion(s.id, acceptance);
  const entered = deferred<void>(), finish = deferred<void>();
  const legacy = new SuggestionComposer(async () => { entered.resolve(); await finish.promise; return { ok: true, flow: graph() as ComposedFlow, rawResponse: '{}' }; });
  legacy.start(); await entered.promise;
  const p = provider(), view = await prepared(p, s.id);
  getDb().run("UPDATE prepared_opportunities SET state = 'queued', created_at = 1 WHERE id = ?", [view.proposalId]);
  getDb().run('DELETE FROM opportunity_composition_owners');
  try { finish.resolve(); await legacy.idle(); p.kick(); await p.idle(); } finally { finish.resolve(); legacy.stop(); }
  expect(getCompositionRow(s.id)?.state).toBe('failed'); expect(p.get(view.proposalId).state).toBe('ready');
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(1);
});

test('prepared inference cannot attach after old mixed records resolve to legacy ownership', async () => {
  const s = source(), entered = deferred<void>(), finish = deferred<void>();
  const p = provider({ async chat() { entered.resolve(); await finish.promise; return { text: JSON.stringify(graph()) }; } });
  const view = p.ensure(s.id); await entered.promise;
  // An older writer could persist a legacy request without consulting the new reservation.
  getDb().run("INSERT INTO suggestion_feedback VALUES ('old-feedback', ?, 'old-accept', 'accept', 'Review', '{}', 1)", [s.id]);
  getDb().run(`INSERT INTO suggestion_composition_jobs (id, suggestion_id, feedback_id, request, state, created_at, updated_at)
    VALUES ('old-job', ?, 'old-feedback', ?, 'queued', 1, 1)`, [s.id, JSON.stringify({ ...acceptance, goalLink: null, observations: [] })]);
  getDb().run('DELETE FROM opportunity_composition_owners');
  finish.resolve(); await p.idle();
  expect(p.get(view.proposalId)).toMatchObject({ state: 'blocked', canApprove: false });
  expect(p.get(view.proposalId).compositionId).not.toBeNull();
  expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(0);
  const legacy = new SuggestionComposer(async () => ({ ok: true, flow: graph() as ComposedFlow, rawResponse: '{}' }));
  legacy.start(); try { await legacy.idle(); } finally { legacy.stop(); }
  expect(getCompositionRow(s.id)?.state).toBe('draft_ready'); expect(getDb().query('SELECT id FROM flow').all()).toHaveLength(1);
});
