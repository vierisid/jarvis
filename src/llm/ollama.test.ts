import { describe, expect, it, afterEach } from 'bun:test';
import { OllamaProvider } from './ollama.ts';

const originalFetch = globalThis.fetch;

describe('OllamaProvider.listModels', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the installed model ids, sorted, tags intact', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        models: [
          { name: 'qwen2.5:3b', model: 'qwen2.5:3b', modified_at: '', size: 1, digest: 'a' },
          { name: 'llama3.1:8b', model: 'llama3.1:8b', modified_at: '', size: 1, digest: 'b' },
        ],
      }), { status: 200 })) as unknown as typeof fetch;

    const models = await new OllamaProvider().listModels();
    expect(models).toEqual(['llama3.1:8b', 'qwen2.5:3b']);
  });

  it('throws on a non-ok response instead of inventing a model list', async () => {
    globalThis.fetch = (async () =>
      new Response('not found', { status: 404 })) as unknown as typeof fetch;

    expect(new OllamaProvider().listModels()).rejects.toThrow('Failed to list models: 404');
  });

  it('propagates network errors instead of inventing a model list', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Unable to connect');
    }) as unknown as typeof fetch;

    expect(new OllamaProvider().listModels()).rejects.toThrow('Unable to connect');
  });
});
