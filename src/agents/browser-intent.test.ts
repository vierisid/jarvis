import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema';
import { AgentOrchestrator } from './orchestrator';
import { AgentInstance } from './agent';
import { runSubAgent } from './sub-agent-runner';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine';
import { ApprovalManager, approvalNeedsClick, approvalIntentFromContext } from '../authority/approval';
import { AuditTrail } from '../authority/audit';
import { DeferredExecutor } from '../authority/deferred-executor';
import { buildBackgroundProfile } from '../authority/background-profile';
import { resolveToolGate } from '../authority/tool-action-map';
import { ToolRegistry, type ToolDefinition } from '../actions/tools/registry';
import { browserClickTool, browserSnapshotTool, browserUploadFileTool, createBrowserTools } from '../actions/tools/builtin';
import { uiActTool, uiSnapshotTool, resetUiSnapshots } from '../actions/tools/ui';
import { runSkillTool } from '../actions/tools/skills';
import { getSidecarManager, setSidecarManagerRef } from '../actions/tools/sidecar-route';
import { upsertSkill, setSkillSigningKey } from '../vault/skills';
import type { RoleDefinition } from '../roles/types';
import { applyApprovalDecision, applyExecutionResolution } from '../daemon/approval-decision';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const role = { id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [],
  tools: ['browser', 'desktop', 'ui'], authority_level: 10 } as unknown as RoleDefinition;
const baseConfig: AuthorityConfig = { default_level: 10, governed_categories: [], overrides: [], context_rules: [],
  learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' };
type Exec = { executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }, signal?: AbortSignal, taint?: Set<string>) => Promise<unknown> };
const exec = (o: AgentOrchestrator, name: string, args: Record<string, unknown> = {}, taint = new Set<string>()) =>
  (o as unknown as Exec).executeTool({ id: 'call', name, arguments: args }, undefined, taint);

function fixture(definitions: ToolDefinition[], config: Partial<AuthorityConfig> = {}, level = 10, realExecution = false) {
  const calls: string[] = [];
  const registry = new ToolRegistry();
  for (const tool of definitions) registry.register(realExecution ? tool : { ...tool, execute: async () => { calls.push(tool.name); return 'executed'; } });
  const approvals = new ApprovalManager();
  const audit = new AuditTrail();
  const engine = new AuthorityEngine({ ...baseConfig, ...config });
  const orch = new AgentOrchestrator();
  orch.setToolRegistry(registry);
  orch.setAuthorityEngine(engine);
  orch.setApprovalManager(approvals);
  orch.setAuditTrail(audit);
  orch.createPrimary({ ...role, authority_level: level });
  return { orch, calls, approvals, registry, engine, audit };
}

let oldManager: ReturnType<typeof getSidecarManager>;
beforeEach(() => { initDatabase(':memory:'); setSkillSigningKey(Buffer.alloc(32, 5)); resetUiSnapshots(); oldManager = getSidecarManager(); });
afterEach(() => { setSidecarManagerRef(oldManager!); setSkillSigningKey(null); resetUiSnapshots(); closeDb(); });

describe('ambiguous UI effects require review at real agent gates', () => {
  test('ordinary and isolated browser tools cannot silently send through click/type/Enter', async () => {
    const tools = [...createBrowserTools({} as never), browserUploadFileTool];
    for (const name of ['browser_navigate', 'browser_click', 'browser_type', 'browser_press_key', 'browser_evaluate', 'browser_hover', 'browser_scroll', 'browser_upload_file']) {
      const tool = tools.find(t => t.name === name)!;
      expect(tool).toBeDefined();
      const f = fixture([tool]);
      const result = await exec(f.orch, name, { element_id: 1, url: 'https://example.test', direction: 'down', expression: '1', file_path: '/tmp/synthetic', text: 'hello', submit: true, key: 'Enter', intent: 'read only', effect: 'read_data' });
      expect(String(result)).toContain('[AWAITING_APPROVAL]');
      expect(f.calls).toEqual([]);
      const card = f.approvals.getPending().find(p => p.tool_name === name)!;
      expect(approvalNeedsClick(card)).toBe(true);
      expect(approvalIntentFromContext(card)).toContain('Business effect unknown');
    }
  });

  test('background and tainted chat calls both stop, while snapshots remain available', async () => {
    for (const background of [false, true]) {
      const f = fixture([browserClickTool, browserSnapshotTool]);
      if (background) f.orch.setAuthorityProfile(buildBackgroundProfile());
      expect(String(await exec(f.orch, 'browser_snapshot'))).toContain('executed');
      expect(String(await exec(f.orch, 'browser_click', { element_id: 1 }, new Set(['browser_snapshot'])))).toContain('[AWAITING_APPROVAL]');
      expect(f.calls).toEqual(['browser_snapshot']);
    }
  });

  test('an always-allow browser override cannot remove review; a deny still wins', async () => {
    const f = fixture([browserClickTool], { overrides: [{ action: 'access_browser', allowed: true }] });
    expect(String(await exec(f.orch, 'browser_click', { element_id: 1 }))).toContain('[AWAITING_APPROVAL]');
    const denied = fixture([browserClickTool], { overrides: [{ action: 'access_browser', allowed: false }] });
    expect(String(await exec(denied.orch, 'browser_click', { element_id: 1 }))).toContain('[AUTHORITY DENIED]');
    expect(denied.calls).toEqual([]);
  });

  test('reviewed arguments execute once through the durable approval executor', async () => {
    const f = fixture([browserClickTool]);
    await exec(f.orch, 'browser_click', { element_id: 9 });
    const card = f.approvals.getPending()[0]!;
    expect(JSON.parse(card.tool_arguments)).toEqual({ element_id: 9 });
    f.approvals.approve(card.id, 'user');
    const executor = new DeferredExecutor(f.approvals, f.audit);
    executor.setToolRegistry(f.registry);
    await executor.executeApproved(card.id);
    await executor.executeApproved(card.id);
    expect(f.calls).toEqual(['browser_click']);
  });

  test('voice auto-approval and sub-agents cannot bypass human review', async () => {
    const f = fixture([browserClickTool]);
    expect(await f.orch.executeRealtimeToolCall('browser_click', { element_id: 1 })).toContain('[BLOCKED]');
    let turn = 0;
    await runSubAgent({ agent: new AgentInstance(role), task: 'click', context: '',
      toolRegistry: f.registry, authorityEngine: f.engine, auditTrail: f.audit,
      llmManager: { chatTier: async () => ({ content: 'done', usage: { input_tokens: 0, output_tokens: 0 },
        tool_calls: turn++ === 0 ? [{ id: 'c', name: 'browser_click', arguments: { element_id: 1 } }] : [], finish_reason: 'stop' }) } as never });
    expect(f.calls).toEqual([]);
  });

  test('an approval from before mandatory UI review cannot dispatch after upgrade', async () => {
    const f = fixture([browserClickTool]);
    const old = f.approvals.createRequest({ agentId: 'a', agentName: 'PA', toolName: 'browser_click',
      toolArguments: { element_id: 1 }, actionCategory: 'access_browser', urgency: 'normal',
      reason: 'Legacy browsing approval', context: 'Category-only approval' });
    f.approvals.approve(old.id, 'user');
    const executor = new DeferredExecutor(f.approvals, f.audit);
    executor.setToolRegistry(f.registry);
    expect(await executor.executeApproved(old.id)).toContain('predates the required UI review');
    expect(f.calls).toEqual([]);
  });
});

describe('UI approval execution stays bound to its origin', () => {
  function browser() {
    const clicks: number[] = [];
    let session = 1;
    let connected = true;
    return {
      clicks,
      replaceSession: () => { session++; },
      disconnect: () => { connected = false; },
      click: async (id: number) => { clicks.push(id); return 'clicked'; },
      captureApprovalGuard: () => {
        const captured = session;
        return () => connected && session === captured;
      },
    };
  }

  test('a background approval runs the originating browser, never the main registry', async () => {
    const bg = browser();
    const main = browser();
    const f = fixture(createBrowserTools(bg as never), {}, 10, true);
    f.orch.setAuthorityProfile(buildBackgroundProfile());
    const mainRegistry = new ToolRegistry();
    for (const tool of createBrowserTools(main as never)) mainRegistry.register(tool);
    const executor = new DeferredExecutor(f.approvals, f.audit);
    executor.setToolRegistry(mainRegistry);
    await exec(f.orch, 'browser_click', { element_id: 7 });
    const request = f.approvals.getPending()[0]!;
    const deps = { approvalManager: f.approvals, deferredExecutor: executor };
    await applyApprovalDecision('approve', request.id, 'dashboard', deps);
    await executor.executeApproved(request.id);
    expect(bg.clicks).toEqual([7]);
    expect(main.clicks).toEqual([]);
    expect(f.approvals.getRequest(request.id)?.execution_outcome).toBe('committed');
  });

  test.each(['disconnect', 'replaceSession', 'unregister'] as const)('a lost background session cannot fall back to main: %s', async change => {
    const bg = browser();
    const main = browser();
    const f = fixture(createBrowserTools(bg as never), {}, 10, true);
    const mainRegistry = new ToolRegistry();
    for (const tool of createBrowserTools(main as never)) mainRegistry.register(tool);
    const executor = new DeferredExecutor(f.approvals, f.audit);
    executor.setToolRegistry(mainRegistry);
    await exec(f.orch, 'browser_click', { element_id: 7 });
    const request = f.approvals.getPending()[0]!;
    if (change === 'unregister') f.registry.clear();
    else bg[change]();
    await applyApprovalDecision('approve', request.id, 'dashboard', { approvalManager: f.approvals, deferredExecutor: executor });
    expect(bg.clicks).toEqual([]);
    expect(main.clicks).toEqual([]);
    expect(f.approvals.getRequest(request.id)?.execution_outcome).toBe('blocked');
  });

  async function structural(name: string, actions: string[]) {
    setSidecarManagerRef({ listSidecars: () => [{ id: 'sc', name: 'pc', connected: true, capabilities: ['browser'] }],
      dispatchRPC: async (_id: string, method: string) => {
        if (method !== 'browser_ax_snapshot') { actions.push(method); return { success: true }; }
        return { url: 'https://mail.google.com/', title: 'Gmail', elements: [
          { ax_id: 'a', backend_node_id: 42, role: 'button', name, interactive: true, sig: 'ref' },
        ] };
      } } as never);
    const text = String(await uiSnapshotTool.execute({ kind: 'browser', target: 'sc' }));
    return Number(text.match(/\[(\d+)\] button/)![1]);
  }

  test.each(['pending', 'approved'] as const)('persisted %s structural approval cannot use a recycled ID after restart', async state => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-ui-approval-'));
    const file = join(dir, 'vault.db');
    closeDb();
    try {
      initDatabase(file);
      const actions: string[] = [];
      const id = await structural('Continue', actions);
      const f = fixture([uiActTool], { overrides: [{ action: 'send_email', allowed: false }] }, 10, true);
      await exec(f.orch, 'ui_act', { element_id: id });
      const request = f.approvals.getPending()[0]!;
      if (state === 'approved') f.approvals.approve(request.id, 'dashboard');
      closeDb();
      resetUiSnapshots();
      initDatabase(file);
      const after = new ApprovalManager('new-process');
      after.reconcileAfterRestart();
      expect(await structural('Send', actions)).toBe(id);
      const executor = new DeferredExecutor(after, f.audit);
      executor.setToolRegistry(f.registry);
      const deps = { approvalManager: after, deferredExecutor: executor };
      if (state === 'pending') await applyApprovalDecision('approve', request.id, 'dashboard', deps);
      else await applyExecutionResolution('execute', request.id, 'dashboard', deps);
      expect(actions).toEqual([]);
      expect(after.getRequest(request.id)?.execution_outcome).toBe('blocked');
      expect(after.getRequest(request.id)?.execution_result).toContain('fresh');
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a live structural approval still dispatches once', async () => {
    const actions: string[] = [];
    const id = await structural('Continue', actions);
    const f = fixture([uiActTool], {}, 10, true);
    await exec(f.orch, 'ui_act', { element_id: id });
    const request = f.approvals.getPending()[0]!;
    const executor = new DeferredExecutor(f.approvals, f.audit);
    executor.setToolRegistry(f.registry);
    await applyApprovalDecision('approve', request.id, 'dashboard', { approvalManager: f.approvals, deferredExecutor: executor });
    await executor.executeApproved(request.id);
    expect(actions).toEqual(['browser_ax_click']);
  });

  test('replacing a structural snapshot invalidates its approval within the same manager', async () => {
    const actions: string[] = [];
    const id = await structural('Continue', actions);
    const f = fixture([uiActTool], {}, 10, true);
    await exec(f.orch, 'ui_act', { element_id: id });
    const request = f.approvals.getPending()[0]!;
    resetUiSnapshots();
    expect(await structural('Send', actions)).toBe(id);
    const executor = new DeferredExecutor(f.approvals, f.audit);
    executor.setToolRegistry(f.registry);
    await applyApprovalDecision('approve', request.id, 'dashboard', { approvalManager: f.approvals, deferredExecutor: executor });
    expect(actions).toEqual([]);
    expect(f.approvals.getRequest(request.id)?.execution_outcome).toBe('blocked');
  });
});

async function captureSend(name = 'Send') {
  setSidecarManagerRef({ listSidecars: () => [{ id: 'sc', name: 'pc', connected: true, capabilities: ['browser'] }],
    dispatchRPC: async () => ({ url: 'https://mail.google.com/mail/u/0/', title: 'Gmail', elements: [
      { ax_id: 'a', backend_node_id: 42, role: 'button', name, interactive: true, sig: 'send-ref' },
    ] }) } as never);
  const text = String(await uiSnapshotTool.execute({ kind: 'browser', target: 'sc' }));
  return Number(text.match(/\[(\d+)\] button/)![1]);
}

describe('visible business effects add checks, never a proof of safe semantics', () => {
  test('a Send control in a captured Gmail surface obeys send_email deny', async () => {
    const id = await captureSend();
    const f = fixture([uiActTool], { overrides: [{ action: 'send_email', allowed: false }] });
    expect(String(await exec(f.orch, 'ui_act', { element_id: id }))).toContain('[AUTHORITY DENIED]');
    expect(f.calls).toEqual([]);
  });

  test('a known send requires a card, and an unrecognized control keeps uncertainty explicit', async () => {
    const id = await captureSend();
    const f = fixture([uiActTool], { governed_categories: ['send_email'] });
    expect(String(await exec(f.orch, 'ui_act', { element_id: id }))).toContain('[AWAITING_APPROVAL]');
    expect(f.approvals.getPending()[0]!.action_category).toBe('send_email');
    const unknown = await captureSend('Continue');
    const gate = resolveToolGate(uiActTool, 'ui_act', { element_id: unknown, effect: 'read_data' });
    expect(gate.confirm).toBe('always');
    expect(gate.intent).toContain('Business effect unknown');
    expect(gate.intent).toContain('Continue');
  });

  test('a level shortfall above the app-control floor offers a click-only review', async () => {
    const id = await captureSend();
    const f = fixture([uiActTool], {}, 5);
    expect(String(await exec(f.orch, 'ui_act', { element_id: id }))).toContain('[AWAITING_APPROVAL]');
    expect(approvalNeedsClick(f.approvals.getPending()[0]!)).toBe(true);
    expect(f.calls).toEqual([]);
  });

  test('a changed page or relabeled stable control cannot reuse the reviewed surface', async () => {
    for (const change of ['page', 'label']) {
      resetUiSnapshots();
      let captures = 0;
      let actions = 0;
      setSidecarManagerRef({ listSidecars: () => [{ id: 'sc', name: 'pc', connected: true, capabilities: ['browser'] }],
        dispatchRPC: async (_id: string, method: string) => {
          if (method !== 'browser_ax_snapshot') { actions++; return { success: true }; }
          const changed = captures++ > 0;
          return { url: changed && change === 'page' ? 'https://mail.google.com/different' : 'https://mail.google.com/', title: 'Gmail',
            elements: [{ ax_id: 'a', backend_node_id: 42, stable_id: 'same-button', sig: 'same-ref', role: 'button',
              name: changed && change === 'label' ? 'Send' : 'Continue', interactive: true }] };
        } } as never);
      const snap = String(await uiSnapshotTool.execute({ kind: 'browser', target: 'sc' }));
      const id = Number(snap.match(/\[(\d+)\] button/)![1]);
      expect(String(await uiActTool.execute({ element_id: id }))).toContain('changed since review');
      expect(actions).toBe(0);
    }
  });

  test('a skill declaration cannot hide a detected send behind a more severe category', async () => {
    upsertSkill({ name: 'send-and-delete', app: 'Gmail', steps: [{ action: 'click',
      ref: { role: 'button', name: 'Send', path: [], ordinal: 0, sig: 's' }, effect: 'delete_data' }] });
    const f = fixture([runSkillTool], { overrides: [{ action: 'send_email', allowed: false }] });
    expect(String(await exec(f.orch, 'run_skill', { name: 'send-and-delete' }))).toContain('[AUTHORITY DENIED]');
    expect(f.calls).toEqual([]);
  });

  test('an unclassified recorded click needs review even at maximum authority', async () => {
    upsertSkill({ name: 'mystery', steps: [{ action: 'click', ref: { role: 'button', name: 'Continue', path: [], ordinal: 0, sig: 's' } }] });
    const f = fixture([runSkillTool]);
    expect(String(await exec(f.orch, 'run_skill', { name: 'mystery' }))).toContain('[AWAITING_APPROVAL]');
    expect(approvalNeedsClick(f.approvals.getPending().find(p => p.tool_name === 'run_skill')!)).toBe(true);
    expect(f.calls).toEqual([]);
  });
});
