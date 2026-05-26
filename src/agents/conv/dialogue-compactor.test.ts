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

/**
 * Helper: wait for any in-flight background compactions to settle.
 * The compactor schedules LLM calls via .then() so we need a microtask flush.
 */
async function settle(): Promise<void> {
  // Two awaits cover the promise chain we use internally.
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
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

  it('first long-convo turn returns just the tail (no blocking) and schedules background compaction', async () => {
    const provider = new StubProvider();
    const llm = makeManager(provider);
    const compactor = new DialogueCompactor(llm, 8, 14);
    const input = mkTurns(20);
    const out = await compactor.compact('conv1', input);

    // No summary on first turn - tail only.
    expect(out.length).toBe(8);
    expect(out[0]!.content).toBe('turn 12');
    expect(out[out.length - 1]!.content).toBe('turn 19');

    // The LLM call happened in the background (not blocking the foreground).
    await settle();
    expect(provider.callCount).toBe(1);
  });

  it('subsequent turn uses cached summary + tail', async () => {
    const provider = new StubProvider();
    const llm = makeManager(provider);
    const compactor = new DialogueCompactor(llm, 8, 14);

    await compactor.compact('conv1', mkTurns(20));
    await settle();
    expect(provider.callCount).toBe(1);

    // Second call same length - cache hit, no new compaction
    const out = await compactor.compact('conv1', mkTurns(20));
    await settle();
    expect(provider.callCount).toBe(1);

    expect(out[0]!.role).toBe('system');
    expect(typeof out[0]!.content === 'string' && out[0]!.content.includes('BULLET SUMMARY')).toBe(true);
  });

  it('background recompacts when head boundary shifts but foreground stays fast', async () => {
    const provider = new StubProvider();
    const llm = makeManager(provider);
    const compactor = new DialogueCompactor(llm, 8, 14);

    await compactor.compact('conv1', mkTurns(20));
    await settle();
    expect(provider.callCount).toBe(1);

    // Add 2 more turns - head boundary shifts
    await compactor.compact('conv1', mkTurns(22));
    // Foreground used cached summary; recompact runs in background.
    await settle();
    expect(provider.callCount).toBe(2);
  });

  it('isolates cache per conversation', async () => {
    const provider = new StubProvider();
    const llm = makeManager(provider);
    const compactor = new DialogueCompactor(llm, 8, 14);

    await compactor.compact('a', mkTurns(20));
    await compactor.compact('b', mkTurns(20));
    await settle();
    expect(provider.callCount).toBe(2);
  });

  it('invalidate() drops cache so next call schedules a fresh compaction', async () => {
    const provider = new StubProvider();
    const llm = makeManager(provider);
    const compactor = new DialogueCompactor(llm, 8, 14);

    await compactor.compact('conv1', mkTurns(20));
    await settle();
    expect(provider.callCount).toBe(1);

    compactor.invalidate('conv1');
    await compactor.compact('conv1', mkTurns(20));
    await settle();
    expect(provider.callCount).toBe(2);
  });

  it('does not stampede concurrent compactions for the same conversation', async () => {
    const provider = new StubProvider();
    const llm = makeManager(provider);
    const compactor = new DialogueCompactor(llm, 8, 14);

    // Fire 3 calls in parallel before any settle
    await Promise.all([
      compactor.compact('conv1', mkTurns(20)),
      compactor.compact('conv1', mkTurns(20)),
      compactor.compact('conv1', mkTurns(20)),
    ]);
    await settle();
    // Only one background compaction should have fired.
    expect(provider.callCount).toBe(1);
  });
});
