/**
 * #1154: the effect boundary counts a dispatched effect as in flight from its
 * claim until its record is written, which is what a delete of its flow waits
 * for (db/repos/flow-deletion.ts).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeWorkflowDb, DEFAULT_IDS, initWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { ToolRegistry } from '../../actions/tools/registry';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends, type BuildServiceBackendsOptions } from './service-backends';
import { beginEffectDispatch, effectDispatchInFlight, waitForEffectDispatches } from './effect-inflight';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

function fixture(execute: () => Promise<unknown>) {
  const flow = createFlow({ projectId: DEFAULT_IDS.project });
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Routine', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: 'action', type: 'PIECE', settings: {
      pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1', actionName: 'invoke', input: { toolName: 'write_file' } } },
  } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const registry = new ToolRegistry();
  registry.register({ name: 'write_file', category: 'file-ops', description: 'Synthetic write', parameters: {}, execute });
  const options: BuildServiceBackendsOptions = { credentialResolver: new CredentialResolver(),
    llmManager: { chat: async () => ({ content: '' }) } as any, toolRegistry: registry,
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(),
    approvalManager: new ApprovalManager(), onWorkflowApproval: () => {},
    channelService: { getChannelStatus: () => ({}), getBroadcastRecipient: () => 'r', sendWorkflowNotification: async () => {},
      tryBroadcastToChannels: async () => ({ delivered: [], failed: [] }) } as any,
    wsService: { broadcastNotificationToDashboard: () => 1 } as any,
  };
  const backends = buildSandboxServiceBackends(options);
  const invoke = () => backends.toolsInvoke!({ toolName: 'write_file', params: { path: '/tmp/synthetic' } },
    { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'action', executionPath: [] });
  return { flow, run, invoke };
}

test('an effect is in flight from its dispatch until its record is written, success or failure', async () => {
  let seen = null as boolean | null;
  const ok = fixture(async () => { seen = effectDispatchInFlight(ok.flow.id); return 'saved'; });
  expect(effectDispatchInFlight(ok.flow.id)).toBe(false);
  await ok.invoke();
  expect(seen).toBe(true);
  expect(effectDispatchInFlight(ok.flow.id)).toBe(false);
  expect(listWorkflowEffects(ok.run.id)[0]?.status).toBe('succeeded');

  const failing = fixture(async () => { throw new Error('remote said no'); });
  await expect(failing.invoke()).rejects.toThrow('remote said no');
  expect(effectDispatchInFlight(failing.flow.id)).toBe(false);
});

test('waiting resolves when the last dispatch ends, or false at the deadline', async () => {
  const a = beginEffectDispatch('f'), b = beginEffectDispatch('f');
  expect(await waitForEffectDispatches('f', 10)).toBe(false);
  const waiting = waitForEffectDispatches('f', 5_000);
  a();
  a(); // a second call of the same end does not count twice
  expect(effectDispatchInFlight('f')).toBe(true);
  b();
  expect(await waiting).toBe(true);
  expect(await waitForEffectDispatches('f', 0)).toBe(true);
});
