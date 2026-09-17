import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { ApprovalManager, executionState, type ApprovalExecutionMode, type ApprovalRequest } from './approval.ts';
import { AuditTrail } from './audit.ts';
import { DeferredExecutor } from './deferred-executor.ts';
import { EmergencyController } from './emergency.ts';
import type { ToolRegistry } from '../actions/tools/registry.ts';
import { applyApprovalDecision, applyExecutionResolution } from '../daemon/approval-decision.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

function request(mgr: ApprovalManager, overrides: { toolName?: string; executionMode?: ApprovalExecutionMode } = {}) {
  return mgr.createRequest({
    agentId: 'a1', agentName: 'PA', toolName: overrides.toolName ?? 'send_email',
    toolArguments: { to: 'x@example.com' }, actionCategory: 'send_email',
    urgency: 'normal', reason: 'test', context: '',
    ...(overrides.executionMode ? { executionMode: overrides.executionMode } : {}),
  });
}
function executor(mgr: ApprovalManager, run: () => Promise<string>) {
  const ex = new DeferredExecutor(mgr, new AuditTrail());
  ex.setToolRegistry({ execute: run } as unknown as ToolRegistry);
  return ex;
}
/** The daemon coming back: a manager with a new boot id that reconciles before serving. */
function restart() {
  const next = new ApprovalManager();
  const counts = next.reconcileAfterRestart();
  return { mgr: next, counts };
}

describe('execution claim and receipt', () => {
  test('the claim is exclusive: two surfaces resolving one approval run it once', async () => {
    const mgr = new ApprovalManager();
    const req = request(mgr);
    mgr.approve(req.id, 'dashboard');
    let runs = 0;
    const ex = executor(mgr, async () => { runs++; await new Promise(r => setTimeout(r, 20)); return 'sent'; });
    const [first, second] = await Promise.all([ex.executeApproved(req.id, 'dashboard'), ex.executeApproved(req.id, 'voice')]);
    expect(runs).toBe(1);
    expect(first).toBe('sent');
    expect(second).toContain('already taken for execution (in_flight)');
    expect(mgr.getRequest(req.id)).toMatchObject({ status: 'executed', execution_outcome: 'committed',
      execution_claimed_by: 'dashboard', execution_boot_id: mgr.bootId, execution_result: 'sent' });
  });

  test('receipts say what the execution produced', async () => {
    const mgr = new ApprovalManager();
    const committed = request(mgr); mgr.approve(committed.id, 'dashboard');
    await executor(mgr, async () => 'sent').executeApproved(committed.id);
    expect(mgr.getRequest(committed.id)).toMatchObject({ status: 'executed', execution_outcome: 'committed' });

    const failed = request(mgr); mgr.approve(failed.id, 'dashboard');
    await executor(mgr, async () => { throw new Error('smtp down'); }).executeApproved(failed.id);
    expect(mgr.getRequest(failed.id)).toMatchObject({ status: 'executed', execution_outcome: 'failed',
      execution_result: expect.stringContaining('smtp down') });

    const blocked = request(mgr); mgr.approve(blocked.id, 'dashboard');
    const ex = executor(mgr, async () => 'sent');
    const emergency = new EmergencyController(); emergency.pause(); ex.setEmergencyController(emergency);
    await ex.executeApproved(blocked.id);
    expect(mgr.getRequest(blocked.id)).toMatchObject({ status: 'executed', execution_outcome: 'blocked' });
  });

  test('a receipt needs an approved row', () => {
    const mgr = new ApprovalManager();
    const req = request(mgr);
    expect(mgr.markExecuted(req.id, 'too early')).toBe(false);
    expect(mgr.getRequest(req.id)!.status).toBe('pending');
    mgr.approve(req.id, 'dashboard');
    expect(mgr.markExecuted(req.id, 'done')).toBe(true);
    expect(mgr.markExecuted(req.id, 'again')).toBe(false);
    expect(mgr.getRequest(req.id)!.execution_result).toBe('done');
  });

  test('the deciding surface is recorded on the claim', async () => {
    const mgr = new ApprovalManager();
    const req = request(mgr);
    const ex = executor(mgr, async () => 'sent');
    await applyApprovalDecision('approve', req.id, 'notification', { approvalManager: mgr, deferredExecutor: ex });
    expect(mgr.getRequest(req.id)).toMatchObject({ decided_by: 'notification', execution_claimed_by: 'notification', execution_outcome: 'committed' });
  });
});

describe('reconciliation after a restart', () => {
  test('before execution: approved and unclaimed is not started, waits for the user, and is never run on its own', async () => {
    const before = new ApprovalManager();
    const req = request(before);
    before.approve(req.id, 'dashboard');

    const { mgr: after, counts } = restart();
    expect(counts).toEqual({ demotedInline: 0, notStarted: 1, interrupted: 0 });
    const row = after.getRequest(req.id)!;
    expect(row).toMatchObject({ status: 'approved', execution_outcome: 'not_started', execution_claimed_at: null });
    expect(executionState(row)).toBe('not_started');
    expect(after.getUnresolved().map(r => r.id)).toEqual([req.id]);
    expect(after.getPending()).toEqual([]);
    // The decision already happened; the old endpoints have nothing to flip.
    expect(after.approve(req.id, 'dashboard')).toBeNull();
    expect(after.deny(req.id, 'dashboard')).toBeNull();

    let runs = 0;
    const ex = executor(after, async () => { runs++; return 'sent'; });
    const deps = { approvalManager: after, deferredExecutor: ex };
    expect(runs).toBe(0);
    const first = await applyExecutionResolution('execute', req.id, 'dashboard', deps);
    expect(first).toMatchObject({ status: 'executed', result: 'sent' });
    expect(runs).toBe(1);
    expect(after.getRequest(req.id)).toMatchObject({ status: 'executed', execution_outcome: 'committed',
      execution_claimed_by: 'dashboard', execution_boot_id: after.bootId });
    expect(after.getUnresolved()).toEqual([]);
    expect(await applyExecutionResolution('execute', req.id, 'dashboard', deps)).toEqual({ status: 'not_unresolved' });
    expect(runs).toBe(1);
  });

  test('during an effect: a claim without a receipt is unknown, refused for replay, and can only be closed', async () => {
    const before = new ApprovalManager();
    const req = request(before);
    before.approve(req.id, 'dashboard');
    let runs = 0;
    // The tool never returns: the process dies mid-effect with the claim written.
    const dying = executor(before, async () => { runs++; return new Promise<string>(() => {}); });
    void dying.executeApproved(req.id, 'dashboard');
    expect(runs).toBe(1);
    expect(before.getRequest(req.id)!.execution_claimed_at).not.toBeNull();

    const { mgr: after, counts } = restart();
    expect(counts).toEqual({ demotedInline: 0, notStarted: 0, interrupted: 1 });
    const row = after.getRequest(req.id)!;
    expect(row).toMatchObject({ status: 'approved', execution_outcome: 'unknown', execution_claimed_by: 'dashboard', execution_boot_id: before.bootId });
    expect(executionState(row)).toBe('unknown');
    expect(after.getUnresolved().map(r => r.id)).toEqual([req.id]);

    const ex = executor(after, async () => { runs++; return 'sent'; });
    expect(await ex.executeApproved(req.id, 'dashboard')).toContain('already taken for execution (unknown)');
    expect(after.claimExecution(req.id, 'anyone')).toBe(false);
    const deps = { approvalManager: after, deferredExecutor: ex };
    expect(await applyExecutionResolution('execute', req.id, 'dashboard', deps)).toMatchObject({ status: 'not_executable',
      reason: expect.stringContaining('may have run') });
    expect(runs).toBe(1);

    const closed = await applyExecutionResolution('close', req.id, 'dashboard', deps, 'Checked the outbox: it was sent');
    expect(closed).toMatchObject({ status: 'closed', request: { status: 'approved', execution_outcome: 'closed',
      resolved_by: 'dashboard', resolution_note: 'Checked the outbox: it was sent' } });
    expect(executionState(after.getRequest(req.id)!)).toBe('closed');
    expect(after.getUnresolved()).toEqual([]);
    expect(await applyExecutionResolution('close', req.id, 'dashboard', deps)).toEqual({ status: 'not_unresolved' });
    expect(runs).toBe(1);
  });

  test('after completion: a receipt is left exactly as written', async () => {
    const before = new ApprovalManager();
    const req = request(before);
    before.approve(req.id, 'dashboard');
    await executor(before, async () => 'sent').executeApproved(req.id, 'dashboard');
    const written = before.getRequest(req.id)!;

    const { mgr: after, counts } = restart();
    expect(counts).toEqual({ demotedInline: 0, notStarted: 0, interrupted: 0 });
    expect(after.getRequest(req.id)).toEqual(written);
    expect(after.getUnresolved()).toEqual([]);
    expect(await executor(after, async () => 'again').executeApproved(req.id)).toContain('not in approved state');
  });

  test('a pending inline row is demoted, a workflow-owned row is left to its effect record', () => {
    const before = new ApprovalManager();
    const inline = request(before, { executionMode: 'inline' });
    const workflow = request(before, { executionMode: 'workflow' });
    before.approve(workflow.id, 'dashboard');
    const decided = request(before);
    before.deny(decided.id, 'dashboard');

    const { mgr: after, counts } = restart();
    expect(counts).toEqual({ demotedInline: 1, notStarted: 0, interrupted: 0 });
    expect(after.getRequest(inline.id)).toMatchObject({ status: 'pending', execution_mode: 'deferred' });
    expect(after.getRequest(workflow.id)).toMatchObject({ status: 'approved', execution_outcome: null });
    expect(after.getRequest(decided.id)).toMatchObject({ status: 'denied', execution_outcome: null });
    expect(after.getUnresolved()).toEqual([]);
  });

  test('an intent grant that never returned can be closed but not run', async () => {
    const before = new ApprovalManager();
    const intent = request(before, { toolName: 'request_approval' });
    before.approve(intent.id, 'dashboard');
    const { mgr: after } = restart();
    expect(after.getUnresolved().map(r => r.id)).toEqual([intent.id]);
    let runs = 0;
    const deps = { approvalManager: after, deferredExecutor: executor(after, async () => { runs++; return 'no'; }) };
    expect(await applyExecutionResolution('execute', intent.id, 'dashboard', deps)).toMatchObject({ status: 'not_executable',
      reason: expect.stringContaining('intent grant') });
    expect(runs).toBe(0);
    expect(await applyExecutionResolution('close', intent.id, 'dashboard', deps)).toMatchObject({ status: 'closed' });
  });

  test('a claim held by the running process is not reconciled', () => {
    const mgr = new ApprovalManager();
    const req = request(mgr);
    mgr.approve(req.id, 'dashboard');
    expect(mgr.claimExecution(req.id, 'inline-gate')).toBe(true);
    expect(mgr.reconcileAfterRestart()).toEqual({ demotedInline: 0, notStarted: 0, interrupted: 0 });
    const row = mgr.getRequest(req.id)!;
    expect(row.execution_outcome).toBeNull();
    expect(executionState(row)).toBe('in_flight');
    expect(mgr.getUnresolved()).toEqual([]);
  });

  test('closing needs an unresolved row', () => {
    const mgr = new ApprovalManager();
    const pending = request(mgr);
    expect(mgr.closeUnresolved(pending.id, 'dashboard')).toBe(false);
    const executed = request(mgr);
    mgr.approve(executed.id, 'dashboard');
    mgr.markExecuted(executed.id, 'done');
    expect(mgr.closeUnresolved(executed.id, 'dashboard')).toBe(false);
    expect(mgr.getRequest(executed.id)).toMatchObject({ status: 'executed', execution_outcome: 'committed' });
  });

  test('resolutions broadcast the updated row like decisions do', async () => {
    const before = new ApprovalManager();
    const req = request(before);
    before.approve(req.id, 'dashboard');
    const { mgr: after } = restart();
    const broadcasts: ApprovalRequest[] = [];
    const deps = { approvalManager: after, deferredExecutor: executor(after, async () => 'sent'),
      wsService: { broadcastApprovalUpdate: (r: ApprovalRequest) => broadcasts.push(r) } };
    await applyExecutionResolution('execute', req.id, 'dashboard', deps);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ id: req.id, status: 'executed', execution_outcome: 'committed' });
  });

  test('execution state names every stage', () => {
    const mgr = new ApprovalManager();
    const req = request(mgr);
    expect(executionState(mgr.getRequest(req.id)!)).toBe('pending');
    mgr.approve(req.id, 'dashboard');
    expect(executionState(mgr.getRequest(req.id)!)).toBe('awaiting_execution');
    mgr.claimExecution(req.id, 'dashboard');
    expect(executionState(mgr.getRequest(req.id)!)).toBe('in_flight');
    mgr.markExecuted(req.id, 'sent');
    expect(executionState(mgr.getRequest(req.id)!)).toBe('committed');
    const denied = request(mgr);
    mgr.deny(denied.id, 'dashboard');
    expect(executionState(mgr.getRequest(denied.id)!)).toBe('denied');
  });
});
