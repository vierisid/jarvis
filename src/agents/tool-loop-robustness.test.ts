/**
 * What a tool loop does with a model that writes arguments that are not JSON,
 * and with one that never stops calling tools. Each of the three loops
 * (processMessage, streamMessage, processTaskCall) is driven the same way.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { LLMManager } from '../llm/manager.ts';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse, LLMStreamEvent, LLMToolCall } from '../llm/provider.ts';
import { AgentOrchestrator } from './orchestrator.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import type { RoleDefinition } from '../roles/types.ts';

type Script = (toolResults: string[], call: number) => { content: string; calls: LLMToolCall[] };

class Scripted implements LLMProvider {
  name = 'scripted';
  requests = 0;
  constructor(private readonly script: Script) {}
  private next(m: LLMMessage[]): LLMResponse {
    this.requests++;
    const results = m.filter((x) => x.role === 'tool').map((x) => String(x.content));
    const { content, calls } = this.script(results, this.requests);
    return { content, tool_calls: calls, usage: { input_tokens: 1, output_tokens: 1 }, model: 'scripted', finish_reason: calls.length ? 'tool_use' : 'stop' };
  }
  async chat(m: LLMMessage[], _o?: LLMOptions): Promise<LLMResponse> { return this.next(m); }
  async *stream(m: LLMMessage[]): AsyncIterable<LLMStreamEvent> {
    const response = this.next(m);
    for (const call of response.tool_calls) yield { type: 'tool_call', tool_call: call };
    if (response.content) yield { type: 'text', text: response.content };
    yield { type: 'done', response };
  }
  async listModels(): Promise<string[]> { return ['scripted']; }
}

const ROLE = {
  id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [],
  tools: ['file-ops'], authority_level: 10,
} as unknown as RoleDefinition;
const AUTHORITY = (): AuthorityConfig => ({
  default_level: 10, governed_categories: [], overrides: [], context_rules: [],
  learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal',
});

function build(script: Script) {
  closeDb();
  initDatabase(':memory:');
  const llm = new LLMManager();
  const provider = new Scripted(script);
  llm.registerProvider(provider);
  llm.setTierMap({ medium: { provider: provider.name }, conversation: { provider: provider.name } });
  const registry = new ToolRegistry();
  const ran: string[] = [];
  registry.register({ name: 'read_file', description: 't', category: 'file-ops', parameters: {}, execute: async () => { ran.push('read_file'); return 'ok'; } });
  const orch = new AgentOrchestrator();
  orch.setLLMManager(llm);
  orch.setToolRegistry(registry);
  orch.setAuthorityEngine(new AuthorityEngine(AUTHORITY()));
  orch.setApprovalManager(new ApprovalManager());
  orch.setAuditTrail(new AuditTrail());
  orch.createPrimary(ROLE);
  return { orch, provider, ran };
}

const PROMPT = { static: 'role', dynamic: 'dyn' };
type Outcome = { text: string; events: LLMStreamEvent[] };
const LOOPS: Array<[string, (orch: AgentOrchestrator) => Promise<Outcome>]> = [
  ['processMessage', async (orch) => ({ text: await orch.processMessage(PROMPT, 'go', 'medium', 'scripted', null), events: [] })],
  ['streamMessage', async (orch) => {
    const events: LLMStreamEvent[] = [];
    for await (const event of orch.streamMessage(PROMPT, 'go', 'medium', 'scripted', undefined, null)) events.push(event);
    const done = events.find((e) => e.type === 'done');
    return { text: done?.type === 'done' ? done.response.content : '', events };
  }],
  ['processTaskCall', async (orch) => {
    const result = await orch.processTaskCall({ systemPrompt: PROMPT, userMessage: 'go', tier: 'medium', subsystem: 'scripted', scope: null });
    return { text: result.kind === 'completed' ? result.text : '', events: [] };
  }],
];

afterEach(() => closeDb());

describe('arguments the model wrote that are not valid JSON', () => {
  for (const [name, run] of LOOPS) {
    test(`${name}: the model is told, nothing runs, and the turn carries on`, async () => {
      const { orch, ran } = build((results, call) => call === 1
        ? { content: '', calls: [{ id: 'bad', name: 'read_file', arguments: {}, argumentsError: 'Unexpected token b' }] }
        : { content: `got: ${results.at(-1)}`, calls: [] });
      const outcome = await run(orch);
      expect(ran).toEqual([]);
      expect(outcome.text).toContain('were not valid JSON');
      expect(outcome.text).toContain('did not run');
      expect(outcome.events.some((e) => e.type === 'error')).toBe(false);
    });
  }
});

test('processTaskCall: a clarification whose arguments did not parse does not pause the task on a made-up question', async () => {
  const { orch } = build((results, call) => call === 1
    ? { content: '', calls: [{ id: 'q', name: 'ask_for_clarification', arguments: {}, argumentsError: 'not valid JSON' }] }
    : { content: `got: ${results.at(-1)}`, calls: [] });
  const result = await orch.processTaskCall({ systemPrompt: PROMPT, userMessage: 'go', tier: 'medium', subsystem: 'scripted', scope: null });
  expect(result.kind).toBe('completed');
  expect(result.kind === 'completed' ? result.text : '').toContain('did not run');
});

describe('a turn that never stops calling tools', () => {
  const forever: Script = (_r, call) => ({ content: '', calls: [{ id: `c${call}`, name: 'read_file', arguments: {} }] });

  for (const [name, run] of LOOPS) {
    test(`${name}: stops at a sensible limit with plain words, not a marker`, async () => {
      const { orch, provider, ran } = build(forever);
      const outcome = await run(orch);
      expect(provider.requests).toBeLessThanOrEqual(200);
      expect(ran.length).toBeLessThanOrEqual(200);
      expect(JSON.stringify(outcome)).not.toContain('Max tool iterations');
      if (name === 'streamMessage') {
        // Reported as stopped, never as a completed turn.
        expect(outcome.events.some((e) => e.type === 'done')).toBe(false);
        const stop = outcome.events.find((e) => e.type === 'error');
        expect(stop).toMatchObject({ type: 'error', code: 'tool_loop_limit' });
        expect((stop as { error: string }).error).toContain('I stopped after');
      } else {
        expect(outcome.text).toContain('I stopped after');
      }
    });
  }
});
