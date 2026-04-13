import { describe, expect, test } from 'bun:test';
import { AgentOrchestrator } from './orchestrator.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { LLMMessage, LLMOptions, LLMProvider, LLMResponse, LLMStreamEvent } from '../llm/provider.ts';
import { LLMManager } from '../llm/manager.ts';
import { ToolRegistry, type ToolDefinition } from '../actions/tools/registry.ts';

const TEST_ROLE: RoleDefinition = {
  id: 'tester',
  name: 'Test Agent',
  description: 'Exercises orchestrator tool validation.',
  responsibilities: ['Execute requested actions'],
  autonomous_actions: ['Use tools when needed'],
  approval_required: [],
  kpis: [],
  communication_style: {
    tone: 'direct',
    verbosity: 'concise',
    formality: 'casual',
  },
  heartbeat_instructions: 'No-op.',
  sub_roles: [],
  tools: ['desktop_launch_app'],
  authority_level: 5,
};

class ScriptedProvider implements LLMProvider {
  name = 'scripted';
  calls: LLMMessage[][] = [];

  constructor(private readonly responses: LLMResponse[]) {}

  async chat(messages: LLMMessage[], _options?: LLMOptions): Promise<LLMResponse> {
    this.calls.push(messages.map((message) => ({ ...message })));
    const next = this.responses.shift();
    if (!next) {
      throw new Error('No scripted response left');
    }
    return next;
  }

  async *stream(_messages: LLMMessage[], _options?: LLMOptions): AsyncIterable<LLMStreamEvent> {
    throw new Error('Stream not used in this test');
  }

  async listModels(): Promise<string[]> {
    return ['scripted'];
  }
}

describe('AgentOrchestrator', () => {
  test('retries when a response claims tool execution without any tool call', async () => {
    const provider = new ScriptedProvider([
      {
        content: "I've opened Notes and typed your reminder.",
        tool_calls: [],
        usage: { input_tokens: 10, output_tokens: 10 },
        model: 'scripted',
        finish_reason: 'stop',
      },
      {
        content: '',
        tool_calls: [{ id: 'tc1', name: 'desktop_launch_app', arguments: { app_name: 'Notes' } }],
        usage: { input_tokens: 10, output_tokens: 10 },
        model: 'scripted',
        finish_reason: 'tool_use',
      },
      {
        content: 'Done.',
        tool_calls: [],
        usage: { input_tokens: 10, output_tokens: 10 },
        model: 'scripted',
        finish_reason: 'stop',
      },
    ]);

    const llmManager = new LLMManager();
    llmManager.registerProvider(provider);

    const toolRegistry = new ToolRegistry();
    const executions: Record<string, unknown>[] = [];
    const launchTool: ToolDefinition = {
      name: 'desktop_launch_app',
      description: 'Launch a desktop app.',
      category: 'desktop',
      parameters: {
        app_name: {
          type: 'string',
          description: 'App name',
          required: true,
        },
      },
      execute: async (params) => {
        executions.push(params);
        return 'launched';
      },
    };
    toolRegistry.register(launchTool);

    const orchestrator = new AgentOrchestrator();
    orchestrator.setLLMManager(llmManager);
    orchestrator.setToolRegistry(toolRegistry);
    orchestrator.createPrimary(TEST_ROLE);

    const result = await orchestrator.processMessage('Use tools honestly.', 'Open Notes.');

    expect(result).toBe('Done.');
    expect(executions).toEqual([{ app_name: 'Notes' }]);
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[1]?.some((message) => message.role === 'system' && typeof message.content === 'string' && message.content.includes('described tool actions'))).toBe(true);
  });
});
