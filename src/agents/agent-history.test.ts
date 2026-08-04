import { describe, test, expect } from 'bun:test';
import { AgentInstance } from './agent.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { ContentBlock } from '../llm/provider.ts';

const role: RoleDefinition = {
  name: 'test-role',
  description: 'test',
  authority_level: 1,
  tools: [],
  system_prompt: 'test',
} as unknown as RoleDefinition;

describe('AgentInstance message history bounds', () => {
  test('history stays within the retention budget instead of growing forever', () => {
    const agent = new AgentInstance(role);
    // ~500 tokens per message (2000 chars / 4) → 200k-token budget caps out
    // around 400 messages; push far past that.
    const filler = 'x'.repeat(2000);
    for (let i = 0; i < 2000; i++) {
      agent.addMessage(i % 2 === 0 ? 'user' : 'assistant', `${i}:${filler}`);
    }
    const messages = agent.getMessages();
    expect(messages.length).toBeLessThan(600);
    // Newest message is always retained
    const last = messages[messages.length - 1]!;
    expect(typeof last.content === 'string' && last.content.startsWith('1999:')).toBe(true);
  });

  test('image payloads are released once the turn completes', () => {
    const agent = new AgentInstance(role);
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'help with this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(100_000) } },
    ];
    agent.addMessage('user', blocks);

    // Mid-turn: the image is still there for the in-flight request
    const midTurn = agent.getMessages();
    expect((midTurn[0]!.content as ContentBlock[]).some((b) => b.type === 'image')).toBe(true);

    agent.addMessage('assistant', 'done');

    const after = agent.getMessages();
    const userContent = after[0]!.content as ContentBlock[];
    expect(userContent.some((b) => b.type === 'image')).toBe(false);
    expect(userContent.some((b) => b.type === 'text' && b.text.includes('screenshot'))).toBe(true);
    // The text block from the same message survives
    expect(userContent.some((b) => b.type === 'text' && b.text === 'help with this')).toBe(true);
    // In-flight references still hold the original, untouched message object
    expect((midTurn[0]!.content as ContentBlock[]).some((b) => b.type === 'image')).toBe(true);
  });
});
