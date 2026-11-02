/** Real ingress, durable queue/ledger, handler and effect boundary; Sheets is a local fixture. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../../db';
import { createFlow, getFlow, deleteFlow, setPublishedVersion, updateFlowStatus } from '../../db/repos/flow';
import { createDraftVersion, getLatestDraft, lockVersion } from '../../db/repos/flow-version';
import { createFlowRun, getFlowRun, listRuns } from '../../db/repos/flow-run';
import { enqueue } from '../../db/repos/job-queue';
import { pruneFires, FIRE_RETENTION_MS } from '../../db/repos/trigger-fire';
import { configureWorkflowReadiness } from '../../db/repos/flow-readiness';
import { PieceCatalog } from '../../runtime/piece-catalog';
import { WorkflowEventBus } from '../../runtime/event-bus';
import { WorkflowEventBuffer } from '../../runtime/event-buffer';
import { TriggerManager } from './manager';
import { Worker } from '../../queue/worker';
import { createRunFlowHandler, RUN_FLOW } from '../handler';
import { evaluateWorkflowExpression } from '../../runtime/safe-expression';
import { pieceInputDigest, executeAuthorizedPiece } from '../../runtime/piece-effect-guard';
import { buildSandboxServiceBackends } from '../../runtime/service-backends';
import { CredentialResolver } from '../../credentials/adapter';
import { AuthorityEngine } from '../../../authority/engine';
import { EmergencyController } from '../../../authority/emergency';
import { AuditTrail } from '../../../authority/audit';
import { createManageWorkflowTool } from '../../../actions/tools/manage-workflow';
import { compileWorkflow } from '../../runtime/workflow-readiness';
import { UNTRUSTED_OPEN } from '../../../roles/untrusted';
const SHEETS = '@activepieces/piece-google-sheets';
let dir: string, manager: TriggerManager;
const catalog = () => new PieceCatalog([{ name: SHEETS, displayName: 'Google Sheets fixture', description: 'No network', actions: {
  sheets_append_values: { name: 'sheets_append_values', displayName: 'Append rows', description: 'Fixture of inspected action schema', inputSchema: { fields: [
    ...['spreadsheet_id', 'worksheet_title', 'range', 'value_input_option'].map(name => ({ name, label: name, type: 'string' as const, required: true })),
    { name: 'values', label: 'Values', type: 'json', required: true },
  ] } },
} }]);
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jarvis-forms-')); initWorkflowDb(join(dir, 'fixture.db')); configureWorkflowReadiness({ pieces: catalog() }); });
afterEach(async () => { await manager?.stop(); closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); });
function submissionGraph() { return {
    name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook', input: { submission_id_field: 'id', submission_email_field: 'email' } },
    nextAction: { name: 'append', type: 'PIECE', settings: { pieceName: SHEETS, pieceVersion: '0.18.2', actionName: 'sheets_append_values', input: {
      spreadsheet_id: 'fixture-only', worksheet_title: 'Submissions', range: 'A:C', value_input_option: 'RAW', values: [['{{trigger.id}}', '{{trigger.email}}', '{{trigger.name}}']],
    } } },
  }; }
async function fixture(failAfterWrite = false) {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Form submissions fixture', trigger: submissionGraph() });
  lockVersion(version.id); setPublishedVersion(flow.id, version.id); updateFlowStatus(flow.id, 'ENABLED');
  manager = new TriggerManager({ eventBus: new WorkflowEventBus(), log: () => {} }); await manager.start();
  const rows: unknown[][] = [];
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const services = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), llmManager: {} as any,
    authorityEngine: authority, emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(),
    channelService: { getChannelStatus: () => ({}), tryBroadcastToChannels: async () => ({ delivered: [], failed: [] }) } as any,
    wsService: { broadcastNotificationToDashboard: () => 0 } as any });
  const resolve = (value: any, payload: Record<string, unknown>): any => {
    if (typeof value === 'string' && value.startsWith('{{')) return evaluateWorkflowExpression(value.slice(2, -2), { trigger: payload });
    if (Array.isArray(value)) return value.map(v => resolve(v, payload));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, resolve(v,payload)]));
    return value;
  };
  const worker = new Worker({ log: () => {}, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: {
    execute: async ctx => {
      const input = resolve(ctx.version.trigger.nextAction!.settings!.input, ctx.payload);
      const identity = { runId: ctx.run.id, projectId: DEFAULT_IDS.project, stepName: 'append', executionPath: [] };
      const governance = await services.pieceAuthorize!({ piece: SHEETS, action: 'sheets_append_values', input, inputDigest: await pieceInputDigest(input) }, identity);
      const result = await executeAuthorizedPiece({ apiUrl: 'http://fixture.invalid', engineToken: 'fixture-only', piece: SHEETS, action: 'sheets_append_values', input,
        stepName: 'append', executionPath: [], fetchImpl: (async (_url, init) => {
          const body = JSON.parse(String(init?.body)); services.pieceReceipt!(identity, body.effectId, body.result); return Response.json({ recorded: true });
        }) as typeof fetch }, governance, async () => {
          rows.push(...input.values);
          if (failAfterWrite) throw Error('Fixture: provider wrote the row but response was lost');
          return { updatedRows: 1, updatedRange: 'Submissions!A2:C2' };
        });
      return { stepsCount: 2, steps: { trigger: { output: ctx.payload }, append: { output: result } } };
    },
  } }) } });
  return { flowId: flow.id, versionId: version.id, rows, worker };
}
const send = (flowId: string, payload: unknown, key?: string) => manager.webhookManager().handleRequest(flowId,
  new Request('http://localhost/api/webhooks/' + flowId, { method: 'POST', body: JSON.stringify(payload), headers: key ? { 'idempotency-key': key } : {} }));
const valid = { id: ' a1 ', email: ' ME@EXAMPLE.COM ', name: ' Alice ' };

test('concurrent and repeated submissions append one normalized row, independent of delivery headers', async () => {
  const f = await fixture();
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => send(f.flowId, valid, 'different-' + i)));
  const replies = await Promise.all(responses.map(r => r.json()));
  expect(replies.filter(r => r.outcome === 'started')).toHaveLength(1);
  expect(replies.filter(r => r.outcome === 'duplicate')).toHaveLength(11);
  await f.worker.drain();
  expect(f.rows).toEqual([['a1', 'me@example.com', 'Alice']]);
  expect(listRuns({ flowId: f.flowId })).toHaveLength(1);
  expect(listRuns({ flowId: f.flowId })[0]!.status).toBe('SUCCEEDED');
  expect((await (await send(f.flowId, { ...valid, id: 'a1' })).json()).outcome).toBe('duplicate');
  await send(f.flowId, { ...valid, id: 'a2' }); await f.worker.drain(); expect(f.rows).toHaveLength(2);
});

test('invalid submissions queue nothing and do not consume the ID', async () => {
  const f = await fixture();
  for (const payload of [{ ...valid, id: ' ' }, { ...valid, email: 'invalid' }, {}, [], 'not a form']) expect((await send(f.flowId, payload)).status).toBe(422);
  expect(listRuns({ flowId: f.flowId })).toHaveLength(0); expect(f.rows).toHaveLength(0);
  expect((await send(f.flowId, valid)).status).toBe(200); await f.worker.drain(); expect(f.rows).toHaveLength(1);
});

test('deduplication survives restart and ordinary 30-day history pruning', async () => {
  const f = await fixture(); await send(f.flowId, valid); await f.worker.drain();
  await manager.stop(); pruneFires(Date.now() + FIRE_RETENTION_MS + 1000); closeWorkflowDb();
  initWorkflowDb(join(dir, 'fixture.db')); configureWorkflowReadiness({ pieces: catalog() });
  manager = new TriggerManager({ eventBus: new WorkflowEventBus(), log: () => {} }); await manager.start();
  expect((await (await send(f.flowId, valid)).json()).outcome).toBe('duplicate');
  expect(listRuns({ flowId: f.flowId })).toHaveLength(1); expect(f.rows).toHaveLength(1);
});

test('uncertain append cannot be resent by webhook retry or a fresh manual run', async () => {
  const f = await fixture(true); const first = await (await send(f.flowId, valid)).json(); await f.worker.drain();
  expect(getFlowRun(first.runId)?.status).toBe('FAILED'); expect(f.rows).toHaveLength(1);
  expect((await (await send(f.flowId, valid)).json()).outcome).toBe('duplicate');
  const run = createFlowRun({ flowId: f.flowId, flowVersionId: f.versionId });
  enqueue({ jobType: RUN_FLOW, payload: { runId: run.id, payload: valid }, flowRunId: run.id, flowId: f.flowId, flowVersionId: f.versionId });
  await f.worker.drain(); expect(getFlowRun(run.id)?.status).toBe('FAILED');
  expect(getFlowRun(run.id)?.failedStep?.errorMessage).toContain('already accepted'); expect(f.rows).toHaveLength(1);
});

test('manual runs validate and normalize too; a single-step preview cannot bypass the form guard', async () => {
  const f = await fixture();
  for (const [payload, extra, expected] of [[{ ...valid, email: 'bad' }, {}, 'FAILED'], [valid, { stepNameToTest: 'append' }, 'FAILED'], [valid, {}, 'SUCCEEDED']] as const) {
    const run = createFlowRun({ flowId: f.flowId, flowVersionId: f.versionId });
    enqueue({ jobType: RUN_FLOW, payload: { runId: run.id, payload, ...extra }, flowRunId: run.id, flowId: f.flowId, flowVersionId: f.versionId });
    await f.worker.drain(); expect(getFlowRun(run.id)?.status).toBe(expected);
  }
  expect(f.rows).toEqual([['a1', 'me@example.com', 'Alice']]);
  expect((await (await send(f.flowId, valid)).json()).outcome).toBe('duplicate');
});


test('workflow builder saves the complete processor as a disabled draft without running it', async () => {
  const tool = createManageWorkflowTool({ pieceRegistry: catalog(), llm: { async chat({ system }) {
    expect(system).toContain('submission_id_field');
    expect(system).toContain('atomically accepts each ID once');
    return { text: JSON.stringify({ displayName: 'Form submissions fixture', trigger: submissionGraph() }) };
  } } });
  const raw = await tool.execute({ action: 'compose', name: 'Form submissions fixture',
    description: 'Fixture only: webhook id/email/name, normalize and validate, append RAW rows to fixture-only spreadsheet, Submissions tab A:C, duplicate IDs must not append again. Save disabled. Do not run.' }) as string;
  const lines = raw.split('\n');
  const result = JSON.parse(lines[1]?.startsWith(UNTRUSTED_OPEN) ? lines.slice(2, -1).join('\n') : raw);
  expect(result.ok).toBe(true);
  const saved = getFlow(result.flow.id)!;
  expect(saved.status).toBe('DISABLED');
  expect(saved.published_version_id).toBeNull();
  const version = getLatestDraft(saved.id)!;
  expect(version.trigger.settings?.input).toEqual({ submission_id_field: 'id', submission_email_field: 'email' });
  expect(version.trigger.nextAction?.settings?.actionName).toBe('sheets_append_values');
  expect(version.trigger.nextAction?.settings?.input?.values).toEqual([['{{trigger.id}}', '{{trigger.email}}', '{{trigger.name}}']]);
  expect(compileWorkflow(version.trigger, { pieces: catalog() }).ready).toBe(true);
  expect(listRuns({ flowId: saved.id })).toHaveLength(0);
  const liveCatalog = catalog();
  liveCatalog.upsert({ ...liveCatalog.get(SHEETS)!, auth: { type: 'OAUTH2' } });
  expect(compileWorkflow(version.trigger, { pieces: liveCatalog }).issues).toContainEqual(expect.objectContaining({ code: 'CONNECTION_BINDING' }));
  const unconfigured = submissionGraph();
  unconfigured.nextAction.settings.input.spreadsheet_id = '';
  expect(compileWorkflow(unconfigured, { pieces: liveCatalog }).ready).toBe(false);
});


test('form identities outlive run history but can be pruned after workflow deletion', async () => {
  const f = await fixture(); await send(f.flowId, valid); await f.worker.drain();
  getWorkflowDb().run('DELETE FROM flow_run WHERE flow_id = ?', [f.flowId]);
  pruneFires(Date.now() + FIRE_RETENTION_MS + 1000);
  expect((await (await send(f.flowId, valid)).json()).outcome).toBe('duplicate');
  expect(f.rows).toHaveLength(1);
  await manager.stop(); deleteFlow(f.flowId);
  expect(pruneFires(Date.now() + FIRE_RETENTION_MS + 1000)).toBe(1);
});
