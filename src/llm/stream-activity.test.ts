import { afterEach, expect, test } from 'bun:test';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { GroqProvider } from './groq';
import { LLMManager } from './manager';
import { NVIDIAProvider } from './nvidia';
import { OllamaProvider } from './ollama';
import { OpenAIProvider } from './openai';
import { OpenRouterProvider } from './openrouter';
import type { LLMProvider, LLMStreamEvent } from './provider';

/**
 * A provider that is alive but has nothing to yield yet (thinking, a tool
 * call's arguments arriving in pieces, keepalive pings) must not look stalled.
 * Each provider gets a body that drips such bytes for longer than the stall
 * window, then ends. Without the provider reporting byte activity the manager
 * cuts it as "sent no data".
 */
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const SSE_FILLER = ': keepalive\n\n';
// Ollama is NDJSON: a thinking-only chunk carries no content and yields nothing.
const OLLAMA_FILLER = '{"model":"m","message":{"role":"assistant","content":"","thinking":"hm"},"done":false}\n';

function dripFetch(filler: string): void {
  globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    const encoder = new TextEncoder();
    let sent = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const tick = () => {
          if (init?.signal?.aborted) { controller.error(init.signal.reason); return; }
          if (sent++ === 8) { controller.close(); return; }
          controller.enqueue(encoder.encode(filler));
          timer = setTimeout(tick, 15);
        };
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); try { controller.error(init.signal!.reason); } catch { /* closed */ } });
        timer = setTimeout(tick, 15);
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

const cases: Array<[string, () => LLMProvider, string]> = [
  ['anthropic', () => new AnthropicProvider('k', 'claude-x'), SSE_FILLER],
  ['openai chat completions', () => new OpenAIProvider('k', 'gpt-4o'), SSE_FILLER],
  ['openai responses', () => new OpenAIProvider('k', 'gpt-6'), SSE_FILLER],
  ['gemini', () => new GeminiProvider('k', 'gemini-x'), SSE_FILLER],
  ['groq', () => new GroqProvider('k', 'groq-x'), SSE_FILLER],
  ['nvidia', () => new NVIDIAProvider('k', 'nvidia-x'), SSE_FILLER],
  ['openrouter', () => new OpenRouterProvider('k', 'or-x'), SSE_FILLER],
  ['ollama', () => new OllamaProvider('http://127.0.0.1:1', 'm'), OLLAMA_FILLER],
];

for (const [name, make, filler] of cases) {
  test(`${name}: bytes that are not yet an event keep the stream from stalling`, async () => {
    dripFetch(filler);
    const manager = new LLMManager({ streamFirstDataMs: 60, streamIdleMs: 60 });
    const provider = make();
    // Ollama's own longer first-data window would hide the point of the test.
    Object.defineProperty(provider, 'streamFirstDataMs', { value: undefined });
    manager.registerProvider(provider);
    const events: LLMStreamEvent[] = [];
    for await (const event of manager.stream([{ role: 'user', content: 'hi' }], { max_tokens: 16 })) events.push(event);
    expect(JSON.stringify(events)).not.toContain('sent no data');
  });
}

test('a local provider gets a longer first-data window than a hosted one', async () => {
  globalThis.fetch = (async () => new Response(new ReadableStream({ start() {} }), { status: 200 })) as unknown as typeof fetch;
  expect(new OllamaProvider().streamFirstDataMs).toBeGreaterThan(90_000);
  // The provider's own window wins over a shorter manager default.
  const manager = new LLMManager({ streamFirstDataMs: 20, streamIdleMs: 20 });
  const provider: LLMProvider = {
    name: 'local', streamFirstDataMs: 200,
    async chat() { throw new Error('unused'); },
    async *stream(_m, options) { await new Promise((resolve) => options?.signal?.addEventListener('abort', resolve)); },
    async listModels() { return []; },
  };
  manager.registerProvider(provider);
  const started = Date.now();
  const events: LLMStreamEvent[] = [];
  for await (const event of manager.stream([{ role: 'user', content: 'hi' }])) events.push(event);
  expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  expect(JSON.stringify(events)).toContain('sent no data for 200ms');
});
