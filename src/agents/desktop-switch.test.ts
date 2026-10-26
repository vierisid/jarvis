/**
 * #905: with desktop.enabled off, a desktop call the model makes anyway (an
 * off-list call, a stale realtime session, a filter that is switched off) is
 * answered with the desktop-off refusal BEFORE the authority gate, on the text
 * and realtime paths: the tool never runs and the gate records no decision for
 * it. The registry refuses it too, but only after the gate has already logged
 * it as allowed and executed (realtime auto-approves, so it would even read
 * "approval_required, executed") or raised a card asking the person to approve
 * a call that can only be refused.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { LLMManager } from '../llm/manager.ts';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse, LLMStreamEvent, LLMToolCall } from '../llm/provider.ts';
import { AgentOrchestrator } from './orchestrator.ts';
import { RealtimeTaint } from './realtime-taint.ts';
import { AgentInstance } from './agent.ts';
import { runSubAgent } from './sub-agent-runner.ts';
import { ToolRegistry, type ToolDefinition } from '../actions/tools/registry.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { DESKTOP_DISABLED_MESSAGE, setDesktopEnabledSource } from '../actions/tools/desktop-guard.ts';
import { resetToolFilterPolicy, setToolFilterPolicy } from '../actions/tools/tool-relevance/policy.ts';
import type { RoleDefinition } from '../roles/types.ts';

class OneCallProvider implements LLMProvider {
  name = 'desktop-switch';
  private calls = 0;
  seen: LLMMessage[][] = [];
  constructor(private readonly toolName: string, private readonly args: Record<string, unknown>) {}
  private next(): LLMResponse {
    this.calls++;
    if (this.calls === 1) {
      const call: LLMToolCall = { id: 'c1', name: this.toolName, arguments: this.args };
      return { content: '', tool_calls: [call], usage: { input_tokens: 1, output_tokens: 1 }, model: 'm', finish_reason: 'tool_use' };
    }
    return { content: 'finished', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'm', finish_reason: 'stop' };
  }
  async chat(m: LLMMessage[], _o?: LLMOptions): Promise<LLMResponse> { this.seen.push([...m]); return this.next(); }
  async *stream(m: LLMMessage[]): AsyncIterable<LLMStreamEvent> {
    this.seen.push([...m]);
    const response = this.next();
    for (const call of response.tool_calls) yield { type: 'tool_call', tool_call: call };
    if (response.content) yield { type: 'text', text: response.content };
    yield { type: 'done', response };
  }
  async listModels(): Promise<string[]> { return ['m']; }
}

const ROLE = {
  id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [],
  tools: ['desktop'], authority_level: 10,
} as unknown as RoleDefinition;

// Everything allowed: a desktop_list_windows (read_data) that reached the gate is logged as
// allowed and executed, which is what the early refusal must prevent.
const AUTHORITY = (): AuthorityConfig => ({
  default_level: 10, governed_categories: [], overrides: [], context_rules: [],
  learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal',
});

let desktopOn = true;
beforeEach(() => {
  desktopOn = true;
  setDesktopEnabledSource(() => desktopOn);
  closeDb();
  initDatabase(':memory:');
});
afterEach(() => {
  setDesktopEnabledSource(null);
  resetToolFilterPolicy();
  closeDb();
});

function build() {
  const ran: string[] = [];
  const provider = new OneCallProvider('desktop_list_windows', {});
  const llm = new LLMManager();
  llm.registerProvider(provider);
  llm.setTierMap({ medium: { provider: provider.name }, conversation: { provider: provider.name } });
  const registry = new ToolRegistry();
  const tool = (name: string, category: string): ToolDefinition => ({
    name, description: 't', category, parameters: {},
    execute: async () => { ran.push(name); return 'ok'; },
  });
  registry.register(tool('desktop_list_windows', 'desktop'));
  registry.register(tool('read_file', 'file-ops'));
  const audit = new AuditTrail();
  const approvals = new ApprovalManager();
  const orch = new AgentOrchestrator();
  orch.setLLMManager(llm);
  orch.setToolRegistry(registry);
  orch.setAuthorityEngine(new AuthorityEngine(AUTHORITY()));
  orch.setApprovalManager(approvals);
  orch.setAuditTrail(audit);
  orch.createPrimary(ROLE);
  return { orch, ran, audit, approvals, provider };
}

function toolResult(provider: OneCallProvider): string | null {
  for (const buffer of [...provider.seen].reverse()) {
    const m = [...buffer].reverse().find((x) => x.role === 'tool');
    if (m) return String(m.content);
  }
  return null;
}

const PROMPT = { static: 'role', dynamic: 'dyn' };

describe('desktop.enabled: false answers before the gate', () => {
  for (const filterEnabled of [true, false]) {
    test(`text loop (tool filter ${filterEnabled ? 'on' : 'off'}): refused, no gate row, no card, not run`, async () => {
      setToolFilterPolicy(filterEnabled ? { enabled: true, maxParamsB: 20, models: [] } : { enabled: false, maxParamsB: 20, models: [] });
      desktopOn = false;
      const { orch, ran, audit, approvals, provider } = build();
      await orch.processMessage(PROMPT, 'list my windows', 'medium', 'desktop-switch', null);
      expect(ran).toEqual([]);
      expect(toolResult(provider)).toContain(DESKTOP_DISABLED_MESSAGE);
      expect(approvals.getPending()).toEqual([]);
      // One denied row for the refusal itself, and nothing that reads as a gate
      // decision or an off-list admission of the tool.
      expect(audit.query({ limit: 20 }).map((r) => [r.tool_name, r.authority_decision, r.executed]))
        .toEqual([['desktop_disabled(desktop_list_windows)', 'denied', 0]]);
    });
  }

  test('realtime: refused, no gate row, not run', async () => {
    desktopOn = false;
    const { orch, ran, audit } = build();
    const taint = new RealtimeTaint();
    const reply = await orch.executeRealtimeToolCall('desktop_list_windows', {}, { taint });
    expect(reply).toBe(DESKTOP_DISABLED_MESSAGE);
    expect(ran).toEqual([]);
    // Nothing was read, so the session is not tainted (#928).
    expect([...taint.marks]).toEqual([]);
    expect(audit.query({ limit: 20 }).map((r) => [r.tool_name, r.authority_decision, r.executed, r.channel]))
      .toEqual([['desktop_disabled(desktop_list_windows)', 'denied', 0, 'voice']]);
  });

  test('with the switch on the same calls reach the gate and run (the fixture is live)', async () => {
    const realtime = build();
    const taint = new RealtimeTaint();
    expect(await realtime.orch.executeRealtimeToolCall('desktop_list_windows', {}, { taint })).toContain('ok');
    expect(realtime.ran).toEqual(['desktop_list_windows']);
    // A read that ran taints the session that made it.
    expect([...taint.marks]).toEqual(['desktop_list_windows']);
    expect(realtime.audit.query({ limit: 20 }).filter((r) => r.tool_name === 'desktop_list_windows')).toHaveLength(1);

    closeDb();
    initDatabase(':memory:');
    const text = build();
    await text.orch.processMessage(PROMPT, 'list my windows', 'medium', 'desktop-switch', null);
    expect(text.ran).toEqual(['desktop_list_windows']);
    expect(text.audit.query({ limit: 20 }).filter((r) => r.tool_name === 'desktop_list_windows')).toHaveLength(1);
  });

  for (const [on, filterOn] of [[false, false], [false, true], [true, false], [true, true]] as const) test(`sub-agent (switch ${on ? 'on' : 'off'}, tool filter ${filterOn ? 'on' : 'off'}): ${on ? 'runs, with its gate row' : 'refused, no gate row, not run'}`, async () => {
    desktopOn = on;
    if (filterOn) setToolFilterPolicy({ enabled: true, maxParamsB: 20, models: [] });
    const ran: string[] = [];
    const registry = new ToolRegistry();
    registry.register({ name: 'desktop_list_windows', description: 't', category: 'desktop', parameters: {},
      execute: async () => { ran.push('desktop_list_windows'); return 'ok'; } });
    const audit = new AuditTrail();
    const agent = new AgentInstance({ ...ROLE, id: 'software-engineer' } as RoleDefinition);
    let turn = 0;
    const usage = { input_tokens: 0, output_tokens: 0 };
    const seen: LLMMessage[][] = [];
    const llm = {
      chatTier: async (_tier: unknown, _subsystem: unknown, messages: LLMMessage[]) => {
        seen.push([...messages]);
        turn += 1;
        return turn === 1
          ? { content: '', tool_calls: [{ id: 'c1', name: 'desktop_list_windows', arguments: {} }], usage, finish_reason: 'tool_use' }
          : { content: 'done', tool_calls: [], usage, finish_reason: 'stop' };
      },
    };
    await runSubAgent({
      agent, task: 'list windows', context: '', llmManager: llm as never, toolRegistry: registry,
      authorityEngine: new AuthorityEngine(AUTHORITY()), auditTrail: audit, profile: null,
    });
    const rows = audit.query({ limit: 20 }).filter((r) => r.tool_name === 'desktop_list_windows');
    if (on) {
      expect(ran).toEqual(['desktop_list_windows']);
      expect(rows).toHaveLength(1);
    } else {
      expect(ran).toEqual([]);
      expect(rows).toEqual([]);
      // Only the refusal's own row: no off-list admission of a tool that is off.
      expect(audit.query({ limit: 20 }).map((r) => [r.tool_name, r.authority_decision, r.executed]))
        .toEqual([['desktop_disabled(desktop_list_windows)', 'denied', 0]]);
      const toolMessage = seen.flat().reverse().find((m) => m.role === 'tool');
      expect(String(toolMessage?.content)).toContain(DESKTOP_DISABLED_MESSAGE);
    }
  });
});
