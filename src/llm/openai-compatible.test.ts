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
    expect(await provider.listModels()).toEqual(['custom-z', 'claude-route']);
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

  it('retries a bare-origin HTML route failure under /api/v1 for models and chat', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/api/v1/models')) {
        return Response.json({ data: [{ id: 'custom-chat' }] });
      }
      if (url.includes('/api/v1/chat/completions')) {
        return Response.json({
          id: 'chat_test', object: 'chat.completion', created: 1, model: 'custom-chat',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      return new Response('<!doctype html><title>Forbidden</title>', {
        status: 403, headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider('https://gateway.example/', 'custom-chat', 'token');
    expect(await provider.listModels()).toEqual(['custom-chat']);
    expect((await provider.chat([{ role: 'user', content: 'hello' }])).content).toBe('OK');
    expect(requested).toEqual([
      'https://gateway.example/v1/models',
      'https://gateway.example/api/v1/models',
      'https://gateway.example/api/v1/chat/completions',
    ]);
  });

  it('does not hide or retry a JSON 403 authentication failure', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return Response.json({ error: { message: 'invalid key' } }, { status: 403 });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider('https://gateway.example/', 'custom-chat', 'bad-token');
    await expect(provider.listModels()).rejects.toThrow('403');
    expect(requested).toEqual(['https://gateway.example/v1/models']);
  });
});
