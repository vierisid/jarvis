/**
 * Response parsing and CLI helpers for the benchmark, tested without a
 * server. Every number the cache and accuracy verdicts read comes through
 * these.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeOllamaHost, parseArgs, parseCount, parseOllamaReply, parseOpenAIReply } from './protocol.ts';

describe('openai replies', () => {
  test('string arguments are parsed, and llama-server timings win for evaluated tokens', () => {
    const r = parseOpenAIReply({
      choices: [{ message: { content: 'looking', tool_calls: [{ id: 'x', function: { name: 'discover_tools', arguments: '{"names":["browser_navigate"]}' } }] } }],
      usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 } },
      timings: { prompt_n: 40, prompt_ms: 12.4 },
    }, 'fallback');
    expect(r.call).toEqual({ id: 'x', name: 'discover_tools', args: { names: ['browser_navigate'] } });
    expect(r.content).toBe('looking');
    expect(r).toMatchObject({ promptTokens: 1000, evaluatedTokens: 40, prefillMs: 12, callCount: 1 });
  });

  test('object arguments survive (they used to become {})', () => {
    const r = parseOpenAIReply({ choices: [{ message: { tool_calls: [{ function: { name: 'discover_tools', arguments: { names: ['a'] } } }] } }] }, 'f');
    expect(r.call?.args).toEqual({ names: ['a'] });
    expect(r.call?.id).toBe('f');
  });

  test('cached_tokens gives evaluated tokens; no cache report is null, never a guess', () => {
    expect(parseOpenAIReply({ usage: { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 0 } } }, 'f').evaluatedTokens).toBe(500);
    expect(parseOpenAIReply({ usage: { prompt_tokens: 500 } }, 'f').evaluatedTokens).toBeNull();
    expect(parseOpenAIReply({}, 'f')).toMatchObject({ call: null, callCount: 0, promptTokens: null });
  });
});

describe('ollama replies', () => {
  test('evaluated tokens come from prompt_eval_count, and there is no total', () => {
    const r = parseOllamaReply({
      message: { tool_calls: [{ function: { name: 'browser_navigate', arguments: { url: 'x' } } }, { function: { name: 'run_command' } }] },
      prompt_eval_count: 77, prompt_eval_duration: 5_000_000,
    }, 'c1');
    expect(r).toMatchObject({ promptTokens: null, evaluatedTokens: 77, prefillMs: 5, callCount: 2 });
    expect(r.call).toEqual({ id: 'c1', name: 'browser_navigate', args: { url: 'x' } });
  });

  test('an omitted prompt_eval_count (omitempty on a fully cached prompt) is 0, not unknown', () => {
    expect(parseOllamaReply({ message: { content: 'hi' } }, 'c').evaluatedTokens).toBe(0);
  });
});

describe('helpers', () => {
  test('parseArgs tolerates every shape', () => {
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseArgs({ a: 1 })).toEqual({ a: 1 });
    expect(parseArgs('not json')).toEqual({});
    expect(parseArgs('[1,2]')).toEqual({});
    expect(parseArgs(undefined)).toEqual({});
  });

  test('OLLAMA_HOST as the server reads it becomes a usable client URL', () => {
    expect(normalizeOllamaHost('0.0.0.0')).toBe('http://127.0.0.1:11434');
    expect(normalizeOllamaHost('0.0.0.0:11500')).toBe('http://127.0.0.1:11500');
    expect(normalizeOllamaHost('localhost:11434')).toBe('http://localhost:11434');
    expect(normalizeOllamaHost('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
    expect(normalizeOllamaHost('https://gpu.example:8443')).toBe('https://gpu.example:8443');
  });

  test('a malformed count is an error, not NaN (which removed the --max-calls cap)', () => {
    expect(parseCount('--max-calls', '250')).toBe(250);
    expect(() => parseCount('--max-calls', 'abc')).toThrow('--max-calls');
    expect(() => parseCount('--max-calls', '-1')).toThrow();
    expect(() => parseCount('--max-calls', '1.5')).toThrow();
  });
});
