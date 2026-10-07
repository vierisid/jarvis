import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { AgentService } from './agent-service';
import { BriefChatTransport } from '../brief/chat-transport';
import { BriefConversationProvider } from '../brief/conversations';
import { BriefCapabilities } from '../brief/capabilities';
import { registerChatTransport } from '../brief/registrations/chat-transport';
import { registerConversations } from '../brief/registrations/conversations';
import { ConvOrchestrator } from '../agents/conv/conv-orchestrator';
import { TaskDispatcher } from '../agents/conv/task-dispatcher';
import { TaskRegistry } from '../agents/conv/task-registry';
import { initDatabase, getDb, closeDb } from '../vault/schema';
import { createEntity } from '../vault/entities';
import { createFact } from '../vault/facts';
import { getMemoryUsageLedger } from '../vault/memory-usage';
import type { JarvisConfig } from '../config/types';
import type { RoleDefinition } from '../roles/types';
import type { LLMMessage, LLMProvider, LLMResponse } from '../llm/provider';

let saved: string | undefined;
beforeEach(() => { saved = process.env.JARVIS_BRIEF_MEMORY_USAGE; process.env.JARVIS_BRIEF_MEMORY_USAGE = '1'; initDatabase(':memory:', { quiet: true }); });
afterEach(() => { closeDb(); if (saved === undefined) delete process.env.JARVIS_BRIEF_MEMORY_USAGE; else process.env.JARVIS_BRIEF_MEMORY_USAGE = saved; });
const response: LLMResponse = { content: 'Fixture answer', model: 'fixture', tool_calls: [], finish_reason: 'stop', usage: { input_tokens: 0, output_tokens: 0 } };
const role = { id: 'fixture', name: 'Fixture', description: 'Test only', responsibilities: [], autonomous_actions: [], approval_required: [],
  authority_level: 5, tools: [], sub_roles: [], kpis: [] } as unknown as RoleDefinition;

for (const routerFirst of [false, true]) test(`real transport and ${routerFirst ? 'router-first' : 'classic'} AgentService preserve packed provenance across two chats and replay`, async () => {
  const aEntity = createEntity('person', 'Ada'), bEntity = createEntity('person', 'Bruno');
  const aFact = createFact(aEntity.id, 'editor', 'Emacs', { confirmed: true }), bFact = createFact(bEntity.id, 'editor', 'Vim', { confirmed: true });
  const seen: LLMMessage[][] = [];
  const provider: LLMProvider = { name: 'fixture', listModels: async () => [], chat: async () => response,
    async *stream(messages) { seen.push(structuredClone(messages)); await Bun.sleep(2); yield { type: 'text', text: response.content }; yield { type: 'done', response }; } };
  const service = new AgentService({} as JarvisConfig), manager = service.getLLMManager(), orch = service.getOrchestrator();
  Object.assign(service, { role }); manager.registerProvider(provider);
  manager.setTierMap({ medium: { provider: 'fixture' }, ...(routerFirst ? { conversation: { provider: 'fixture' } } : {}) });
  orch.setLLMManager(manager); orch.createPrimary(role);
  if (routerFirst) {
    const registry = new TaskRegistry();
    const dispatcher = new TaskDispatcher(manager, registry, async () => ({ kind: 'completed', text: 'Task', conversation: [] }));
    Object.assign(service, { convOrchestrator: new ConvOrchestrator(manager, registry, dispatcher, 'Fixture') });
  }
  const conversations = new BriefConversationProvider(), transport = new BriefChatTransport({ db: getDb(), send: () => {}, runner: {
    ready: () => true, stream: input => {
      const result = service.streamMessage(input.text, 'websocket', undefined, null, input.contextKey, input);
      return { stream: result.stream, onComplete: async () => {} }; // Extraction is outside the use ledger fixture.
    },
  } });
  const caps = new BriefCapabilities([...registerConversations(conversations), ...registerChatTransport(transport)], ['conversations', 'chatTransport']);
  const a = { conversationId: conversations.repository.create().conversationId, turnId: 'turn-a', requestId: 'request-a', text: 'Ada editor' };
  const b = { conversationId: conversations.repository.create().conversationId, turnId: 'turn-b', requestId: 'request-b', text: 'Bruno editor' };
  const send = (payload: typeof a) => transport.handle({ type: 'brief_chat_send', payload, timestamp: Date.now() }, {} as ServerWebSocket<unknown>, caps);
  try {
    await Promise.all([send(a), send(b)]); await transport.idle();
    expect(transport.repository.get(a).state).toBe('completed'); expect(transport.repository.get(b).state).toBe('completed');
    expect(seen).toHaveLength(2);
    for (const [ref, fact, other] of [[a, aFact, bFact], [b, bFact, aFact]] as const) {
      const result = getMemoryUsageLedger().readTarget({ conversationId: ref.conversationId });
      if (!result.data) throw Error('Missing history');
      expect(result.data.uses.filter(u => u.stage === 'supplied')).toMatchObject([{ factId: fact.id, turn: { conversationId: ref.conversationId, turnId: ref.turnId, requestId: ref.requestId } }]);
      expect(result.data.uses.some(u => u.factId === other.id || u.stage === 'outcome_verified')).toBe(false);
      const prompt = seen.find(messages => JSON.stringify(messages).includes(ref.text))!;
      expect(JSON.stringify(prompt)).toContain(fact.id); expect(JSON.stringify(prompt)).not.toContain(other.id);
    }
    const count = getDb().query('SELECT COUNT(*) AS n FROM memory_use_events').get();
    await send(a); await transport.idle(); expect(seen).toHaveLength(2);
    expect(getDb().query('SELECT COUNT(*) AS n FROM memory_use_events').get()).toEqual(count);
  } finally { transport.stop(); await transport.idle(); }
});
