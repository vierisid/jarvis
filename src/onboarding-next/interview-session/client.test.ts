import { expect, test } from 'bun:test';
import { createInterviewClient } from './client.ts';
import { createInterviewSocketTransport, createInterviewTransportHandler } from './transport.ts';
import type { Command, Result, Snapshot } from './types.ts';

const initial = (): Snapshot => ({ schemaVersion: 1, sessionId: 'session', turnId: 'turn-1', cursor: 1, phase: 'ready',
  messages: [{ id: 'opening:assistant', role: 'assistant', text: 'What are you working on?' }], confirmedFactIds: [], pendingAnswer: null });
function storage() { const values = new Map<string, string>(); return { getItem: (k: string) => values.get(k) ?? null,
  setItem: (k: string, v: string) => { values.set(k, v); } }; }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const ok = (snapshot: Snapshot): Result => ({ kind: 'ok', snapshot });

test('refresh after lost acknowledgement retains immutable answer and a newer draft', async () => {
  const local = storage(), commands: Command[] = [];
  const send = async (c: Command): Promise<Result> => { commands.push(c); if (c.type === 'answer') throw new Error('closed'); return ok(initial()); };
  let client = createInterviewClient({ storage: local, storageKey: 'actor/project/tab', send });
  await client.connect(); client.setDraft('original answer'); await client.submit();
  const answer = client.state().pendingAnswer!; client.setDraft('new draft'); client.dispose();
  client = createInterviewClient({ storage: local, storageKey: 'actor/project/tab', send });
  await client.connect(); await client.retry();
  expect(commands.filter(c => c.type === 'answer')).toEqual([{ type: 'answer', ...answer }, { type: 'answer', ...answer }]);
  expect(client.state().draft.text).toBe('new draft');
});
test('reconnect reconciles an accepted answer without replay or clearing a newer draft', async () => {
  const local = storage(); let server = initial();
  const send = async (c: Command): Promise<Result> => {
    if (c.type === 'answer') {
      server = { ...server, cursor: 4, turnId: 'turn-2', messages: [...server.messages,
        { id: `${c.turnId}:user`, role: 'user', text: c.text, clientRequestId: c.clientRequestId }, { id: `${c.turnId}:assistant`, role: 'assistant', text: 'What repeats?' }] };
      throw new Error('ack lost');
    }
    return ok(server);
  };
  let c = createInterviewClient({ storage: local, storageKey: 'scope/tab', send });
  await c.connect(); c.setDraft('accepted'); await c.submit(); c.setDraft('newer'); c.dispose();
  c = createInterviewClient({ storage: local, storageKey: 'scope/tab', send }); await c.connect();
  expect(c.state().pendingAnswer).toBeNull(); expect(c.state().draft.text).toBe('newer');
  expect(c.state().snapshot?.messages).toHaveLength(3);
});
test('typed draft survives refresh before send and another account cannot read it', async () => {
  const local = storage(), send = async () => ok(initial());
  const c = createInterviewClient({ storage: local, storageKey: 'actor-a/project/tab', send });
  c.setDraft('not yet sent'); c.dispose();
  expect(createInterviewClient({ storage: local, storageKey: 'actor-a/project/tab', send }).state().draft.text).toBe('not yet sent');
  expect(createInterviewClient({ storage: local, storageKey: 'actor-b/project/tab', send }).state().draft.text).toBe('');
});
test('double send is guarded and snapshot revisions reject a late reply after skip', async () => {
  const wait = deferred<Result>(); let answers = 0;
  const c = createInterviewClient({ storage: storage(), storageKey: 'scope/tab', async send(command) {
    if (command.type === 'answer') { answers++; return wait.promise; }
    return ok(command.type === 'skip' ? { ...initial(), cursor: 5, phase: 'skipped' } : initial());
  } });
  await c.connect(); c.setDraft('answer'); const submit = c.submit(); await c.submit(); await c.skip();
  wait.resolve(ok({ ...initial(), cursor: 4, phase: 'ready', messages: [{ id: 'late', role: 'assistant', text: 'late bubble' }] }));
  await submit;
  expect(answers).toBe(1); expect(c.state().snapshot?.phase).toBe('skipped');
  expect(c.state().snapshot?.messages.some(m => m.id === 'late')).toBe(false);
});
test('dispose aborts pending transport and rejects its later snapshot', async () => {
  const wait = deferred<Result>(); let signal: AbortSignal | undefined;
  const c = createInterviewClient({ storage: storage(), storageKey: 'scope/tab', send: async (_c, s) => { signal = s; return wait.promise; } });
  const started = c.connect(); c.dispose(); expect(signal?.aborted).toBe(true); wait.resolve(ok(initial())); await started;
  expect(c.state().snapshot).toBeNull();
});
test('skip during the opening request works before the client knows its session ID', async () => {
  const wait = deferred<Result>(); const commands: Command[] = []; let openingSignal: AbortSignal | undefined;
  const c = createInterviewClient({ storage: storage(), storageKey: 'scope/tab', async send(command, signal) {
    commands.push(command);
    if (command.type === 'start') openingSignal = signal;
    return command.type === 'start' ? wait.promise : ok({ ...initial(), cursor: 3, phase: 'skipped' });
  } });
  const opening = c.connect(); await c.skip();
  const busyAfterSkip = c.state().busy, abortedAfterSkip = openingSignal?.aborted;
  wait.resolve(ok(initial())); await opening;
  expect(commands).toHaveLength(2); expect(c.state().snapshot?.phase).toBe('skipped');
  expect(busyAfterSkip).toBe(false); expect(abortedAfterSkip).toBe(true);
});
test('a late transport failure cannot replace a confirmed terminal state with an error', async () => {
  const wait = deferred<Result>();
  const c = createInterviewClient({ storage: storage(), storageKey: 'scope/tab', async send(command) {
    if (command.type === 'answer') { await wait.promise; throw new Error('old socket closed'); }
    return ok(command.type === 'skip' ? { ...initial(), cursor: 5, phase: 'skipped' } : initial());
  } });
  await c.connect(); c.setDraft('answer'); const pending = c.submit(); await c.skip();
  wait.resolve(ok(initial())); await pending;
  expect(c.state().snapshot?.phase).toBe('skipped'); expect(c.state().error).toBeNull();
});
test('a rejected competing-tab answer is released only after authoritative turn reconciliation', async () => {
  let server = initial();
  const c = createInterviewClient({ storage: storage(), storageKey: 'scope/tab', async send(command) {
    if (command.type === 'answer') {
      server = { ...server, cursor: 4, turnId: 'turn-2', messages: [...server.messages,
        { id: 'turn-1:user', role: 'user', text: 'Other tab answer' }, { id: 'turn-1:assistant', role: 'assistant', text: 'Next question' }] };
      return { kind: 'conflict', reason: 'turn_changed' };
    }
    return ok(server);
  } });
  await c.connect(); c.setDraft('My unsent answer'); await c.submit();
  expect(c.state().pendingAnswer).not.toBeNull();
  await c.refresh();
  expect(c.state().pendingAnswer).toBeNull(); expect(c.state().draft.text).toBe('My unsent answer');
});
test('failed draft persistence prevents transmission and retains existing draft', async () => {
  let fail = false, sent = 0; const local = storage();
  const c = createInterviewClient({ storage: { ...local, setItem(k, v) { if (fail) throw new Error('quota'); local.setItem(k, v); } },
    storageKey: 'scope/tab', async send() { sent++; return ok(initial()); } });
  await c.connect(); c.setDraft('kept'); fail = true;
  await expect(c.submit()).rejects.toThrow('quota'); expect(sent).toBe(1); expect(c.state().draft.text).toBe('kept');
});
test('another tab submitting identical text cannot acknowledge this client request', async () => {
  let server = initial();
  const c = createInterviewClient({ storage: storage(), storageKey: 'scope/tab', async send(command) {
    if (command.type === 'answer') {
      server = { ...server, cursor: 4, turnId: 'turn-2', messages: [...server.messages,
        { id: 'turn-1:user', role: 'user', text: command.text, clientRequestId: 'another-tab-request' }] };
      throw new Error('lost');
    }
    return ok(server);
  } });
  await c.connect(); c.setDraft('same text'); await c.submit(); await c.refresh();
  expect(c.state().pendingAnswer).toBeNull(); expect(c.state().draft.text).toBe('same text');
});
test('corrupt draft storage is preserved and does not trigger provider work', () => {
  const local = storage(); local.setItem('key', '{bad');
  expect(() => createInterviewClient({ storage: local, storageKey: 'key', send: async () => ok(initial()) })).toThrow();
  expect(local.getItem('key')).toBe('{bad');
});

class Socket extends EventTarget {
  readyState = 1;
  sent: { requestId: string; speakReply: boolean; command: Command }[] = [];
  send(v: string) { this.sent.push(JSON.parse(v)); }
  reply(v: unknown) { this.dispatchEvent(new MessageEvent('message', { data: typeof v === 'string' ? v : JSON.stringify(v) })); }
}
test('socket adapter correlates concurrent requests and ignores unrelated text/voice/binary', async () => {
  const socket = new Socket(), send = createInterviewSocketTransport(socket as unknown as WebSocket);
  const start = send({ type: 'start' }), read = send({ type: 'read', sessionId: 'session' });
  expect(socket.sent.every(s => s.speakReply === false)).toBe(true);
  socket.reply({ type: 'interview_assistant', payload: { text: 'old protocol' } });
  socket.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([1, 2]) })); socket.reply('{bad');
  socket.reply({ type: 'interview_session_snapshot', requestId: socket.sent[1]!.requestId, result: ok({ ...initial(), cursor: 2 }) });
  expect((await read).kind).toBe('ok');
  socket.reply({ type: 'interview_session_snapshot', requestId: socket.sent[0]!.requestId, result: ok(initial()) });
  expect((await start).kind).toBe('ok');
});
test('socket close, timeout and abort release listeners and reject pending work', async () => {
  for (const mode of ['close', 'timeout', 'abort']) {
    const socket = new Socket(); let added = 0, removed = 0;
    const add = socket.addEventListener.bind(socket), remove = socket.removeEventListener.bind(socket);
    socket.addEventListener = (...args) => { added++; add(...args); };
    socket.removeEventListener = (...args) => { removed++; remove(...args); };
    const controller = new AbortController(), send = createInterviewSocketTransport(socket as unknown as WebSocket, 10);
    const pending = send({ type: 'start' }, controller.signal);
    if (mode === 'close') socket.dispatchEvent(new Event('close'));
    if (mode === 'abort') controller.abort();
    await expect(pending).rejects.toThrow('interrupted'); expect(removed).toBe(added);
  }
});
test('server transport passes only authenticated context and rejects voice/extra envelope fields', async () => {
  const seen: unknown[] = [], handler = createInterviewTransportHandler({ async request(ctx, c) { seen.push([ctx, c]); return ok(initial()); } });
  const request = { type: 'interview_session_request', requestId: 'transport-1', speakReply: false, command: { type: 'start' } };
  expect((await handler('auth', request))?.requestId).toBe('transport-1'); expect(seen).toEqual([['auth', { type: 'start' }]]);
  expect((await handler('auth', { ...request, speakReply: true }))?.result.kind).toBe('invalid');
  expect((await handler('auth', { ...request, actorId: 'injected' }))?.result.kind).toBe('invalid');
  expect(await handler('auth', { type: 'interview_listen' })).toBeNull(); expect(seen).toHaveLength(1);
});
