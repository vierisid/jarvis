/**
 * Opening an app the owner asked for on the notch needs no approval
 * (authority/app-open.ts), checked where tool calls are actually decided.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ToolRegistry, type ToolDefinition } from '../actions/tools/registry.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { buildTaintGating } from '../authority/taint-gating.ts';
import { withBriefTurn } from '../brief/chat-context.ts';
import { NOTCH_SWITCH } from '../notch/switch.ts';
import type { RoleDefinition } from '../roles/types.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { AgentOrchestrator } from './orchestrator.ts';

type Exec = { executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }, signal?: AbortSignal, taint?: Set<string>) => Promise<unknown> };

const role = { id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [], tools: ['terminal', 'browser', 'desktop'], authority_level: 5 } as unknown as RoleDefinition;
const config = (): AuthorityConfig => ({
  default_level: 3, governed_categories: ['send_email', 'send_message', 'make_payment'], overrides: [], context_rules: [],
  learning: { enabled: true, suggest_threshold: 5 }, emergency_state: 'normal',
});

function build() {
  const calls: string[] = [];
  const registry = new ToolRegistry();
  const tool = (name: string, category: string): ToolDefinition => ({
    name, description: 't', category, parameters: {},
    execute: async (params) => { calls.push(`${name} ${JSON.stringify(params)}`); return 'ok'; },
  });
  for (const t of [tool('desktop_launch_app', 'desktop'), tool('desktop_click', 'desktop'), tool('run_command', 'terminal'), tool('browser_snapshot', 'browser')]) registry.register(t);
  const approvals = new ApprovalManager();
  const orch = new AgentOrchestrator();
  orch.setToolRegistry(registry);
  orch.setAuthorityEngine(new AuthorityEngine(config()));
  orch.setApprovalManager(approvals);
  orch.setTaintGating(buildTaintGating(undefined));
  orch.createPrimary(role);
  const run = (name: string, args: Record<string, unknown>, turn: Set<string>) =>
    (orch as unknown as Exec).executeTool({ id: 't', name, arguments: args }, undefined, turn);
  return { calls, approvals, run };
}

const onNotch = <T>(fn: () => T): T =>
  withBriefTurn({ conversationId: 'c', turnId: 't', requestId: 'notch-spoken-1', signal: new AbortController().signal, progress: () => {} }, fn);
const onDashboard = <T>(fn: () => T): T =>
  withBriefTurn({ conversationId: 'c', turnId: 't', requestId: 'req-1', signal: new AbortController().signal, progress: () => {} }, fn);

let before: string | undefined;
beforeEach(() => { before = process.env[NOTCH_SWITCH]; process.env[NOTCH_SWITCH] = '1'; initDatabase(':memory:', { quiet: true }); });
afterEach(() => { if (before === undefined) delete process.env[NOTCH_SWITCH]; else process.env[NOTCH_SWITCH] = before; closeDb(); });

describe('"open Steam", asked on the notch', () => {
  test('opens it, with no approval', async () => {
    const h = build();
    const out = await onNotch(() => h.run('desktop_launch_app', { executable: 'steam' }, new Set()));
    expect(h.calls).toEqual(['desktop_launch_app {"executable":"steam"}']);
    expect(String(out)).not.toContain('AWAITING_APPROVAL');
    expect(h.approvals.getPending()).toEqual([]);
  });

  test('also after the turn has read outside content, and by its installed path', async () => {
    const h = build();
    const turn = new Set<string>();
    await onNotch(() => h.run('browser_snapshot', {}, turn));
    await onNotch(() => h.run('desktop_launch_app', { executable: 'C:\\Program Files (x86)\\Steam\\steam.exe' }, turn));
    expect(h.calls).toHaveLength(2);
    expect(h.approvals.getPending()).toEqual([]);
  });

  test('opening it still counts as outside content: a command after it stops for approval', async () => {
    const h = build();
    const turn = new Set<string>();
    await onNotch(() => h.run('desktop_launch_app', { executable: 'steam' }, turn));
    expect([...turn]).toContain('desktop_launch_app');
    const out = String(await onNotch(() => h.run('run_command', { command: 'reg query x' }, turn)));
    expect(out).toContain('[AWAITING_APPROVAL]');
    expect(h.approvals.getPending()).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
  });

  test('anything that is not a plain app open is asked about, as before', async () => {
    for (const args of [{ executable: 'steam', args: '-applaunch 730' }, { executable: 'powershell' }, { executable: 'C:\\Users\\sam\\Downloads\\steam.exe' }, { executable: 'setup.msi' }]) {
      const h = build();
      const out = String(await onNotch(() => h.run('desktop_launch_app', args, new Set())));
      expect([JSON.stringify(args), out.includes('AWAITING_APPROVAL'), h.calls.length]).toEqual([JSON.stringify(args), true, 0]);
    }
    const click = build();
    expect(String(await onNotch(() => click.run('desktop_click', { x: 1, y: 2 }, new Set())))).toContain('AWAITING_APPROVAL');
  });
});

describe('everywhere else, opening an app is reviewed as it always was', () => {
  test('a dashboard turn, a turn with no chat behind it, and the notch switch off', async () => {
    const dashboard = build();
    expect(String(await onDashboard(() => dashboard.run('desktop_launch_app', { executable: 'steam' }, new Set())))).toContain('AWAITING_APPROVAL');
    const bare = build();
    expect(String(await bare.run('desktop_launch_app', { executable: 'steam' }, new Set()))).toContain('AWAITING_APPROVAL');
    delete process.env[NOTCH_SWITCH];
    const off = build();
    expect(String(await onNotch(() => off.run('desktop_launch_app', { executable: 'steam' }, new Set())))).toContain('AWAITING_APPROVAL');
    expect([dashboard.calls.length, bare.calls.length, off.calls.length]).toEqual([0, 0, 0]);
  });
});
