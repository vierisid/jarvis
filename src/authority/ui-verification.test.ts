import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema';
import { ApprovalManager } from './approval';
import { AuditTrail } from './audit';
import { DeferredExecutor } from './deferred-executor';
import { ToolRegistry, type ToolDefinition } from '../actions/tools/registry';
import { desktopLaunchAppTool } from '../actions/tools/desktop';
import { browserSnapshotTool, browserNavigateTool, browserClickTool } from '../actions/tools/builtin';
import { setSidecarManagerRef, resetRemoteSnapshotGenerations } from '../actions/tools/sidecar-route';
import type { SidecarManager } from '../sidecar/manager';
import { SidecarRPCError } from '../sidecar/rpc';

beforeEach(() => { initDatabase(':memory:', { quiet: true }); resetRemoteSnapshotGenerations(); });
afterEach(() => { closeDb(); setSidecarManagerRef(null as unknown as SidecarManager); });

function fixture(tool: ToolDefinition, reply: unknown, os = 'linux') {
  const sidecar = { id: 'fixture-device', name: 'Fixture device', os, connected: true,
    session: 'fixture-session', capabilities: ['browser', 'desktop'], features: ['browser_elem_gen', 'browser_action_outcomes'] };
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const machines = [sidecar];
  setSidecarManagerRef({ getConnectionSessionId: () => sidecar.connected ? sidecar.session : null, listSidecars: () => machines, dispatchRPC: async (_id: string, method: string, args: Record<string, unknown>) => {
    calls.push({ method, args });
    if (method === 'browser_snapshot') return { text: 'fixture', page_url: 'https://example.test/', loader_id: 'L1', elem_gen: 'e.1' };
    if (reply instanceof Error) throw reply;
    return reply;
  } } as unknown as SidecarManager);
  const registry = new ToolRegistry(); registry.register(tool);
  const manager = new ApprovalManager();
  const executor = new DeferredExecutor(manager, new AuditTrail()); executor.setToolRegistry(registry);
  const request = (args: Record<string, unknown>) => {
    const r = manager.createRequest({ agentId: 'fixture', agentName: 'Fixture', toolName: tool.name,
      toolArguments: { target: sidecar.id, ...args }, actionCategory: 'control_app', urgency: 'normal', reason: 'fixture',
      context: JSON.stringify({ confirm: 'always', intent: 'Fixture UI action' }), toolRegistry: registry });
    manager.approve(r.id, 'dashboard'); return r; // click-only: decided on the dashboard (Q-08)
  };
  return { sidecar, machines, calls, manager, executor, request };
}

for (const os of ['windows', 'darwin', 'linux']) for (const visible of [true, null]) {
  test(`${os}: approved launch records ${visible ? 'observed' : 'unverified'} window without relaunch`, async () => {
    const f = fixture(desktopLaunchAppTool, { success: true, pid: 42, window_visible: visible }, os);
    const request = f.request({ executable: 'fixture-app' });
    const receipt = await f.executor.executeApprovedWithReceipt(request.id);
    expect(receipt.failed).toBeUndefined();
    expect(receipt.verification).toEqual(visible
      ? { status: 'verified', postcondition: 'window_visible', pid: 42 }
      : { status: 'unverified', reason: 'window_visibility_unknown' });
    expect(f.manager.getRequest(request.id)?.execution_result).toContain(visible ? 'window_visible' : 'UI verification: unverified');
    await f.executor.executeApprovedWithReceipt(request.id);
    expect(f.calls).toHaveLength(1);
  });
}

test('approved navigation records the landing document, not the requested URL', async () => {
  const f = fixture(browserNavigateTool, { text: 'redirect', page_url: 'https://example.test/actual', loader_id: 'L2' });
  const request = f.request({ url: 'https://example.test/requested' });
  const receipt = await f.executor.executeApprovedWithReceipt(request.id);
  expect(receipt.verification).toEqual({ status: 'verified', postcondition: 'page_observed', pageUrl: 'https://example.test/actual', documentId: 'L2' });
});

for (const code of ['BROWSER_ACTION_REFUSED', 'BROWSER_ACTION_UNCERTAIN']) test(`approved ${code} does not commit success or dispatch twice`, async () => {
  const f = fixture(browserClickTool, new SidecarRPCError(code, 'fixture refusal'));
  await browserSnapshotTool.execute({ target: f.sidecar.id });
  const request = f.request({ element_id: 1 });
  const receipt = await f.executor.executeApprovedWithReceipt(request.id);
  expect(receipt.failed).toBe(true);
  // Typed, not just failed (Q-08): refused before dispatch is blocked, an uncertain one stays unknown.
  expect(f.manager.getRequest(request.id)?.execution_outcome).toBe(code === 'BROWSER_ACTION_REFUSED' ? 'blocked' : 'unknown');
  const call = f.calls.find(c => c.method === 'browser_click')!;
  expect(call.args).toMatchObject({ action_outcome: true, elem_gen: 'e.1' });
  await f.executor.executeApprovedWithReceipt(request.id);
  expect(f.calls.filter(c => c.method === 'browser_click')).toHaveLength(1);
});

test('snapshot binding alone cannot substitute for typed browser outcomes', async () => {
  const f = fixture(browserClickTool, 'Error: legacy refusal');
  f.sidecar.features = ['browser_elem_gen'];
  await browserSnapshotTool.execute({ target: f.sidecar.id });
  const request = f.request({ element_id: 1 });
  const receipt = await f.executor.executeApprovedWithReceipt(request.id);
  expect(receipt.failed).toBe(true);
  expect(receipt.result).toContain('cannot report typed browser action outcomes');
  expect(f.calls.filter(c => c.method === 'browser_click')).toEqual([]);
});

test('a completed approved click still has no verified business postcondition', async () => {
  const f = fixture(browserClickTool, 'Clicked element [1]');
  await browserSnapshotTool.execute({ target: f.sidecar.id });
  const request = f.request({ element_id: 1 });
  const receipt = await f.executor.executeApprovedWithReceipt(request.id);
  expect(receipt.failed).toBeUndefined();
  expect(receipt.verification).toEqual({ status: 'unverified', reason: 'no_supported_postcondition' });
  expect(f.manager.getRequest(request.id)?.execution_result).toContain('UI verification: unverified');
});

for (const tool of [desktopLaunchAppTool, browserNavigateTool]) for (const change of ['reconnect', 'offline', 'capability']) {
  test(`${tool.name}: approval refuses ${change} without dispatch`, async () => {
    const f = fixture(tool, { success: true, pid: 42, window_visible: true });
    const request = f.request(tool === desktopLaunchAppTool ? { executable: 'fixture-app' } : { url: 'https://example.test/' });
    if (change === 'reconnect') f.sidecar.session = 'replacement-session';
    if (change === 'offline') f.sidecar.connected = false;
    if (change === 'capability') f.sidecar.capabilities = [];
    const receipt = await f.executor.executeApprovedWithReceipt(request.id);
    expect(receipt.result).toContain('original UI session');
    expect(f.manager.getRequest(request.id)?.execution_outcome).toBe('blocked');
    expect(f.calls).toEqual([]);
  });
}

for (const tool of [desktopLaunchAppTool, browserNavigateTool]) test(`${tool.name}: approval cannot follow a new default device`, async () => {
  const f = fixture(tool, 'ok');
  const request = f.request({ ...(tool === desktopLaunchAppTool ? { executable: 'fixture-app' } : { url: 'https://example.test/' }), target: undefined });
  f.machines.unshift({ ...f.sidecar, id: 'replacement-device', session: 'replacement-session' });
  const receipt = await f.executor.executeApprovedWithReceipt(request.id);
  expect(receipt.result).toContain('original UI session');
  expect(f.manager.getRequest(request.id)?.execution_outcome).toBe('blocked');
  expect(f.calls).toEqual([]);
});
