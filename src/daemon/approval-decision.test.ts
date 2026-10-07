import { test, expect, describe, beforeEach } from 'bun:test';
import { initDatabase } from '../vault/schema.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { DeferredExecutor } from '../authority/deferred-executor.ts';
import type { ToolRegistry } from '../actions/tools/registry.ts';
import type { ApprovalRequest } from '../authority/approval.ts';
import { applyApprovalDecision, channelApprovalReply, CHANNEL_APPROVE_REFUSED, notificationApprovalDecision } from './approval-decision.ts';
import { APPROVAL_LABEL_DELIVERY_MAX_CHARS, approvalToast } from '../authority/approval-delivery.ts';

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
      get: () => undefined,
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
      get: () => undefined,
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

/**
 * #718. A channel card that could not show all of what would happen offers
 * only `deny`; a typed `approve <id>` must not get past what it withheld.
 */
describe('channelApprovalReply', () => {
  let mgr: ApprovalManager;
  let executions: number;
  let deps: Parameters<typeof channelApprovalReply>[3];

  beforeEach(() => {
    initDatabase(':memory:');
    mgr = new ApprovalManager();
    const executor = new DeferredExecutor(mgr, new AuditTrail());
    executions = 0;
    executor.setToolRegistry({
      get: () => undefined,
      execute: async () => { executions++; return 'ran'; },
    } as unknown as ToolRegistry);
    deps = { approvalManager: mgr, deferredExecutor: executor, wsService: null };
  });

  const create = (intent: string) => mgr.createRequest({
    agentId: 'a1', agentName: 'PA', toolName: 'site_run_command', toolArguments: { command: 'x' },
    actionCategory: 'execute_command', urgency: 'normal', reason: 'execute_command requires user approval',
    context: JSON.stringify({ intent }),
  });

  test('approve is refused, and nothing runs, when the card had to cut what will happen', async () => {
    const req = create(`In site project "shop", run: ${'x'.repeat(APPROVAL_LABEL_DELIVERY_MAX_CHARS)}`);
    expect(await channelApprovalReply('approve', req.id.slice(0, 8), 'telegram', deps)).toBe(CHANNEL_APPROVE_REFUSED);
    expect(mgr.getRequest(req.id)!.status).toBe('pending');
    expect(executions).toBe(0);
  });

  test('deny still works on that card', async () => {
    const req = create(`In site project "shop", run: ${'x'.repeat(APPROVAL_LABEL_DELIVERY_MAX_CHARS)}`);
    expect(await channelApprovalReply('deny', req.id.slice(0, 8), 'telegram', deps)).toBe('Denied: site_run_command');
    expect(mgr.getRequest(req.id)!.status).toBe('denied');
  });

  test('a card shown whole is approved and run as before', async () => {
    const req = create('In site project "shop", run: make deploy');
    expect(await channelApprovalReply('approve', req.id.slice(0, 8), 'telegram', deps)).toBe('Approved and executed. Result: ran');
    expect(executions).toBe(1);
  });

  test('an unknown id is reported', async () => {
    expect(await channelApprovalReply('approve', 'deadbeef', 'discord', deps)).toBe('No pending approval found for ID deadbeef');
  });
});

/**
 * #791. A review-only toast has no Approve or Deny; a click reported for one
 * anyway must not decide the request.
 */
describe('notificationApprovalDecision', () => {
  let mgr: ApprovalManager;
  let executions: number;
  let deps: Parameters<typeof notificationApprovalDecision>[1];

  beforeEach(() => {
    initDatabase(':memory:');
    mgr = new ApprovalManager();
    const executor = new DeferredExecutor(mgr, new AuditTrail());
    executions = 0;
    executor.setToolRegistry({
      get: () => undefined,
      execute: async () => { executions++; return 'ran'; },
    } as unknown as ToolRegistry);
    deps = { approvalManager: mgr, deferredExecutor: executor, wsService: null };
  });

  const create = (reason: string) => mgr.createRequest({
    agentId: 'a1', agentName: 'PA', toolName: 'request_approval', toolArguments: {},
    actionCategory: 'send_email', urgency: 'normal', reason, context: '',
  });
  const long = `Send the quarterly numbers to ${'everyone@example.com, '.repeat(10)}`;

  test('an approve for a request whose toast was review-only is ignored', async () => {
    const req = create(long);
    expect(approvalToast(req).approvable).toBe(false);
    expect(await notificationApprovalDecision({ id: req.id, kind: 'approval', action: 'approve' }, deps)).toBeNull();
    expect(await notificationApprovalDecision({ id: req.id, kind: 'approval', action: 'deny' }, deps)).toBeNull();
    expect(mgr.getRequest(req.id)!.status).toBe('pending');
  });

  test('an approve for a toast that showed everything is applied', async () => {
    const req = create('Send the weekly update');
    const outcome = await notificationApprovalDecision({ id: req.id, kind: 'approval', action: 'approve' }, deps);
    expect(outcome?.status).toBe('approved');
    expect(mgr.getRequest(req.id)!.status).toBe('approved');
  });

  test('only kind approval decides anything; review and dismiss are not decisions', async () => {
    const req = create('Send the weekly update');
    expect(await notificationApprovalDecision({ id: req.id, kind: 'approval_review', action: 'approve' }, deps)).toBeNull();
    expect(await notificationApprovalDecision({ id: req.id, kind: 'approval', action: 'review' }, deps)).toBeNull();
    expect(await notificationApprovalDecision({ id: req.id, kind: 'done', action: 'approve' }, deps)).toBeNull();
    expect(await notificationApprovalDecision(undefined, deps)).toBeNull();
    expect(mgr.getRequest(req.id)!.status).toBe('pending');
    expect(executions).toBe(0);
  });
});
