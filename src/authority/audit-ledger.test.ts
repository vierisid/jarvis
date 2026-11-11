import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { ApprovalManager } from './approval.ts';
import { AuditTrail } from './audit.ts';
import { DeferredExecutor } from './deferred-executor.ts';
import type { ToolRegistry } from '../actions/tools/registry.ts';
import { applyApprovalDecision } from '../daemon/approval-decision.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

const audit = () => new AuditTrail();
function asked(mgr: ApprovalManager, trail: AuditTrail) {
  const request = mgr.createRequest({ agentId: 'a1', agentName: 'PA', toolName: 'send_email', toolArguments: { to: 'x@example.test' },
    actionCategory: 'send_email', urgency: 'normal', reason: 'test', context: '' });
  trail.log({ agent_id: 'a1', agent_name: 'PA', tool_name: 'send_email', action_category: 'send_email',
    authority_decision: 'approval_required', approval_id: request.id, executed: false });
  return request;
}
async function decide(action: 'approve' | 'deny', run: () => Promise<string>, device: string | null = 'dev-1') {
  const mgr = new ApprovalManager(), trail = audit();
  const executor = new DeferredExecutor(mgr, trail);
  executor.setToolRegistry({ get: () => undefined, execute: run } as unknown as ToolRegistry);
  const request = asked(mgr, trail);
  await applyApprovalDecision(action, request.id, 'dashboard', { approvalManager: mgr, deferredExecutor: executor, auditTrail: trail, decidedDevice: device });
  return { trail, request };
}

describe('the ledger reads one entry per side effect', () => {
  test('an approved action that ran is one entry with its outcome, however many rows it wrote', async () => {
    const { trail, request } = await decide('approve', async () => 'sent');
    expect(trail.query({ agentId: 'a1' }).length).toBeGreaterThanOrEqual(3);
    const entries = trail.queryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ approval_id: request.id, outcome: 'succeeded', executed: 1, authority_decision: 'approval_required', events: 3 });
    expect(trail.getStats()).toMatchObject({ total: 1, approvalRequired: 1, byOutcome: { succeeded: 1 } });
  });

  test('a denied action is one denied entry that did not run', async () => {
    const { trail } = await decide('deny', async () => 'never');
    expect(trail.queryEntries()).toMatchObject([{ authority_decision: 'denied', outcome: 'not_started', executed: 0 }]);
    expect(trail.getStats()).toMatchObject({ total: 1, denied: 1, byOutcome: { not_started: 1 } });
  });

  test('an approved action whose run threw is not marked executed', async () => {
    const { trail } = await decide('approve', async () => { throw new Error('smtp down'); });
    expect(trail.queryEntries()).toMatchObject([{ outcome: 'failed', executed: 0 }]);
  });

  test('the entry records which device decided, by name when it is still enrolled', async () => {
    getDb().run("INSERT INTO sidecars (id, name, token_id, status, enrolled_at) VALUES ('dev-1', 'Studio laptop', 'tok-1', 'enrolled', datetime('now'))");
    const { trail } = await decide('approve', async () => 'sent', 'dev-1');
    expect(trail.queryEntries()[0]).toMatchObject({ decided_by: 'dashboard:dev-1', decided_device: 'Studio laptop' });
    const other = await decide('approve', async () => 'sent', null);
    expect(other.trail.queryEntries().find(e => e.approval_id === other.request.id)?.decided_by).toBe('dashboard');
  });

  test('a decision row joins the workflow effect its approval belongs to', () => {
    const trail = audit();
    getDb().run('CREATE TABLE IF NOT EXISTS workflow_effect (id TEXT PRIMARY KEY, approval_id TEXT)');
    getDb().run("INSERT INTO workflow_effect (id, approval_id) VALUES ('wfe_1', 'appr_1')");
    trail.log({ agent_id: 'workflow:r1', agent_name: 'Workflow F / s / wfe_1', tool_name: 'workflow_notify', action_category: 'send_message',
      authority_decision: 'approval_required', approval_id: 'appr_1', executed: false, effect_id: 'wfe_1' });
    trail.log({ agent_id: 'workflow:r1', agent_name: 'Workflow F / s', tool_name: 'workflow_notify', action_category: 'send_message',
      authority_decision: 'allowed', approval_id: 'appr_1', executed: false, decided_by: 'dashboard:dev-9' });
    trail.log({ agent_id: 'workflow:r1', agent_name: 'Workflow F / s / wfe_1', tool_name: 'workflow_notify', action_category: 'send_message',
      authority_decision: 'approval_required', approval_id: 'appr_1', executed: true, effect_id: 'wfe_1', outcome: 'succeeded' });
    expect(trail.query({ agentId: 'workflow:r1' }).map(r => r.effect_id)).toEqual(['wfe_1', 'wfe_1', 'wfe_1']);
    expect(trail.queryEntries()).toMatchObject([{ effect_id: 'wfe_1', events: 3, outcome: 'succeeded', decided_by: 'dashboard:dev-9' }]);
    expect(trail.getStats().total).toBe(1);
  });

  test('filters apply to entries, and rows that share no effect or approval stay separate', () => {
    const trail = audit();
    for (const tool of ['a', 'b']) trail.log({ agent_id: 'x', agent_name: 'X', tool_name: tool, action_category: 'read_data', authority_decision: 'allowed', executed: true });
    expect(trail.queryEntries()).toHaveLength(2);
    expect(trail.queryEntries({ tool: 'a' })).toHaveLength(1);
    expect(trail.queryEntries({ decision: 'denied' })).toHaveLength(0);
    expect(trail.getStats()).toMatchObject({ total: 2, allowed: 2 });
  });
});
