/**
 * Saying it is the approval (authority/owner-word.ts), on the two other roads
 * an approval can come from: a helper agent's tool call, and the model's own
 * request for approval.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRequestApprovalTool } from '../actions/tools/approval-tool.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { runSubAgent, type SubAgentResult } from '../agents/sub-agent-runner.ts';
import { withBriefTurn } from '../brief/chat-context.ts';
import type { LLMToolCall } from '../llm/provider.ts';
import { NOTCH_SWITCH } from '../notch/switch.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import type { ApprovalDelivery } from './approval-delivery.ts';
import { ApprovalManager } from './approval.ts';
import { AuthorityEngine } from './engine.ts';

const turn = (requestId: string) => <T>(fn: () => T): T =>
  withBriefTurn({ conversationId: 'c', turnId: 't', requestId, signal: new AbortController().signal, progress: () => {} }, fn);
const onNotch = turn('notch-typed-1');
const onDashboard = turn('req-1');

let before: string | undefined;
beforeEach(() => { before = process.env[NOTCH_SWITCH]; process.env[NOTCH_SWITCH] = '1'; initDatabase(':memory:', { quiet: true }); });
afterEach(() => { if (before === undefined) delete process.env[NOTCH_SWITCH]; else process.env[NOTCH_SWITCH] = before; closeDb(); });

describe('a helper agent working on something asked on the notch', () => {
  function helper(calls: LLMToolCall[]) {
    const runs: string[] = [];
    const registry = new ToolRegistry();
    for (const name of ['write_file', 'run_command']) {
      registry.register({ name, category: name === 'run_command' ? 'terminal' : 'file-ops', description: 't', parameters: {},
        execute: async (params) => { runs.push(`${name} ${JSON.stringify(params)}`); return 'ok'; } });
    }
    const history: Array<{ role: string; content: unknown }> = [];
    const agent = {
      id: 'child', agent: { role: { id: 'fixture', name: 'Fixture', description: '', responsibilities: [] }, authority: { max_authority_level: 10 } },
      setTask() {}, activate() {}, idle() {},
      addMessage: (role: string, content: unknown) => history.push({ role, content }), getMessages: () => history,
    } as never;
    let call = 0;
    const llmManager = { chatTier: async () => (call++ === 0
      ? { content: '', finish_reason: 'tool_use', tool_calls: calls, usage: { input_tokens: 1, output_tokens: 1 } }
      : { content: 'done', finish_reason: 'end_turn', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } }) } as never;
    const engine = new AuthorityEngine({ default_level: 10, governed_categories: ['write_data'] as never, overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
    const run = (): Promise<SubAgentResult> => runSubAgent({ agent, task: 'do it', context: '', llmManager, toolRegistry: registry,
      authorityEngine: engine, auditTrail: { log: (row: unknown) => row } as never, maxIterations: 3 });
    return { run, runs };
  }
  const said = (result: SubAgentResult): string => result.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
  const write: LLMToolCall = { id: 'c1', name: 'write_file', arguments: { path: '/tmp/notes.txt', content: 'hello' } };
  const remove: LLMToolCall = { id: 'c2', name: 'run_command', arguments: { command: 'rm -rf /tmp/old' } };

  test('is not refused for want of a yes: the owner gave it by asking', async () => {
    const h = helper([write]);
    const result = await onNotch(() => h.run());
    expect(h.runs).toEqual(['write_file {"path":"/tmp/notes.txt","content":"hello"}']);
    expect(said(result)).not.toContain('requires user approval');
  });

  test('cannot delete: a helper cannot hold the question, so it is refused and nothing is removed', async () => {
    const h = helper([remove]);
    const result = await onNotch(() => h.run());
    expect(h.runs).toEqual([]);
    expect(said(result)).toContain('requires user approval');
  });

  test('anywhere else it is refused as before', async () => {
    const h = helper([write]);
    const result = await onDashboard(() => h.run());
    expect(h.runs).toEqual([]);
    expect(said(result)).toContain('requires user approval');
  });
});

describe('the model asking for approval of its own accord, in a turn from the notch', () => {
  function tool() {
    const approvalManager = new ApprovalManager();
    const delivered: string[] = [];
    const approvalDelivery = { deliver: async (request: { id: string }) => { delivered.push(request.id); } } as unknown as ApprovalDelivery;
    const made = createRequestApprovalTool({ approvalManager, approvalDelivery, getCurrentAgent: () => ({ id: 'primary', name: 'Jarvis' }), timeoutMs: 20 });
    return { approvalManager, delivered, ask: (category: string, intent: string) => made.execute({ action_category: category, intent }) as Promise<string> };
  }

  test('is told the owner already approved it by asking, and nothing is raised', async () => {
    const h = tool();
    for (const [category, intent] of [
      ['send_email', 'Send the numbers to Leo'], ['send_message', 'Tell Sam the build is done'], ['install_software', 'Install Steam'],
      ['modify_settings', 'Turn on dark mode'], ['execute_command', 'Run git push'],
    ]) {
      const out = await onNotch(() => h.ask(category!, intent!));
      expect([category, out.startsWith('[APPROVED]')]).toEqual([category, true]);
    }
    expect(h.approvalManager.getPending()).toEqual([]);
    expect(h.delivered).toEqual([]);
  });

  test('a delete and a payment are still raised, and wait for the owner', async () => {
    const h = tool();
    for (const [category, intent] of [['delete_data', 'Delete the folder notch-test'], ['make_payment', 'Buy the game for 40 dollars']]) {
      const out = await onNotch(() => h.ask(category!, intent!));
      expect([category, out.startsWith('[APPROVED]')]).toEqual([category, false]);
    }
    expect(h.approvalManager.getPending()).toHaveLength(2);
    expect(h.delivered).toHaveLength(2);
  });

  test('in a dashboard turn everything is raised as before', async () => {
    const h = tool();
    const out = await onDashboard(() => h.ask('send_email', 'Send the numbers to Leo'));
    expect(out.startsWith('[APPROVED]')).toBe(false);
    expect(h.approvalManager.getPending()).toHaveLength(1);
  });
});
