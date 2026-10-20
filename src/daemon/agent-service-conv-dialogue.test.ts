/**
 * #912. The dashboard chat stores the user's message in the vault and then
 * starts the turn (ws-service.ts handleChatTurn). On the conversation tier the
 * turn read the channel's conversation back as its dialogue, which already
 * ended in that message, and ConvOrchestrator appended the message again: the
 * model was sent the same user message twice in a row.
 *
 * These drive a real AgentService into a real ConvOrchestrator with a
 * recording provider and count what the model was actually sent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { addMessage, getOrCreateConversation } from '../vault/conversations.ts';
import { LLMManager } from '../llm/manager.ts';
import type { LLMMessage, LLMOptions, LLMProvider, LLMResponse, LLMStreamEvent } from '../llm/provider.ts';
import { ConvOrchestrator } from '../agents/conv/conv-orchestrator.ts';
import { TaskDispatcher } from '../agents/conv/task-dispatcher.ts';
import { TaskRegistry } from '../agents/conv/task-registry.ts';
import { DialogueCompactor } from '../agents/conv/dialogue-compactor.ts';
import { AgentService } from './agent-service.ts';

class RecordingProvider implements LLMProvider {
  name = 'rec';
  seen: LLMMessage[][] = [];
  async chat(m: LLMMessage[], _o?: LLMOptions): Promise<LLMResponse> {
    this.seen.push([...m]);
    return { content: 'reply', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'rec', finish_reason: 'stop' };
  }
  async *stream(m: LLMMessage[]): AsyncIterable<LLMStreamEvent> {
    const response = await this.chat(m);
    yield { type: 'text', text: response.content };
    yield { type: 'done', response };
  }
  async listModels(): Promise<string[]> { return ['rec']; }
}

function convAgent() {
  const provider = new RecordingProvider();
  const llm = new LLMManager();
  llm.registerProvider(provider);
  llm.setTierMap({ medium: { provider: provider.name }, conversation: { provider: provider.name } });
  const registry = new TaskRegistry();
  const dispatcher = new TaskDispatcher(llm, registry, async () => { throw new Error('no task runs here'); });
  const conv = new ConvOrchestrator(llm, registry, dispatcher, 'persona');
  const agent = new AgentService({} as never);
  Object.assign(agent as unknown as Record<string, unknown>, {
    config: {},
    convOrchestrator: conv,
    llmManager: llm,
    // The background follow-ups call the LLM; they are not what is measured.
    extractKnowledge: async () => {},
    learnFromInteraction: async () => {},
  });
  return { agent, provider };
}

/** What ws-service does before it starts the turn: store the user's message. */
function storeTurn(channel: string, text: string) {
  addMessage(getOrCreateConversation(channel).id, { role: 'user', content: text });
}

function dialogueSent(provider: RecordingProvider): string[] {
  expect(provider.seen).toHaveLength(1);
  return provider.seen[0]!.filter((m) => m.role !== 'system').map((m) => `${m.role}:${String(m.content)}`);
}

describe('#912: a conv-tier turn sends the stored user message once', () => {
  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDb());

  test('dashboard stream: the message the caller stored is not repeated, earlier turns are kept', async () => {
    const { agent, provider } = convAgent();
    const conversation = getOrCreateConversation('websocket');
    addMessage(conversation.id, { role: 'user', content: 'earlier question' });
    addMessage(conversation.id, { role: 'assistant', content: 'earlier answer' });
    storeTurn('websocket', 'what is on today?');

    const { stream } = agent.streamMessage('what is on today?', 'websocket');
    for await (const _ of stream) { /* drain */ }

    expect(dialogueSent(provider)).toEqual([
      'user:earlier question',
      'assistant:earlier answer',
      'user:what is on today?',
    ]);
  });

  test('non-streaming turn: the same, when it reads the channel\'s dialogue itself', async () => {
    const { agent, provider } = convAgent();
    storeTurn('websocket', 'remind me at five');

    await agent.handleMessage('remind me at five', 'websocket');

    expect(dialogueSent(provider)).toEqual(['user:remind me at five']);
  });

  test('a repeated message from an earlier turn is history, not this turn, and is kept', async () => {
    const { agent, provider } = convAgent();
    const conversation = getOrCreateConversation('websocket');
    addMessage(conversation.id, { role: 'user', content: 'yes' });
    addMessage(conversation.id, { role: 'assistant', content: 'Sure?' });
    storeTurn('websocket', 'yes');

    const { stream } = agent.streamMessage('yes', 'websocket');
    for await (const _ of stream) { /* drain */ }

    expect(dialogueSent(provider)).toEqual(['user:yes', 'assistant:Sure?', 'user:yes']);
  });

  test('a long conversation: the compacted tail still ends before this turn', async () => {
    const { agent, provider } = convAgent();
    Object.assign(agent as unknown as Record<string, unknown>, {
      dialogueCompactor: new DialogueCompactor(agent.getLLMManager()),
    });
    const conversation = getOrCreateConversation('websocket');
    for (let i = 0; i < 25; i++) {
      addMessage(conversation.id, { role: 'user', content: `question ${i}` });
      addMessage(conversation.id, { role: 'assistant', content: `answer ${i}` });
    }
    storeTurn('websocket', 'and now?');

    const { stream } = agent.streamMessage('and now?', 'websocket');
    for await (const _ of stream) { /* drain */ }

    // The compactor also summarises the head in the background; the turn's
    // own call is the one carrying the router persona.
    const turnCall = provider.seen.find((m) => m.some((x) => x.role === 'system' && String(x.content).includes('persona')))!;
    const sent = turnCall.filter((m) => m.role !== 'system').map((m) => `${m.role}:${String(m.content)}`);
    expect(sent.filter((m) => m === 'user:and now?')).toHaveLength(1);
    expect(sent.slice(-2)).toEqual(['assistant:answer 24', 'user:and now?']);
  });

  test('a caller that stored nothing loses nothing', async () => {
    const { agent, provider } = convAgent();
    const conversation = getOrCreateConversation('pebble');
    addMessage(conversation.id, { role: 'user', content: 'open the browser' });
    addMessage(conversation.id, { role: 'assistant', content: 'Opened.' });

    const { stream } = agent.streamMessage('and close it', 'pebble');
    for await (const _ of stream) { /* drain */ }

    expect(dialogueSent(provider)).toEqual(['user:open the browser', 'assistant:Opened.', 'user:and close it']);
  });
  // Accepted limit: a stored user message that got no reply looks exactly
  // like this turn's own stored message, so when the next turn repeats it
  // without storing anything, the stored copy is dropped. The model still
  // sees the words once, as this turn, so nothing is lost.
  test('an unanswered stored message the caller repeats without storing is sent once', async () => {
    const { agent, provider } = convAgent();
    const conversation = getOrCreateConversation('pebble');
    addMessage(conversation.id, { role: 'user', content: 'open the browser' });
    addMessage(conversation.id, { role: 'assistant', content: 'Opened.' });
    addMessage(conversation.id, { role: 'user', content: 'and close it' });

    const { stream } = agent.streamMessage('and close it', 'pebble');
    for await (const _ of stream) { /* drain */ }

    expect(dialogueSent(provider)).toEqual(['user:open the browser', 'assistant:Opened.', 'user:and close it']);
  });
});
