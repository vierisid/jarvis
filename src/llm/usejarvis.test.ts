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

  it('keeps retryable statuses recognizable (429 passes through with marker)', async () => {
    globalThis.fetch = (async () => jsonResponse(429, { error: { message: 'rate limited' } })) as unknown as typeof fetch;
    const provider = new UsejarvisAIProvider('https://llm.usejarvis.host', 'sk-uj-abc');
    await expect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'uj-chat' })).rejects.toThrow(/\(429\)/);
  });
});
