import { describe, expect, it } from 'bun:test';
import { compactHistory } from './history.ts';
import type { LLMMessage } from './provider.ts';

/** ~`tokens` measured size: measureMessage is ceil(len/4) + 10 overhead. */
function filler(tokens: number, label: string): string {
  return `${label}:`.padEnd(Math.max(1, (tokens - 10) * 4), 'x');
}

function userMsg(tokens: number, label: string): LLMMessage {
  return { role: 'user', content: filler(tokens, label) };
}

describe('compactHistory', () => {
  it('returns everything untouched when under budget', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      userMsg(50, 'a'),
      userMsg(50, 'b'),
    ];
    const result = compactHistory(messages, 10_000);
    expect(result).toHaveLength(3);
    expect(result[1]).toBe(messages[1]);
    expect(result[2]).toBe(messages[2]);
  });

  it('preserves the whole leading run of system messages when trimming', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'static prompt', cache: true },
      { role: 'system', content: 'dynamic context' },
      ...Array.from({ length: 40 }, (_, i) => userMsg(200, `m${i}`)),
    ];
    const result = compactHistory(messages, 3_000);
    expect(result[0]!.role).toBe('system');
    expect(result[1]!.role).toBe('system');
    expect(result[0]!.content).toBe('static prompt');
    expect(result[1]!.content).toBe('dynamic context');
    // Trimming happened
    expect(result.length).toBeLessThan(messages.length);
  });

  it('does not force-keep a system message that sits mid-history', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'leading' },
      ...Array.from({ length: 30 }, (_, i) => userMsg(300, `old${i}`)),
      { role: 'system', content: 'mid-history system' },
      ...Array.from({ length: 30 }, (_, i) => userMsg(300, `new${i}`)),
    ];
    const result = compactHistory(messages, 3_000);
    expect(result[0]!.content).toBe('leading');
    // The mid-history system message is evictable like any chunk; with this
    // much newer content it must have been dropped.
    expect(result.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('keeps tool-call exchange chains atomic across eviction', () => {
    const toolExchange: LLMMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'run', arguments: { q: filler(100, 'args') } }] },
      { role: 'tool', content: filler(100, 'result'), tool_call_id: 't1' },
    ];
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 30 }, (_, i) => userMsg(300, `old${i}`)),
      ...toolExchange,
      userMsg(50, 'tail'),
    ];
    const result = compactHistory(messages, 2_000);
    // If the assistant tool_call survived, its tool result must too (and
    // vice versa) - orphaned halves break tool-calling APIs.
    const hasAssistantCall = result.some((m) => m.role === 'assistant' && m.tool_calls?.length);
    const hasToolResult = result.some((m) => m.role === 'tool');
    expect(hasAssistantCall).toBe(hasToolResult);
  });

  it('always keeps the newest chunk even when it alone exceeds budget', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      userMsg(100, 'old'),
      userMsg(5_000, 'huge-tail'),
    ];
    const result = compactHistory(messages, 1_000);
    expect(result[result.length - 1]!.content).toContain('huge-tail');
  });

  it('keeps the trim boundary stable while history grows within a page', () => {
    const budget = 4_000;
    const base: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 60 }, (_, i) => userMsg(100, `m${i}`)),
    ];

    // First call that trims establishes a boundary.
    const first = compactHistory(base, budget);
    expect(first.length).toBeLessThan(base.length);
    const firstBoundary = first[1]!.content; // first retained non-system message

    // Growing the history by less than one page (page = 35% of ~3500 tokens
    // ~= 1225; each message is ~100) must NOT move the boundary.
    const growing = [...base];
    for (let i = 0; i < 5; i++) {
      growing.push(userMsg(100, `extra${i}`));
      const result = compactHistory(growing, budget);
      expect(result[1]!.content).toBe(firstBoundary);
    }

    // Growing past a full page eventually moves the boundary forward.
    for (let i = 5; i < 40; i++) growing.push(userMsg(100, `extra${i}`));
    const late = compactHistory(growing, budget);
    expect(late[1]!.content).not.toBe(firstBoundary);
  });

  it('fits the budget after eviction (excluding the oversized-tail case)', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 100 }, (_, i) => userMsg(150, `m${i}`)),
    ];
    const budget = 5_000;
    const result = compactHistory(messages, budget);
    const totalSize = JSON.stringify(result).length / 4; // generous over-estimate
    expect(totalSize).toBeLessThan(budget * 1.5);
    // Chronological order preserved.
    const labels = result.slice(1).map((m) => String(m.content).split(':')[0]);
    const indices = labels.map((l) => Number(l!.replace('m', '')));
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it('handles empty and single-message inputs', () => {
    expect(compactHistory([], 1_000)).toEqual([]);
    const single: LLMMessage[] = [{ role: 'system', content: 'sys' }];
    expect(compactHistory(single, 1_000)).toBe(single);
  });
});
