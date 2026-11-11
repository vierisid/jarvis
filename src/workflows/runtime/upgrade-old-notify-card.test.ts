import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { ToolRegistry } from '../../actions/tools/registry';
import { listWorkflowEffects, saveWorkflowEffect } from '../db/repos/workflow-effect';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

/**
 * v0.17.6 judged every notify as a governed send, so a dashboard-only notice
 * parked on an approval card and its effect was recorded as `send_message`.
 * Since #1331 a notice that only reaches the owner is a `read_data` that asks
 * for nothing. A card created by the old version and approved after the upgrade
 * must still run its step, once, instead of failing as "changed since it was
 * recorded" and losing the owner's decision.
 */
function oldCardFixture() {
  const flow = createFlow({ projectId: DEFAULT_IDS.project });
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Morning stand-up', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: 'action', type: 'PIECE', settings: {
      pieceName: '@jarvispieces/piece-jarvis-notify', pieceVersion: '0.0.1', actionName: 'notify', input: {} } } } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const delivered: unknown[] = [];
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [],
    context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const approvals = new ApprovalManager();
  const backends = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), llmManager: {} as never, toolRegistry: new ToolRegistry(), authorityEngine: authority,
    emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(),
    approvalManager: approvals, onWorkflowApproval: () => {},
    channelService: { getChannelStatus: () => ({}), getBroadcastRecipient: () => 'owner',
      sendWorkflowNotification: async () => {}, tryBroadcastToChannels: async () => ({ delivered: [], failed: [] }) } as never,
    wsService: { broadcastNotificationToDashboard: (...args: unknown[]) => { delivered.push(args); return 1; } } as never,
  });
  const context = { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'action', executionPath: [] };
  const request = { message: 'Stand-up at 9', channels: ['dashboard'], priority: 'normal' as const };

  /** The card as v0.17.6 left it: parked, recorded and labelled as a governed send. */
  async function parkAsOldVersion() {
    authority.addContextRule({ id: 'old-version-asked', action: 'read_data', condition: 'tool_name',
      params: { tool_name: 'workflow_notify' }, effect: 'require_approval', description: 'v0.17.6 asked' });
    const pending = await backends.notify!(request, context);
    expect(pending.approval?.approvalId).toBeTruthy();
    authority.removeContextRule('old-version-asked');
    const [effect] = listWorkflowEffects(run.id);
    effect!.actionCategory = 'send_message';
    saveWorkflowEffect(effect!);
    getWorkflowDb().run("UPDATE approval_requests SET action_category = 'send_message' WHERE id = ?", [pending.approval!.approvalId]);
    return pending.approval!.approvalId;
  }
  return { backends, approvals, request, context, delivered, run, parkAsOldVersion };
}

test('an old dashboard-notify card, approved after the upgrade, delivers once and finishes cleanly', async () => {
  const f = oldCardFixture();
  const approvalId = await f.parkAsOldVersion();
  expect(f.delivered).toHaveLength(0);

  f.approvals.approve(approvalId, 'owner');
  const reply = await f.backends.notify!(f.request, f.context);
  expect(reply.approval).toBeUndefined();
  expect(reply.delivered).toEqual(['dashboard']);
  expect(f.delivered).toHaveLength(1);

  // The engine retrying the step does not deliver again.
  await f.backends.notify!(f.request, f.context);
  expect(f.delivered).toHaveLength(1);
  expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'succeeded', actionCategory: 'read_data' });
});

test('an old card still waiting for its answer stays a waiting card', async () => {
  const f = oldCardFixture();
  const approvalId = await f.parkAsOldVersion();
  const again = await f.backends.notify!(f.request, f.context);
  expect(again.approval?.approvalId).toBe(approvalId);
  expect(f.delivered).toHaveLength(0);
});

test('an old card the owner denied ends the step as denied, not as a changed effect', async () => {
  const f = oldCardFixture();
  const approvalId = await f.parkAsOldVersion();
  f.approvals.deny(approvalId, 'owner');
  await expect(f.backends.notify!(f.request, f.context)).rejects.toMatchObject({ outcome: { code: 'APPROVAL_DENIED', effect: 'not_started' } });
  expect(f.delivered).toHaveLength(0);
});

test('only the relaxation is bridged: other changed effects are still refused', async () => {
  const f = oldCardFixture();
  const approvalId = await f.parkAsOldVersion();
  f.approvals.approve(approvalId, 'owner');
  // Different message than the one approved.
  await expect(f.backends.notify!({ ...f.request, message: 'Something else' }, f.context)).rejects.toThrow(/changed since it was recorded/);
  expect(f.delivered).toHaveLength(0);
});
