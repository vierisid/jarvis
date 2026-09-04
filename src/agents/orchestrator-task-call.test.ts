import { describe, expect, it, beforeEach } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { LLMManager } from '../llm/manager.ts';
import { AgentOrchestrator } from './orchestrator.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse, LLMStreamEvent, LLMToolCall } from '../llm/provider.ts';

/**
 * Scripted LLM provider: returns canned responses by call order. Lets us
 * simulate a task tier that first calls `ask_for_clarification` then
 * (after resume) returns a final text.
 */
class ScriptedProvider implements LLMProvider {
  name = 'scripted';
  private queue: LLMResponse[] = [];
  constructor(responses: LLMResponse[]) {
    this.queue = [...responses];
  }
  async chat(_messages: LLMMessage[], _opts?: LLMOptions): Promise<LLMResponse> {
    const next = this.queue.shift();
    if (!next) {
      return {
        content: 'fallback',
        tool_calls: [],
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'scripted',
        finish_reason: 'stop',
      };
    }
    return next;
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LLMStreamEvent> { throw new Error('not used'); }
  async listModels(): Promise<string[]> { return ['scripted']; }
}

function text(content: string): LLMResponse {
  return {
    content,
    tool_calls: [],
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'scripted',
    finish_reason: 'stop',
  };
}

function toolCall(name: string, args: Record<string, unknown>): LLMResponse {
  const call: LLMToolCall = { id: `call_${Math.random()}`, name, arguments: args };
  return {
    content: '',
    tool_calls: [call],
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'scripted',
    finish_reason: 'tool_use',
  };
}

function response(
  content: string,
  finish: LLMResponse['finish_reason'],
  calls: LLMToolCall[] = [],
): LLMResponse {
  return {
    content,
    tool_calls: calls,
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'scripted',
    finish_reason: finish,
  };
}

function makeOrchestrator(provider: LLMProvider): AgentOrchestrator {
  const m = new LLMManager();
  m.registerProvider(provider);
  m.setTierMap({ medium: { provider: provider.name } });
  const orch = new AgentOrchestrator();
  orch.setLLMManager(m);
  // processTaskCall doesn't touch the primary agent's history (unlike
  // processMessage), so no primary needed for these tests. An empty tool
  // registry is enough - the only tool the LLM uses in these scripts is
  // `ask_for_clarification`, which the orchestrator intercepts before
  // dispatching to the registry.
  orch.setToolRegistry(new ToolRegistry());
  return orch;
}

describe('AgentOrchestrator.processTaskCall', () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
  });

  it('returns completed when LLM emits text directly', async () => {
    const provider = new ScriptedProvider([text('done')]);
    const orch = makeOrchestrator(provider);

    const result = await orch.processTaskCall({
      systemPrompt: 'task system',
      userMessage: 'find capital of Italy',
      tier: 'medium',
      subsystem: 'task_test',
    });
    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.text).toBe('done');
      // conversation buffer includes system + user + assistant
      expect(result.conversation.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('accepts a tool-less answer unchanged when requireToolUse is off', async () => {
    const provider = new ScriptedProvider([text('done')]);
    const orch = makeOrchestrator(provider);

    const result = await orch.processTaskCall({
      systemPrompt: 'task system',
      userMessage: 'draft a thank-you note',
      tier: 'medium',
      subsystem: 'task_test',
    });
    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') expect(result.text).toBe('done');
  });

  it('pushes back once when the model announces work instead of doing it', async () => {
    // What the hosted medium tier actually did: an announcement, no tool call,
    // ~2s. Without the push-back this string becomes the task's result and the
    // conversation tier reads it to the user as a progress note.
    const provider = new ScriptedProvider([
      text("On it - I'll open Notepad, then verify it's in the foreground."),
      toolCall('open_app', { name: 'notepad' }),
      text('Notepad is open and focused (PID 16672).'),
    ]);
    const orch = makeOrchestrator(provider);

    const result = await orch.processTaskCall({
      systemPrompt: 'task system',
      userMessage: 'open notepad',
      tier: 'medium',
      subsystem: 'task_test',
      requireToolUse: true,
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.text).toBe('Notepad is open and focused (PID 16672).');
    // The announcement and the push-back are both in the buffer, so a resume
    // replays why the model was told to act.
    const roles = (result.conversation as { role: string }[]).map((m) => m.role);
    expect(roles.filter((r) => r === 'user').length).toBe(2);
  });

  it('gives up after a bounded number of push-backs', async () => {
    const provider = new ScriptedProvider([
      text('I will get right on that.'),
      text('Getting on it now.'),
      text('I am still about to get on that.'),
    ]);
    const orch = makeOrchestrator(provider);

    const result = await orch.processTaskCall({
      systemPrompt: 'task system',
      userMessage: 'open notepad',
      tier: 'medium',
      subsystem: 'task_test',
      requireToolUse: true,
    });
    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.text).toBe('I am still about to get on that.');
    }
  });

  it('does not push back on a resumed task that already ran tools', async () => {
    // The pre-pause buffer carries the tool results. Pushing back here would
    // tell a model that already sent the mail that nothing has been done.
    const provider = new ScriptedProvider([text('Already done - Notepad is open.')]);
    const orch = makeOrchestrator(provider);

    const result = await orch.processTaskCall({
      systemPrompt: 'task system',
      userMessage: 'yes, go ahead',
      tier: 'medium',
      subsystem: 'task_test',
      requireToolUse: true,
      history: [
        { role: 'system', content: 'task system' },
        { role: 'user', content: 'open notepad' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'open_app', arguments: {} }] },
        { role: 'tool', content: 'opened', tool_call_id: 'c1' },
      ],
    });

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.text).toBe('Already done - Notepad is open.');
    }
  });

  it('does not push back when the provider reported calls without a tool_use finish', async () => {
    // Gemini marks every function call STOP, so its calls arrive here.
    const provider = new ScriptedProvider([
      response('Opening notepad.', 'stop', [{ id: 'c1', name: 'open_app', arguments: { name: 'notepad' } }]),
      text('SHOULD NOT BE REACHED'),
    ]);
    const orch = makeOrchestrator(provider);

    const result = await orch.processTaskCall({
      systemPrompt: 'task system',
      userMessage: 'open notepad',
      tier: 'medium',
      subsystem: 'task_test',
      requireToolUse: true,
    });
    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') expect(result.text).toBe('Opening notepad.');
  });

  it('does not push back on a truncated answer', async () => {
    const provider = new ScriptedProvider([
      response('A very long draft that ran out of', 'length'),
      text('SHOULD NOT BE REACHED'),
    ]);
    const orch = makeOrchestrator(provider);

    const result = await orch.processTaskCall({
      systemPrompt: 'task system',
      userMessage: 'summarise the vault',
      tier: 'medium',
      subsystem: 'task_test',
      requireToolUse: true,
    });
    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.text).toContain('A very long draft that ran out of');
      expect(result.text).toContain('truncated');
    }
  });

  it('never re-sends an empty assistant message when pushing back', async () => {
    // Providers reject empty assistant content once the buffer is re-sent.
    const provider = new ScriptedProvider([
      response('', 'stop'),
      toolCall('open_app', { name: 'notepad' }),
      text('Notepad is open.'),
    ]);
    const orch = makeOrchestrator(provider);

    const result = await orch.processTaskCall({
      systemPrompt: 'task system',
      userMessage: 'open notepad',
      tier: 'medium',
      subsystem: 'task_test',
      requireToolUse: true,
    });
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.text).toBe('Notepad is open.');
    const empties = (result.conversation as { role: string; content: string }[])
      .filter((m) => m.role === 'assistant' && !m.content?.trim() && !('tool_calls' in m));
    expect(empties.length).toBe(0);
  });

  it('returns paused when LLM calls ask_for_clarification', async () => {
    const provider = new ScriptedProvider([
      toolCall('ask_for_clarification', { question: 'Which Sarah?' }),
    ]);
    const orch = makeOrchestrator(provider);

    const result = await orch.processTaskCall({
      systemPrompt: 'task system',
      userMessage: 'book a meeting with Sarah',
      tier: 'medium',
      subsystem: 'task_test',
    });
    expect(result.kind).toBe('paused');
    if (result.kind === 'paused') {
      expect(result.question).toBe('Which Sarah?');
      // Conversation captured up to the pause: system + user + assistant + tool stub
      expect(result.conversation.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('resumes from saved conversation and continues to completion', async () => {
    // First run: ask for clarification.
    const provider = new ScriptedProvider([
      toolCall('ask_for_clarification', { question: 'Which Sarah?' }),
    ]);
    const orch = makeOrchestrator(provider);
    const first = await orch.processTaskCall({
      systemPrompt: 'task system',
      userMessage: 'book Sarah',
      tier: 'medium',
      subsystem: 'task_test',
    });
    expect(first.kind).toBe('paused');
    if (first.kind !== 'paused') return;

    // Second run: resume with the saved conversation. The LLM now responds
    // with a final text.
    const resumeProvider = new ScriptedProvider([text('Booked with Sarah Chen.')]);
    const resumeOrch = makeOrchestrator(resumeProvider);
    const second = await resumeOrch.processTaskCall({
      systemPrompt: 'task system',
      userMessage: 'Chen',
      tier: 'medium',
      subsystem: 'task_test',
      history: first.conversation,
    });
    expect(second.kind).toBe('completed');
    if (second.kind === 'completed') {
      expect(second.text).toBe('Booked with Sarah Chen.');
    }
  });

  it('truncated_question falls back to a generic prompt', async () => {
    const provider = new ScriptedProvider([
      toolCall('ask_for_clarification', { question: '' }),
    ]);
    const orch = makeOrchestrator(provider);
    const result = await orch.processTaskCall({
      systemPrompt: '',
      userMessage: 'X',
      tier: 'medium',
      subsystem: 'task_test',
    });
    expect(result.kind).toBe('paused');
    if (result.kind === 'paused') {
      expect(result.question.length).toBeGreaterThan(0);
    }
  });
});
