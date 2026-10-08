/**
 * #830: an approved `browser_navigate` gets its site playbook back when it was
 * approved INLINE, and still gets none in any other mode.
 *
 * #586 suppressed delivery for every approved call, because this executor could
 * not place a trusted trailer outside the untrusted frame, and a delivery is
 * recorded when the tool offers one -- so each approved navigation burned the
 * chat's 30-minute slot on a copy the model was told to distrust. #708 gave the
 * inline gate the trailer separately, so there the reason is gone. In deferred
 * mode it is not: the receipt goes to a person or a row, never a model.
 *
 * The owner's condition is the EXECUTION MODE, not the tool and not the caller,
 * so each mode is tested, and the deferred one with every claimant.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { upsertWebappTemplate } from '../vault/webapp-templates.ts';
import { ApprovalManager, type ApprovalExecutionMode } from './approval.ts';
import { AuditTrail } from './audit.ts';
import { DeferredExecutor } from './deferred-executor.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { browserNavigateTool, browserSnapshotTool } from '../actions/tools/builtin.ts';
import { getSidecarManager, resetRemoteSnapshotGenerations, setSidecarManagerRef } from '../actions/tools/sidecar-route.ts';
import { splitToolReturn, UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../roles/untrusted.ts';
import { AuthorityEngine } from './engine.ts';
import { AgentOrchestrator } from '../agents/orchestrator.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { SidecarManager } from '../sidecar/manager.ts';
import type { SidecarInfo } from '../sidecar/types.ts';

const box: SidecarInfo = {
  id: 'remote-box', name: 'Remote Box', enrolled_at: '2026-01-01', last_seen_at: '2026-01-02', status: 'enrolled',
  connected: true, hostname: 'box', os: 'linux', platform: 'x64', capabilities: ['browser'],
  features: ['browser_elem_gen'], version: '0.11.0', latest_version: '0.11.0',
};

/**
 * Each test lands on its own host, so the process-wide redelivery memory one
 * test leaves behind cannot answer for the next.
 */
let host = '';
let playbook = '';
const calls: string[] = [];

function fakeSidecar(): SidecarManager {
  return {
    listSidecars: () => [box],
    dispatchRPC: async (_id: string, method: string) => {
      calls.push(method);
      return { text: `Page: ${host}\n[1] button "Go"`, page_url: `https://${host}/`, loader_id: 'L1', elem_gen: 'e.1' };
    },
  } as unknown as SidecarManager;
}

const original = getSidecarManager();
let n = 0;
beforeEach(() => {
  initDatabase(':memory:', { quiet: true });
  resetRemoteSnapshotGenerations();
  calls.length = 0;
  n++;
  host = `app${n}-${Date.now()}.example`;
  playbook = `PLAYBOOK-${n}: check the account before acting.`;
  upsertWebappTemplate({ app_name: `App${n}-${Date.now()}`, domains: [host], description: '', instructions: playbook });
  setSidecarManagerRef(fakeSidecar());
});
afterEach(() => {
  closeDb();
  resetRemoteSnapshotGenerations();
  setSidecarManagerRef(original as SidecarManager);
});

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(browserSnapshotTool);
  r.register(browserNavigateTool);
  return r;
}

/** Raise a navigate card in `mode`, the way the orchestrator does, and approve it. */
function approvedNavigate(mgr: ApprovalManager, reg: ToolRegistry, mode: ApprovalExecutionMode) {
  const req = mgr.createRequest({
    agentId: 'a1', agentName: 'PA', toolName: 'browser_navigate',
    toolArguments: { url: `https://${host}/`, target: 'remote-box' }, actionCategory: 'control_app',
    urgency: 'normal', reason: 'test', toolRegistry: reg, executionMode: mode,
    context: JSON.stringify({ confirm: 'always', intent: 'Review browser_navigate' }),
  });
  return req;
}

function executor(mgr: ApprovalManager, reg: ToolRegistry): DeferredExecutor {
  const ex = new DeferredExecutor(mgr, new AuditTrail());
  ex.setToolRegistry(reg);
  return ex;
}

/** Whether the chat's own next snapshot of this page still gets the playbook. */
async function chatSnapshotGetsPlaybook(): Promise<boolean> {
  const { trailer } = splitToolReturn(await browserSnapshotTool.execute({ target: 'remote-box' }));
  return trailer.includes(playbook);
}

describe('an approved navigate and its site playbook (#830)', () => {
  test('INLINE: the playbook comes back as a trailer, outside the payload and out of the stored row', async () => {
    const mgr = new ApprovalManager();
    const reg = registry();
    const req = approvedNavigate(mgr, reg, 'inline');
    mgr.approve(req.id, 'dashboard');

    const receipt = await executor(mgr, reg).executeApprovedWithReceipt(req.id, 'inline-gate');

    expect(calls).toEqual(['browser_navigate']);
    expect(receipt.trailer).toContain(playbook);
    expect(receipt.outside).toContain(`Page: ${host}`);
    expect(receipt.outside).not.toContain(playbook);
    // #829: the row the `executed` fallbacks re-read carries no trailer.
    expect(mgr.getRequest(req.id)!.execution_result).not.toContain(playbook);
    // Delivered once, so the chat's next snapshot inside the TTL gets none.
    expect(await chatSnapshotGetsPlaybook()).toBe(false);
  });

  for (const claimant of ['dashboard', 'voice', 'inline-gate']) {
    test(`DEFERRED, run by ${claimant}: no playbook, and the chat's slot is not spent`, async () => {
      const mgr = new ApprovalManager();
      const reg = registry();
      const req = approvedNavigate(mgr, reg, 'deferred');
      mgr.approve(req.id, 'dashboard');

      const receipt = await executor(mgr, reg).executeApprovedWithReceipt(req.id, claimant);

      expect(calls).toEqual(['browser_navigate']);
      expect(receipt.trailer).toBeUndefined();
      expect(receipt.result).not.toContain(playbook);
      expect(mgr.getRequest(req.id)!.execution_result).not.toContain(playbook);
      // #586's own failure: a recorded delivery nobody can read would leave
      // the chat's snapshot without a playbook for 30 minutes.
      expect(await chatSnapshotGetsPlaybook()).toBe(true);
    });
  }

  test('an INLINE request demoted after its wait timed out is deferred, and delivers nothing', async () => {
    const mgr = new ApprovalManager();
    const reg = registry();
    const req = approvedNavigate(mgr, reg, 'inline');
    expect(mgr.demoteToDeferred(req.id)).toBe(true);
    mgr.approve(req.id, 'dashboard');

    const receipt = await executor(mgr, reg).executeApprovedWithReceipt(req.id, 'dashboard');

    expect(calls).toEqual(['browser_navigate']);
    expect(receipt.trailer).toBeUndefined();
    expect(receipt.result).not.toContain(playbook);
    expect(await chatSnapshotGetsPlaybook()).toBe(true);
  });

  test('an INLINE row run from the dashboard after a restart does not navigate at all', async () => {
    // Why the mode alone is a sound condition: the one way an inline row
    // reaches this executor without its gate is the execute route after a
    // restart, and a restart drops every UI execution binding, so a reviewed
    // UI call -- which navigate is -- is refused before it dispatches.
    // A regression guard on that premise; it passes with and without #830.
    const mgr = new ApprovalManager();
    const reg = registry();
    const req = approvedNavigate(mgr, reg, 'inline');
    mgr.approve(req.id, 'dashboard');
    mgr.reconcileAfterRestart();
    expect(mgr.getRequest(req.id)!.execution_outcome).toBe('not_started');

    const receipt = await executor(mgr, reg).executeApprovedWithReceipt(req.id, 'dashboard');

    expect(calls).toEqual([]);
    expect(receipt.result).toContain('no longer available');
    expect(await chatSnapshotGetsPlaybook()).toBe(true);
  });
});

describe('end to end through the inline gate (#830)', () => {
  test('the model gets the page framed and the playbook after the frame closes', async () => {
    const role = { id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [], tools: ['browser'],
      authority_level: 10 } as unknown as RoleDefinition;
    const approvals = new ApprovalManager();
    const audit = new AuditTrail();
    const reg = registry();
    const orch = new AgentOrchestrator();
    orch.setToolRegistry(reg);
    orch.setAuthorityEngine(new AuthorityEngine({ default_level: 10, governed_categories: [],
      overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }));
    orch.setApprovalManager(approvals);
    orch.setAuditTrail(audit);
    orch.setDeferredExecutor(executor(approvals, reg));
    orch.createPrimary(role);
    type Exec = { executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }, signal?: AbortSignal, taint?: Set<string>) => Promise<unknown> };
    const pending = (orch as unknown as Exec).executeTool(
      { id: 'call', name: 'browser_navigate', arguments: { url: 'https://' + host + '/', target: 'remote-box' } }, undefined, new Set());
    let card = approvals.getPending()[0];
    for (let i = 0; !card && i < 200; i++) {
      await new Promise((r) => setTimeout(r, 5));
      card = approvals.getPending()[0];
    }
    expect(card?.tool_name).toBe('browser_navigate');
    expect(card?.execution_mode).toBe('inline');
    approvals.approve(card!.id, 'dashboard');
    const result = String(await pending);

    const close = result.lastIndexOf(UNTRUSTED_CLOSE);
    expect(result).toContain(UNTRUSTED_OPEN);
    expect(result.indexOf('Page: ' + host)).toBeGreaterThan(-1);
    expect(result.indexOf('Page: ' + host)).toBeLessThan(close);
    expect(result.indexOf(playbook)).toBeGreaterThan(close);
    expect(result.split(playbook).length).toBe(2);
  });
});

describe('an approved inline row that outlived its gate (#830 review)', () => {
  test('a browser_snapshot card run from the dashboard after a restart delivers nothing', async () => {
    // browser_snapshot is not a reviewed UI tool, so a restart does not refuse
    // it the way it refuses navigate; it can still take an inline card where
    // access_browser is governed. Run after a restart, its result goes to the
    // execute route, not a model -- so the restart demotes it to deferred and
    // the executor suppresses delivery as for any deferred row.
    const mgr = new ApprovalManager();
    const reg = registry();
    const req = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'browser_snapshot', toolArguments: { target: 'remote-box' },
      actionCategory: 'access_browser', urgency: 'normal', reason: 'test', toolRegistry: reg, executionMode: 'inline',
      context: '',
    });
    mgr.approve(req.id, 'dashboard');
    mgr.reconcileAfterRestart();
    expect(mgr.getRequest(req.id)!.execution_mode).toBe('deferred');
    expect(mgr.getRequest(req.id)!.execution_outcome).toBe('not_started');

    const receipt = await executor(mgr, reg).executeApprovedWithReceipt(req.id, 'dashboard');

    expect(calls).toEqual(['browser_snapshot']);
    expect(receipt.trailer).toBeUndefined();
    expect(receipt.result).not.toContain(playbook);
    expect(await chatSnapshotGetsPlaybook()).toBe(true);
  });
});

describe('an inline row an older boot already reconciled (#830 second review)', () => {
  test('is demoted on the next restart too, so the execute route runs it deferred', async () => {
    const mgr = new ApprovalManager();
    const reg = registry();
    const req = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'browser_snapshot', toolArguments: { target: 'remote-box' },
      actionCategory: 'access_browser', urgency: 'normal', reason: 'test', toolRegistry: reg, executionMode: 'inline',
      context: '',
    });
    mgr.approve(req.id, 'dashboard');
    // What a boot before the demotion existed left behind: reconciled to
    // not_started, mode still inline.
    getDb().run(`UPDATE approval_requests SET execution_outcome = 'not_started' WHERE id = ?`, [req.id]);
    mgr.reconcileAfterRestart();
    expect(mgr.getRequest(req.id)!.execution_mode).toBe('deferred');

    const receipt = await executor(mgr, reg).executeApprovedWithReceipt(req.id, 'dashboard');
    expect(calls).toEqual(['browser_snapshot']);
    expect(receipt.trailer).toBeUndefined();
    expect(await chatSnapshotGetsPlaybook()).toBe(true);
  });
});
