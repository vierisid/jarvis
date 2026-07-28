import { test, expect, describe, beforeEach } from 'bun:test';
import { initDatabase } from '../vault/schema.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { DeferredExecutor } from '../authority/deferred-executor.ts';
import type { ToolRegistry } from '../actions/tools/registry.ts';
import type { ApprovalRequest } from '../authority/approval.ts';
import { applyApprovalDecision } from './approval-decision.ts';

function makeRequest(mgr: ApprovalManager, overrides?: { toolName?: string; executionMode?: 'inline' | 'deferred' }) {
  return mgr.createRequest({
    agentId: 'a1',
    agentName: 'PA',
    toolName: overrides?.toolName ?? 'send_email',
    toolArguments: { to: 'x@example.com' },
    actionCategory: 'send_email',
    urgency: 'normal',
    reason: 'test',
    context: '',
    ...(overrides?.executionMode ? { executionMode: overrides.executionMode } : {}),
  });
}

describe('applyApprovalDecision', () => {
  let mgr: ApprovalManager;
  let executor: DeferredExecutor;
  let executions: number;
  let broadcasts: ApprovalRequest[];
  let deps: Parameters<typeof applyApprovalDecision>[3];

  beforeEach(() => {
    initDatabase(':memory:');
    mgr = new ApprovalManager();
    executor = new DeferredExecutor(mgr, new AuditTrail());
    executions = 0;
    executor.setToolRegistry({
      execute: async () => { executions++; return 'sent'; },
    } as unknown as ToolRegistry);
    broadcasts = [];
    deps = {
      approvalManager: mgr,
      deferredExecutor: executor,
      wsService: { broadcastApprovalUpdate: (r) => broadcasts.push(r) },
    };
  });

  test('approve executes the deferred action and broadcasts', async () => {
    const req = makeRequest(mgr);
    const outcome = await applyApprovalDecision('approve', req.id, 'notification', deps);
    expect(outcome.status).toBe('approved');
    if (outcome.status !== 'approved') throw new Error('unreachable');
    expect(outcome.executed).toBe(true);
    expect(executions).toBe(1);
    expect(mgr.getRequest(req.id)!.status).toBe('executed');
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]!.id).toBe(req.id);
  });

  test('approve skips execution for inline requests (blocked caller owns them)', async () => {
    const req = makeRequest(mgr, { executionMode: 'inline' });
    const outcome = await applyApprovalDecision('approve', req.id, 'telegram', deps);
    expect(outcome.status).toBe('approved');
    if (outcome.status !== 'approved') throw new Error('unreachable');
    expect(outcome.executed).toBe(false);
    expect(executions).toBe(0);
    expect(mgr.getRequest(req.id)!.status).toBe('approved');
    expect(broadcasts.length).toBe(1);
  });

  test('deny records the denial and broadcasts', async () => {
    const req = makeRequest(mgr);
    const outcome = await applyApprovalDecision('deny', req.id, 'notification', deps);
    expect(outcome.status).toBe('denied');
    expect(executions).toBe(0);
    expect(mgr.getRequest(req.id)!.status).toBe('denied');
    expect(broadcasts.length).toBe(1);
  });

  test('already-decided requests are reported, not re-executed', async () => {
    const req = makeRequest(mgr);
    mgr.deny(req.id, 'dashboard');
    const outcome = await applyApprovalDecision('approve', req.id, 'notification', deps);
    expect(outcome.status).toBe('already_decided');
    expect(executions).toBe(0);
    expect(broadcasts.length).toBe(0);
  });

  test('tool failure is captured in the result and the request closed out', async () => {
    executor.setToolRegistry({
      execute: async () => { throw new Error('smtp down'); },
    } as unknown as ToolRegistry);
    const req = makeRequest(mgr);
    const outcome = await applyApprovalDecision('approve', req.id, 'notification', deps);
    expect(outcome.status).toBe('approved');
    if (outcome.status !== 'approved') throw new Error('unreachable');
    // DeferredExecutor reports tool failures as a result string, not a throw.
    expect(outcome.executed).toBe(true);
    expect(outcome.result).toContain('Error executing');
    expect(mgr.getRequest(req.id)!.status).toBe('executed');
    expect(broadcasts.length).toBe(1);
  });
});
