/**
 * Saving multi-tier mode answers "saved and applied", so chat has to follow the
 * new tier map without a restart: the router-first conversation layer is built
 * from the tier map, and used to be built once at boot.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { LLMManager } from '../llm/manager.ts';
import type { LLMMessage, LLMOptions, LLMProvider, LLMResponse, LLMStreamEvent } from '../llm/provider.ts';
import { AgentService } from './agent-service.ts';

class Recording implements LLMProvider {
  toolCounts: number[] = [];
  constructor(readonly name: string) {}
  async chat(_m: LLMMessage[], o?: LLMOptions): Promise<LLMResponse> {
    this.toolCounts.push(o?.tools?.length ?? 0);
    return { content: 'reply', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: this.name, finish_reason: 'stop' };
  }
  async *stream(m: LLMMessage[], o?: LLMOptions): AsyncIterable<LLMStreamEvent> {
    const response = await this.chat(m, o);
    yield { type: 'text', text: response.content };
    yield { type: 'done', response };
  }
  async listModels(): Promise<string[]> { return [this.name]; }
}

function classicAgent() {
  const small = new Recording('small');
  const conversation = new Recording('conv');
  const llm = new LLMManager();
  llm.registerProvider(small);
  llm.registerProvider(conversation);
  llm.setTierMap({ medium: { provider: 'small' } });
  const agent = new AgentService({} as never);
  Object.assign(agent as unknown as Record<string, unknown>, {
    config: {}, llmManager: llm, convOrchestrator: null,
    extractKnowledge: async () => {}, learnFromInteraction: async () => {},
  });
  return { agent, llm, small, conversation };
}
const convOrchestratorOf = (agent: AgentService) => (agent as unknown as { convOrchestrator: unknown }).convOrchestrator;

describe('the conversation tier follows a hot reload', () => {
  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDb());

  test('adding the conversation tier switches chat to it without a restart', async () => {
    const { agent, llm, conversation } = classicAgent();
    expect(convOrchestratorOf(agent)).toBeNull();

    // What hotReloadLLMProviders does to the manager, then what the routes call next.
    llm.setTierMap({ medium: { provider: 'small' }, conversation: { provider: 'conv' } });
    agent.syncConversationTier();

    expect(convOrchestratorOf(agent)).not.toBeNull();
    expect(agent.getTaskRegistry()).not.toBeNull();
    const { stream } = agent.streamMessage('hello', 'websocket-tier-test');
    for await (const _ of stream) { /* drain */ }
    expect(conversation.toolCounts.length).toBeGreaterThan(0);
  });

  test('removing the conversation tier returns chat to the classic path instead of failing', () => {
    const { agent, llm } = classicAgent();
    llm.setTierMap({ medium: { provider: 'small' }, conversation: { provider: 'conv' } });
    agent.syncConversationTier();
    const first = convOrchestratorOf(agent);
    agent.syncConversationTier();
    expect(convOrchestratorOf(agent)).toBe(first);

    llm.setTierMap({ medium: { provider: 'small' } });
    agent.syncConversationTier();
    expect(convOrchestratorOf(agent)).toBeNull();
  });
});

describe('saving LLM settings applies them to chat', () => {
  test('POST /api/config/llm re-syncs the conversation tier after the providers reload', async () => {
    const { createApiRoutes } = await import('./api-routes.ts');
    const { DEFAULT_CONFIG } = await import('../config/types.ts');
    const order: string[] = [];
    const routes = createApiRoutes({
      daemonStartedAt: Date.now(), healthMonitor: {}, config: structuredClone(DEFAULT_CONFIG),
      agentService: {
        getLLMManager: () => new Proxy({}, { get: (_t, prop) => { order.push(`manager.${String(prop)}`); return prop === 'getProviderNames' ? () => [] : () => null; } }),
        syncConversationTier: () => { order.push('sync'); },
      },
    } as never) as Record<string, { POST?: (req: Request) => Promise<Response> }>;
    initDatabase(':memory:');
    try {
      const response = await routes['/api/config/llm']!.POST!(new Request('http://x/api/config/llm', { method: 'POST', body: '{}' }));
      expect(response.status).toBe(200);
      expect(order.at(-1)).toBe('sync');
    } finally { closeDb(); }
  });
});
