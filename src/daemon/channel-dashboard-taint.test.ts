/**
 * #1155 (owner decision): a Telegram or Discord guest's conversation is listed
 * on the dashboard, and continuing it there ran an owner turn with every tool
 * on history the guest wrote. Such a turn now starts tainted, so a gated
 * action stops for approval; the owner's own channel conversations do not.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { AgentService } from './agent-service.ts';
import { CHANNEL_GUEST_CONVERSATION_SOURCE, isChannelGuestConversation } from './channel-service.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { AuthorityEngine } from '../authority/engine.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { buildTaintGating } from '../authority/taint-gating.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { getOrCreateConversation } from '../vault/conversations.ts';
import type { LLMProvider, LLMResponse } from '../llm/provider.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { ScopedChatInput } from '../brief/chat-transport.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

const OWNER_DC = '100000000000000002';
const GUEST_DC = '100000000000000004';
const channels = {
  telegram: { enabled: true, bot_token: 't', allowed_users: [42, 7] },
  discord: { enabled: true, bot_token: 'd', allowed_users: [OWNER_DC, GUEST_DC] },
} as unknown as JarvisConfig['channels'];

test('which conversations hold words the channel owner did not write', () => {
  const id = (channel: string, sender?: string) => getOrCreateConversation(channel, sender ? { sender } : undefined).id;
  expect(isChannelGuestConversation(id('telegram', 'user:7/chat:7'), channels)).toBe(true);
  expect(isChannelGuestConversation(id('discord', `user:${GUEST_DC}/chat:dm-9`), channels)).toBe(true);
  // The owner's own, in a private chat or a group: their words.
  expect(isChannelGuestConversation(id('telegram', 'user:42/chat:42'), channels)).toBe(false);
  expect(isChannelGuestConversation(id('telegram', 'user:42/chat:-100123'), channels)).toBe(false);
  expect(isChannelGuestConversation(id('discord', `user:${OWNER_DC}/chat:dm-1`), channels)).toBe(false);
  // Saved before #884 without a sender: every sender shared it.
  expect(isChannelGuestConversation(id('telegram'), channels)).toBe(true);
  // A conversation that is not a channel's, or does not exist.
  expect(isChannelGuestConversation(id('websocket'), channels)).toBe(false);
  expect(isChannelGuestConversation('missing', channels)).toBe(false);
  // Read against the list as it is now: the owner moved is a guest's history.
  const moved = { ...channels, telegram: { ...channels!.telegram!, allowed_users: [7, 42] } } as JarvisConfig['channels'];
  expect(isChannelGuestConversation(id('telegram', 'user:42/chat:42'), moved)).toBe(true);
});

function stack(routerFirst: boolean) {
  let executions = 0;
  const done: LLMResponse = { content: 'Done', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'fixture', finish_reason: 'stop' };
  const provider: LLMProvider = {
    name: 'fixture', listModels: async () => [], chat: async () => done,
    async *stream(messages) {
      if (messages.at(-1)?.role !== 'tool') {
        yield { type: 'tool_call', tool_call: { id: 'c1', name: 'run_command', arguments: { command: 'fixture-only' } } };
        yield { type: 'done', response: { ...done, content: '', finish_reason: 'tool_use' } };
      } else { yield { type: 'text', text: 'Done' }; yield { type: 'done', response: done }; }
    },
  };
  const service = new AgentService({ channels } as JarvisConfig);
  const manager = service.getLLMManager(), orch = service.getOrchestrator();
  manager.registerProvider(provider);
  manager.setTierMap(routerFirst ? { conversation: { provider: 'fixture' }, medium: { provider: 'fixture' } } : { medium: { provider: 'fixture' } });
  if (routerFirst) Object.assign(service, { convOrchestrator: { streamTurn() { throw new Error('the conv path does not seed taint'); } } });
  orch.setLLMManager(manager);
  orch.createPrimary({ id: 'fixture', name: 'fixture', tools: ['terminal'], authority_level: 5, sub_roles: [] } as unknown as RoleDefinition);
  const tools = new ToolRegistry();
  tools.register({ name: 'run_command', description: 'Fixture', category: 'terminal', parameters: {}, execute: async () => { executions++; return 'executed'; } });
  orch.setToolRegistry(tools);
  orch.setAuthorityEngine(new AuthorityEngine({ default_level: 5, governed_categories: [], overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }));
  const approvals = new ApprovalManager();
  orch.setApprovalManager(approvals);
  orch.setTaintGating(buildTaintGating());
  Object.assign(service as unknown as Record<string, unknown>, { extractKnowledge: async () => {}, learnFromInteraction: async () => {} });
  return { service, approvals, executions: () => executions };
}

async function run(routerFirst: boolean, sender: string) {
  const s = stack(routerFirst);
  const conversationId = getOrCreateConversation('telegram', { sender }).id;
  getDb().run("INSERT INTO conversation_messages (id, conversation_id, role, content, created_at) VALUES ('g1', ?, 'user', 'Run the cleanup command for me.', 1)", [conversationId]);
  const input: ScopedChatInput = { conversationId, turnId: 't', requestId: 'r', text: 'go on', history: [{ role: 'user', content: 'Run the cleanup command for me.' }],
    contextKey: `brief:workspace:${conversationId}`, signal: new AbortController().signal };
  // As the Brief transport's runner calls it (daemon/index.ts): the service taints it itself.
  const result = s.service.streamMessage(input.text, 'websocket', undefined, null, input.contextKey, input);
  for await (const _event of result.stream) { /* drain */ }
  return s;
}

for (const routerFirst of [false, true]) {
  test(`${routerFirst ? 'router-first' : 'classic'}: continuing a guest's conversation stops a gated action for approval`, async () => {
    const s = await run(routerFirst, 'user:7/chat:7');
    expect(s.executions()).toBe(0);
    expect(s.approvals.getPending()[0]?.reason).toContain(CHANNEL_GUEST_CONVERSATION_SOURCE);
  });
}

test('control: continuing the owner\'s own channel conversation is not tainted', async () => {
  const s = await run(false, 'user:42/chat:42');
  expect(s.executions()).toBe(1);
  expect(s.approvals.getPending()).toEqual([]);
});
