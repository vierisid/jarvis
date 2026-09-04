import { afterEach, describe, expect, it } from 'bun:test';
import { UsejarvisAIProvider } from './usejarvis.ts';
import { instantiateProvider } from './config-binding.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('UsejarvisAIProvider', () => {
  it('normalizes the provisioner-written origin to a /v1 base', () => {
    const bare = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-a');
    expect((bare as any).apiUrl).toBe('https://llm.usejarvis.host/v1/chat/completions');
    // Already-suffixed and trailing-slash forms stay stable.
    const suffixed = new UsejarvisAIProvider('https://llm.usejarvis.host/v1/', 'sk-uj-a');
    expect((suffixed as any).apiUrl).toBe('https://llm.usejarvis.host/v1/chat/completions');
  });

  it('is created by the canonical config binding only when fully configured', () => {
    const provider = instantiateProvider('usejarvis_ai', {
      kind: 'usejarvis_ai',
      base_url: 'https://llm.usejarvis.host',
      api_key: 'sk-uj-abc',
    });
    expect(provider).toBeInstanceOf(UsejarvisAIProvider);
    expect(provider?.name).toBe('usejarvis_ai');
    // System-owned config always carries both values; a partial entry is a
    // broken render, not something to guess around.
    expect(instantiateProvider('usejarvis_ai', { kind: 'usejarvis_ai', base_url: 'https://x' })).toBeNull();
  });

  it('listModels returns the key-scoped alias catalog, deduped + sorted', async () => {
    let url = '';
    let auth: string | null = null;
    globalThis.fetch = (async (input: any, init?: any) => {
      url = String(input);
      auth = new Headers(init?.headers).get('Authorization');
      return jsonResponse(200, { data: [{ id: 'uj-low' }, { id: 'uj-chat' }, { id: 'uj-low' }, { id: 42 }] });
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    expect(await provider.listModels()).toEqual(['uj-chat', 'uj-low']);
    expect(url).toBe('https://llm.usejarvis.host/v1/models');
    expect(auth ?? '').toBe('Bearer sk-uj-abc');
  });

  it('never sends a custom temperature — the uj-* aliases resolve to reasoning models that reject it', async () => {
    // The base OpenAIProvider skips temperature only for names it recognises as
    // reasoning models; the hosted aliases are opaque, so without the override a
    // temperature=0.4 reached the proxy and 400'd ("claude-opus-5 does not
    // support temperature=0.4"). This proves the override strips it on the wire.
    let sent: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input: any, init?: any) => {
      sent = JSON.parse(String(init?.body));
      return jsonResponse(200, {
        id: 'x',
        object: 'chat.completion',
        model: 'uj-high',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    await provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-high', temperature: 0.4 });
    expect(sent!.model).toBe('uj-high');
    expect('temperature' in sent!).toBe(false);
  });

  it('never sends a custom temperature on the STREAM path either', async () => {
    // The stream() builder carries its own copy of the temperature guard, so it
    // gets its own wire-level assertion — a regression in just one path would
    // otherwise slip through.
    let sent: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input: any, init?: any) => {
      sent = JSON.parse(String(init?.body));
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    try {
      for await (const _ of provider.stream([{ role: 'user', content: 'hi' }], { model: 'uj-high', temperature: 0.4 })) { /* drain */ }
    } catch { /* the body is captured before any stream parsing */ }
    expect(sent!.model).toBe('uj-high');
    expect(sent!.stream).toBe(true);
    expect('temperature' in sent!).toBe(false);
  });

  it('retries a thinking-budget 400 once with a max_tokens that clears the budget (chat)', async () => {
    // A tier that resolves to a thinking model rejects a max_tokens below its
    // thinking budget; the small structured calls (awareness deltas etc.) hit
    // this. The provider retries once with room, so the call succeeds.
    const sent: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: any, init?: any) => {
      sent.push(JSON.parse(String(init?.body)));
      if (sent.length === 1) {
        return jsonResponse(400, {
          error: { message: 'litellm.BadRequestError: AnthropicException - `max_tokens` must be greater than `thinking.budget_tokens`.' },
        });
      }
      return jsonResponse(200, {
        id: 'x', object: 'chat.completion', model: 'uj-medium',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    const res = await provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-medium', max_tokens: 200 });
    expect(res.content).toBe('ok');
    expect(sent.length).toBe(2); // one retry, no more
    expect(sent[0]!.max_completion_tokens).toBe(200); // first call kept the caller's tiny cap
    expect(sent[1]!.max_completion_tokens as number).toBeGreaterThanOrEqual(16384); // retry cleared the budget
  });

  it('does NOT retry a 400 that is not a thinking-budget error', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(400, { error: { message: 'some other invalid_request_error' } });
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    await expect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-low', max_tokens: 5 })).rejects.toThrow();
    expect(calls).toBe(1); // no retry — a tiny cap on a non-thinking tier is respected
  });

  it('restarts the STREAM once on a pre-stream thinking-budget 400, with a cleared max_tokens', async () => {
    const sent: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: any, init?: any) => {
      sent.push(JSON.parse(String(init?.body)));
      if (sent.length === 1) {
        return jsonResponse(400, {
          error: { message: 'AnthropicException - `max_tokens` must be greater than `thinking.budget_tokens`.' },
        });
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    let text = '';
    let sawError = false;
    for await (const ev of provider.stream([{ role: 'user', content: 'hi' }], { model: 'uj-medium', max_tokens: 200 })) {
      if (ev.type === 'error') sawError = true;
      if (ev.type === 'text') text += ev.text;
    }
    expect(sawError).toBe(false); // the pre-stream error was swallowed by the restart
    expect(text).toBe('ok');
    expect(sent.length).toBe(2);
    expect(sent[1]!.max_completion_tokens as number).toBeGreaterThanOrEqual(16384);
  });

  it('retries a thinking-budget 400 at most ONCE — a still-failing retry rejects, no loop (chat)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(400, {
        error: { message: 'AnthropicException - `max_tokens` must be greater than `thinking.budget_tokens`.' },
      });
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-medium', max_tokens: 200 }),
    ).rejects.toThrow();
    expect(calls).toBe(2); // original + exactly one retry — the termination guard
  });

  it('does NOT retry when the caller already sent max_tokens >= the floor (retry would be identical)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(400, {
        error: { message: 'AnthropicException - `max_tokens` must be greater than `thinking.budget_tokens`.' },
      });
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-medium', max_tokens: 32000 }),
    ).rejects.toThrow();
    expect(calls).toBe(1); // 32000 >= floor -> bumping wouldn't change the request, so no wasted retry
  });

  it('retries the STREAM at most once — a still-failing restart surfaces one error, no loop', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(400, {
        error: { message: 'AnthropicException - `max_tokens` must be greater than `thinking.budget_tokens`.' },
      });
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    let errorEvents = 0;
    for await (const ev of provider.stream([{ role: 'user', content: 'hi' }], { model: 'uj-medium', max_tokens: 200 })) {
      if (ev.type === 'error') errorEvents++;
    }
    expect(calls).toBe(2); // original + one restart
    expect(errorEvents).toBe(1); // the second failure surfaces, rewritten, exactly once
  });

  it('rewrites budget-exceeded into actionable copy, keeping the (status) marker', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(400, { error: { message: 'ExceededBudget: budget has been exceeded for this key' } })) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    await expect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-chat' })).rejects.toThrow(
      /\(400\).*included AI usage is used up/,
    );
  });

  it('rewrites blocked/no-plan (401) and model-not-in-plan errors', async () => {
    globalThis.fetch = (async () => jsonResponse(401, { error: { message: 'Authentication Error: key is blocked' } })) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    await expect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-chat' })).rejects.toThrow(
      /\(401\).*active plan is required/,
    );
    globalThis.fetch = (async () => jsonResponse(400, { error: { message: 'model uj-realtime not allowed for this key' } })) as unknown as typeof fetch;
    await expect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-realtime' })).rejects.toThrow(
      /\(400\).*not included in your plan/,
    );
  });

  it('rewrites STREAM error events too (the base class yields, never throws)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(400, { error: { message: 'ExceededBudget: budget has been exceeded for this key' } })) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    const events: Array<{ type: string; error?: string }> = [];
    for await (const ev of provider.stream([{ role: 'user', content: 'hi' }], { model: 'uj-chat' })) {
      events.push(ev as { type: string; error?: string });
    }
    const err = events.find((e) => e.type === 'error');
    expect(err?.error).toMatch(/included AI usage is used up/);
    expect(err?.error).toMatch(/\(400\)/);
  });

  it('keeps retryable statuses recognizable (429 passes through with marker)', async () => {
    globalThis.fetch = (async () => jsonResponse(429, { error: { message: 'rate limited' } })) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    await expect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-chat' })).rejects.toThrow(/\(429\)/);
  });

  // LiteLLM denies an out-of-plan model with 401, NOT 403 — so the model
  // branch has to outrank the auth branch. Pinned at 401 specifically: at
  // 400 (the old fixture) the ordering bug cannot fire, and a paying user
  // picking a model outside their plan gets told their account is inactive.
  it('reports model-not-in-plan for a 401 denial, not "no active plan"', async () => {
    globalThis.fetch = (async () => jsonResponse(401, {
      error: {
        message: "Authentication Error, key not allowed to access model. This key can only access "
          + "models=['uj-chat','uj-low']. Tried to access uj-realtime",
      },
    })) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    await expect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-realtime' })).rejects.toThrow(
      /\(401\).*not included in your plan/,
    );
  });

  // The 429 budget body carries NO reset field (platform team, 2026-08-19);
  // the reset time lives on GET /key/info at the proxy ROOT, readable with
  // the account's own key, as ISO-8601 with an explicit offset.
  it('budget copy quotes the /key/info reset time and memoizes the lookup', async () => {
    let infoCalls = 0;
    let infoUrl = '';
    let infoAuth: string | null = null;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.endsWith('/key/info')) {
        infoCalls++;
        infoUrl = url;
        infoAuth = new Headers(init?.headers).get('Authorization');
        return jsonResponse(200, {
          key: 'sk-uj-abc',
          info: { budget_reset_at: '2026-08-19T12:00:00+00:00', max_budget: 0.005 },
        });
      }
      return jsonResponse(429, {
        error: {
          message: 'ExceededBudget: Budget has been exceeded! Current cost: 0.0051, Max budget: 0.005',
          code: 'budget_exceeded',
        },
      });
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    const failed = async (): Promise<string> => {
      try {
        await provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-chat' });
        throw new Error('expected the budget error to throw');
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(await failed()).toMatch(/used up for this window \(resumes 12:00 UTC\)/);
    // /key/info sits on the proxy ROOT, not under /v1, with the same bearer.
    expect(infoUrl).toBe('https://llm.usejarvis.host/key/info');
    expect(infoAuth ?? '').toBe('Bearer sk-uj-abc');
    // A second budget error inside the memo window issues no second lookup.
    expect(await failed()).toMatch(/resumes 12:00 UTC/);
    expect(infoCalls).toBe(1);
  });

  it('budget copy degrades to time-less when /key/info fails, leaking nothing', async () => {
    globalThis.fetch = (async (input: any) => {
      if (String(input).endsWith('/key/info')) {
        throw new Error('connect ETIMEDOUT llm.usejarvis.host:443');
      }
      return jsonResponse(429, { error: { message: 'Budget has been exceeded!' } });
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    let message = '';
    try {
      await provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-chat' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/used up for this window\./);
    expect(message).not.toMatch(/resumes \d/);
    expect(message).not.toContain('llm.usejarvis.host');
  });

  it('403 maps to model-not-in-plan (team_model_access_denied), no /key/info lookup', async () => {
    let infoCalls = 0;
    globalThis.fetch = (async (input: any) => {
      if (String(input).endsWith('/key/info')) { infoCalls++; return jsonResponse(200, {}); }
      return jsonResponse(403, { error: { message: 'team_model_access_denied', code: 'team_model_access_denied' } });
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    await expect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'gpt-5.5' })).rejects.toThrow(
      /\(403\).*not included in your plan/,
    );
    expect(infoCalls).toBe(0);
  });

  // The base class YIELDS {type:'error'} events instead of throwing, so a
  // try/catch around super.stream() is dead code — and this is the path
  // every conversation turn takes. Without the event rewrite the raw proxy
  // body (which echoes the bearer we presented) reaches the chat bubble.
  it('rewrites stream error EVENTS, leaking neither the key nor the body', async () => {
    const key = 'sk-uj-7Yb2QpLmN4vXzR1aTgKe0wUf';
    globalThis.fetch = (async () => new Response(
      `<html><title>401</title><body>Upstream rejected credential Bearer ${key} `
        + 'for host llm.usejarvis.host. ' + 'x'.repeat(4000) + '</body></html>',
      { status: 401, headers: { 'Content-Type': 'text/html' } },
    )) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', key);

    const events: Array<{ type: string; error?: string }> = [];
    for await (const event of provider.stream([{ role: 'user', content: 'hi' }], { model: 'uj-chat' })) {
      events.push(event as { type: string; error?: string });
    }
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    const text = errors[0]!.error ?? '';
    expect(text).not.toContain(key);
    expect(text).not.toContain('llm.usejarvis.host');
    expect(text).toMatch(/\(401\).*active plan is required/);
    expect(text.length).toBeLessThan(300); // never the unbounded CDN page
  });

  // Streaming is the primary hosted conversational path; without real usage
  // there, cache_creation_input_tokens is hardcoded 0 and a silent cache
  // decline is indistinguishable from success — the exact blindness the
  // field exists to remove. Usage placement differs by backend: real OpenAI
  // sends it on a terminal EMPTY-choices chunk, while the hosted LiteLLM
  // proxy rides it on the LAST CONTENT chunk (choices=1, no empty-choices
  // terminal at all — platform-verified 2026-08-19). The parser must take
  // usage from whichever chunk carries it; both shapes below pin the same
  // reported usage.
  const STREAM_USAGE = {
    prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005,
    prompt_tokens_details: { cached_tokens: 800 },
    cache_creation_input_tokens: 150,
  };
  const EXPECTED_STREAM_USAGE = {
    input_tokens: 50, // 1000 - 800 cached - 150 written
    output_tokens: 5,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 150,
  };

  async function streamUsageFromSse(sse: string): Promise<{ sent: any; done: any }> {
    let sent: any = null;
    globalThis.fetch = (async (_url: any, init?: any) => {
      sent = JSON.parse(String(init.body));
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    const events: any[] = [];
    for await (const event of provider.stream([{ role: 'user', content: 'hi' }], { model: 'uj-chat' })) {
      events.push(event);
    }
    return { sent, done: events.find((e) => e.type === 'done') };
  }

  it('requests include_usage and reports usage from an empty-choices terminal chunk (OpenAI shape)', async () => {
    const sse = [
      'data: ' + JSON.stringify({
        id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'uj-chat',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hey' }, finish_reason: null }],
      }),
      'data: ' + JSON.stringify({
        id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'uj-chat',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      // The include_usage terminal chunk: EMPTY choices, usage attached.
      'data: ' + JSON.stringify({
        id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'uj-chat',
        choices: [],
        usage: STREAM_USAGE,
      }),
      'data: [DONE]', '',
    ].join('\n');
    const { sent, done } = await streamUsageFromSse(sse);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(done.response.usage).toEqual(EXPECTED_STREAM_USAGE);
  });

  it('reports usage riding on the last CONTENT chunk with no empty-choices terminal (proxy shape)', async () => {
    const sse = [
      'data: ' + JSON.stringify({
        id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'uj-chat',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hey' }, finish_reason: null }],
      }),
      // Measured proxy shape: usage on the final content chunk, choices=1,
      // then straight to [DONE] — no empty-choices chunk exists.
      'data: ' + JSON.stringify({
        id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'uj-chat',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: STREAM_USAGE,
      }),
      'data: [DONE]', '',
    ].join('\n');
    const { done } = await streamUsageFromSse(sse);
    expect(done.response.usage).toEqual(EXPECTED_STREAM_USAGE);
    expect(done.response.content).toBe('hey');
  });

  // The uncached-input subtraction assumes the proxy folds cache writes into
  // prompt_tokens; an unfolded report must clamp at zero, not persist a
  // negative count into llm_usage.
  it('clamps input_tokens at zero when the proxy reports unfolded cache writes', async () => {
    globalThis.fetch = (async () => jsonResponse(200, {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 900, completion_tokens: 3, total_tokens: 903,
        prompt_tokens_details: { cached_tokens: 900 },
        cache_creation_input_tokens: 200,
      },
    })) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    const res = await provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-chat' });
    expect(res.usage.input_tokens).toBe(0);
  });

  it('filters the catalog to uj-* so a mis-scoped key cannot leak upstream ids', async () => {
    globalThis.fetch = (async () => jsonResponse(200, {
      data: [{ id: 'uj-chat' }, { id: 'claude-haiku-4-5-20251001' }, { id: 'gpt-4o-mini' }],
    })) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    expect(await provider.listModels()).toEqual(['uj-chat']);
  });

  it('listModels degrades to the fallback aliases instead of throwing (pr2 review #6)', async () => {
    // Transient 503:
    globalThis.fetch = (async () => jsonResponse(503, { error: 'upstream down' })) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    expect(await provider.listModels()).toEqual(['uj-chat', 'uj-high', 'uj-low', 'uj-medium']);
    // Network failure:
    globalThis.fetch = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await provider.listModels()).toEqual(['uj-chat', 'uj-high', 'uj-low', 'uj-medium']);
  });

  it('defaultModel is uj-medium so the manager model-less retry never posts an empty model (pr2 review #7)', () => {
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    expect((provider as unknown as { defaultModel: string }).defaultModel).toBe('uj-medium');
  });
});

/**
 * Prompt-cache breakpoints. MARGIN-CRITICAL: agentic turns re-send a growing
 * prefix, and the proxy bills a cached read at ~0.1x fresh input (measured
 * live). LiteLLM only forwards the marker when it rides ON a content part —
 * a top-level cache_control field, which OpenRouter accepts, is dropped.
 */
const sentVolatileMarked = (sent: any): boolean =>
  sent.messages.some((m: any) =>
    Array.isArray(m.content) &&
    m.content.some((p: any) => p.cache_control && String(p.text).includes('In flight')));

describe('UsejarvisAIProvider prompt-cache markers', () => {
  const capture = async (
    messages: Array<Record<string, unknown>>,
    // The marker tests exercise an OPTED-IN provider; the opt-in default
    // itself (OFF) is pinned by its own test below.
    opts: { promptCache?: boolean } = { promptCache: true },
  ): Promise<any> => {
    let sent: any = null;
    globalThis.fetch = (async (_url: any, init?: any) => {
      sent = JSON.parse(String(init.body));
      return jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc', opts);
    await provider.chat(messages as any, { model: 'uj-chat' });
    return sent;
  };

  // The uj-* aliases are vendor-opaque: a marker reaching a non-Anthropic
  // upstream is an unknown property → 400 on every call. Emission must be
  // an explicit provisioner opt-in, never a default.
  it('sends no cache_control unless the system block opts in', async () => {
    const sent = await capture([
      { role: 'system', content: 'You are Jarvis. ' + 'x'.repeat(200), cache: true },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ], {});
    expect(JSON.stringify(sent)).not.toContain('cache_control');
  });

  it('config binding enables markers only with the block opt-in AND the user switch', () => {
    const entry = {
      kind: 'usejarvis_ai' as const,
      base_url: 'https://llm.usejarvis.host',
      api_key: 'sk-uj-abc',
    };
    const flag = (p: unknown): boolean => (p as any).promptCache;
    expect(flag(instantiateProvider('usejarvis_ai', entry))).toBe(false);
    expect(flag(instantiateProvider('usejarvis_ai', { ...entry, prompt_cache: true }))).toBe(true);
    expect(flag(instantiateProvider('usejarvis_ai', { ...entry, prompt_cache: true }, { promptCache: false }))).toBe(false);
  });

  it('marks the cache:true system block and the newest user turn', async () => {
    const sent = await capture([
      { role: 'system', content: 'You are Jarvis. ' + 'x'.repeat(200), cache: true },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
    expect(sent.messages[0].content).toEqual([
      { type: 'text', text: expect.stringContaining('You are Jarvis.'), cache_control: { type: 'ephemeral' } },
    ]);
    // Rolling breakpoint on the newest turn — what the NEXT request reads.
    expect(sent.messages[3].content[0].cache_control).toEqual({ type: 'ephemeral' });
    // Untouched in between, so the prefix stays byte-identical across turns.
    expect(sent.messages[1].content).toBe('first');
    expect(sent.messages[2].content).toBe('reply');
  });

  // THE test for this feature. Callers emit [static(cache:true), dynamic],
  // and the dynamic block carries elapsed-second counters. Marking the last
  // SYSTEM message (rather than the last MARKED one) ends the cached prefix
  // on bytes that change every turn, so the entry can never be read back —
  // the write premium is paid and the persona is re-billed at full rate.
  // Asserting the marked text is byte-identical across two turns is what
  // catches that; it fails against a positional heuristic.
  it('ends the cached prefix on stable bytes when a dynamic system block follows', async () => {
    const persona = 'You are Jarvis. ' + 'x'.repeat(2000);
    const turn = (elapsed: number) => [
      { role: 'system', content: persona, cache: true },
      { role: 'system', content: `In flight: task-1 (running, ${elapsed}s)` },
      { role: 'user', content: 'hi' },
    ];
    const a = await capture(turn(12));
    const b = await capture(turn(47));

    const markedOf = (sent: any) =>
      sent.messages
        .filter((m: any) => Array.isArray(m.content))
        .flatMap((m: any) => m.content)
        .filter((p: any) => p.cache_control)
        .map((p: any) => p.text);

    expect(markedOf(a)).toEqual([persona]);
    // Byte-identical across turns → the prefix is reusable.
    expect(markedOf(a)).toEqual(markedOf(b));
    // …and the volatile block is NOT the boundary.
    expect(sentVolatileMarked(a)).toBe(false);
    expect(sentVolatileMarked(b)).toBe(false);
  });

  // One-shot calls never resend their prefix, so a rolling breakpoint there
  // is a guaranteed-unread 1.25x cache write. AnthropicProvider guards on the
  // presence of an assistant turn; this must match.
  it('skips the rolling breakpoint on one-shot calls (no assistant turn)', async () => {
    const sent = await capture([
      { role: 'user', content: 'classify this: ' + 'y'.repeat(2000) },
    ]);
    expect(JSON.stringify(sent)).not.toContain('cache_control');
  });

  it('still marks a one-shot call\'s stable system prefix', async () => {
    const sent = await capture([
      { role: 'system', content: 'Extraction rules. ' + 'z'.repeat(2000), cache: true },
      { role: 'user', content: 'extract' },
    ]);
    expect(sent.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    // …but not the user turn: nothing will resend this prefix.
    expect(sent.messages[1].content).toBe('extract');
  });

  it('never sends a TOP-LEVEL cache_control (LiteLLM drops it)', async () => {
    const sent = await capture([{ role: 'user', content: 'hi' }]);
    expect(sent.cache_control).toBeUndefined();
  });

  it('honours the global prompt-cache switch', async () => {
    const sent = await capture([{ role: 'user', content: 'hi' }], { promptCache: false });
    expect(sent.messages[0].content).toBe('hi');
    expect(JSON.stringify(sent)).not.toContain('cache_control');
  });

  // An assistant turn carrying tool_calls must keep content '' — promoting it
  // to a part array changes what the API expects and breaks the tool loop.
  it('leaves a tool_calls assistant message alone', async () => {
    const sent = await capture([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', name: 'search', arguments: { q: 'x' } }],
      },
    ]);
    expect(sent.messages[1].content).toBe('');
    expect(sent.messages[1].tool_calls).toHaveLength(1);
    expect(JSON.stringify(sent.messages[1])).not.toContain('cache_control');
  });

  // THE agentic-loop shape: from iteration 2 onward the last message is a
  // `tool` result. LiteLLM's tool→tool_result translation is not verified to
  // carry a content-part marker through, so the rolling breakpoint must
  // anchor on the last USER message — marking the tool message is either a
  // silent no-op on exactly the loop this feature exists for, or a 400.
  it('anchors the rolling breakpoint on the last user turn, never a tool result', async () => {
    const sent = await capture([
      { role: 'system', content: 'You are Jarvis. ' + 'x'.repeat(200), cache: true },
      { role: 'user', content: 'do the thing' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', name: 'search', arguments: { q: 'x' } }],
      },
      { role: 'tool', content: 'result: ' + 'r'.repeat(500), tool_call_id: 't1' },
    ]);
    // The tool result stays a plain string — untouched.
    expect(sent.messages[3].content).toBe('result: ' + 'r'.repeat(500));
    expect(JSON.stringify(sent.messages[3])).not.toContain('cache_control');
    // The user turn carries the rolling breakpoint instead.
    expect(sent.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  // An empty marked system block must not suppress the breakpoint: the
  // boundary falls back to the previous marked block, matching
  // AnthropicProvider's empty-block filter.
  it('skips an empty cache:true system block and marks the previous one', async () => {
    const persona = 'You are Jarvis. ' + 'x'.repeat(500);
    const sent = await capture([
      { role: 'system', content: persona, cache: true },
      { role: 'system', content: '', cache: true },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'again' },
    ]);
    expect(sent.messages[0].content).toEqual([
      { type: 'text', text: persona, cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('falls back to the last system block when the caller declares no boundary', async () => {
    const sent = await capture([
      { role: 'system', content: 'Rules. ' + 'q'.repeat(500) },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'again' },
    ]);
    expect(sent.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});
