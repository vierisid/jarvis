import { afterEach, describe, expect, it } from 'bun:test';
import {
  OpenAICompatibleProvider,
  openAICompatibleRouteCandidates,
} from './openai-compatible.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function htmlMiss() {
  return new Response('<!doctype html><title>nope</title>', {
    status: 404, headers: { 'content-type': 'text/html' },
  });
}
const modelList = () => Response.json({ data: [{ id: 'm1' }] });

describe('openAICompatibleRouteCandidates', () => {
  it('offers the api-prefixed variant for a bare origin', () => {
    expect(openAICompatibleRouteCandidates('https://gw.example/')).toEqual([
      'https://gw.example/v1',
      'https://gw.example/api/v1',
    ]);
  });

  it('keeps a user-typed path as a fallback, since it may already be the API root', () => {
    expect(openAICompatibleRouteCandidates('https://host/openai')).toEqual([
      'https://host/openai/v1',
      'https://host/openai',
    ]);
  });

  it('does not duplicate an already-versioned root', () => {
    expect(openAICompatibleRouteCandidates('http://localhost:8080/v1')).toEqual([
      'http://localhost:8080/v1',
      'http://localhost:8080/api/v1',
    ]);
  });
});

describe('OpenAICompatibleProvider route resolution', () => {
  it('reaches a gateway that serves the API straight off the configured path', async () => {
    // Regression: normalization appends /v1, which 404s here. Without the
    // configured root as a fallback this endpoint became unreachable.
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      return url.includes('/openai/v1') ? htmlMiss() : modelList();
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider('https://host/openai', '', 'k');
    expect(await provider.listModels()).toEqual(['m1']);
    expect(seen).toEqual([
      'https://host/openai/v1/models',
      'https://host/openai/models',
    ]);
  });

  it('re-probes instead of staying pinned after a transient routing miss', async () => {
    // Regression: the resolved route used to be a one-way latch, so a single
    // HTML 404 diverted every later call until the daemon restarted.
    const seen: string[] = [];
    let failConfigured = true;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (failConfigured && !url.includes('/api/v1')) return htmlMiss();
      if (!failConfigured && url.includes('/api/v1')) return htmlMiss();
      return modelList();
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider('https://gw.example/', '', 'k');
    await provider.listModels();
    expect(seen).toEqual(['https://gw.example/v1/models', 'https://gw.example/api/v1/models']);

    // The gateway recovers on its configured route.
    failConfigured = false;
    seen.length = 0;
    expect(await provider.listModels()).toEqual(['m1']);
    expect(seen[seen.length - 1]).toBe('https://gw.example/v1/models');
  });

  it('caches the winning route so a healthy gateway costs one request', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      return url.includes('/api/v1') ? modelList() : htmlMiss();
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider('https://gw.example/', '', 'k');
    await provider.listModels();
    seen.length = 0;
    await provider.listModels();
    expect(seen).toEqual(['https://gw.example/api/v1/models']);
  });

  it('still surfaces a JSON 403 without probing alternates', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return Response.json({ error: { message: 'invalid key' } }, { status: 403 });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider('https://gw.example/', '', 'bad');
    await expect(provider.listModels()).rejects.toThrow('403');
    expect(seen).toEqual(['https://gw.example/v1/models']);
  });
});

describe('route candidates never re-add a stripped endpoint suffix', () => {
  it('a pasted /chat/completions URL yields no self-appending route', () => {
    // Regression: the fallback used the RAW input, re-introducing the suffix
    // the normalizer strips — every request then went to
    // `.../chat/completions/chat/completions`.
    for (const pasted of [
      'https://api.foo.com/v1/chat/completions',
      'https://api.foo.com/v1/models',
      'https://api.foo.com/openai/v1/chat/completions',
    ]) {
      const candidates = openAICompatibleRouteCandidates(pasted);
      for (const candidate of candidates) {
        expect(candidate).not.toMatch(/\/(chat\/completions|models)$/);
      }
    }
  });

  it('still resolves a pasted endpoint URL to the right root', () => {
    expect(openAICompatibleRouteCandidates('https://api.foo.com/v1/chat/completions')).toEqual([
      'https://api.foo.com/v1',
      'https://api.foo.com/api/v1',
    ]);
  });

  it('sends a pasted endpoint URL to exactly one URL', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return Response.json({ data: [{ id: 'm1' }] });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider('https://api.foo.com/v1/chat/completions', '', 'k');
    await provider.listModels();
    expect(seen).toEqual(['https://api.foo.com/v1/models']);
  });
});

describe('concurrent requests do not read each other route', () => {
  it('keeps each in-flight request on its own root', async () => {
    // Regression guard: the route used to be threaded by swapping a shared
    // field around the call, which only worked because the base postChat read
    // it synchronously. It now travels as an argument.
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      await Promise.resolve();
      if (!url.includes('/api/v1')) {
        return new Response('<!doctype html><title>x</title>', {
          status: 404, headers: { 'content-type': 'text/html' },
        });
      }
      return Response.json({
        id: 'c', object: 'chat.completion', created: 1, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider('https://gw.example/', 'm', 'k');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => provider.chat([{ role: 'user', content: 'hi' }])),
    );

    expect(results.every((r) => r.content === 'OK')).toBe(true);
    // Every request landed on one of the two legitimate roots — never a
    // hybrid produced by one call observing another's in-flight swap.
    const legal = new Set([
      'https://gw.example/v1/chat/completions',
      'https://gw.example/api/v1/chat/completions',
    ]);
    expect(seen.every((u) => legal.has(u))).toBe(true);
  });
});
