import { afterEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import type { WSMessage } from '../comms/websocket.ts';
import type { LLMStreamEvent } from '../llm/provider.ts';
import type { TTSProvider } from '../comms/voice.ts';
import { initDatabase, getDb, closeDb } from '../vault/schema.ts';
import { BriefConversationProvider } from './conversations.ts';
import { BriefChatTransport, type ScopedChatInput, type ScopedChatRunner } from './chat-transport.ts';
import { createBriefCapabilities } from './registrations/index.ts';
import { registerConversations } from './registrations/conversations.ts';
import { registerChatTransport } from './registrations/chat-transport.ts';
import type { BriefChatEvent, BriefSendTurn } from './contracts.ts';
import { currentBriefTurn } from './chat-context.ts';

afterEach(() => closeDb());
const done = (): LLMStreamEvent => ({ type: 'done', response: { content: '', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'fixture', finish_reason: 'stop' } });
const identity = ({ conversationId, turnId, requestId }: BriefSendTurn) => ({ conversationId, turnId, requestId });
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture did not reach expected state'); await Bun.sleep(1); }
}
function controlled() {
  const inputs = new Map<string, ScopedChatInput>();
  const queues = new Map<string, LLMStreamEvent[]>();
  const wakes = new Map<string, () => void>();
  const runner: ScopedChatRunner = { ready: () => true, stream(input) {
    inputs.set(input.turnId, input); queues.set(input.turnId, []);
    return { onComplete: async () => {}, stream: (async function* () {
      try {
        while (true) {
          input.signal.throwIfAborted();
          const next = queues.get(input.turnId)!.shift();
          if (next) { yield next; if (next.type === 'done' || next.type === 'error') return; }
          else await new Promise<void>(resolve => {
            const wake = () => { input.signal.removeEventListener('abort', wake); wakes.delete(input.turnId); resolve(); };
            wakes.set(input.turnId, wake);
            input.signal.addEventListener('abort', wake, { once: true });
          });
        }
      } finally { wakes.get(input.turnId)?.(); }
    })() };
  } };
  return { inputs, runner, push(turnId: string, event: LLMStreamEvent) { queues.get(turnId)!.push(event); wakes.get(turnId)?.(); } };
}
function fixture(options: { concurrency?: number; tts?: TTSProvider; enabled?: boolean } = {}) {
  initDatabase(':memory:', { quiet: true });
  const conversations = new BriefConversationProvider();
  const control = controlled();
  const frames = new Map<ServerWebSocket<unknown>, WSMessage[]>();
  const client = () => { const socket = {} as ServerWebSocket<unknown>; frames.set(socket, []); return socket; };
  const transport = new BriefChatTransport({ db: getDb(), runner: control.runner, concurrency: options.concurrency,
    send: (socket, frame) => { frames.get(socket)!.push(frame); }, tts: () => options.tts ?? null });
  const capabilities = createBriefCapabilities([...registerConversations(conversations), ...registerChatTransport(transport)],
    options.enabled === false ? ['conversations'] : ['conversations', 'chatTransport']);
  const send = (socket: ServerWebSocket<unknown>, type: WSMessage['type'], payload: unknown) => transport.handle({ type, payload, timestamp: Date.now() }, socket, capabilities);
  const input = (name: string, speak = false): BriefSendTurn => ({ conversationId: conversations.repository.create({ title: name }).conversationId, turnId: `turn-${name}`, requestId: `request-${name}`, text: `Question ${name}`, speak });
  const events = (socket: ServerWebSocket<unknown>) => frames.get(socket)!.filter(frame => frame.type === 'brief_chat_event').map(frame => frame.payload as BriefChatEvent);
  return { ...control, transport, conversations, frames, client, send, input, events };
}

test('interleaved streams, tab switch and one cancel isolate text, progress, history and TTS', async () => {
  const spoken: string[] = [];
  const tts: TTSProvider = { async synthesize(text) { return Buffer.from(text); }, async *synthesizeStream(text) { spoken.push(text); yield Buffer.from(text); } };
  const f = fixture({ concurrency: 2, tts });
  const a = f.input('A', true), b = f.input('B', true);
  const ownerA = f.client(), ownerB = f.client(), mirrorA = f.client(), legacy = f.client();
  try {
    await f.send(mirrorA, 'brief_chat_subscribe', { conversationId: a.conversationId });
    await f.send(ownerA, 'brief_chat_send', a); await f.send(ownerB, 'brief_chat_send', b);
    await until(() => f.inputs.size === 2);
    f.push(a.turnId, { type: 'text', text: 'Only A' });
    f.push(b.turnId, { type: 'text', text: 'Only B' });
    f.push(a.turnId, { type: 'tool_call', tool_call: { id: 'tool-a', name: 'fixture', arguments: { secret: 'private-argument' } } });
    await until(() => f.events(mirrorA).some(event => event.payload.kind === 'activity'));
    const aCount = f.frames.get(ownerA)!.length;
    await f.send(ownerA, 'brief_chat_unsubscribe', { conversationId: a.conversationId });
    await f.send(ownerA, 'brief_chat_subscribe', { conversationId: b.conversationId });
    await f.send(ownerA, 'brief_chat_cancel', identity(a));
    expect(f.inputs.get(a.turnId)!.signal.aborted).toBe(true);
    expect(f.inputs.get(b.turnId)!.signal.aborted).toBe(false);
    f.push(b.turnId, { type: 'text', text: ' finishes.' }); f.push(b.turnId, done());
    await f.transport.idle();
    expect(f.events(ownerB).every(event => event.conversationId === b.conversationId)).toBe(true);
    expect(f.events(mirrorA).every(event => event.conversationId === a.conversationId)).toBe(true);
    expect(f.events(mirrorA).filter(event => event.payload.kind === 'terminal').map(event => event.payload)).toEqual([{ kind: 'terminal', state: 'cancelled' }]);
    expect(f.frames.get(ownerA)!.slice(aCount).filter(frame => frame.type === 'brief_chat_event').every(frame => (frame.payload as BriefChatEvent).conversationId === b.conversationId)).toBe(true);
    expect(f.frames.get(legacy)).toEqual([]);
    expect(spoken).toEqual(['Only B finishes.']);
    const audio = f.frames.get(ownerB)!.filter(frame => frame.type === 'brief_chat_audio');
    expect(audio).toHaveLength(3);
    expect(audio.every(frame => (frame.payload as any).turnId === b.turnId)).toBe(true);
    expect(f.frames.get(ownerA)!.some(frame => frame.type === 'brief_chat_audio')).toBe(false);
    expect(JSON.stringify([...f.frames.values()])).not.toContain('private-argument');
    expect(f.transport.repository.conversations.messages(a.conversationId).items.map(message => message.content)).toEqual(['Question A', 'Only A']);
    expect(f.transport.repository.conversations.messages(b.conversationId).items.map(message => message.content)).toEqual(['Question B', 'Only B finishes.']);
    expect(f.inputs.get(a.turnId)!.history).toEqual([]); expect(f.inputs.get(b.turnId)!.history).toEqual([]);
    expect(f.inputs.get(a.turnId)!.contextKey).not.toBe(f.inputs.get(b.turnId)!.contextKey);
  } finally { f.transport.stop(); await f.transport.idle(); }
});

test('duplicates, reconnect and stale cancel reconcile the original terminal without another generation', async () => {
  const f = fixture(); const a = f.input('A'); const original = f.client();
  try {
    await f.send(original, 'brief_chat_send', a);
    await f.send(original, 'brief_chat_send', a);
    await until(() => f.inputs.has(a.turnId));
    f.push(a.turnId, { type: 'text', text: 'Before disconnect' });
    await until(() => f.events(original).some(event => event.payload.kind === 'delta'));
    const cursor = f.events(original).at(-1)!.sequence;
    f.transport.detach(original);
    f.push(a.turnId, { type: 'text', text: ' after reconnect' }); f.push(a.turnId, done());
    await f.transport.idle();
    const returning = f.client();
    await f.send(returning, 'brief_chat_subscribe', { conversationId: a.conversationId, afterSequence: cursor });
    const sync = f.frames.get(returning)!.at(-1)!.payload as any;
    expect(sync.events.map((event: BriefChatEvent) => event.payload.kind)).toEqual(['delta', 'terminal']);
    expect(sync.messages.items.map((message: any) => message.content)).toEqual(['Question A', 'Before disconnect after reconnect']);
    await f.send(returning, 'brief_chat_send', a);
    expect(f.frames.get(returning)!.at(-1)!.payload).toMatchObject({ duplicate: true, state: 'completed' });
    expect(f.inputs.size).toBe(1);
    const next = { ...a, turnId: 'next-turn', requestId: 'next-request', text: 'Next' };
    await f.send(returning, 'brief_chat_send', next);
    await until(() => f.inputs.has(next.turnId));
    await f.send(returning, 'brief_chat_cancel', identity(a));
    expect(f.inputs.get(next.turnId)!.signal.aborted).toBe(false);
    expect(f.inputs.get(next.turnId)!.history).toEqual([{ role: 'user', content: 'Question A' }, { role: 'assistant', content: 'Before disconnect after reconnect' }]);
    await f.send(returning, 'brief_chat_cancel', identity(next));
    await f.transport.idle();
    expect(f.transport.repository.snapshot(a.conversationId, 0).events.filter(event => event.turnId === a.turnId && event.payload.kind === 'terminal')).toHaveLength(1);
  } finally { f.transport.stop(); await f.transport.idle(); }
});

test('production limiter queues another conversation and a cancelled queued turn never calls the model', async () => {
  const f = fixture(); const client = f.client(); const a = f.input('A'), b = f.input('B');
  try {
    await f.send(client, 'brief_chat_send', a); await f.send(client, 'brief_chat_send', b);
    expect(f.inputs.size).toBe(1);
    expect(f.transport.repository.get(b).state).toBe('queued');
    await f.send(client, 'brief_chat_cancel', identity(b));
    f.push(a.turnId, done()); await f.transport.idle();
    expect(f.inputs.size).toBe(1);
    expect(f.transport.repository.get(b).state).toBe('cancelled');
  } finally { f.transport.stop(); await f.transport.idle(); }
});

test('disabled transport, malformed frames and unavailable cursors never create turns', async () => {
  const off = fixture({ enabled: false }); const client = off.client(); const input = off.input('off');
  await off.send(client, 'brief_chat_send', input);
  expect(off.frames.get(client)!.at(-1)!.payload).toMatchObject({ ...identity(input), code: 'unavailable' });
  expect(off.transport.repository.pending()).toEqual([]);
  off.transport.stop(); closeDb();
  const f = fixture(); const socket = f.client(); const a = f.input('A');
  try {
    for (const payload of [null, [], { ...a, text: '' }, { ...a, workspaceId: 'other' }, { ...a, turnId: '../bad' }, { ...a, text: 'x'.repeat(65_537) }]) {
      await f.send(socket, 'brief_chat_send', payload);
      expect(f.frames.get(socket)!.at(-1)?.type).toBe('brief_chat_error');
    }
    await f.send(socket, 'brief_chat_subscribe', { conversationId: a.conversationId, afterSequence: 1 });
    expect(f.frames.get(socket)!.at(-1)?.type).toBe('brief_chat_error');
    expect(f.transport.repository.pending()).toEqual([]); expect(f.inputs.size).toBe(0);
    expect(currentBriefTurn()).toBeUndefined();
  } finally { f.transport.stop(); await f.transport.idle(); }
});

test('cancel ends audio immediately and suppresses a delayed provider chunk and duplicate terminal', async () => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const options = { tts: { async synthesize() { return Buffer.from(''); }, async *synthesizeStream() {
    yield Buffer.from('first'); await delayed; yield Buffer.from('late');
  } } as TTSProvider | undefined };
  const f = fixture(options); const owner = f.client(), mirror = f.client(); const a = f.input('audio', true);
  try {
    await f.send(mirror, 'brief_chat_subscribe', { conversationId: a.conversationId });
    await f.send(owner, 'brief_chat_send', a);
    f.push(a.turnId, { type: 'text', text: 'A spoken answer' }); f.push(a.turnId, done());
    await until(() => f.frames.get(owner)!.some(frame => frame.type === 'brief_chat_audio' && (frame.payload as any).phase === 'chunk'));
    f.runner.ready = () => false;
    await f.send(owner, 'brief_chat_cancel', identity(a));
    const audio = f.frames.get(owner)!.filter(frame => frame.type === 'brief_chat_audio');
    expect(audio.map(frame => (frame.payload as any).phase)).toEqual(['start', 'chunk', 'end']);
    expect(audio.at(-1)!.payload).toMatchObject({ ...identity(a), cancelled: true });
    release(); await f.transport.idle();
    expect(f.frames.get(owner)!.filter(frame => frame.type === 'brief_chat_audio')).toEqual(audio);
    expect(f.frames.get(mirror)!.some(frame => frame.type === 'brief_chat_audio')).toBe(false);
    expect(f.events(owner).filter(event => event.payload.kind === 'terminal')).toHaveLength(1);
    const sequences = f.frames.get(owner)!.filter(frame => ['brief_chat_event', 'brief_chat_audio'].includes(frame.type)).map(frame => (frame.payload as any).sequence as number);
    expect(sequences.every((value, index) => index === 0 || value > sequences[index - 1]!)).toBe(true);
    options.tts = undefined;
    f.runner.ready = () => true;
    await f.send(owner, 'brief_chat_send', a);
    expect(f.frames.get(owner)!.at(-1)!.payload).toMatchObject({ ...identity(a), state: 'cancelled', duplicate: true });
    expect(f.inputs.size).toBe(1);
  } finally { release(); f.transport.stop(); await f.transport.idle(); }
});

test('model errors persist a sanitized failed terminal and preserve partial output for replay', async () => {
  const f = fixture(); const owner = f.client(); const a = f.input('error');
  try {
    await f.send(owner, 'brief_chat_send', a);
    f.push(a.turnId, { type: 'text', text: 'Partial' });
    f.push(a.turnId, { type: 'error', error: 'provider-secret' });
    await f.transport.idle();
    await f.send(owner, 'brief_chat_cancel', identity(a));
    const snapshot = f.transport.repository.snapshot(a.conversationId, 0);
    expect(snapshot.events.filter(event => event.payload.kind === 'terminal').map(event => event.payload)).toEqual([
      { kind: 'terminal', state: 'failed', error: { code: 'generation_failed', message: 'This response could not finish. You can send a new message to try again.' } },
    ]);
    expect(snapshot.messages.items.at(-1)?.content).toBe('Partial');
    expect(JSON.stringify([...f.frames.values()])).not.toContain('provider-secret');
  } finally { f.transport.stop(); await f.transport.idle(); }
});

test('subscription admission cannot orphan a queued turn and queue admission cannot append messages', async () => {
  const f = fixture(); const owner = f.client();
  try {
    for (let i = 0; i < 50; i++) {
      const input = f.input(`subscription-${i}`);
      await f.send(owner, 'brief_chat_subscribe', { conversationId: input.conversationId });
      f.conversations.repository.setOpen(input.conversationId, false);
    }
    const refused = f.input('refused');
    await f.send(owner, 'brief_chat_send', refused);
    expect(f.frames.get(owner)!.at(-1)!.payload).toMatchObject({ ...identity(refused), code: '409' });
    expect(f.transport.repository.pending()).toEqual([]);
    expect(f.conversations.repository.messages(refused.conversationId).items).toEqual([]);
    const other = f.client();
    for (let i = 0; i < 32; i++) await f.send(other, 'brief_chat_send', f.input(`queue-${i}`));
    const overflow = f.input('overflow');
    await f.send(other, 'brief_chat_send', overflow);
    expect(f.frames.get(other)!.at(-1)!.payload).toMatchObject({ ...identity(overflow), code: '409', message: 'Chat queue is full' });
    expect(f.transport.repository.pending()).toHaveLength(32);
    expect(f.conversations.repository.messages(overflow.conversationId).items).toEqual([]);
  } finally { f.transport.stop(); await f.transport.idle(); }
});

test('resubscribing during speech never resumes a truncated audio stream', async () => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const tts: TTSProvider = { async synthesize() { return Buffer.from(''); }, async *synthesizeStream() {
    yield Buffer.from('header'); await delayed; yield Buffer.from('tail');
  } };
  const f = fixture({ tts }); const owner = f.client(); const a = f.input('audio-switch', true);
  try {
    await f.send(owner, 'brief_chat_send', a);
    f.push(a.turnId, { type: 'text', text: 'Spoken answer' }); f.push(a.turnId, done());
    await until(() => f.frames.get(owner)!.some(frame => frame.type === 'brief_chat_audio' && (frame.payload as any).phase === 'chunk'));
    await f.send(owner, 'brief_chat_unsubscribe', { conversationId: a.conversationId });
    const audio = f.frames.get(owner)!.filter(frame => frame.type === 'brief_chat_audio');
    expect(audio.map(frame => (frame.payload as any).phase)).toEqual(['start', 'chunk', 'end']);
    expect(audio.at(-1)!.payload).toMatchObject({ cancelled: true });
    await f.send(owner, 'brief_chat_subscribe', { conversationId: a.conversationId });
    release(); await f.transport.idle();
    expect(f.frames.get(owner)!.filter(frame => frame.type === 'brief_chat_audio')).toEqual(audio);
    expect(f.transport.repository.get(a).state).toBe('completed');
  } finally { release(); f.transport.stop(); await f.transport.idle(); }
});

test('leaving before speech starts prevents audio after returning to the conversation', async () => {
  let syntheses = 0;
  const tts: TTSProvider = { async synthesize() { return Buffer.from(''); }, async *synthesizeStream() {
    syntheses++; yield Buffer.from('audio');
  } };
  const f = fixture({ tts }); const owner = f.client(); const a = f.input('before-audio', true);
  try {
    await f.send(owner, 'brief_chat_send', a);
    await f.send(owner, 'brief_chat_unsubscribe', { conversationId: a.conversationId });
    await f.send(owner, 'brief_chat_subscribe', { conversationId: a.conversationId });
    f.push(a.turnId, { type: 'text', text: 'Answer' }); f.push(a.turnId, done());
    await f.transport.idle();
    expect(syntheses).toBe(0);
    expect(f.frames.get(owner)!.some(frame => frame.type === 'brief_chat_audio')).toBe(false);
    expect(f.transport.repository.get(a).state).toBe('completed');
  } finally { f.transport.stop(); await f.transport.idle(); }
});

test('repeated queued cancellation releases retained jobs before the active turn ends', async () => {
  const f = fixture(); const owner = f.client(); const a = f.input('active'), b = f.input('waiting');
  try {
    await f.send(owner, 'brief_chat_send', a);
    for (let i = 0; i < 64; i++) {
      const queued = { ...b, turnId: `queued-${i}`, requestId: `queued-request-${i}`, text: 'x'.repeat(65_536) };
      await f.send(owner, 'brief_chat_send', queued);
      await f.send(owner, 'brief_chat_cancel', identity(queued));
    }
    // Inspect retained work, not just DB state: terminal rows no longer count
    // toward admission, but must not leave closures and input in the limiter.
    await Bun.sleep(0);
    const retained = f.transport as unknown as { jobs: Set<unknown>; controllers: Map<string, unknown> };
    expect(retained.jobs.size).toBe(1);
    expect(retained.controllers.size).toBe(1);
    expect(f.transport.repository.pending()).toHaveLength(1);
    expect(f.inputs.size).toBe(1);
    const next = { ...b, turnId: 'surviving-turn', requestId: 'surviving-request' };
    await f.send(owner, 'brief_chat_send', next);
    f.push(a.turnId, done());
    await until(() => f.inputs.has(next.turnId));
    f.push(next.turnId, done()); await f.transport.idle();
    expect(f.inputs.size).toBe(2);
  } finally { f.transport.stop(); await f.transport.idle(); }
});
