/**
 * A turn from inside the brain (the notch): the same stored, keyed,
 * cancellable turn a dashboard send makes, with no socket and no speech.
 */
import { afterEach, expect, test } from 'bun:test';
import { BriefChatTransport, type ScopedChatInput } from './chat-transport';
import type { BriefChatEvent } from './contracts';
import { currentOrigin } from '../llm/origin';
import { initDatabase, getDb, closeDb } from '../vault/schema';
import { getOrCreateConversation } from '../vault/conversations';
import { ConversationRequestError } from '../vault/conversation-lifecycle';

afterEach(() => closeDb());

const done = { type: 'done' as const, response: { content: '', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'x', finish_reason: 'stop' as const } };

function setup(stream: (input: ScopedChatInput) => AsyncIterable<{ type: 'text'; text: string } | typeof done>) {
  initDatabase(':memory:', { quiet: true });
  const seen: { input: ScopedChatInput; origin: string | undefined }[] = [];
  const sent: unknown[] = [];
  const transport = new BriefChatTransport({ db: getDb(), send: (_client, message) => { sent.push(message); },
    tts: () => { throw new Error('a turn from inside the brain is never spoken'); },
    runner: { ready: () => true, stream: (input) => {
      seen.push({ input, origin: currentOrigin() });
      return { stream: stream(input), onComplete: async () => {} };
    } } });
  const events: BriefChatEvent[] = [];
  transport.onEvent((event) => { events.push(event); });
  const conversationId = getOrCreateConversation('notch', { label: 'Notch' }).id;
  return { transport, events, seen, sent, conversationId };
}

test('a submitted turn runs as the person\'s own, is stored, and tells its listener how it went', async () => {
  const { transport, events, seen, sent, conversationId } = setup(async function* () { yield { type: 'text', text: 'It is ' }; yield { type: 'text', text: 'four.' }; yield done; });
  const ref = { conversationId, turnId: 't1', requestId: 'notch-typed-1' };
  const { turn, created } = transport.submit({ ...ref, text: 'two plus two?' });
  expect(created).toBe(true);
  expect(turn.speak).toBe(false);
  await transport.idle();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.input.text).toBe('two plus two?');
  expect(seen[0]!.input.contextKey).toContain(conversationId);
  const kinds = events.map((event) => event.payload.kind);
  expect(kinds[0]).toBe('message');
  expect(kinds.filter((kind) => kind === 'delta')).toHaveLength(2);
  expect(events.at(-1)!.payload).toMatchObject({ kind: 'terminal', state: 'completed' });
  // The whole reply is in the conversation, where a restart finds it.
  const stored = getDb().query<{ content: string }, [string]>('SELECT content FROM conversation_messages WHERE id = ?').get(turn.assistantMessageId);
  expect(stored?.content).toBe('It is four.');
  // No socket was written to.
  expect(sent).toHaveLength(0);
});

test('the same request is one turn, however often it is submitted', async () => {
  const { transport, seen, conversationId } = setup(async function* () { yield { type: 'text', text: 'ok' }; yield done; });
  const ref = { conversationId, turnId: 't1', requestId: 'notch-typed-1' };
  expect(transport.submit({ ...ref, text: 'do it' }).created).toBe(true);
  expect(transport.submit({ ...ref, text: 'do it' }).created).toBe(false);
  await transport.idle();
  expect(transport.submit({ ...ref, text: 'do it' }).created).toBe(false);
  await transport.idle();
  expect(seen).toHaveLength(1);
});

test('a second turn in a conversation that has one is refused, and says why', async () => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { transport, conversationId } = setup(async function* () { await held; yield { type: 'text', text: 'ok' }; yield done; });
  transport.submit({ conversationId, turnId: 't1', requestId: 'r1', text: 'first' });
  let refused: unknown = null;
  try { transport.submit({ conversationId, turnId: 't2', requestId: 'r2', text: 'second' }); } catch (error) { refused = error; }
  expect(refused).toBeInstanceOf(ConversationRequestError);
  expect((refused as ConversationRequestError).status).toBe(409);
  release();
  await transport.idle();
});

test('a cancelled turn ends as cancelled and its run is told to stop', async () => {
  let aborted = false;
  const { transport, events, conversationId } = setup(async function* (input) {
    await new Promise<void>((resolve) => { input.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }); });
    yield { type: 'text', text: 'too late' };
    yield done;
  });
  const ref = { conversationId, turnId: 't1', requestId: 'r1' };
  transport.submit({ ...ref, text: 'something long' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  transport.cancelTurn(ref);
  await transport.idle();
  expect(aborted).toBe(true);
  expect(events.at(-1)!.payload).toMatchObject({ kind: 'terminal', state: 'cancelled' });
  expect(transport.repository.get(ref).state).toBe('cancelled');
});

test('a submitted turn runs under the person\'s origin', async () => {
  const { transport, seen, conversationId } = setup(async function* () { yield done; });
  transport.submit({ conversationId, turnId: 't1', requestId: 'r1', text: 'hello' });
  await transport.idle();
  expect(seen[0]!.origin).toBe('user');
});

test('empty text and a bad identity are refused before anything is stored', () => {
  const { transport, conversationId } = setup(async function* () { yield done; });
  expect(() => transport.submit({ conversationId, turnId: 't1', requestId: 'r1', text: '   ' })).toThrow(ConversationRequestError);
  expect(() => transport.submit({ conversationId, turnId: 'bad id', requestId: 'r1', text: 'x' })).toThrow(ConversationRequestError);
  expect(transport.repository.pending()).toHaveLength(0);
});
