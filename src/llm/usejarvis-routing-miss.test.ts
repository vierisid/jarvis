import { afterEach, describe, expect, it } from 'bun:test';
import { LLMManager } from './manager.ts';
import { LLMProviderError, type LLMStreamEvent } from './provider.ts';
import { UsejarvisAIProvider } from './usejarvis.ts';

/**
 * The hosted proxy answers 400 when the replica that took the request holds no
 * deployment for the model. A /model/update in flight evicts every DB model
 * from that replica for a few hundred ms, and on 2026-09-10 that failed a
 * hosted voice turn on attempt 1 of 3. It is the proxy's own transient state,
 * not a bad request, so it must retry instead of failing the turn.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Verbatim shape of the body the proxy returned in the incident. */
const ROUTING_MISS = {
  error: {
    message:
      'litellm.BadRequestError: You passed in model=gpt-5.6-luna. There are no healthy deployments for this model. ' +
      'Received Model Group=gpt-5.6-luna\nAvailable Model Group Fallbacks=None',
    type: null,
    param: null,
    code: '400',
  },
};

const OK_SSE = [
  'data: ' + JSON.stringify({
    id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'uj-chat',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hey' }, finish_reason: null }],
  }),
  'data: ' + JSON.stringify({
    id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'uj-chat',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }),
  'data: [DONE]', '',
].join('\n');

const provider = () => new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');

async function streamErrorFor(status: number, body: unknown) {
  globalThis.fetch = (async () => jsonResponse(status, body)) as unknown as typeof fetch;
  const events: LLMStreamEvent[] = [];
  for await (const ev of provider().stream([{ role: 'user', content: 'hi' }], { model: 'uj-chat' })) {
    events.push(ev);
  }
  return events.find((e) => e.type === 'error') as Extract<LLMStreamEvent, { type: 'error' }>;
}

describe('UsejarvisAIProvider routing miss', () => {
  it('tags the stream error as a retryable server fault with a short pause, body still withheld', async () => {
    const err = await streamErrorFor(400, ROUTING_MISS);
    expect(err.code).toBe('server');
    expect(err.retry_after_ms).toBe(1000);
    expect(err.error).toMatch(/\(400\)/);
    expect(err.error).not.toMatch(/gpt-5\.6-luna|healthy deployments/);
  });

  it('throws a retryable LLMProviderError from chat, body still withheld', async () => {
    globalThis.fetch = (async () => jsonResponse(400, ROUTING_MISS)) as unknown as typeof fetch;
    const err = await provider().chat([{ role: 'user', content: 'hi' }], { model: 'uj-chat' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMProviderError);
    expect((err as LLMProviderError).code).toBe('server');
    expect((err as LLMProviderError).retryAfterMs).toBe(1000);
    expect((err as LLMProviderError).message).not.toMatch(/gpt-5\.6-luna|healthy deployments/);
  });

  it('leaves an ordinary 400 non-retryable', async () => {
    const err = await streamErrorFor(400, { error: { message: 'some other invalid_request_error' } });
    // The base class's status-derived code, untouched.
    expect(err.code).toBe('bad_request');
    expect(err.retry_after_ms).toBeUndefined();
    globalThis.fetch = (async () => jsonResponse(400, { error: { message: 'some other invalid_request_error' } })) as unknown as typeof fetch;
    const thrown = await provider().chat([{ role: 'user', content: 'hi' }], { model: 'uj-chat' }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(LLMProviderError);
    expect((thrown as Error).message).toMatch(/\(400\)/);
  });

  it('leaves a 429 carrying router wording on the rate-limit path (it also fails over)', async () => {
    const err = await streamErrorFor(429, {
      error: { message: 'litellm.RateLimitError: No deployments available for selected model, Try again in 5 seconds.' },
    });
    expect(err.code).toBe('rate_limit');
    expect(err.error).toMatch(/\(429\)/);
  });

  /** The tier paths production runs (streamTier / chatTier). */
  function tieredManager(): LLMManager {
    const manager = new LLMManager();
    manager.registerProvider(provider());
    manager.setTierMap({ conversation: { provider: 'usejarvis_ai' } });
    return manager;
  }

  it('streamTier retries it and the turn completes on the next attempt', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? jsonResponse(400, ROUTING_MISS)
        : new Response(OK_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const events: LLMStreamEvent[] = [];
    const stream = tieredManager().streamTier('conversation', 'test', [{ role: 'user', content: 'hi' }], { model: 'uj-chat' });
    for await (const ev of stream) events.push(ev);
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('')).toBe('hey');
  });

  it('chatTier retries it and the call succeeds on the next attempt', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? jsonResponse(400, ROUTING_MISS)
        : jsonResponse(200, {
            id: 'x',
            object: 'chat.completion',
            model: 'uj-chat',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
    }) as unknown as typeof fetch;
    const result = await tieredManager().chatTier('conversation', 'test', [{ role: 'user', content: 'hi' }], { model: 'uj-chat' });
    expect(calls).toBe(2);
    // The retried response is the one surfaced.
    expect(result.content).toBe('hi');
  });
});
