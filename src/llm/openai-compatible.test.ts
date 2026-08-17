import { afterEach, describe, expect, it } from 'bun:test';
import { OpenAICompatibleProvider } from './openai-compatible.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('OpenAICompatibleProvider', () => {
  it('discovers every model from the versioned gateway root', async () => {
    let requested = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return Response.json({ data: [{ id: 'custom-z' }, { id: 'claude-route' }] });
    }) as typeof fetch;

    const provider = new OpenAICompatibleProvider('https://gateway.example/api', '', 'token');
    expect(await provider.listModels()).toEqual(['claude-route', 'custom-z']);
    expect(requested).toBe('https://gateway.example/api/v1/models');
  });

  it('summarizes an HTML route error instead of returning the whole page', async () => {
    globalThis.fetch = (async () => new Response(
      '<!DOCTYPE html><html><head><title>404: This page could not be found.</title></head><body>large page</body></html>',
      { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
    )) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider('https://gateway.example/api', 'custom-z', 'token');
    await expect(provider.chat([{ role: 'user', content: 'hello' }])).rejects.toThrow(
      'OpenAI-compatible API error: HTTP 404: 404: This page could not be found.',
    );
  });
});
