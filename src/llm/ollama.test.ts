import { describe, expect, it, afterEach } from 'bun:test';
import { OllamaProvider } from './ollama.ts';
import type { LLMMessage } from './provider.ts';

const originalFetch = globalThis.fetch;

/** Capture the request body sent to /api/chat and reply with a canned response. */
function captureChatRequest(): { body: () => Record<string, any> } {
  let captured: Record<string, any> = {};
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({
      model: 'llama3',
      created_at: '2026-01-01T00:00:00Z',
      message: { role: 'assistant', content: 'ok' },
      done: true,
      prompt_eval_count: 10,
      eval_count: 5,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { body: () => captured };
}

const TOOL_HISTORY: LLMMessage[] = [
  { role: 'user', content: 'open notepad and type hello' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', name: 'desktop_launch_app', arguments: { executable: 'notepad.exe' } }],
  },
  { role: 'tool', content: '{"success":true,"pid":123}', tool_call_id: 'call_1' },
];

const A_TOOL = {
  name: 'desktop_launch_app',
  description: 'Launch an app',
  parameters: { type: 'object', properties: {} },
};

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

describe('OllamaProvider message conversion', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('replays assistant tool_calls so the model can see its own prior actions', async () => {
    const req = captureChatRequest();
    await new OllamaProvider().chat(TOOL_HISTORY);

    const assistant = req.body().messages.find((m: any) => m.role === 'assistant');
    expect(assistant.tool_calls).toEqual([
      { function: { name: 'desktop_launch_app', arguments: { executable: 'notepad.exe' } } },
    ]);
  });

  it('anchors tool results with tool_name (resolved from the call id) and tool_call_id', async () => {
    const req = captureChatRequest();
    await new OllamaProvider().chat(TOOL_HISTORY);

    const tool = req.body().messages.find((m: any) => m.role === 'tool');
    expect(tool.role).toBe('tool'); // not force-cast to assistant
    expect(tool.tool_name).toBe('desktop_launch_app');
    expect(tool.tool_call_id).toBe('call_1');
    expect(tool.content).toBe('{"success":true,"pid":123}');
  });

  it('omits tool linkage fields on plain messages', async () => {
    const req = captureChatRequest();
    await new OllamaProvider().chat([{ role: 'user', content: 'hi' }]);

    const user = req.body().messages.find((m: any) => m.role === 'user');
    expect(user.tool_calls).toBeUndefined();
    expect(user.tool_name).toBeUndefined();
    expect(user.tool_call_id).toBeUndefined();
  });
});

describe('OllamaProvider generation options', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('always lifts the ~128-token num_predict default and pins num_ctx to the history budget window', async () => {
    const req = captureChatRequest();
    await new OllamaProvider().chat([{ role: 'user', content: 'hi' }]);

    expect(req.body().options.num_predict).toBe(4096);
    expect(req.body().options.num_ctx).toBe(32000);
  });

  it('respects explicit max_tokens and temperature', async () => {
    const req = captureChatRequest();
    await new OllamaProvider().chat([{ role: 'user', content: 'hi' }], {
      max_tokens: 512,
      temperature: 0.9,
      tools: [A_TOOL],
    });

    expect(req.body().options.num_predict).toBe(512);
    expect(req.body().options.temperature).toBe(0.9);
  });

  it('defaults to low temperature on tool-calling turns', async () => {
    const req = captureChatRequest();
    await new OllamaProvider().chat([{ role: 'user', content: 'hi' }], { tools: [A_TOOL] });

    expect(req.body().options.temperature).toBe(0.2);
  });

  it('leaves temperature to the model default on plain turns', async () => {
    const req = captureChatRequest();
    await new OllamaProvider().chat([{ role: 'user', content: 'hi' }]);

    expect(req.body().options.temperature).toBeUndefined();
  });

  it('honors a custom context window for num_ctx', async () => {
    const req = captureChatRequest();
    await new OllamaProvider('http://localhost:11434', 'llama3', 8192)
      .chat([{ role: 'user', content: 'hi' }]);

    expect(req.body().options.num_ctx).toBe(8192);
  });
});
