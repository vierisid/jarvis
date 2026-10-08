import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '../../db';
import { createFlow, updateFlowStatus, setPublishedVersion } from '../../db/repos/flow';
import { createDraftVersion, lockVersion, mergeRunOutputsIntoSampleData } from '../../db/repos/flow-version';
import { queueStats } from '../../db/repos/job-queue';
import { configureWorkflowReadiness } from '../../db/repos/flow-readiness';
import { PieceCatalog } from '../../runtime/piece-catalog';
import { WorkflowEventBus } from '../../runtime/event-bus';
import { TriggerManager } from './manager';
import type { CronScheduler } from './cron';
import type { EngineRuntime } from '../engine-runtime/engine-runtime';
import { WorkflowRemoval } from '../../../brief/workflow-removal';
import type { WorkflowManageCommand } from '../../../brief/workflow-removal-contracts';

let service: WorkflowRemoval, tm: TriggerManager, saved: string | undefined;
beforeEach(() => {
  saved = process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL; process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL = '1'; initWorkflowDb(':memory:');
  configureWorkflowReadiness({ pieces: new PieceCatalog([{ name: 'jarvis-trigger', displayName: '', description: '', actions: {},
    triggers: { on_event: { name: 'on_event', displayName: '', description: '' } } }]) });
  service = new WorkflowRemoval(getWorkflowDb());
});
afterEach(async () => { service.stop(); await tm?.stop(); closeWorkflowDb();
  if (saved === undefined) delete process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL; else process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL = saved; });
function flow(trigger: Record<string, unknown>) {
  const f = createFlow(), v = createDraftVersion({ flowId: f.id, displayName: 'Fixture', trigger });
  lockVersion(v.id); setPublishedVersion(f.id, v.id); updateFlowStatus(f.id, 'ENABLED'); return f.id;
}
function command(flowId: string, action: WorkflowManageCommand['action'] = 'remove', extra: Partial<WorkflowManageCommand> = {}): WorkflowManageCommand {
  const i = service.read().data.items.find(i => i.flowId === flowId)!;
  return { scopeId: service.projectId, flowId, versionId: i.versionId, expectedRevision: i.revision, requestId: crypto.randomUUID(), action, ...extra };
}
const settle = () => new Promise<void>(r => setImmediate(r));
class Cron {
  callbacks = new Map<string, () => void>();
  schedule(id: string, _expression: string, cb: () => void) { this.callbacks.set(id, cb); }
  cancel(id: string) { this.callbacks.delete(id); }
  cancelAll() { this.callbacks.clear(); }
}
test('removal fences cron immediately before asynchronous teardown; old callback cannot survive Undo and re-enable', async () => {
  const f = flow({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input: { cronExpression: '* * * * *' } } });
  const cron = new Cron(); tm = new TriggerManager({ eventBus: new WorkflowEventBus(), cronScheduler: cron as unknown as CronScheduler, log: () => {} });
  await tm.start(); service.start(tm); const old = cron.callbacks.get(`flow:${f}`)!;
  old(); expect(queueStats().queued).toBe(1);
  const c = command(f), removed = service.change(c); if (removed.status !== 'accepted' || !removed.receipt) throw Error('not removed');
  old(); expect(queueStats().queued).toBe(1); await service.reconcileFlow(f);
  expect(cron.callbacks.size).toBe(0);
  service.change({ ...c, action: 'restore', requestId: 'restore', receiptId: removed.receipt.receiptId }); await service.reconcileFlow(f);
  old(); expect(queueStats().queued).toBe(1);
  service.change(command(f, 'activation', { activation: 'ENABLED' })); await service.reconcileFlow(f);
  old(); expect(queueStats().queued).toBe(1);
  cron.callbacks.get(`flow:${f}`)!(); expect(queueStats().queued).toBe(2);
});
test('event delivery is refused immediately after removal even while teardown is stalled', async () => {
  const f = flow({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'jarvis-trigger', triggerName: 'on_event', input: { eventType: 'fixture.event' } } });
  const bus = new WorkflowEventBus(); tm = new TriggerManager({ eventBus: bus, log: () => {} }); await tm.start();
  service.start({ refresh: () => new Promise(() => {}) });
  bus.publish('fixture.event', { n: 1 }); expect(queueStats().queued).toBe(1);
  service.change(command(f)); bus.publish('fixture.event', { n: 2 }); expect(queueStats().queued).toBe(1);
  expect(service.read().data.removals[0]?.registration).toBe('pending');
});
test('a polling result accepted before removal cannot create a run after Undo and explicit re-enable', async () => {
  const f = flow({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'jarvis-trigger', triggerName: 'on_event', input: {} } });
  const cron = new Cron(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<{ output: unknown[] }>(); let polls = 0;
  const runtime = { async acquire() { return { async release() {}, async executeTriggerHook(hook: string) {
    if (hook === 'ON_ENABLE') return { scheduleOptions: { cronExpression: '* * * * *' }, listeners: [] };
    if (hook === 'ON_DISABLE') return {};
    polls++; if (polls === 1) { entered.resolve(); return release.promise; } return { output: [{ new: true }] };
  } }; } } as unknown as EngineRuntime;
  tm = new TriggerManager({ eventBus: new WorkflowEventBus(), cronScheduler: cron as unknown as CronScheduler, engineRuntime: runtime, log: () => {} });
  await tm.start(); service.start(tm); const old = cron.callbacks.get(`flow:${f}`)!; old(); await entered.promise;
  const c = command(f), result = service.change(c); if (result.status !== 'accepted' || !result.receipt) throw Error('not removed');
  await service.reconcileFlow(f);
  service.change({ ...c, action: 'restore', requestId: 'restore', receiptId: result.receipt.receiptId }); await service.reconcileFlow(f);
  service.change(command(f, 'activation', { activation: 'ENABLED' })); await service.reconcileFlow(f);
  release.resolve({ output: [{ old: true }] }); await settle(); await settle(); expect(queueStats().queued).toBe(0);
  old(); await settle(); expect(polls).toBe(1);
  cron.callbacks.get(`flow:${f}`)!(); await settle(); await settle(); expect(queueStats().queued).toBe(1);
});
test('removal during ON_ENABLE prevents a late subscription and reconciles the captured engine version', async () => {
  const f = flow({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'jarvis-trigger', triggerName: 'on_event', input: {} } });
  const cron = new Cron(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<unknown>(); let disables = 0;
  const runtime = { async acquire() { return { async release() {}, async executeTriggerHook(hook: string) {
    if (hook === 'ON_ENABLE') { entered.resolve(); return release.promise; }
    if (hook === 'ON_DISABLE') disables++; return {};
  } }; } } as unknown as EngineRuntime;
  tm = new TriggerManager({ eventBus: new WorkflowEventBus(), cronScheduler: cron as unknown as CronScheduler, engineRuntime: runtime, log: () => {} });
  service.start(tm); const registering = tm.refresh(f); await entered.promise;
  service.change(command(f)); release.resolve({ scheduleOptions: { cronExpression: '* * * * *' }, listeners: [] });
  await registering; await service.reconcileFlow(f);
  expect(cron.callbacks.size).toBe(0); expect(tm.list()).toEqual([]); expect(disables).toBe(1); expect(queueStats().queued).toBe(0);
});

for (const secret of [undefined, 'fixture-webhook-secret']) test(`R3: pending ${secret ? 'signed' : 'unsigned'} webhook cannot cross Remove/Undo/Enable`, async () => {
  const f = flow({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook', input: { ...(secret ? { secret } : {}) } } });
  tm = new TriggerManager({ eventBus: new WorkflowEventBus(), log: () => {} }); await tm.start(); service.start(tm);
  const payload = JSON.stringify({ stale: true }), headers: Record<string, string> = {};
  if (secret) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    headers['x-jarvis-signature'] = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))).toString('hex');
  }
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const request = new Request(`http://localhost/webhooks/${f}`, { method: 'POST', headers,
    body: new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }) });
  const pending = tm.webhookManager().handleRequest(f, request); await settle();
  const c = command(f), removed = service.change(c); if (removed.status !== 'accepted' || !removed.receipt) throw Error('not removed');
  await service.reconcileFlow(f);
  service.change({ ...c, action: 'restore', requestId: 'restore', receiptId: removed.receipt.receiptId }); await service.reconcileFlow(f);
  service.change(command(f, 'activation', { activation: 'ENABLED' })); await service.reconcileFlow(f);
  body.enqueue(new TextEncoder().encode(payload)); body.close(); const response = await pending;
  expect(queueStats().queued).toBe(0); expect(response.status).toBe(409);
  const fresh = await tm.webhookManager().handleRequest(f, new Request(`http://localhost/webhooks/${f}`, { method: 'POST', headers, body: payload }));
  expect(fresh.status).toBe(200); expect(queueStats().queued).toBe(1);
});

test('R4: trigger dispatch uses the restored draft even after older run bookkeeping', async () => {
  const f = createFlow(), old = createDraftVersion({ flowId: f.id, displayName: 'Old', trigger: { name: 'trigger', type: 'EMPTY', settings: {} } });
  const selected = createDraftVersion({ flowId: f.id, displayName: 'Selected schedule', trigger: {
    name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input: { cronExpression: '* * * * *' } },
  } });
  getWorkflowDb().run('UPDATE flow_version SET updated = 1 WHERE id = ?', [old.id]);
  getWorkflowDb().run('UPDATE flow_version SET updated = 2 WHERE id = ?', [selected.id]);
  updateFlowStatus(f.id, 'ENABLED'); const cron = new Cron();
  tm = new TriggerManager({ eventBus: new WorkflowEventBus(), cronScheduler: cron as unknown as CronScheduler, log: () => {} });
  await tm.start(); service.start(tm);
  const c = command(f.id), removed = service.change(c); if (removed.status !== 'accepted' || !removed.receipt) throw Error('not removed');
  await service.reconcileFlow(f.id);
  service.change({ ...c, action: 'restore', requestId: 'restore', receiptId: removed.receipt.receiptId }); await service.reconcileFlow(f.id);
  mergeRunOutputsIntoSampleData(old.id, { action: { output: { late: true } } });
  service.change(command(f.id, 'activation', { activation: 'ENABLED' })); await service.reconcileFlow(f.id);
  expect(cron.callbacks.size).toBe(1); cron.callbacks.get(`flow:${f.id}`)!();
  expect(getWorkflowDb().query('SELECT flow_version_id FROM flow_run WHERE flow_id = ?').all(f.id)).toEqual([{ flow_version_id: selected.id }]);
});
