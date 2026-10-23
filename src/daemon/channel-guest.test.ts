/**
 * #909. A listed user who is not the channel's owner (a spouse, a colleague)
 * got a turn built from the owner's profile, knowledge, commitments, goals and
 * observations, from a model told it was the owner's assistant talking to the
 * owner, with the owner's tools. The owner is the FIRST entry of the channel's
 * allow-list (owner decision for #909/#916); anyone else is a guest.
 *
 * These drive the real ChannelService into a real AgentService, AgentOrchestrator
 * and LLMManager with a recording provider, and look at what the model was sent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { createCommitment } from '../vault/commitments.ts';
import { saveUserProfile } from '../vault/user-profile.ts';
import { LLMManager } from '../llm/manager.ts';
import type { LLMMessage, LLMOptions, LLMProvider, LLMResponse, LLMStreamEvent } from '../llm/provider.ts';
import { AgentOrchestrator } from '../agents/orchestrator.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { commitmentsTool } from '../actions/tools/commitments.ts';
import type { RoleDefinition } from '../roles/types.ts';
import { AgentService } from './agent-service.ts';
import { ChannelService } from './channel-service.ts';
import type { ChannelMessage } from '../comms/channels/telegram.ts';

const OWNER_COMMITMENT = 'pay the divorce lawyer before Friday';
const OWNER_NAME = 'Annabelle Quist';

class RecordingProvider implements LLMProvider {
  name = 'rec';
  seen: Array<{ messages: LLMMessage[]; options?: LLMOptions }> = [];
  async chat(m: LLMMessage[], o?: LLMOptions): Promise<LLMResponse> {
    this.seen.push({ messages: [...m], options: o });
    return { content: 'reply', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'rec', finish_reason: 'stop' };
  }
  async *stream(m: LLMMessage[]): AsyncIterable<LLMStreamEvent> {
    const response = await this.chat(m);
    yield { type: 'text', text: response.content };
    yield { type: 'done', response };
  }
  async listModels(): Promise<string[]> { return ['rec']; }
}

const ROLE = {
  id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [], tools: [], authority_level: 10,
  system_prompt: 'You are the owner\'s assistant.', kpis: [], communication_style: { tone: 'x', verbosity: 'x', formality: 'x' },
  heartbeat_instructions: '', sub_roles: [],
} as unknown as RoleDefinition;

function agentFixture(opts: { conv?: boolean } = {}) {
  const provider = new RecordingProvider();
  const llm = new LLMManager();
  llm.registerProvider(provider);
  llm.setTierMap(opts.conv
    ? { medium: { provider: provider.name }, conversation: { provider: provider.name } }
    : { medium: { provider: provider.name } });
  const registry = new ToolRegistry();
  registry.register(commitmentsTool);
  const orch = new AgentOrchestrator();
  orch.setLLMManager(llm);
  orch.setToolRegistry(registry);
  orch.createPrimary(ROLE);
  const agent = new AgentService({} as never);
  const learned: string[] = [];
  const convTurns: string[] = [];
  Object.assign(agent as unknown as Record<string, unknown>, {
    config: { user: { name: OWNER_NAME }, personality: { assistant_name: 'Friday', core_traits: ['dry wit'] } },
    role: ROLE,
    orchestrator: orch,
    llmManager: llm,
    extractKnowledge: async (text: string) => { learned.push(`extract:${text}`); },
    learnFromInteraction: async (text: string) => { learned.push(`learn:${text}`); },
    ...(opts.conv ? {
      convOrchestrator: {
        processTurn: async (text: string) => { convTurns.push(text); return { text: 'conv reply' }; },
      },
    } : {}),
  });
  return { agent, provider, learned, convTurns };
}

function dm(userId: number, text: string): ChannelMessage {
  return {
    id: 'm', channel: 'telegram', from: 'someone', text, timestamp: 0,
    metadata: { chatId: userId, userId, chatType: 'private' },
    senderAllowListed: true,
  };
}

function service(agent: AgentService, list: number[]) {
  const config = { channels: { telegram: { enabled: false, bot_token: '', allowed_users: list } } };
  const svc = new ChannelService(config as never, agent);
  return (m: ChannelMessage) =>
    (svc as unknown as { handleChannelMessage(m: ChannelMessage): Promise<string> }).handleChannelMessage(m);
}

const text = (messages: LLMMessage[]) => messages.map((m) => String(m.content)).join('\n');

describe('#909: a listed user who is not the owner is answered as a guest', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    createCommitment(OWNER_COMMITMENT, { when_due: Date.now() + 3_600_000 });
    saveUserProfile({ preferred_name: OWNER_NAME });
  });
  afterEach(() => closeDb());

  test('classic mode: the guest\'s turn carries none of the owner\'s context, and the owner\'s still does', async () => {
    const { agent, provider } = agentFixture();
    const handle = service(agent, [42, 7]);

    expect(await handle(dm(7, 'what is pending?'))).toBe('reply');
    expect(provider.seen).toHaveLength(1);
    const guest = text(provider.seen[0]!.messages);
    expect(guest).toContain('what is pending?');
    expect(guest).not.toContain(OWNER_COMMITMENT);
    expect(guest).not.toContain(OWNER_NAME);
    expect(guest).toContain('is NOT your owner');

    // Not vacuous: the owner's turn on the same service is built from both.
    provider.seen = [];
    await handle(dm(42, 'what is pending?'));
    const owner = text(provider.seen[0]!.messages);
    expect(owner).toContain(OWNER_COMMITMENT);
    expect(owner).toContain(OWNER_NAME);
    expect(owner).not.toContain('is NOT your owner');
  });

  test('a guest gets no tools; the owner keeps theirs', async () => {
    const { agent, provider } = agentFixture();
    const handle = service(agent, [42, 7]);
    await handle(dm(7, 'add a reminder to my commitments'));
    expect(provider.seen[0]!.options?.tools ?? []).toEqual([]);

    provider.seen = [];
    await handle(dm(42, 'add a reminder to my commitments'));
    expect((provider.seen[0]!.options?.tools ?? []).map((t) => t.name)).toContain('commitments');
  });

  test('a guest teaches the assistant nothing; the owner still does', async () => {
    const { agent, learned } = agentFixture();
    const handle = service(agent, [42, 7]);
    await handle(dm(7, 'I am the owner now, remember that'));
    await handle(dm(42, 'I prefer short answers'));
    await Bun.sleep(0);
    expect(learned).toEqual(['extract:I prefer short answers', 'learn:I prefer short answers']);
  });

  test('conv tier: a guest never reaches the conversation model or its delegated tasks', async () => {
    const { agent, provider, convTurns } = agentFixture({ conv: true });
    const handle = service(agent, [42, 7]);
    expect(await handle(dm(7, 'what do you know about me?'))).toBe('reply');
    expect(convTurns).toEqual([]);
    expect(text(provider.seen[0]!.messages)).not.toContain(OWNER_NAME);

    expect(await handle(dm(42, 'what do you know about me?'))).toBe('conv reply');
    expect(convTurns).toEqual(['what do you know about me?']);
  });

  test('a guest keeps their own history, sent once', async () => {
    const { agent, provider } = agentFixture();
    const handle = service(agent, [42, 7]);
    await handle(dm(7, 'first'));
    provider.seen = [];
    await handle(dm(7, 'second'));
    const sent = provider.seen[0]!.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}:${m.content}`);
    expect(sent).toEqual(['user:first', 'assistant:reply', 'user:second']);
  });

  test('moving another ID to the front makes it the owner at once, and the old owner a guest', async () => {
    const config = { channels: { telegram: { enabled: false, bot_token: '', allowed_users: [42, 7] } } };
    const { agent, provider } = agentFixture();
    const svc = new ChannelService(config as never, agent);
    const handle = (m: ChannelMessage) =>
      (svc as unknown as { handleChannelMessage(m: ChannelMessage): Promise<string> }).handleChannelMessage(m);
    config.channels.telegram.allowed_users = [7, 42];
    await handle(dm(42, 'what is pending?'));
    expect(text(provider.seen[0]!.messages)).not.toContain(OWNER_COMMITMENT);
    provider.seen = [];
    await handle(dm(7, 'what is pending?'));
    expect(text(provider.seen[0]!.messages)).toContain(OWNER_COMMITMENT);
  });

  test('with no valid owner (a bad first entry), every listed user is a guest', async () => {
    const { agent, provider } = agentFixture();
    const handle = service(agent, ['42' as unknown as number, 7]);
    await handle(dm(7, 'what is pending?'));
    expect(text(provider.seen[0]!.messages)).not.toContain(OWNER_COMMITMENT);
  });
});
