import type { LLMMessage, LLMOptions, LLMResponse, LLMStreamEvent } from './provider.ts';
import { LLMProviderError, classifyHttpStatus, parseRetryAfterMs } from './provider.ts';

/** GPT-6 tool calling uses Responses. Gate on the official origin so compatible
 * gateways and hosted subclasses retain their existing wire protocol. */
export function usesResponses(baseUrl: string, model: string): boolean {
  return baseUrl.replace(/\/$/, '') === 'https://api.openai.com/v1' && /^gpt-6(?:[.-]|$)/i.test(model);
}

export function responsesBody(messages: LLMMessage[], options: LLMOptions, model: string, stream: boolean) {
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    const text = typeof message.content === 'string' ? message.content
      : message.content.map(part => part.type === 'text' ? part.text : '[image]').join('\n');
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: text });
      continue;
    }
    if (message.content.length) {
      const content = typeof message.content === 'string' ? message.content : message.content.map(part =>
        part.type === 'image' && message.role === 'user'
          ? { type: 'input_image', image_url: `data:${part.source.media_type};base64,${part.source.data}` }
          : { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.type === 'text' ? part.text : '[image]' });
      input.push({ role: message.role, content });
    }
    for (const call of message.tool_calls ?? []) {
      input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
    }
  }
  return {
    model, input, store: false, stream,
    // Responses requires at least 16, including the five-token connection probe.
    ...(options.max_tokens !== undefined ? { max_output_tokens: Math.max(16, options.max_tokens) } : {}),
    ...(options.tools?.length ? {
      tools: options.tools.map(tool => ({ type: 'function', ...tool, strict: false })),
      tool_choice: options.tool_choice ?? 'auto',
    } : {}),
  };
}

type OutputItem = {
  type: string; call_id?: string; name?: string; arguments?: string;
  content?: { type: string; text?: string; refusal?: string }[];
};
type ResponseData = {
  model: string; status: string; output?: OutputItem[];
  error?: { message?: string }; incomplete_details?: { reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
};

export function parseResponses(data: ResponseData): LLMResponse {
  if (data.status !== 'completed' && data.status !== 'incomplete') {
    throw new LLMProviderError(data.error?.message ?? 'OpenAI response did not complete', 'server');
  }
  const output = data.output ?? [];
  const toolCalls = output.filter(item => data.status === 'completed' && item.type === 'function_call').map(item => {
    if (!item.call_id || !item.name) throw new LLMProviderError('Invalid OpenAI tool call', 'bad_request');
    const args: unknown = JSON.parse(item.arguments ?? '{}');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new LLMProviderError('Invalid OpenAI tool arguments', 'bad_request');
    return { id: item.call_id, name: item.name, arguments: args as Record<string, unknown> };
  });
  const cached = data.usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    content: output.flatMap(item => item.content ?? []).map(part => part.text ?? part.refusal ?? '').join(''),
    // Never execute a truncated function call.
    tool_calls: data.status === 'completed' ? toolCalls : [],
    model: data.model,
    usage: { input_tokens: Math.max(0, (data.usage?.input_tokens ?? 0) - cached), output_tokens: data.usage?.output_tokens ?? 0, cache_read_input_tokens: cached },
    finish_reason: data.status === 'incomplete' ? (data.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'error') : toolCalls.length ? 'tool_use' : 'stop',
  };
}

export async function postResponses(base: string, headers: Record<string, string>, messages: LLMMessage[], options: LLMOptions, model: string, stream: boolean) {
  const body = JSON.stringify(responsesBody(messages, options, model, stream));
  options.checkDeadline?.();
  options.signal?.throwIfAborted();
  const response = await fetch(`${base}/responses`, { method: 'POST', headers, body, signal: options.signal });
  if (!response.ok) {
    // Surface the provider's explanation, not its entire payload. Auth failures
    // may echo a key, so redact credential headers and recognizable key fragments.
    let detail = '';
    try {
      const payload = await response.json() as { error?: { message?: unknown } };
      if (typeof payload.error?.message === 'string') detail = payload.error.message;
    } catch { /* Non-JSON responses still retain their HTTP classification. */ }
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'content-type' || !value) continue;
      detail = detail.replaceAll(value, '[redacted]');
      const credential = value.replace(/^(?:Bearer|Basic)\s+/i, '');
      if (credential) detail = detail.replaceAll(credential, '[redacted]');
    }
    detail = detail.replace(/\bsk-[A-Za-z0-9_.*-]+/g, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 500);
    throw new LLMProviderError(`OpenAI Responses API error: HTTP ${response.status}${detail ? `: ${detail}` : ''}`, classifyHttpStatus(response.status), parseRetryAfterMs(response.headers));
  }
  return response;
}

export async function* streamResponses(response: Response): AsyncIterable<LLMStreamEvent> {
  if (!response.body) throw new LLMProviderError('No OpenAI response body', 'network');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      if (done && buffer) { lines.push(buffer); buffer = ''; }
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let event: { type: string; delta?: string; response?: ResponseData; message?: string };
        // A garbled frame is the provider's fault, not the connection's. The raw
        // frame may carry model output, so it never goes into the message.
        try { event = JSON.parse(raw); } catch {
          // A leftover partial frame at end of stream is a dropped connection.
          if (done) throw new LLMProviderError('OpenAI stream ended before completion', 'network');
          throw new LLMProviderError('OpenAI Responses stream sent malformed JSON', 'server');
        }
        if (!event || typeof event !== 'object') throw new LLMProviderError('OpenAI Responses stream sent malformed JSON', 'server');
        if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
          if (event.delta) yield { type: 'text', text: event.delta };
        } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          if (!event.response) throw new LLMProviderError('Missing OpenAI response', 'server');
          const result = parseResponses(event.response);
          for (const tool_call of result.tool_calls) yield { type: 'tool_call', tool_call };
          yield { type: 'done', response: result };
          return;
        } else if (event.type === 'response.failed' || event.type === 'error') {
          throw new LLMProviderError(event.response?.error?.message ?? event.message ?? 'OpenAI response failed', 'server');
        }
      }
      if (done) throw new LLMProviderError('OpenAI stream ended before completion', 'network');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
