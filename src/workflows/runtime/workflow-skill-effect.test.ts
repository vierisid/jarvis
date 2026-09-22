/**
 * run_skill through the workflow effect boundary.
 *
 * A skill is the one click sequence a flow may invoke. The boundary must gate
 * it on what the stored steps reach (not on the tool name), show a card that
 * names the effect with the resolved values, pin the run to the reviewed
 * machine and skill version, dispatch exactly once, and record a typed
 * outcome when the skill cannot run or stops part way.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { ToolRegistry } from '../../actions/tools/registry';
import { runSkillTool } from '../../actions/tools/skills';
import { getSidecarManager, setSidecarManagerRef } from '../../actions/tools/sidecar-route';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager, approvalIntentFromContext } from '../../authority/approval';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends, type BuildServiceBackendsOptions } from './service-backends';
import { getDb } from '../../vault/schema';
import { setSkillSigningKey, upsertSkill } from '../../vault/skills';
import { ActionOutcomeError } from '../../actions/action-outcome';
import type { SidecarManager } from '../../sidecar/manager';

const originalManager = getSidecarManager();
// initWorkflowDb opens the shared Jarvis DB, so the vault's skills table is
// there too; one init, one close.
beforeEach(() => { initWorkflowDb(':memory:'); setSkillSigningKey(Buffer.alloc(32, 9)); });
afterEach(() => { closeWorkflowDb(); setSkillSigningKey(null); setSidecarManagerRef(originalManager as unknown as SidecarManager); });

type Call = { id: string; method: string; params: Record<string, unknown> };

/** A browser sidecar whose page holds a Send button that disappears once clicked. */
function fakeSidecar(calls: Call[]) {
  let sent = false;
  const manager = {
    listSidecars: () => [{ id: 'pc-1', name: 'Office PC', connected: true, capabilities: ['desktop', 'browser'], unavailable_capabilities: [] }],
    getConnectionSessionId: () => 'session-1',
    dispatchRPC: async (id: string, method: string, params: Record<string, unknown>) => {
      calls.push({ id, method, params });
      if (method === 'browser_ax_snapshot') {
        return { url: 'https://mail.google.com', title: 'Gmail', elements: sent ? [] : [
          { ax_id: '1', backend_node_id: 7, role: 'button', name: 'Send', interactive: true, path: [], ordinal: 0, sig: 'send' },
        ] };
      }
      if (method === 'browser_ax_click') { sent = true; return { ok: true }; }
      return { ok: true };
    },
  };
  setSidecarManagerRef(manager as unknown as SidecarManager);
}

function gmailSkill(extra: Record<string, unknown> = {}) {
  return upsertSkill({
    name: 'gmail-send', app: 'Gmail', description: 'send the draft', provenance: 'recorded',
    match: { domains: ['mail.google.com'] },
    params: [{ name: 'subject', type: 'string', description: '', required: true }],
    steps: [{ action: 'click', surface: 'browser', ref: { role: 'button', name: 'Send', path: [], ordinal: 0, sig: 'send' }, postcondition: { kind: 'element_gone' } }],
    ...extra,
  });
}

function fixture(governed: string[] = []) {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Send the weekly mail', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: 'action', type: 'PIECE', settings: {
      pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1', actionName: 'invoke', input: {},
    } },
  } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const registry = new ToolRegistry();
  registry.register(runSkillTool);
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: governed as never, overrides: [],
    context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const approvals = new ApprovalManager();
  const audit = new AuditTrail();
  const delivered: string[] = [];
  const options: BuildServiceBackendsOptions = { credentialResolver: new CredentialResolver(),
    llmManager: { chat: async () => ({ content: '' }) } as never, toolRegistry: registry, authorityEngine: authority,
    emergencyController: new EmergencyController(), auditTrail: audit, eventBuffer: new WorkflowEventBuffer(),
    approvalManager: approvals, onWorkflowApproval: (request) => { delivered.push(request.id); },
    channelService: { getChannelStatus: () => ({}), getBroadcastRecipient: () => null,
      sendWorkflowNotification: async () => {}, tryBroadcastToChannels: async () => ({ delivered: [], failed: [] }) } as never,
    wsService: { broadcastNotificationToDashboard: () => {} } as never,
  };
  const backends = buildSandboxServiceBackends(options);
  const context = { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'action', executionPath: [] };
  const invoke = (params: Record<string, unknown>) => backends.toolsInvoke!({ toolName: 'run_skill', params }, context);
  return { invoke, approvals, delivered, run, authority, audit };
}

describe('run_skill as a workflow effect', () => {
  test('is gated on what the skill does: a send-email skill pauses for approval with a card that names it', async () => {
    const calls: Call[] = [];
    fakeSidecar(calls);
    gmailSkill();
    const f = fixture(['send_email']);
    const pending = await f.invoke({ name: 'gmail-send', params: { subject: 'Weekly numbers' } });
    expect(pending.approval).toBeDefined();
    expect(calls.filter((c) => c.method === 'browser_ax_click')).toHaveLength(0);

    const request = f.approvals.getRequest(pending.approval!.approvalId)!;
    expect(request.action_category).toBe('send_email');
    expect(request.execution_mode).toBe('workflow');
    expect(approvalIntentFromContext(request)).toContain('click Send (sends email)');
    expect(approvalIntentFromContext(request)).toContain('"gmail-send" in Gmail');
    expect(f.delivered).toEqual([request.id]);

    const effect = listWorkflowEffects(f.run.id)[0]!;
    expect(effect.actionCategory).toBe('send_email');
    expect(effect.target).toMatchObject({ tool: 'run_skill', skill: 'gmail-send', version: 1, surface: 'browser', capability: 'browser', sidecarId: 'pc-1' });
    expect(effect.arguments).toMatchObject({ name: 'gmail-send', target: 'pc-1' });

    f.approvals.approve(request.id, 'test');
    const done = await f.invoke({ name: 'gmail-send', params: { subject: 'Weekly numbers' } });
    expect(String(done.result)).toContain('completed');
    expect(calls.filter((c) => c.method === 'browser_ax_click')).toHaveLength(1);
    expect(calls.find((c) => c.method === 'browser_ax_click')!.id).toBe('pc-1');
    expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('succeeded');

    // Replay returns the durable result without dispatching again.
    const again = await f.invoke({ name: 'gmail-send', params: { subject: 'Weekly numbers' } });
    expect(again.result).toEqual(done.result);
    expect(calls.filter((c) => c.method === 'browser_ax_click')).toHaveLength(1);
  });

  test('a skill that only controls the app runs without a card when nothing governs control_app', async () => {
    const calls: Call[] = [];
    fakeSidecar(calls);
    upsertSkill({ name: 'dismiss', app: 'Notepad', steps: [{ action: 'click', surface: 'browser', ref: { role: 'button', name: 'Send', path: [], ordinal: 0, sig: 'send' } }] });
    const f = fixture(['send_email']);
    const done = await f.invoke({ name: 'dismiss' });
    expect(String(done.result)).toContain('completed');
    expect(listWorkflowEffects(f.run.id)[0]!.actionCategory).toBe('control_app');
  });

  test('every category the skill reaches is checked: governing send_message stops a Slack skill', async () => {
    const calls: Call[] = [];
    fakeSidecar(calls);
    upsertSkill({ name: 'slack-say', app: 'Slack', steps: [
      { action: 'click', surface: 'browser', ref: { role: 'button', name: 'Send', path: [], ordinal: 0, sig: 'send' } },
    ] });
    const f = fixture(['send_message']);
    const pending = await f.invoke({ name: 'slack-say' });
    expect(pending.approval).toBeDefined();
    const request = f.approvals.getRequest(pending.approval!.approvalId)!;
    expect(request.action_category).toBe('send_message');
    // The record keeps the worst case by level.
    expect(listWorkflowEffects(f.run.id)[0]!.actionCategory).toBe('control_app');
  });

  test('a paying skill raises the card to urgent', async () => {
    fakeSidecar([]);
    upsertSkill({ name: 'checkout', app: 'Shop', steps: [
      { action: 'click', surface: 'browser', ref: { role: 'button', name: 'Pay now', path: [], ordinal: 0, sig: 'pay' } },
    ] });
    const f = fixture(['make_payment']);
    const pending = await f.invoke({ name: 'checkout' });
    const request = f.approvals.getRequest(pending.approval!.approvalId)!;
    expect(request.action_category).toBe('make_payment');
    expect(request.urgency).toBe('urgent');
    expect(approvalIntentFromContext(request)).toContain('click Pay now (pays)');
  });

  test('a skill re-recorded after review cannot dispatch under the old approval', async () => {
    const calls: Call[] = [];
    fakeSidecar(calls);
    gmailSkill();
    const f = fixture(['send_email']);
    const pending = await f.invoke({ name: 'gmail-send', params: { subject: 'x' } });
    f.approvals.approve(pending.approval!.approvalId, 'test');
    // Same name, new content: a new version.
    gmailSkill({ description: 'now clicks something else' });
    await expect(f.invoke({ name: 'gmail-send', params: { subject: 'x' } })).rejects.toThrow(/target changed after review/);
    expect(calls.filter((c) => c.method === 'browser_ax_click')).toHaveLength(0);
  });

  test('an unknown skill is refused before any effect exists, and the refusal is audited', async () => {
    fakeSidecar([]);
    const f = fixture();
    await expect(f.invoke({ name: 'nothing-here' })).rejects.toThrow(/Unsupported direct workflow capability: run_skill/);
    expect(listWorkflowEffects(f.run.id)).toHaveLength(0);
    const rows = f.audit.query({ limit: 5 }).filter((r) => r.tool_name === 'run_skill');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authority_decision).toBe('denied');
  });

  test('a skill that cannot run is a blocked outcome with nothing started', async () => {
    const calls: Call[] = [];
    fakeSidecar(calls);
    const s = gmailSkill();
    getDb().prepare("UPDATE skills SET steps_json = '[]' WHERE id = ?").run(s.id);
    const f = fixture();
    await expect(f.invoke({ name: 'gmail-send', params: { subject: 'x' } })).rejects.toBeInstanceOf(ActionOutcomeError);
    const effect = listWorkflowEffects(f.run.id)[0]!;
    expect(effect.status).toBe('blocked');
    expect(effect.outcome).toMatchObject({ status: 'blocked', code: 'SKILL_NOT_RUNNABLE', effect: 'not_started' });
    expect(calls.filter((c) => c.method === 'browser_ax_click')).toHaveLength(0);
  });

  test('a skill that stops part way is an error outcome whose earlier steps may have run', async () => {
    const calls: Call[] = [];
    fakeSidecar(calls);
    upsertSkill({ name: 'two-steps', app: 'Gmail', steps: [
      { action: 'click', surface: 'browser', ref: { role: 'button', name: 'Send', path: [], ordinal: 0, sig: 'send' } },
      { action: 'click', surface: 'browser', ref: { role: 'button', name: 'Archive', path: [], ordinal: 0, sig: 'arch' } },
    ] });
    const f = fixture();
    await expect(f.invoke({ name: 'two-steps' })).rejects.toBeInstanceOf(ActionOutcomeError);
    const effect = listWorkflowEffects(f.run.id)[0]!;
    expect(effect.status).toBe('failed');
    expect(effect.outcome).toMatchObject({ status: 'error', code: 'SKILL_STEP_FAILED', effect: 'may_have_occurred' });
    // The first click landed; the second target was never found; nothing was retried.
    expect(calls.filter((c) => c.method === 'browser_ax_click')).toHaveLength(1);
    await expect(f.invoke({ name: 'two-steps' })).rejects.toBeInstanceOf(ActionOutcomeError);
    expect(calls.filter((c) => c.method === 'browser_ax_click')).toHaveLength(1);
  });
});
