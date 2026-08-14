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
describe('UsejarvisAIProvider prompt-cache markers', () => {
  const capture = async (
    messages: Array<Record<string, unknown>>,
    opts?: { promptCache?: boolean },
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

  it('marks the last system message and the last message overall', async () => {
    const sent = await capture([
      { role: 'system', content: 'You are Jarvis. ' + 'x'.repeat(200) },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
    // System: promoted to a content part carrying the breakpoint.
    expect(sent.messages[0].content).toEqual([
      { type: 'text', text: expect.stringContaining('You are Jarvis.'), cache_control: { type: 'ephemeral' } },
    ]);
    // Rolling breakpoint on the newest turn — what the NEXT request reads.
    expect(sent.messages[3].content[0].cache_control).toEqual({ type: 'ephemeral' });
    // Untouched in between, so the prefix stays byte-identical across turns.
    expect(sent.messages[1].content).toBe('first');
    expect(sent.messages[2].content).toBe('reply');
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

  it('a single message still gets exactly one breakpoint', async () => {
    const sent = await capture([{ role: 'user', content: 'hi' }]);
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});
