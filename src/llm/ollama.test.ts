import { describe, expect, it, afterEach } from 'bun:test';
import { OllamaProvider } from './ollama.ts';
import type { LLMMessage } from './provider.ts';

const originalFetch = globalThis.fetch;

/**
 * Stub /api/chat and hand back the request body the provider built. The
 * assertions below are about the payload we put on the wire — a live Ollama
 * isn't needed, and wasn't available when this regression was found.
 */
async function captureChatBody(
  messages: LLMMessage[],
): Promise<{ messages: OllamaWireMessage[] }> {
  let captured: string | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = init.body as string;
    return new Response(JSON.stringify({
      model: 'qwen2.5:3b',
      created_at: '',
      message: { role: 'assistant', content: 'ok' },
      done: true,
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await new OllamaProvider().chat(messages);
  // Guards the diagnostic, not the provider: if chat() ever returns without
  // reaching fetch, this says so instead of failing as a JSON parse error.
  expect(captured).toBeDefined();
  return JSON.parse(captured!);
}

type OllamaWireMessage = {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
  tool_call_id?: string;
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

describe('OllamaProvider tool-call round-trip', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Assistant calls a tool, we answer it — the shape the orchestrator emits. */
  const toolTurn: LLMMessage[] = [
    { role: 'user', content: 'run hostnamectl on the linux box' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'ollama_1_abc',
        name: 'run_command',
        arguments: { command: 'hostnamectl', target: 'linux-box' },
      }],
    },
    { role: 'tool', content: 'Static hostname: linux-box', tool_call_id: 'ollama_1_abc' },
  ];

  it('sends the assistant tool calls back, with arguments as an object', async () => {
    const body = await captureChatBody(toolTurn);
    const assistant = body.messages[1]!;

    expect(assistant.role).toBe('assistant');
    expect(assistant.tool_calls).toEqual([{
      function: {
        name: 'run_command',
        // Not a JSON string: Ollama's native API takes an object here.
        arguments: { command: 'hostnamectl', target: 'linux-box' },
      },
    }]);
  });

  it('keeps the tool result addressed to the call it answers', async () => {
    const body = await captureChatBody(toolTurn);
    const result = body.messages[2]!;

    expect(result.role).toBe('tool');
    expect(result.content).toBe('Static hostname: linux-box');
    // tool_name is the field Ollama reads; tool_call_id rides along in case a
    // build does look for it. See the note on OllamaMessage.
    expect(result.tool_name).toBe('run_command');
    expect(result.tool_call_id).toBe('ollama_1_abc');
  });

  it('still passes a result through when its call fell outside the window', async () => {
    const body = await captureChatBody([
      { role: 'tool', content: 'orphaned output', tool_call_id: 'ollama_dropped' },
    ]);
    const result = body.messages[0]!;

    expect(result.role).toBe('tool');
    expect(result.content).toBe('orphaned output');
    expect(result.tool_name).toBeUndefined();
  });

  it('leaves ordinary text and image messages untouched', async () => {
    const body = await captureChatBody([
      { role: 'system', content: 'be terse' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BASE64' } },
        ],
      },
    ]);

    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: 'what is this',
      images: ['BASE64'],
    });
  });
});
