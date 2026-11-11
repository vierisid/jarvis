import { afterEach, expect, test } from 'bun:test';
import { OpenAIProvider } from './openai';
import type { LLMStreamEvent } from './provider';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const messages = [{ role: 'user' as const, content: 'hi' }];

function sse(...chunks: unknown[]): string {
  return chunks.map(c => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}
const delta = (d: Record<string, unknown>, finish: string | null = null) =>
  ({ id: 'x', model: 'm', choices: [{ index: 0, delta: d, finish_reason: finish }] });
function reply(body: string, contentType = 'text/event-stream', status = 200) {
  globalThis.fetch = (async () => new Response(body, { status, headers: { 'content-type': contentType } })) as unknown as typeof fetch;
}
async function collect(): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const event of new OpenAIProvider('k').stream(messages)) out.push(event);
  return out;
}
const call = (index: number, id: string, args: string) =>
  delta({ tool_calls: [{ index, id, type: 'function', function: { name: 'write_file', arguments: args } }] });

test('tool arguments that are not JSON reach the loop as a call carrying the problem, not as a bad request', async () => {
  reply(sse(call(0, 'a', '{bad json'), delta({}, 'tool_calls')));
  const events = await collect();
  expect(events.some(e => e.type === 'error')).toBe(false);
  const tool = events.find(e => e.type === 'tool_call');
  expect(tool).toMatchObject({ tool_call: { id: 'a', name: 'write_file', arguments: {} } });
  expect((tool as { tool_call: { argumentsError?: string } }).tool_call.argumentsError).toBeTruthy();
  expect(events.at(-1)?.type).toBe('done');
});

test('a valid call next to a malformed one still arrives, and empty arguments mean no arguments', async () => {
  reply(sse(call(0, 'ok', '{"path":"a"}'), call(1, 'bad', '[1,2'), call(2, 'none', ''), delta({}, 'tool_calls')));
  const calls = (await collect()).flatMap(e => e.type === 'tool_call' ? [e.tool_call] : []);
  expect(calls.map(c => [c.id, c.argumentsError === undefined])).toEqual([['ok', true], ['bad', false], ['none', true]]);
  expect(calls[0]!.arguments).toEqual({ path: 'a' });
  expect(calls[2]!.arguments).toEqual({});
});

test('two calls with the same id each get their own, so each runs once and the history stays valid', async () => {
  reply(sse(call(0, 'same', '{"n":1}'), call(1, 'same', '{"n":2}'), call(2, '', '{"n":3}'), delta({}, 'tool_calls')));
  const ids = (await collect()).flatMap(e => e.type === 'tool_call' ? [e.tool_call.id] : []);
  expect(new Set(ids).size).toBe(3);
  expect(ids[0]).toBe('same');
});

test('non-stream replies keep a malformed call and make ids unique', async () => {
  reply(JSON.stringify({ id: 'x', model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
    { id: 'same', type: 'function', function: { name: 'write_file', arguments: '{oops' } },
    { id: 'same', type: 'function', function: { name: 'write_file', arguments: '{"n":2}' } },
  ] } }] }), 'application/json');
  const response = await new OpenAIProvider('k').chat(messages);
  expect(response.tool_calls).toHaveLength(2);
  expect(response.tool_calls[0]!.argumentsError).toBeTruthy();
  expect(new Set(response.tool_calls.map(c => c.id)).size).toBe(2);
});

for (const [name, body, type] of [
  ['an HTML page served with a 200', '<html><body>Sign in to the network</body></html>', 'text/html'],
  ['data lines that are not JSON', 'data: {not json}\n\ndata: [oops\n\n', 'text/event-stream'],
  ['data lines that are not JSON, then DONE', 'data: {not json}\n\ndata: [DONE]\n\n', 'text/event-stream'],
  ['plain text', 'hello there', 'text/plain'],
] as const) {
  test(`${name} is reported as an unreadable provider reply, not a finished empty answer`, async () => {
    reply(body, type);
    const events = await collect();
    expect(events.map(e => e.type)).toEqual(['error']);
    const error = events[0] as { error: string; code?: string };
    expect(error.code).toBe('server');
    expect(error.error).toContain('not a readable stream');
    expect(error.error).not.toContain('Sign in');
  });
}

test('a server that ignores stream:true and sends one JSON completion is read as that answer', async () => {
  reply(JSON.stringify({ id: 'x', model: 'm', usage: { prompt_tokens: 2, completion_tokens: 3 }, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'plain answer' } }] }), 'text/plain');
  const events = await collect();
  expect(events.map(e => e.type)).toEqual(['text', 'done']);
  expect(events[0]).toMatchObject({ text: 'plain answer' });
});

test('a stream with a real empty answer is still a completed empty answer', async () => {
  reply(sse(delta({ role: 'assistant' }, 'stop')));
  expect((await collect()).map(e => e.type)).toEqual(['done']);
});
