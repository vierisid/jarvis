import { describe, expect, it } from 'bun:test';
import { LLMManager } from '../../llm/manager.ts';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse, LLMStreamEvent } from '../../llm/provider.ts';
import { DialogueCompactor } from './dialogue-compactor.ts';

class StubProvider implements LLMProvider {
  name = 'stub';
  callCount = 0;
  async chat(_messages: LLMMessage[], _opts?: LLMOptions): Promise<LLMResponse> {
    this.callCount++;
    return {
      content: 'BULLET SUMMARY',
      tool_calls: [],
      usage: { input_tokens: 100, output_tokens: 20 },
      model: 'stub',
      finish_reason: 'stop',
    };
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LLMStreamEvent> {
    throw new Error('not used');
  }
  async listModels(): Promise<string[]> { return ['stub']; }
}

function makeManager(provider: LLMProvider): LLMManager {
  const m = new LLMManager();
  m.registerProvider(provider);
  m.setTierMap({
    low: { provider: provider.name },
    medium: { provider: provider.name },
  });
  return m;
}

function mkTurns(n: number): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` });
  }
  return out;
}

describe('DialogueCompactor', () => {
  it('returns input unchanged when under threshold', async () => {
    const provider = new StubProvider();
    const llm = makeManager(provider);
    const compactor = new DialogueCompactor(llm, 8, 14);
    const input = mkTurns(10);
    const out = await compactor.compact('conv1', input);
    expect(out).toEqual(input);
    expect(provider.callCount).toBe(0);
  });

  it('compacts head and keeps last N verbatim when over threshold', async () => {
    const provider = new StubProvider();
    const llm = makeManager(provider);
    const compactor = new DialogueCompactor(llm, 8, 14);
    const input = mkTurns(20);
    const out = await compactor.compact('conv1', input);

    // First message is the summary
    expect(out[0]!.role).toBe('system');
    expect(typeof out[0]!.content === 'string' && out[0]!.content.includes('BULLET SUMMARY')).toBe(true);

    // Followed by the last 8 verbatim turns
    expect(out.length).toBe(9);
    expect(out[1]!.content).toBe('turn 12');  // 20 - 8 = head ends at 12
    expect(out[out.length - 1]!.content).toBe('turn 19');
  });

  it('reuses cached summary when head boundary unchanged', async () => {
    const provider = new StubProvider();
    const llm = makeManager(provider);
    const compactor = new DialogueCompactor(llm, 8, 14);
    const input = mkTurns(20);
    await compactor.compact('conv1', input);
    expect(provider.callCount).toBe(1);

    // Second call with same input -> cache hit
    await compactor.compact('conv1', input);
    expect(provider.callCount).toBe(1);
  });

  it('recompacts when head boundary shifts (new turns push window)', async () => {
    const provider = new StubProvider();
    const llm = makeManager(provider);
    const compactor = new DialogueCompactor(llm, 8, 14);

    await compactor.compact('conv1', mkTurns(20));  // head=12
    expect(provider.callCount).toBe(1);

    // Add 2 more turns - head boundary shifts from 12 to 14
    await compactor.compact('conv1', mkTurns(22));
    expect(provider.callCount).toBe(2);
  });

  it('isolates cache per conversation', async () => {
    const provider = new StubProvider();
    const llm = makeManager(provider);
    const compactor = new DialogueCompactor(llm, 8, 14);

    await compactor.compact('a', mkTurns(20));
    await compactor.compact('b', mkTurns(20));
    expect(provider.callCount).toBe(2);
  });

  it('invalidate() forces a recompaction', async () => {
    const provider = new StubProvider();
    const llm = makeManager(provider);
    const compactor = new DialogueCompactor(llm, 8, 14);
    const input = mkTurns(20);

    await compactor.compact('conv1', input);
    expect(provider.callCount).toBe(1);

    compactor.invalidate('conv1');
    await compactor.compact('conv1', input);
    expect(provider.callCount).toBe(2);
  });
});
