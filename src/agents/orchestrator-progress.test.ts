import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { AgentOrchestrator } from './orchestrator.ts';
import { LLMManager } from '../llm/manager.ts';
import { ToolRegistry, type ToolDefinition } from '../actions/tools/registry.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type {
  LLMProvider, LLMMessage, LLMOptions, LLMResponse, LLMStreamEvent, LLMToolCall,
} from '../llm/provider.ts';

const ROLE = {
  id: 'personal-assistant',
  name: 'PA',
  authority_level: 5,
  tools: [],
  sub_roles: [],
} as unknown as RoleDefinition;

/** Records the assistant messages the orchestrator feeds back to the model. */
let seenAssistantContent: string[] = [];

class ScriptedProvider implements LLMProvider {
  name = 'scripted';
  private queue: LLMResponse[];
  constructor(responses: LLMResponse[]) { this.queue = [...responses]; }
  async chat(): Promise<LLMResponse> {
    return this.queue.shift() ?? {
      content: 'fallback',
      tool_calls: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'scripted',
      finish_reason: 'stop',
    };
  }
  async *stream(messages: LLMMessage[], _opts?: LLMOptions): AsyncIterable<LLMStreamEvent> {
    for (const message of messages) {
      if (message.role === 'assistant') seenAssistantContent.push(String(message.content ?? ''));
    }
    const response = await this.chat();
    if (response.content) yield { type: 'text', text: response.content };
    for (const call of response.tool_calls) yield { type: 'tool_call', tool_call: call };
    yield { type: 'done', response };
  }
  async listModels(): Promise<string[]> { return ['scripted']; }
}

function silentToolCall(name: string, args: Record<string, unknown>): LLMResponse {
  const call: LLMToolCall = { id: `call_${name}`, name, arguments: args };
  return {
    content: '', // the failure mode: tools called with no prose at all
    tool_calls: [call],
    usage: { input_tokens: 0, output_tokens: 0 },
    model: 'scripted',
    finish_reason: 'tool_use',
  };
}

function textResponse(content: string): LLMResponse {
  return {
    content,
    tool_calls: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    model: 'scripted',
    finish_reason: 'stop',
  };
}

function makeOrchestrator(provider: LLMProvider): AgentOrchestrator {
  const registry = new ToolRegistry();
  const readFile: ToolDefinition = {
    name: 'read_file',
    description: 'Read a file',
    category: 'file-ops',
    parameters: { path: { type: 'string', description: 'path', required: true } },
    execute: async (p) => `contents of ${p.path}`,
  };
  registry.register(readFile);

  const manager = new LLMManager();
  manager.registerProvider(provider);
  manager.setTierMap({ medium: { provider: provider.name } });

  const orch = new AgentOrchestrator();
  orch.setToolRegistry(registry);
  orch.setLLMManager(manager);
  orch.createPrimary(ROLE);
  return orch;
}

describe('AgentOrchestrator.streamMessage progress narration', () => {
  beforeEach(() => { initDatabase(':memory:'); seenAssistantContent = []; });
  afterEach(() => { closeDb(); });

  test('narrates a silent tool call and keeps it clear of the answer', async () => {
    const orch = makeOrchestrator(new ScriptedProvider([
      silentToolCall('read_file', { path: '/tmp/example' }),
      textResponse('The file lists three entries.'),
    ]));

    const chunks: LLMStreamEvent[] = [];
    let final = '';
    for await (const event of orch.streamMessage('system', 'what is in the file?')) {
      chunks.push(event);
      if (event.type === 'done') final = event.response.content;
    }

    const narration = chunks.find(
      (c): c is Extract<LLMStreamEvent, { type: 'text' }> =>
        c.type === 'text' && c.text.includes('I’m checking'),
    );
    expect(narration).toBeDefined();
    // Marked complete so TTS speaks it while the tool is still running.
    expect(narration?.segmentEnd).toBe(true);

    // The answer must not run into the narration.
    expect(final).not.toContain('now.The file');
    expect(final).toBe('I’m checking the relevant details now.\n\nThe file lists three entries.');
  });

  test('does not attribute the narration back to the model', async () => {
    const orch = makeOrchestrator(new ScriptedProvider([
      silentToolCall('read_file', { path: '/tmp/example' }),
      textResponse('Done.'),
    ]));

    for await (const _event of orch.streamMessage('system', 'read it')) { /* drain */ }

    // The second LLM call must not see fabricated assistant prose — the model
    // never wrote it, and echoing it back makes the next turn reason from
    // words it didn't produce.
    expect(seenAssistantContent).not.toContain('I’m checking the relevant details now.');
    for (const content of seenAssistantContent) {
      expect(content).not.toContain('I’m checking');
    }
  });

  test('stays quiet when the model writes its own prose alongside tool calls', async () => {
    const chatty: LLMResponse = {
      content: 'Let me open that file.',
      tool_calls: [{ id: 'c1', name: 'read_file', arguments: { path: '/tmp/example' } }],
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'scripted',
      finish_reason: 'tool_use',
    };
    const orch = makeOrchestrator(new ScriptedProvider([chatty, textResponse('All set.')]));

    let final = '';
    for await (const event of orch.streamMessage('system', 'read it')) {
      if (event.type === 'done') final = event.response.content;
    }
    expect(final).not.toContain('I’m checking');
    expect(final).toBe('Let me open that file.All set.');
  });
});
