import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../../vault/schema.ts';
import { ApprovalManager } from '../../authority/approval.ts';
import { AuditTrail } from '../../authority/audit.ts';
import { DeferredExecutor } from '../../authority/deferred-executor.ts';
import { AuthorityEngine } from '../../authority/engine.ts';
import { ToolRegistry } from './registry.ts';
import { AgentOrchestrator } from '../../agents/orchestrator.ts';
import type { RoleDefinition } from '../../roles/types.ts';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN, splitToolReturn } from '../../roles/untrusted.ts';
import { desktopLaunchAppTool, launchDirective } from './desktop.ts';
import { getSidecarManager, setSidecarManagerRef } from './sidecar-route.ts';
import type { SidecarManager } from '../../sidecar/manager.ts';

// #708: desktop_launch_app's "do not launch it again" directive, authored by
// the brain from `success` and `window_visible`, placed after the frame.

const SIDECAR_NOTE = 'process started (pid 7) but whether a window opened could NOT be checked: no xdotool. Run desktop_list_windows.';

function manager(reply: unknown): SidecarManager {
  return {
    listSidecars: () => [{ id: 'sc1', name: 'linux-box', connected: true, capabilities: ['desktop'], unavailable_capabilities: [] }],
    dispatchRPC: async () => reply,
  } as unknown as SidecarManager;
}

const original = getSidecarManager();
beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => {
  closeDb();
  setSidecarManagerRef(original as SidecarManager);
});

describe('launchDirective', () => {
  test('only the unverified success gets one', () => {
    expect(launchDirective({ success: true, pid: 7, window_visible: null, note: SIDECAR_NOTE })).toContain('do not launch it again');
    expect(launchDirective({ success: true, pid: 7, window_visible: true })).toBeNull();
    expect(launchDirective({ success: false, pid: 7, window_visible: false })).toBeNull();
    // An older sidecar's bare reply has no window_visible at all: absent is not null.
    expect(launchDirective({ success: true, pid: 7 })).toBeNull();
    expect(launchDirective({ success: 'true', window_visible: null })).toBeNull();
    expect(launchDirective('{"success":true,"window_visible":null}')).toBeNull();
    expect(launchDirective(null)).toBeNull();
  });

  test('it is repo text and quotes nothing the sidecar wrote', () => {
    const d = launchDirective({ success: true, pid: 7, window_visible: null, note: SIDECAR_NOTE })!;
    expect(d).not.toContain('xdotool');
    expect(d).not.toContain('pid 7');
  });
});

describe('desktop_launch_app hands its directive over as a trailer (#708)', () => {
  test('the tool return carries the reply as outside content and the directive as the trailer', async () => {
    const reply = { success: true, pid: 7, window_visible: null, note: SIDECAR_NOTE };
    setSidecarManagerRef(manager(reply));
    const { outside, trailer } = splitToolReturn(await desktopLaunchAppTool.execute({ target: 'sc1', executable: 'gedit' }));
    expect(outside).toBe(JSON.stringify(reply, null, 2));
    expect(trailer).toContain('do not launch it again');
  });

  test('a confirmed window carries no trailer and the text is unchanged', async () => {
    const reply = { success: true, pid: 7, window_visible: true, window_title: 'Untitled' };
    setSidecarManagerRef(manager(reply));
    const raw = await desktopLaunchAppTool.execute({ target: 'sc1', executable: 'gedit' });
    expect(raw).toBe(JSON.stringify(reply, null, 2));
  });

  test('through the inline approval gate, the directive lands after the block', async () => {
    setSidecarManagerRef(manager({ success: true, pid: 7, window_visible: null, note: SIDECAR_NOTE }));
    const role = { id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [], tools: ['desktop'],
      authority_level: 10 } as unknown as RoleDefinition;
    const approvals = new ApprovalManager();
    const audit = new AuditTrail();
    const reg = new ToolRegistry();
    reg.register(desktopLaunchAppTool);
    const orch = new AgentOrchestrator();
    orch.setToolRegistry(reg);
    orch.setAuthorityEngine(new AuthorityEngine({ default_level: 10, governed_categories: ['control_app'],
      overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }));
    orch.setApprovalManager(approvals);
    orch.setAuditTrail(audit);
    const ex = new DeferredExecutor(approvals, audit);
    ex.setToolRegistry(reg);
    orch.setDeferredExecutor(ex);
    orch.createPrimary(role);
    type Exec = { executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }, signal?: AbortSignal, taint?: Set<string>) => Promise<unknown> };
    const pending = (orch as unknown as Exec).executeTool(
      { id: 'call', name: 'desktop_launch_app', arguments: { target: 'sc1', executable: 'gedit' } }, undefined, new Set());
    let card = approvals.getPending()[0];
    for (let i = 0; !card && i < 200; i++) {
      await new Promise((r) => setTimeout(r, 5));
      card = approvals.getPending()[0];
    }
    approvals.approve(card!.id, 'dashboard');
    const result = String(await pending);
    expect(result).toContain(UNTRUSTED_OPEN);
    expect(result).toContain('xdotool'); // the sidecar's note, still there, still framed
    const close = result.lastIndexOf(UNTRUSTED_CLOSE);
    expect(result.indexOf('do not launch it again on the strength of this result. Run desktop_list_windows to see what is actually open before interacting with it.'))
      .toBeGreaterThan(close);
  });
});
