/**
 * Opening an app the owner asked for on the notch needs no approval
 * (authority/app-open.ts), checked where tool calls are actually decided.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ToolRegistry, type ToolDefinition } from '../actions/tools/registry.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { setOwnerWordProbe } from '../authority/owner-word.ts';
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

  test('opening it still counts as outside content, as every read does', async () => {
    const h = build();
    const turn = new Set<string>();
    await onNotch(() => h.run('desktop_launch_app', { executable: 'steam' }, turn));
    expect([...turn]).toContain('desktop_launch_app');
  });
});

/**
 * Saying it is the approval (authority/owner-word.ts), decided by the owner on
 * 13 November 2026 after every step of "open Notepad and write a poem" stopped
 * for a yes. Checked where tool calls are actually decided.
 */
describe('anything asked on the notch is done without asking, except a delete or a payment', () => {
  test('a click, typed text, a command, a page, an app with arguments: none stops for a yes', async () => {
    const h = build();
    const turn = new Set<string>();
    const asked: [string, Record<string, unknown>][] = [
      ['desktop_launch_app', { executable: 'steam', args: '-applaunch 730' }],
      ['desktop_launch_app', { executable: 'powershell' }],
      ['browser_snapshot', {}],
      ['desktop_click', { element_id: 52 }],
      ['run_command', { command: 'reg query HKCU\\Software\\Valve' }],
      ['run_command', { command: 'mkdir notch-test' }],
    ];
    for (const [name, args] of asked) {
      const out = String(await onNotch(() => h.run(name, args, turn)));
      expect([name, out.includes('AWAITING_APPROVAL')]).toEqual([name, false]);
    }
    expect(h.calls).toHaveLength(asked.length);
    expect(h.approvals.getPending()).toEqual([]);
  });

  test('also after the turn has read outside content: the step after a read is not held for a yes', async () => {
    const h = build();
    const turn = new Set<string>();
    await onNotch(() => h.run('browser_snapshot', {}, turn));
    expect(turn.size).toBeGreaterThan(0);
    const out = String(await onNotch(() => h.run('run_command', { command: 'dir' }, turn)));
    expect(out).not.toContain('AWAITING_APPROVAL');
    expect(h.calls).toHaveLength(2);
  });

  test('a command that deletes is still asked about, and does not run', async () => {
    // Also in a turn that has read nothing, where the ordinary rules let a command run unasked.
    const h = build();
    const commands = ['rm -rf notch-test', 'Remove-Item -Recurse notch-test', 'del notes.txt', 'git clean -fd'];
    for (const [i, command] of commands.entries()) {
      const out = String(await onNotch(() => h.run('run_command', { command }, new Set())));
      expect([command, out.includes('AWAITING_APPROVAL'), h.calls.length, h.approvals.getPending().length]).toEqual([command, true, 0, i + 1]);
    }
    // The same commands in a dashboard turn are judged by the ordinary rules, which this decision did not change.
    const elsewhere = build();
    expect(String(await onDashboard(() => elsewhere.run('run_command', { command: 'rm -rf notch-test' }, new Set())))).not.toContain('AWAITING_APPROVAL');
  });

  test('a raw click on what the screen calls a payment or a delete is still asked about', async () => {
    setOwnerWordProbe(async (_tool, params) => (params.element_id === 9 ? ['make_payment'] : params.element_id === 8 ? ['delete_data'] : []));
    try {
      const h = build();
      expect(String(await onNotch(() => h.run('desktop_click', { element_id: 9 }, new Set())))).toContain('AWAITING_APPROVAL');
      expect(String(await onNotch(() => h.run('desktop_click', { element_id: 8 }, new Set())))).toContain('AWAITING_APPROVAL');
      expect(String(await onNotch(() => h.run('desktop_click', { element_id: 7 }, new Set())))).not.toContain('AWAITING_APPROVAL');
      expect(h.calls).toEqual(['desktop_click {"element_id":7}']);
      expect(h.approvals.getPending()).toHaveLength(2);
    } finally {
      setOwnerWordProbe(null);
    }
  });
});

describe('everywhere else it is asked about as it always was', () => {
  test('a click, a command after a read, and an app with arguments, in a dashboard turn', async () => {
    const h = build();
    const turn = new Set<string>();
    await onDashboard(() => h.run('browser_snapshot', {}, turn));
    for (const [name, args] of [
      ['desktop_click', { element_id: 52 }], ['run_command', { command: 'dir' }], ['desktop_launch_app', { executable: 'steam', args: '-applaunch 730' }],
    ] as const) {
      const out = String(await onDashboard(() => h.run(name, args, turn)));
      expect([name, out.includes('AWAITING_APPROVAL')]).toEqual([name, true]);
    }
    expect(h.calls).toHaveLength(1);
  });

  test('and with the notch switch off, also in a turn that carries a notch id', async () => {
    delete process.env[NOTCH_SWITCH];
    const h = build();
    expect(String(await onNotch(() => h.run('desktop_click', { element_id: 52 }, new Set())))).toContain('AWAITING_APPROVAL');
    expect(h.calls).toEqual([]);
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
