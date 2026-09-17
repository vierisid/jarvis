import { describe, expect, test } from 'bun:test';
import { runSubAgent, type GovernedToolCall, type GovernedToolDispatch, type SubAgentResult } from './sub-agent-runner';
import { ToolRegistry } from '../actions/tools/registry';
import { AuthorityEngine } from '../authority/engine';
import type { LLMToolCall } from '../llm/provider';

const approval = { effectId: 'effect', approvalId: 'approval', waitpointId: 'waitpoint' };
const write = (id: string): LLMToolCall => ({ id, name: 'write_file', arguments: { path: '/tmp/synthetic', content: 'hello' } });
const read = (id: string): LLMToolCall => ({ id, name: 'read_file', arguments: { path: '/tmp/synthetic' } });

function agent() {
  const history: Array<{ role: string; content: unknown }> = [];
  return {
    id: 'child', agent: { role: { id: 'fixture', name: 'Fixture', description: '', responsibilities: [] }, authority: { max_authority_level: 10 } },
    setTask() {}, activate() {}, idle() {},
    addMessage: (role: string, content: unknown) => history.push({ role, content }), getMessages: () => history,
  } as any;
}

function registry(readThrows = false) {
  const runs: string[] = [];
  const r = new ToolRegistry();
  r.register({ name: 'write_file', category: 'file-ops', description: 'synthetic', parameters: {}, execute: async () => { runs.push('write_file'); return 'saved'; } });
  r.register({ name: 'read_file', category: 'file-ops', description: 'synthetic', parameters: {}, execute: async () => {
    runs.push('read_file'); if (readThrows) throw new Error('disk gone'); return 'contents'; } });
  return { r, runs };
}

/** Scripted model turns: a list of tool calls per turn, then a final answer. */
function llm(turns: LLMToolCall[][], finalText = 'All done') {
  let call = 0;
  return { calls: () => call, manager: { chatTier: async () => {
    const turn = turns[call++];
    return turn
      ? { content: '', finish_reason: 'tool_use', tool_calls: turn, usage: { input_tokens: 1, output_tokens: 1 } }
      : { content: finalText, finish_reason: 'end_turn', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } };
  } } as any };
}

function authority(governed: string[] = ['write_data']) {
  const rows: Array<Record<string, unknown>> = [];
  const engine = new AuthorityEngine({ default_level: 10, governed_categories: governed as any, overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  return { engine, rows, audit: { log: (row: Record<string, unknown>) => { rows.push(row); return row; } } as any };
}

const toolMessages = (result: SubAgentResult) => result.messages.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content as string] as const);

describe('governed tool calls in a sub-agent', () => {
  test('without a governed dispatch, a call that needs approval is refused and audited as needing approval', async () => {
    const { r, runs } = registry();
    const a = authority();
    const model = llm([[write('c1')]]);
    const result = await runSubAgent({ agent: agent(), task: 'save', context: '', llmManager: model.manager, toolRegistry: r,
      authorityEngine: a.engine, auditTrail: a.audit, maxIterations: 3 });
    expect(result.terminationReason).toBe('completed');
    expect(runs).toEqual([]);
    expect(toolMessages(result)[0]![1]).toContain('requires user approval');
    expect(a.rows).toEqual([expect.objectContaining({ tool_name: 'write_file', authority_decision: 'approval_required', executed: false })]);
  });

  test('an allowed call is audited after it ran, with what happened', async () => {
    const a = authority();
    const ok = await runSubAgent({ agent: agent(), task: 'read', context: '', llmManager: llm([[read('c1')]]).manager,
      toolRegistry: registry().r, authorityEngine: a.engine, auditTrail: a.audit, maxIterations: 3 });
    expect(ok.terminationReason).toBe('completed');
    expect(a.rows).toEqual([expect.objectContaining({ tool_name: 'read_file', authority_decision: 'allowed', executed: true })]);

    const b = authority();
    const failed = await runSubAgent({ agent: agent(), task: 'read', context: '', llmManager: llm([[read('c1')]]).manager,
      toolRegistry: registry(true).r, authorityEngine: b.engine, auditTrail: b.audit, maxIterations: 3 });
    expect(toolMessages(failed)[0]![1]).toContain('disk gone');
    expect(b.rows).toEqual([expect.objectContaining({ authority_decision: 'allowed', executed: false })]);
  });

  test('a pause stops the run before any effect and keeps the calls its turn did not reach', async () => {
    const { r, runs } = registry();
    const a = authority();
    const asked: GovernedToolCall[] = [];
    const governedTools: GovernedToolDispatch = async call => { asked.push(call); return { kind: 'paused', approval }; };
    const model = llm([[write('c1'), read('c2')]]);
    const result = await runSubAgent({ agent: agent(), task: 'save then read', context: '', llmManager: model.manager,
      toolRegistry: r, authorityEngine: a.engine, auditTrail: a.audit, governedTools, maxIterations: 3 });
    expect(result.terminationReason).toBe('paused');
    expect(result.paused).toMatchObject({ toolCall: write('c1'), sequence: 1, actionCategory: 'write_data', toolCategory: 'file-ops',
      approval, remaining: [read('c2')], iteration: 0 });
    expect(result.sequence).toBe(1);
    expect(runs).toEqual([]);
    expect(model.calls()).toBe(1);
    expect(asked).toEqual([{ toolCall: write('c1'), sequence: 1, actionCategory: 'write_data', toolCategory: 'file-ops' }]);
    // The assistant turn is in the log; no tool result exists yet for either call.
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', tool_calls: [write('c1'), read('c2')] });
    expect(toolMessages(result)).toEqual([]);
    expect(a.rows).toEqual([expect.objectContaining({ tool_name: 'write_file', authority_decision: 'approval_required', executed: false, approval_id: 'approval' })]);
  });

  test('a resumed run takes the approved result once, finishes the turn, and continues to the end', async () => {
    const { r, runs } = registry();
    const a = authority();
    const model = llm([[write('c1'), read('c2')]]);
    const paused = await runSubAgent({ agent: agent(), task: 'save then read', context: '', llmManager: model.manager,
      toolRegistry: r, authorityEngine: a.engine, auditTrail: a.audit, maxIterations: 3,
      governedTools: async () => ({ kind: 'paused', approval }) });
    const asked: GovernedToolCall[] = [];
    // A new process: fresh agent and model, the saved log and the decision.
    const resumed = await runSubAgent({ agent: agent(), task: 'save then read', context: '', llmManager: model.manager,
      toolRegistry: r, authorityEngine: a.engine, auditTrail: a.audit, maxIterations: 3,
      governedTools: async call => { asked.push(call); return { kind: 'executed', result: 'saved by the boundary' }; },
      resume: { messages: paused.messages, toolsUsed: paused.toolsUsed, tokensUsed: paused.tokensUsed, sequence: paused.sequence!, pending: paused.paused! } });
    expect(resumed.terminationReason).toBe('completed');
    expect(resumed.response).toBe('All done');
    expect(asked).toEqual([{ toolCall: write('c1'), sequence: 1, actionCategory: 'write_data', toolCategory: 'file-ops' }]);
    expect(runs).toEqual(['read_file']);
    expect(toolMessages(resumed).map(([id]) => id)).toEqual(['c1', 'c2']);
    expect(toolMessages(resumed)[0]![1]).toContain('saved by the boundary');
    expect(toolMessages(resumed)[1]![1]).toContain('contents');
    expect(resumed.sequence).toBe(2);
    expect(resumed.toolsUsed).toEqual(['write_file', 'read_file']);
    expect(model.calls()).toBe(2);
    // The gate audited the pause; the resumed dispatch is audited by its boundary, not here.
    expect(a.rows.map(row => [row.tool_name, row.authority_decision, row.executed])).toEqual([
      ['write_file', 'approval_required', false], ['read_file', 'allowed', true]]);
  });

  test('a decision against the paused call becomes a result the agent can act on', async () => {
    const { r, runs } = registry();
    const a = authority();
    const model = llm([[write('c1')]]);
    const paused = await runSubAgent({ agent: agent(), task: 'save', context: '', llmManager: model.manager, toolRegistry: r,
      authorityEngine: a.engine, auditTrail: a.audit, maxIterations: 3, governedTools: async () => ({ kind: 'paused', approval }) });
    const resumed = await runSubAgent({ agent: agent(), task: 'save', context: '', llmManager: model.manager, toolRegistry: r,
      authorityEngine: a.engine, auditTrail: a.audit, maxIterations: 3,
      governedTools: async () => ({ kind: 'denied', reason: 'Workflow approval denied; effect was not executed' }),
      resume: { messages: paused.messages, toolsUsed: paused.toolsUsed, tokensUsed: paused.tokensUsed, sequence: paused.sequence!, pending: paused.paused! } });
    expect(resumed.terminationReason).toBe('completed');
    expect(toolMessages(resumed)[0]![1]).toMatch(/^\[APPROVAL DENIED\] write_file: Workflow approval denied/);
    expect(runs).toEqual([]);
  });

  test('a second governed call in the resumed turn pauses again with what is still unreached', async () => {
    const { r, runs } = registry();
    const a = authority();
    const model = llm([[write('c1'), write('c2'), read('c3')]]);
    const paused = await runSubAgent({ agent: agent(), task: 'save twice', context: '', llmManager: model.manager, toolRegistry: r,
      authorityEngine: a.engine, auditTrail: a.audit, maxIterations: 3, governedTools: async () => ({ kind: 'paused', approval }) });
    expect(paused.paused?.remaining).toEqual([write('c2'), read('c3')]);
    const second = { ...approval, effectId: 'effect-2', approvalId: 'approval-2' };
    const again = await runSubAgent({ agent: agent(), task: 'save twice', context: '', llmManager: model.manager, toolRegistry: r,
      authorityEngine: a.engine, auditTrail: a.audit, maxIterations: 3,
      governedTools: async call => call.sequence === 1 ? { kind: 'executed', result: 'saved' } : { kind: 'paused', approval: second },
      resume: { messages: paused.messages, toolsUsed: paused.toolsUsed, tokensUsed: paused.tokensUsed, sequence: paused.sequence!, pending: paused.paused! } });
    expect(again.terminationReason).toBe('paused');
    expect(again.paused).toMatchObject({ toolCall: write('c2'), sequence: 2, approval: second, remaining: [read('c3')], iteration: 0 });
    expect(toolMessages(again).map(([id]) => id)).toEqual(['c1']);
    expect(runs).toEqual([]);
    expect(model.calls()).toBe(1);
  });

  test('a paused run cannot be resumed without a governed dispatch', async () => {
    const { r } = registry();
    const a = authority();
    const model = llm([[write('c1')]]);
    const paused = await runSubAgent({ agent: agent(), task: 'save', context: '', llmManager: model.manager, toolRegistry: r,
      authorityEngine: a.engine, maxIterations: 3, governedTools: async () => ({ kind: 'paused', approval }) });
    const resumed = await runSubAgent({ agent: agent(), task: 'save', context: '', llmManager: model.manager, toolRegistry: r,
      authorityEngine: a.engine, maxIterations: 3,
      resume: { messages: paused.messages, toolsUsed: paused.toolsUsed, tokensUsed: paused.tokensUsed, sequence: paused.sequence!, pending: paused.paused! } });
    expect(resumed.terminationReason).toBe('error');
    expect(resumed.response).toContain('Cannot resume');
  });
});
