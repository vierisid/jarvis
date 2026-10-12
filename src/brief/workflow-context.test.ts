import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, getWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../workflows/db';
import { createFlow, deleteFlow, setPublishedVersion } from '../workflows/db/repos/flow';
import { createDraftVersion, lockVersion, updateDraftVersion } from '../workflows/db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../workflows/db/repos/flow-run';
import { DefaultWorkerHandlers } from '../workflows/sandbox-api/worker-handlers';
import { SandboxRegistry } from '../workflows/sandbox-api/sandbox-registry';
import { configureWorkflowReadiness } from '../workflows/db/repos/flow-readiness';
import { createSuggestion } from '../vault/awareness';
import { ensurePreparedSchema } from '../awareness/prepared-schema';
import { upsertConnection } from '../workflows/db/repos/app-connection';
import { setEncryptionKey } from '../workflows/db/encryption';
import { createGoal } from '../vault/goals';
import { createWorkItem, decideWorkItem } from '../goals/work-items';
import { startWorkItemRun } from '../goals/workflow-bridge';
import { Worker } from '../workflows/queue/worker';
import { createRunFlowHandler, RUN_FLOW } from '../workflows/runner/handler';
import { createWaitpoint } from '../workflows/db/repos/waitpoint';
import { createSchema } from '../workflows/db/schema';
import { WorkflowContext } from './workflow-context';
import { WorkflowRemoval } from './workflow-removal';
import { INSPECTION_LIMITS, inspectionValue } from './inspection-values';
import { saveWorkflowEffect, type WorkflowEffect } from '../workflows/db/repos/workflow-effect';

let service: WorkflowContext, directory: string, file: string, db: Database, flowId: string, versionId: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-f21-')); file = join(directory, 'fixture.db');
  db = initWorkflowDb(file); service = new WorkflowContext(db, DEFAULT_IDS.project, () => true);
  configureWorkflowReadiness({ tool: () => null });
  flowId = createFlow().id;
  versionId = lockVersion(createDraftVersion({ flowId, displayName: 'Fixture', trigger: { name: 'trigger', type: 'EMPTY', settings: {} } }).id).id;
  setPublishedVersion(flowId, versionId);
});
afterEach(() => { setEncryptionKey(null); closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });
const command = (requestId = 'fixture-request', payload: unknown = {}) => ({ brief: { scopeId: DEFAULT_IDS.project, versionId, requestId }, payload });
function run() { return createFlowRun({ flowId, flowVersionId: versionId }); }
function progressWriter(runId: string) {
  const registry = new SandboxRegistry();
  registry.register({ sandboxId: 'fixture', runId, projectId: DEFAULT_IDS.project, engineToken: 'fixture',
    expiresAt: Date.now() + 60_000, terminatedAt: null });
  return new DefaultWorkerHandlers({ registry });
}
function effect(runId: string, status: WorkflowEffect['status'] = 'unknown'): WorkflowEffect {
  return { id: 'fixture-effect', runId, flowId, versionId, projectId: DEFAULT_IDS.project, versionDigest: 'fixture',
    stepName: 'trigger', executionPath: [], route: 'tools', toolName: 'fixture', actionCategory: 'read', requestDigest: 'fixture',
    arguments: { password: 'fixture-secret', nested: { innocuous: 'fixture-secret', count: 4 } }, target: {}, provenance: {},
    decision: 'allowed', reason: '<script>fixture()</script>', status, approvalId: null, waitpointId: null,
    result: { password: 'fixture-secret' }, createdAt: 1 };
}
test('selection stays on the run version after edits and later publication', () => {
  const r = run(); updateRun(r.id, { status: 'SUCCEEDED', steps: { trigger: { status: 'SUCCEEDED', input: { count: 3 }, output: 42 } } });
  const before = service.selection(flowId, versionId, r.id);
  const next = createDraftVersion({ flowId, displayName: 'Changed', trigger: { name: 'new_trigger', type: 'EMPTY', settings: {} } });
  updateDraftVersion(next.id, { displayName: 'Edited again' }); lockVersion(next.id); setPublishedVersion(flowId, next.id);
  expect(service.selection(flowId, versionId, r.id)).toEqual(before);
  expect(before.canvas.status).toBe('ready'); expect(before.run?.steps[0]?.fields[1]?.value).toBe('42');
  expect(() => service.selection(flowId, next.id, r.id)).toThrow('version_conflict');
  expect(service.selection(flowId, next.id).versionId).toBe(next.id);
});
test('an editable run never inherits the later locked graph, even with equal timestamps', () => {
  const draft = createDraftVersion({ flowId, displayName: 'Draft', trigger: { name: 'old', type: 'EMPTY', settings: {} } });
  const r = createFlowRun({ flowId, flowVersionId: draft.id });
  updateDraftVersion(draft.id, { trigger: { name: 'new', type: 'EMPTY', settings: {} } }); lockVersion(draft.id);
  db.run('UPDATE flow_version SET updated=? WHERE id=?', [r.created, draft.id]);
  const selected = service.selection(flowId, draft.id, r.id);
  expect(selected.canvas.status).toBe('unavailable'); expect(selected.context.groups.rules.status).toBe('unavailable');
  expect(JSON.stringify(selected)).not.toContain('new');
});
test('legacy absent version evidence fails closed after mutation; reading never backfills it', () => {
  const r = run(); db.run('DELETE FROM workflow_run_inspection_versions WHERE run_id=?', [r.id]);
  db.run('UPDATE flow_version SET updated=? WHERE id=?', [r.created + 10, versionId]);
  expect(service.detail(flowId, r.id).inspection.note).toContain('historical graph unavailable');
  expect(db.query('SELECT * FROM workflow_run_inspection_versions').all()).toEqual([]);
});
test('missing immutable version preserves recorded steps and identity without substituting the current version', () => {
  const r = run(); updateRun(r.id, { steps: { trigger: { input: 1, output: 2 } } });
  // Simulate a legacy orphan; normal current writers retain owned versions.
  db.run('PRAGMA foreign_keys=OFF'); db.run('DELETE FROM flow_version WHERE id=?', [versionId]); db.run('PRAGMA foreign_keys=ON');
  const d = service.detail(flowId, r.id); expect(d.versionId).toBe(versionId); expect(d.steps[0]?.fields[1]?.value).toBe('2');
  expect(d.inspection.note).toContain('historical graph unavailable');
});
test('redacts nested credentials, arbitrary text/keys, code, HTML and resume capabilities', () => {
  const r = run(), secret = 'fixture-secret', wait = createWaitpoint({ flowRunId: r.id, projectId: DEFAULT_IDS.project, stepName: 'trigger', type: 'WEBHOOK' });
  updateRun(r.id, { status: 'SUCCEEDED', steps: { trigger: { status: 'SUCCEEDED', input: { Authorization: `Bearer ${secret}`, safe: secret },
    output: { [secret]: '<img src=x onerror=fixture()>', nested: [{ resumeUrl: `https://x/${wait.id}`, count: 6 }] } } } });
  saveWorkflowEffect(effect(r.id));
  const d = service.detail(flowId, r.id), raw = JSON.stringify(d);
  for (const prohibited of [secret, wait.id, '<img', '<script', 'Bearer', 'resumeUrl']) expect(raw).not.toContain(prohibited);
  expect(d.steps[0]?.fields[0]?.redaction).toBe('partial'); expect(d.waits[0]?.id).toMatch(/^wait-/);
  expect(d.status).toBe('uncertain'); expect(d.effects[0]?.status).toBe('unknown');
});
test('missing fields and recorded context are explicit, not populated from current configuration', () => {
  const r = run(); updateRun(r.id, { steps: { trigger: { status: 'FAILED' } } });
  const d = service.selection(flowId, versionId, r.id);
  expect(d.run?.steps[0]?.fields).toEqual([{ label: 'Input', value: 'Missing: not recorded' }, { label: 'Output', value: 'Missing: not recorded' }]);
  for (const state of Object.values(d.context.groups)) expect(state.status).toBe('unavailable');
});
test('configured connection, rule, target and fact references remain distinct from recorded usage', () => {
  const draft = createDraftVersion({ flowId, displayName: 'References', trigger: { name: 'trigger', type: 'EMPTY', settings: { input: { auth: '{{connections.absent}}', factId: 'absent-fact', sidecarId: 'fixture-device' } },
    nextAction: { name: 'rule', type: 'ROUTER', settings: { branches: [] }, children: [] } } });
  // Inspection fixtures need no executable provider; imitate an already locked historic graph.
  db.run("UPDATE flow_version SET state='LOCKED' WHERE id=?", [draft.id]);
  const configured = service.selection(flowId, draft.id).context;
  for (const group of ['memory','bindings','target','rules'] as const) expect(configured.groups[group].status).toBe('ready');
  expect(JSON.stringify(configured)).toContain('missing');
  const r = createFlowRun({ flowId, flowVersionId: draft.id });
  const recorded = service.selection(flowId, draft.id, r.id).context;
  for (const group of ['memory','bindings','target','rules'] as const) expect(recorded.groups[group].status).toBe('unavailable');
});
test('actual memory handoffs, machine binding and approval reference come only from the selected run', () => {
  const r = run(), other = run();
  db.run(`INSERT INTO memory_use_events VALUES ('use-1','missing-fact','revision','supplied','workflow_context',NULL,NULL,NULL,?,?,'call',1)`, [r.id, flowId]);
  db.run(`INSERT INTO memory_use_events VALUES ('use-2','other-fact','revision','supplied','workflow_context',NULL,NULL,NULL,?,?,'call',1)`, [other.id, flowId]);
  db.run('INSERT INTO workflow_run_machine_binding VALUES (?,?)', [r.id, JSON.stringify({ runId: r.id, sidecarId: 'fixture-device', sessionId: 'private-session' })]);
  saveWorkflowEffect({ ...effect(r.id), approvalId: 'approval-fixture' });
  const c = service.selection(flowId, versionId, r.id).context, raw = JSON.stringify(c);
  expect(raw).toContain('Recorded provider handoff'); expect(raw).toContain('missing'); expect(raw).not.toContain('missing-fact'); expect(raw).toContain('fixture-device'); expect(raw).toContain('approval-fixture');
  expect(raw).not.toContain('other-fact'); expect(raw).not.toContain('private-session');
});
test('scope checks precede loading flow/version/run/receipt content', () => {
  const foreign = createFlow({ projectId: 'foreign' }), v = createDraftVersion({ flowId: foreign.id, displayName: 'private' });
  const r = createFlowRun({ flowId: foreign.id, flowVersionId: v.id, projectId: 'foreign' });
  expect(() => service.selection(foreign.id, v.id)).toThrow('not_found');
  expect(() => service.selection(flowId, v.id)).toThrow('not_found');
  expect(() => service.detail(flowId, r.id)).toThrow('not_found');
  const owned = run(); saveWorkflowEffect({ ...effect(owned.id), projectId: 'foreign' });
  expect(() => service.detail(flowId, owned.id)).toThrow('receipt_identity_unavailable');
});
test('stable keyset pagination handles equal timestamps and new head inserts without gaps', () => {
  const ids = Array.from({ length: 60 }, () => run().id); db.run('UPDATE flow_run SET created=1');
  const first = service.list(flowId); if (first.status !== 'ready') throw Error();
  const later = run(); const second = service.list(flowId, first.data.nextCursor); if (second.status !== 'ready') throw Error();
  const got = [...first.data.items, ...second.data.items].map(x => x.runId);
  expect(new Set(got).size).toBe(60); expect(got.sort()).toEqual(ids.sort()); expect(got).not.toContain(later.id);
});
test('history queries seek within the selected flow index without scanning or sorting project history', () => {
  const ids = Array.from({ length: 60 }, () => run().id); db.run('UPDATE flow_run SET created=1');
  const other = createFlow(), otherVersion = lockVersion(createDraftVersion({ flowId: other.id, displayName: 'Other' }).id);
  db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
    INSERT INTO flow_run (id,flow_id,flow_version_id,project_id,status,environment,created,updated)
    SELECT 'unrelated-'||i,?,?,?,'SUCCEEDED','PRODUCTION',i,i FROM n`, [other.id, otherVersion.id, DEFAULT_IDS.project]);
  // Observe the actual service queries, not a separate hand-written equivalent.
  const queries = spyOn(db, 'query');
  let historySql: string[] = [];
  try {
    const first = service.list(flowId); if (first.status !== 'ready') throw Error();
    const second = service.list(flowId, first.data.nextCursor); if (second.status !== 'ready') throw Error();
    expect([...first.data.items, ...second.data.items].map(r => r.runId).sort()).toEqual(ids.sort());
    historySql = queries.mock.calls.map(([sql]) => sql).filter(sql => sql.includes('ORDER BY created DESC, id DESC LIMIT 51'));
  } finally { queries.mockRestore(); }
  expect(historySql).toHaveLength(2);
  for (const [page, sql] of historySql.entries()) {
    const parameters = Array.from({ length: sql.match(/\?/g)?.length ?? 0 }, () => null);
    const plan = db.query<{ detail: string }, null[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters).map(r => r.detail).join('\n');
    expect(plan).toContain('idx_brief_run_history');
    expect(plan).toContain('project_id=? AND flow_id=?');
    expect(plan).not.toContain('TEMP B-TREE'); expect(plan).not.toContain('SCAN');
    if (page) expect(plan).toContain('(created,id)<(?,?)');
  }
});
test('legacy giant source, aggregate receipts and row counts are refused before projection', () => {
  const r = run(); db.run('UPDATE flow_run SET steps=? WHERE id=?', [' '.repeat(INSPECTION_LIMITS.sourceBytes + 1), r.id]);
  expect(() => service.detail(flowId, r.id)).toThrow('source_too_large');
  db.run('UPDATE flow_run SET steps=NULL WHERE id=?', [r.id]);
  for (let i = 0; i < 201; i++) saveWorkflowEffect({ ...effect(r.id), id: `effect-${i}` });
  expect(() => service.detail(flowId, r.id)).toThrow('inspection_capacity');
  db.run('DELETE FROM workflow_effect'); saveWorkflowEffect({ ...effect(r.id), result: 'x'.repeat(INSPECTION_LIMITS.sourceBytes) });
  expect(() => service.detail(flowId, r.id)).toThrow('inspection_capacity');
});
test('deep/wide values are bounded and explicitly partial', () => {
  const field = inspectionValue('Output', Array.from({ length: 1000 }, () => ({ secret: 'private' })));
  expect(field.value.length).toBeLessThan(INSPECTION_LIMITS.fieldChars); expect(field.value).toContain('inspection limit');
  expect(field.value).not.toContain('private');
});
test('manual start atomically queues one run and returns a durable run ID across retries and restart', () => {
  const result = service.start(flowId, command('once', { b: 2, a: 1 }));
  expect(service.start(flowId, command('once', { a: 1, b: 2 }))).toEqual(result);
  expect(service.request(flowId, 'once')).toEqual(result);
  closeWorkflowDb(); db = initWorkflowDb(file); service = new WorkflowContext(db, DEFAULT_IDS.project, () => true);
  expect(service.start(flowId, command('once', { a: 1, b: 2 }))).toEqual(result);
  expect(db.query('SELECT id FROM flow_run').all()).toHaveLength(1);
  expect(db.query('SELECT max_attempts FROM workflow_job').all()).toEqual([{ max_attempts: 1 }]);
});
test('accepted request recovery survives hard deletion and restart while retaining scope and readiness gates', () => {
  const accepted = service.start(flowId, command()); deleteFlow(flowId);
  const jobs = db.query('SELECT id FROM workflow_job').all();
  expect(service.request(flowId, 'fixture-request')).toEqual(accepted);
  closeWorkflowDb(); db = initWorkflowDb(file); service = new WorkflowContext(db, DEFAULT_IDS.project, () => true);
  expect(service.request(flowId, 'fixture-request')).toEqual(accepted);
  expect(() => new WorkflowContext(db, 'foreign', () => true).request(flowId, 'fixture-request')).toThrow('not_found');
  expect(() => service.request(createFlow().id, 'fixture-request')).toThrow('not_found');
  expect(() => service.request('invalid/id', 'fixture-request')).toThrow('invalid_identity');
  expect(() => new WorkflowContext(db, DEFAULT_IDS.project, () => false).request(flowId, 'fixture-request')).toThrow('unavailable');
  expect(() => service.start(flowId, command())).toThrow('not_found');
  expect(db.query('SELECT id FROM workflow_job').all()).toEqual(jobs);
  expect(db.query('SELECT * FROM brief_manual_run_requests').all()).toHaveLength(1);
});
test('request key reuse with changed version, flow or input refuses without another run', () => {
  service.start(flowId, command());
  expect(() => service.start(flowId, command('fixture-request', { changed: 1 }))).toThrow('request_conflict');
  const other = createFlow(); expect(() => service.start(other.id, command())).toThrow('request_conflict');
  expect(db.query('SELECT id FROM flow_run').all()).toHaveLength(1);
});
test('manual input must be explicit, bounded and immutable; refusal never enqueues', () => {
  for (const payload of [undefined, null, [], 'text', { long: 'x'.repeat(65537) }, JSON.parse('{"__proto__":{}}')])
    expect(() => service.start(flowId, { ...command('invalid'), payload })).toThrow();
  expect(() => service.start(flowId, { ...command(), environment: 'TESTING' })).toThrow('invalid_manual_request');
  const draft = createDraftVersion({ flowId, displayName: 'Mutable' });
  expect(() => service.start(flowId, { brief: { ...command().brief, versionId: draft.id }, payload: {} })).toThrow('immutable_version_required');
  expect(db.query('SELECT id FROM flow_run').all()).toEqual([]);
});
test('queue insertion failure rolls back the run and request receipt', () => {
  db.run("CREATE TRIGGER fixture_queue_failure BEFORE INSERT ON workflow_job BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  expect(() => service.start(flowId, command())).toThrow('fixture failure');
  expect(db.query('SELECT id FROM flow_run').all()).toEqual([]); expect(db.query('SELECT * FROM brief_manual_run_requests').all()).toEqual([]);
});
test('removal still fences new requests; accepted requests survive removal and do not replay', () => {
  const accepted = service.start(flowId, command());
  const removal = new WorkflowRemoval(db, DEFAULT_IDS.project, Date.now, () => true); removal.start({ refresh: async () => {} });
  try {
    const item = removal.read().data.items[0]!;
    removal.change({ scopeId: DEFAULT_IDS.project, flowId, versionId, expectedRevision: item.revision, requestId: 'remove', action: 'remove' });
    expect(service.start(flowId, command())).toEqual(accepted);
    expect(() => service.start(flowId, command('new'))).toThrow('workflow_removed');
    expect(db.query('SELECT id FROM flow_run').all()).toHaveLength(1);
  } finally { removal.stop(); }
});
test('additive schema upgrades twice without inventing run evidence or deleting request outcomes', () => {
  const result = service.start(flowId, command()); createSchema(db); createSchema(db);
  expect(service.request(flowId, 'fixture-request')).toEqual(result);
  const other = new Database(file); expect(other.query('SELECT * FROM brief_manual_run_requests').all()).toHaveLength(1); other.close();
});
test('disabled and replaced database providers fail closed', () => {
  expect(new WorkflowContext(db).readiness()).toBe('unavailable');
  closeWorkflowDb(); initWorkflowDb(':memory:'); expect(service.readiness()).toBe('unavailable');
  expect(() => service.selection(flowId, versionId)).toThrow('unavailable');
});

test('existing worker executes the explicitly submitted input once and inspection shows recorded output', async () => {
  const result = service.start(flowId, command('worker', { count: 7 })); let executions = 0;
  const worker = new Worker({ log: () => {}, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: {
    async execute(ctx) { executions++; expect(ctx.version.id).toBe(versionId); expect(ctx.payload).toEqual({ count: 7 });
      await progressWriter(ctx.run.id).updateRunProgress('fixture', { flowRun: { id: ctx.run.id, flowId, flowVersionId: versionId,
        projectId: DEFAULT_IDS.project, status: 'SUCCEEDED' }, step: { name: 'trigger', path: [],
        output: { type: 'EMPTY', status: 'SUCCEEDED', input: ctx.payload, output: 14 } } });
      return { stepsCount: 1, steps: getFlowRun(ctx.run.id)!.steps! }; },
  } }) } });
  await worker.drain(); service.start(flowId, command('worker', { count: 7 })); await worker.drain();
  expect(executions).toBe(1); const d = service.detail(flowId, result.run.runId);
  expect(d.status).toBe('succeeded'); expect(d.steps[0]?.fields[1]?.value).toBe('14');
  expect(d.steps[0]?.status).toBe('succeeded'); expect(d.steps[0]?.fields[0]?.value).toContain('7');
  expect(db.query('SELECT * FROM goal_progress').all()).toHaveLength(0);
});
test('real worker envelopes preserve nested loop evidence and redact payloads without unwrapping payload lookalikes', async () => {
  const r = run(), writer = progressWriter(r.id);
  const child = { type: 'CODE', status: 'FAILED', input: { count: 9, password: 'fixture-secret' }, output: false };
  const loop = { type: 'LOOP_ON_ITEMS', status: 'SUCCEEDED', input: [1], output: { iterations: [
    { nested: { type: 'LOOP_ON_ITEMS', status: 'SUCCEEDED', input: [2], output: { iterations: [{ child }] } } },
  ] } };
  await writer.updateRunProgress('fixture', { flowRun: { id: r.id, flowId, flowVersionId: versionId,
    projectId: DEFAULT_IDS.project, status: 'SUCCEEDED' }, step: { name: 'loop', path: [], output: loop } });
  const detail = service.detail(flowId, r.id);
  expect(detail.steps).toHaveLength(3); expect(new Set(detail.steps.map(s => s.id)).size).toBe(3);
  expect(detail.steps[0]).toMatchObject({ status: 'succeeded', fields: [{ label: 'Input', value: '[1]' }, {}] });
  const leaf = detail.steps.find(s => s.title.endsWith('child'))!;
  expect(leaf.status).toBe('failed'); expect(leaf.fields[0]?.value).toContain('9');
  expect(leaf.fields[1]?.value).toBe('false'); expect(JSON.stringify(detail)).not.toContain('fixture-secret');
  // An unwrapped step's application output may itself resemble a step record.
  updateRun(r.id, { steps: { direct: { type: 'CODE', status: 'SUCCEEDED', input: 4, output: child } } });
  const direct = service.detail(flowId, r.id).steps[0]!;
  expect(direct.status).toBe('succeeded'); expect(direct.fields[0]?.value).toBe('4');
  expect(direct.fields[1]?.value).toContain('9');
});
test('configured bindings share one cap across connection references and restricted auth entries', () => {
  for (const count of [199, 200]) {
    const v = createDraftVersion({ flowId, displayName: 'Bindings', trigger: { name: 'trigger', type: 'EMPTY',
      settings: { input: { auth: 'fixture-inline-secret' } } } });
    updateDraftVersion(v.id, { connectionIds: Array.from({ length: count }, (_,i) => `ref-${i}`) }); lockVersion(v.id);
    if (count === 200) expect(() => service.selection(flowId, v.id)).toThrow('context_capacity');
    else {
      const group = service.selection(flowId, v.id).context.groups.bindings;
      expect(group.status).toBe('ready'); if (group.status !== 'ready') throw Error();
      expect(group.data).toHaveLength(200); expect(group.data.at(-1)?.availability).toBe('redacted');
      expect(JSON.stringify(group)).not.toContain('fixture-inline-secret');
    }
  }
});
test('loop iterations retain individual actual inputs, outputs and statuses', () => {
  const r = run(); updateRun(r.id, { steps: { loop: { type: 'LOOP_ON_ITEMS', status: 'SUCCEEDED', input: [1,2], output: {
    iterations: [{ child: { status: 'SUCCEEDED', input: 1, output: true } }, { child: { status: 'FAILED', input: 2, output: false } }],
  } } } });
  const detail = service.detail(flowId, r.id); expect(detail.steps).toHaveLength(3);
  expect(new Set(detail.steps.map(s => s.id)).size).toBe(3);
  expect(detail.steps.find(s => s.title.includes('iteration-2'))).toMatchObject({ status: 'failed', fields: [{ label: 'Input', value: '2' }, { label: 'Output', value: 'false' }] });
});
test('goal references match configured and accepted work without reading arbitrary metadata or granting progress', () => {
  const goal = createGoal('Fixture goal', 'objective');
  const work = createWorkItem({ title: 'Fixture work', goalId: goal.id, mode: 'workflow', workflowId: flowId, workflowVersionId: versionId, input: {} });
  const configured = service.selection(flowId, versionId).context.groups.goal;
  expect(configured.status).toBe('ready'); expect(JSON.stringify(configured)).toContain(goal.id);
  decideWorkItem(work.id, { outcome: 'accepted', reason: 'fixture' });
  const r = startWorkItemRun(work.id, flowId);
  expect(JSON.stringify(service.selection(flowId, versionId, r.id).context.groups.goal)).toContain(goal.id);
  expect(db.query('SELECT * FROM goal_progress').all()).toHaveLength(0);
});
test('bounded command capacity never evicts an accepted identity or permits replay after history deletion', () => {
  const accepted = service.start(flowId, command());
  db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<9999)
    INSERT INTO brief_manual_run_requests SELECT 'fixture-project','request-'||i,'fixture-flow','digest','{}',1 FROM n`);
  expect(service.start(flowId, command())).toEqual(accepted);
  expect(() => service.start(flowId, command('over-capacity'))).toThrow('request_capacity');
  db.run('DELETE FROM workflow_job'); db.run('DELETE FROM flow_run');
  expect(service.start(flowId, command())).toEqual(accepted);
  expect(db.query('SELECT id FROM flow_run').all()).toHaveLength(0);
});

test('configured preparation references are scoped to their exact version and never claimed as actual run usage', () => {
  ensurePreparedSchema(db);
  const goal = createGoal('Prepared fixture goal', 'objective');
  const suggestion = createSuggestion({ type: 'automation', title: 'Fixture', body: 'Fixture', context: {} });
  db.run(`INSERT INTO prepared_opportunities (id,opportunity_id,revision,specification,state,flow_id,version_id,created_at,updated_at)
    VALUES ('prepared',?,'revision',?,'draft_ready',?,?,1,1)`, [suggestion.id, JSON.stringify({ goal: { goalId: goal.id }, evidence: [{ kind: 'fact', id: 'missing-reference' }] }), flowId, versionId]);
  const c = service.selection(flowId, versionId).context;
  expect(JSON.stringify(c.groups.goal)).toContain(goal.id); expect(c.groups.memory.status).toBe('ready');
  expect(JSON.stringify(c.groups.memory)).toContain('missing');
  const other = lockVersion(createDraftVersion({ flowId, displayName: 'Other', trigger: { name: 'trigger', type: 'EMPTY', settings: {} } }).id);
  expect(service.selection(flowId, other.id).context.groups.goal.status).toBe('unavailable');
  const r = run(); expect(service.selection(flowId, versionId, r.id).context.groups.goal.status).toBe('unavailable');
});
test('connection inspection never decrypts secrets or reads labels, even if the credential cannot be decrypted', () => {
  setEncryptionKey(Buffer.alloc(32, 0x21));
  const connection = upsertConnection({ externalId: 'fixture-account', displayName: 'private-connection-label', type: 'SECRET_TEXT', pieceName: 'fixture-piece', pieceVersion: '1', value: { secret: 'private-fixture-credential' } });
  db.run("UPDATE app_connection SET value='not-valid-ciphertext-or-json' WHERE id=?", [connection.id]);
  setEncryptionKey(null);
  const draft = createDraftVersion({ flowId, displayName: 'Connected', trigger: { name: 'trigger', type: 'EMPTY', settings: { input: { auth: '{{connections.fixture-account}}' } } } });
  db.run("UPDATE flow_version SET state='LOCKED' WHERE id=?", [draft.id]);
  const projected = service.selection(flowId, draft.id), raw = JSON.stringify(projected);
  expect(raw).toContain(connection.id); expect(raw).not.toContain('private-connection-label'); expect(raw).not.toContain('private-fixture-credential');
  expect(projected.context.groups.bindings.status).toBe('ready');
});
test('manual run retains CODE permission and readiness gates and bounds nesting before any writes', () => {
  const draft = createDraftVersion({ flowId, displayName: 'Code', trigger: { name: 'trigger', type: 'EMPTY', settings: {}, nextAction: { name: 'code', type: 'CODE', settings: { sourceCode: { code: 'fixture', packageJson: '{}' } } } } });
  db.run("UPDATE flow_version SET state='LOCKED' WHERE id=?", [draft.id]);
  expect(() => service.start(flowId, { brief: { ...command().brief, versionId: draft.id }, payload: {} })).toThrow();
  db.run("UPDATE flow_version SET trigger=? WHERE id=?", [JSON.stringify({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'unavailable-piece', triggerName: 'missing' } }), draft.id]);
  expect(() => service.start(flowId, { brief: { ...command().brief, versionId: draft.id }, payload: {} })).toThrow();
  let input: Record<string, unknown> = {}; for (let i = 0; i < 18; i++) input = { nested: input };
  expect(() => service.start(flowId, command('deep', input))).toThrow('input_too_complex');
  expect(db.query('SELECT id FROM flow_run').all()).toHaveLength(0); expect(db.query('SELECT * FROM brief_manual_run_requests').all()).toHaveLength(0);
});

test('nested execution paths cannot collide with literal step names in the inspector', () => {
  const r = run(); updateRun(r.id, { steps: {
    'loop-iteration-1-child': { status: 'FAILED', input: 1 },
    loop: { type: 'LOOP_ON_ITEMS', status: 'SUCCEEDED', output: { iterations: [{ child: { status: 'SUCCEEDED', input: 2 } }] } },
  } });
  const detail = service.detail(flowId, r.id);
  expect(detail.steps).toHaveLength(3); expect(new Set(detail.steps.map(s => s.id)).size).toBe(3);
});
test('malformed legacy step containers are unavailable rather than a fabricated empty inspection', () => {
  const r = run(); db.run('UPDATE flow_run SET steps=? WHERE id=?', [JSON.stringify('not-a-step-map'), r.id]);
  expect(() => service.detail(flowId, r.id)).toThrow('record_unavailable');
});

test('untrusted prototype status names remain uncertain and non-finite input is refused', () => {
  const r = run(); updateRun(r.id, { steps: { trigger: { status: 'constructor', input: 1, output: true } } });
  expect(service.detail(flowId, r.id).steps[0]?.status).toBe('uncertain');
  expect(() => service.start(flowId, command('non-finite', JSON.parse('{"count":1e999}')))).toThrow('invalid_input_number');
  expect(db.query('SELECT id FROM workflow_job').all()).toHaveLength(0);
});
