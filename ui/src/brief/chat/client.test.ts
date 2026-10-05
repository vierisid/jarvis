import { afterEach, expect, test } from 'bun:test';
import { initDatabase, getDb, closeDb } from '../../../../src/vault/schema';
import { ConversationRepository } from '../../../../src/vault/conversation-lifecycle';
import { ChatTurnRepository } from '../../../../src/vault/chat-turns';
import { BriefCapabilities } from '../../../../src/brief/capabilities';
import type { BriefChatEvent, BriefSendTurn } from '../../../../src/brief/contracts';
import type { WSMessage } from '../../hooks/useWebSocket';
import { BriefConversationClient } from './client';
import { ChatApiError, type ConversationApi } from './api';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); closeDb(); });
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture timed out'); await Bun.sleep(1); }
}
function fixture(storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  initDatabase(':memory:', { quiet: true });
  const repository = new ConversationRepository(getDb());
  const turns = new ChatTurnRepository(getDb());
  const enabled = ['conversations', 'chatTransport', 'chatState'] as const;
  const capabilities = new BriefCapabilities(enabled.map(id => ({ id, provider: { readiness: () => 'ready' } })), enabled).snapshot();
  const api: ConversationApi = {
    capabilities: async () => capabilities, tabs: async () => repository.tabs(),
    create: async () => repository.create(), tab: async (id, open) => repository.setOpen(id, open),
    select: async id => repository.activate(id), history: async (id, cursor) => repository.messages(id, { cursor: cursor ?? undefined, limit: 50 }),
  };
  const client = new BriefConversationClient(api, storage); cleanups.push(() => client.stop());
  const sent: WSMessage[] = [];
  const socket = { readyState: 1, send: (data: string) => { sent.push(JSON.parse(data)); } } as WebSocket;
  const receive = (type: string, payload: unknown, id?: string) => client.adapter.onMessage({ type, payload, id, timestamp: 10 });
  const sync = (conversationId: string) => {
    const request = sent.findLast(frame => frame.type === 'brief_chat_subscribe' && frame.payload.conversationId === conversationId)!;
    const snapshot = turns.snapshot(conversationId, request.payload.afterSequence);
    receive('brief_chat_sync', { ...snapshot, subscribed: !snapshot.hasMore }, request.id);
    return snapshot;
  };
  const open = async () => { client.adapter.onOpen(socket); await until(() => client.getSnapshot().connected); for (const id of client.store.getSnapshot().order) sync(id); };
  const emit = (event: BriefChatEvent | null) => { if (event) receive('brief_chat_event', event); };
  return { client, api, repository, turns, sent, socket, receive, sync, open, emit };
}
function answer(f: ReturnType<typeof fixture>, id: string, name: string) {
  const input = { conversationId: id, turnId: `turn-${name}`, requestId: `request-${name}`, text: `Question ${name}`, speak: false };
  const accepted = f.turns.accept(input); accepted.events.forEach(f.emit);
  f.emit(f.turns.start(input)); f.emit(f.turns.text(input, `Answer ${name}`)); f.emit(f.turns.finish(input, 'completed'));
}

test('ten add/close cycles preserve all surviving drafts/history, select neighbors, and reopen closed history', async () => {
  const f = fixture(); await f.client.start(); await f.open();
  const survivors = new Map<string, string>();
  for (let cycle = 0; cycle < 10; cycle++) {
    const left = await f.client.add(), middle = await f.client.add(), right = await f.client.add();
    for (const [position, id] of [left, middle, right].entries()) {
      f.sync(id); const name = `${cycle}-${position}`; answer(f, id, name);
      f.client.store.setDraft(id, `Draft ${name}`); survivors.set(id, name);
    }
    await f.client.select(middle); await f.client.close(middle);
    expect(f.client.store.getSnapshot().activeId).toBe(right);
    expect(f.repository.tabs().activeConversationId).toBe(right);
    expect(f.repository.messages(middle).items.map(m => m.content)).toEqual([`Question ${cycle}-1`, `Answer ${cycle}-1`]);
    survivors.delete(middle);
    for (const [id, name] of survivors) {
      expect(f.client.store.getSnapshot().conversations[id]?.draft).toBe(`Draft ${name}`);
      expect(f.client.store.getSnapshot().conversations[id]?.messages.map(m => m.content)).toEqual([`Question ${name}`, `Answer ${name}`]);
    }
    await f.client.reopen(middle); f.sync(middle);
    expect(f.client.store.getSnapshot().conversations[middle]?.draft).toBe(`Draft ${cycle}-1`);
    await f.client.close(middle);
  }
  for (const id of [...f.client.store.getSnapshot().order]) await f.client.close(id);
  expect(f.client.store.getSnapshot().activeId).toBeNull(); expect(f.repository.tabs().activeConversationId).toBeNull();
  expect(f.client.store.getSnapshot().order).toEqual([]);
  expect(f.repository.list({ limit: 100 }).items).toHaveLength(30);
  expect(f.sent.some(frame => frame.type === 'brief_chat_cancel')).toBe(false);
});

test('rapid mutations are serialized, active-last close selects left, and inactive close retains selection', async () => {
  const f = fixture(); await f.client.start();
  const [a, b, c] = await Promise.all([f.client.add(), f.client.add(), f.client.add()]);
  await Promise.all([f.client.select(c), f.client.close(c), f.client.close(a)]);
  expect(f.client.store.getSnapshot().activeId).toBe(b);
  expect(f.repository.tabs().tabs.map(tab => tab.conversationId)).toEqual([b]);
  expect(f.client.getSnapshot().pending).toBe(0);
});

test('delayed history and old lifecycle responses cannot overwrite a selected chat or a restarted workspace', async () => {
  const f = fixture(); await f.client.start(); const a = await f.client.add(), b = await f.client.add();
  let resolve!: (page: Awaited<ReturnType<ConversationApi['history']>>) => void;
  f.api.history = () => new Promise(r => { resolve = r; });
  const loading = f.client.loadOlder(a); await f.client.select(b); f.client.store.setDraft(b, 'B survives');
  resolve({ items: [{ id: 'old', conversation_id: a, role: 'assistant', content: 'A history', created_at: 1, tool_calls: null }], nextCursor: null });
  await loading;
  expect(f.client.store.getSnapshot().activeId).toBe(b);
  expect(f.client.store.getSnapshot().conversations[b]?.messages).toEqual([]);
  expect(f.client.store.getSnapshot().conversations[b]?.draft).toBe('B survives');
  expect(f.client.store.getSnapshot().conversations[a]?.messages[0]?.content).toBe('A history');
  const c = await f.client.add(); const stale = f.client.loadOlder(c); f.client.stop();
  resolve({ items: [{ id: 'stale', conversation_id: c, role: 'assistant', content: 'Stale', created_at: 1, tool_calls: null }], nextCursor: null });
  await stale; expect(f.client.store.getSnapshot().conversations[c]?.messages).toEqual([]);
});

test('reconnect pages all replay events without duplicating snapshot output, preserving drafts and unread', async () => {
  const f = fixture(); await f.client.start(); const a = await f.client.add();
  const input = { conversationId: a, turnId: 'long-turn', requestId: 'long-request', text: 'Long question' };
  f.turns.accept(input); f.turns.start(input);
  for (let i = 0; i < 510; i++) f.turns.text(input, 'x');
  f.turns.finish(input, 'completed'); f.client.store.setDraft(a, 'Next question');
  f.client.adapter.onOpen(f.socket); await until(() => f.client.getSnapshot().connected);
  const first = f.sync(a); expect(first.hasMore).toBe(true);
  const firstRequest = f.sent.find(frame => frame.type === 'brief_chat_subscribe')!;
  // Duplicate old page is ignored after the continuation has acquired its new request ID.
  f.receive('brief_chat_sync', { ...first, subscribed: false }, firstRequest.id);
  const second = f.sync(a); expect(second.hasMore).toBe(false);
  expect(f.client.store.getSnapshot().conversations[a]?.messages.at(-1)?.content).toBe('x'.repeat(510));
  expect(f.client.store.getSnapshot().conversations[a]?.draft).toBe('Next question');
  expect(f.client.store.getSnapshot().conversations[a]?.unread).toHaveLength(1);
  f.client.adapter.onClose(); await f.open();
  expect(f.client.store.getSnapshot().conversations[a]?.messages).toHaveLength(2);
  expect(f.client.store.getSnapshot().conversations[a]?.unread).toHaveLength(1);
});

test('uncertain sends retry the same identity, accepted sends clear only their unchanged draft, and cancel is scoped', async () => {
  const f = fixture(); await f.client.start(); const a = await f.client.add(); await f.open();
  f.client.store.setDraft(a, 'Question'); const ref = f.client.send(a, 'Question');
  const original = f.sent.find(frame => frame.type === 'brief_chat_send')!.payload as BriefSendTurn;
  expect(() => f.client.send(a, 'Second')).toThrow('active turn');
  f.client.adapter.onClose(); await f.open();
  const sends = f.sent.filter(frame => frame.type === 'brief_chat_send');
  expect(sends).toHaveLength(2); expect(sends[1]?.payload).toEqual(original);
  f.client.store.setDraft(a, 'Already editing another question');
  const accepted = f.turns.accept(original); accepted.events.forEach(f.emit);
  expect(f.client.store.getSnapshot().conversations[a]?.draft).toBe('Already editing another question');
  const b = await f.client.add(); f.sync(b);
  f.client.cancel(ref);
  expect(f.sent.at(-1)).toMatchObject({ type: 'brief_chat_cancel', payload: ref });
  expect(f.client.store.getSnapshot().activeId).toBe(b);
  f.client.store.setDraft(b, 'Clear this'); const refB = f.client.send(b, 'Clear this');
  f.turns.accept({ ...refB, text: 'Clear this' }).events.forEach(f.emit);
  expect(f.client.store.getSnapshot().conversations[b]?.draft).toBe('');
});

test('rejected sends retain draft and attachments never silently become a text-only submission', async () => {
  const f = fixture(); await f.client.start(); const a = await f.client.add(); await f.open();
  f.client.store.setAttachments(a, [{ attachmentId: 'pending', name: 'notes.txt', mediaType: 'text/plain', size: 3 }]);
  expect(() => f.client.send(a, 'Question')).toThrow('Attachment');
  f.client.store.setAttachments(a, []); f.client.store.setDraft(a, 'Question');
  const ref = f.client.send(a, 'Question'); f.receive('brief_chat_error', { ...ref, code: 'unavailable', message: 'Unavailable' });
  expect(f.client.store.getSnapshot().conversations[a]?.draft).toBe('Question');
  expect(f.client.store.getSnapshot().conversations[a]?.error).toBe('Unavailable');
  expect(f.client.getSnapshot().pendingSends).toEqual([]);
  const b = await f.client.add();
  f.receive('brief_chat_error', { ...ref, message: 'Late A failure' });
  expect(f.client.store.getSnapshot().activeId).toBe(b);
  expect(f.client.store.getSnapshot().conversations[b]?.error).toBeNull();
});

test('old/malformed/disabled capabilities fall back to single chat, while authentication/network failures stay unavailable', async () => {
  const f = fixture(); let calls = 0;
  f.api.tabs = async () => { calls++; throw new Error('Must not read tabs'); };
  for (const value of [undefined, {}, { contractVersion: 2 }, new BriefCapabilities().snapshot()]) {
    f.api.capabilities = async () => value; await f.client.start(); expect(f.client.getSnapshot().mode).toBe('legacy');
  }
  for (const status of [404, 501, 401, 503]) {
    f.api.capabilities = async () => { throw new ChatApiError(status); }; await f.client.start();
    expect(f.client.getSnapshot().mode).toBe(status === 404 || status === 501 ? 'legacy' : 'unavailable');
  }
  f.api.capabilities = async () => { throw new Error('Offline'); }; await f.client.start();
  expect(f.client.getSnapshot().mode).toBe('unavailable'); expect(calls).toBe(0);
  await expect(f.client.add()).rejects.toThrow('not available');
});

test('a failed close reconciles metadata and preserves the draft and history with a visible error', async () => {
  const f = fixture(); await f.client.start(); const a = await f.client.add(), b = await f.client.add();
  answer(f, b, 'b'); f.client.store.setDraft(b, 'Keep me');
  f.api.tab = async () => { throw new ChatApiError(503); };
  await expect(f.client.close(b)).rejects.toThrow('503');
  expect(f.client.store.getSnapshot().order).toEqual([a, b]);
  expect(f.client.store.getSnapshot().conversations[b]?.draft).toBe('Keep me');
  expect(f.client.store.getSnapshot().conversations[b]?.messages.at(-1)?.content).toBe('Answer b');
  expect(f.client.getSnapshot().error).toContain('503');
});

test('a stale tab fetch on reconnect completes before a newer selection is applied', async () => {
  const f = fixture(); await f.client.start(); const a = await f.client.add(), b = await f.client.add();
  const oldTabs = f.repository.tabs();
  let release!: (tabs: typeof oldTabs) => void;
  f.api.tabs = () => new Promise(resolve => { release = resolve; });
  f.client.adapter.onOpen(f.socket); await until(() => !!release);
  const selecting = f.client.select(a); release(oldTabs); await selecting;
  expect(f.client.store.getSnapshot().activeId).toBe(a); expect(f.repository.tabs().activeConversationId).toBe(a);
  expect(f.client.store.getSnapshot().order).toEqual([a, b]);
});

test('tab reconciliation subscribes newly discovered chats and unsubscribes remotely closed ones', async () => {
  const f = fixture(); await f.client.start(); const a = await f.client.add(); await f.open();
  const b = f.repository.create().conversationId;
  await f.client.select(b);
  expect(f.sent.at(-1)).toMatchObject({ type: 'brief_chat_subscribe', payload: { conversationId: b } }); f.sync(b);
  f.repository.setOpen(a, false); await f.client.select(b);
  expect(f.sent.at(-1)).toMatchObject({ type: 'brief_chat_unsubscribe', payload: { conversationId: a } });
});

test('malformed and delayed sync pages cannot overwrite state or continue an invalid cursor', async () => {
  const f = fixture(); await f.client.start(); const a = await f.client.add();
  f.client.adapter.onOpen(f.socket); await until(() => f.client.getSnapshot().connected);
  const request = f.sent.at(-1)!; const snapshot = f.turns.snapshot(a, 0);
  f.receive('brief_chat_sync', { ...snapshot, hasMore: true, subscribed: false, nextSequence: 0 }, request.id);
  expect(f.client.store.getSnapshot().conversations[a]?.error).toContain('Invalid');
  expect(f.sent).toHaveLength(1);
  await f.client.close(a);
  f.receive('brief_chat_sync', { ...snapshot, subscribed: true }, request.id);
  expect(f.client.store.getSnapshot().activeId).toBeNull();
  expect(f.client.store.getSnapshot().order).toEqual([]);
});

test('reconnect fills missed history beyond the snapshot tail across replay pages', async () => {
  const f = fixture(); await f.client.start(); const a = await f.client.add(); await f.open();
  answer(f, a, 'before');
  await f.client.loadOlder(a);
  expect(f.client.store.getSnapshot().conversations[a]?.history.cursor).toBeNull();
  f.client.adapter.onClose();
  // The first missed answer spans replay pages and is outside the latest ten messages.
  for (let i = 0; i < 6; i++) {
    const input = { conversationId: a, turnId: `offline-${i}`, requestId: `offline-request-${i}`, text: `Offline ${i}` };
    f.turns.accept(input); f.turns.start(input);
    for (let chunk = 0; chunk < (i === 0 ? 510 : 1); chunk++) f.turns.text(input, 'x');
    f.turns.finish(input, 'completed');
  }
  f.client.adapter.onOpen(f.socket); await until(() => f.client.getSnapshot().connected);
  let page = f.sync(a);
  expect(page.hasMore).toBe(true);
  while (page.hasMore) page = f.sync(a);
  const expected = f.repository.messages(a, { limit: 100 }).items;
  // Older delta events do not carry timestamps, so compare canonical identities,
  // order, roles and complete text. Snapshot/history rows keep their exact dates.
  const transcript = (rows: typeof expected) => rows.map(({ id, role, content }) => ({ id, role, content }));
  expect(transcript(f.client.store.getSnapshot().conversations[a]!.messages)).toEqual(transcript(expected));
  expect(f.client.store.getSnapshot().conversations[a]?.history.cursor).toBeNull();
  await f.client.loadOlder(a);
  f.client.adapter.onClose(); await f.open();
  expect(transcript(f.client.store.getSnapshot().conversations[a]!.messages)).toEqual(transcript(expected));
});

test('replay completes an old cached running turn outside the latest fifty turns', async () => {
  const f = fixture(); await f.client.start(); const a = await f.client.add(); await f.open();
  const first = f.client.send(a, 'Before disconnect');
  f.turns.accept({ ...first, text: 'Before disconnect' }).events.forEach(f.emit);
  f.emit(f.turns.start(first)); f.client.adapter.onClose();
  f.turns.text(first, 'Finished offline'); f.turns.finish(first, 'completed');
  for (let i = 0; i < 51; i++) {
    const input = { conversationId: a, turnId: `later-${i}`, requestId: `later-request-${i}`, text: 'Later' };
    f.turns.accept(input); f.turns.start(input); f.turns.text(input, 'Done'); f.turns.finish(input, 'completed');
  }
  await f.open();
  expect(f.client.store.getSnapshot().conversations[a]?.turns[first.turnId]?.state).toBe('completed');
  expect(() => f.client.send(a, 'Can continue')).not.toThrow();
});

test('failed turn details survive live delivery, reconnect and a daemon restart', async () => {
  const f = fixture(); await f.client.start(); const a = await f.client.add(); await f.open();
  const ref = f.client.send(a, 'Fail after partial output');
  f.turns.accept({ ...ref, text: 'Fail after partial output' }).events.forEach(f.emit);
  f.emit(f.turns.start(ref)); f.emit(f.turns.text(ref, 'Partial'));
  const failure = { code: 'generation_failed', message: 'This response could not finish.' };
  f.emit(f.turns.finish(ref, 'failed', failure));
  expect(f.client.store.getSnapshot().conversations[a]?.turns[ref.turnId]).toMatchObject({ state: 'failed', error: failure });
  expect(f.client.store.getSnapshot().conversations[a]?.error).toBe(failure.message);
  f.client.adapter.onClose(); await f.open();
  expect(f.client.store.getSnapshot().conversations[a]?.error).toBe(failure.message);
  const interrupted = f.client.send(a, 'Restart');
  f.turns.accept({ ...interrupted, text: 'Restart' }).events.forEach(f.emit);
  f.emit(f.turns.start(interrupted));
  expect(f.client.store.getSnapshot().conversations[a]?.error).toBeNull();
  f.client.adapter.onClose(); f.turns.recover(); await f.open();
  expect(f.client.store.getSnapshot().conversations[a]?.turns[interrupted.turnId]).toMatchObject({ state: 'failed', error: { code: 'interrupted' } });
  expect(f.client.store.getSnapshot().conversations[a]?.error).toContain('restarted');
  expect(f.client.store.getSnapshot().conversations[a]?.messages.some(m => m.content === 'Partial')).toBe(true);
  // Fresh client must reconstruct the errors too, including those only in replay events.
  await f.client.start(); await f.open();
  const reloaded = new BriefConversationClient(f.api); cleanups.push(() => reloaded.stop()); await reloaded.start();
  reloaded.adapter.onOpen(f.socket); await until(() => reloaded.getSnapshot().connected);
  const request = f.sent.at(-1)!;
  reloaded.adapter.onMessage({ type: 'brief_chat_sync', id: request.id, timestamp: 10, payload: { ...f.turns.snapshot(a, 0), subscribed: true } });
  expect(reloaded.store.getSnapshot().conversations[a]?.turns[ref.turnId]).toMatchObject({ error: failure });
  expect(reloaded.store.getSnapshot().conversations[a]?.error).toContain('restarted');
});

test('history loaded before subscription is not appended again by older replay pages', async () => {
  const f = fixture(); await f.client.start(); const a = await f.client.add();
  for (let i = 0; i < 8; i++) {
    const input = { conversationId: a, turnId: `history-${i}`, requestId: `history-request-${i}`, text: `Question ${i}` };
    f.turns.accept(input); f.turns.start(input); f.turns.text(input, `Answer ${i}`); f.turns.finish(input, 'completed');
  }
  await f.client.loadOlder(a);
  await f.open();
  expect(f.client.store.getSnapshot().conversations[a]?.messages).toEqual(f.repository.messages(a, { limit: 50 }).items);
});

test('acceptance in a stale window preserves a newer draft saved by another window', async () => {
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  const f = fixture(storage); await f.client.start(); const a = await f.client.add(); await f.open();
  f.client.store.setDraft(a, 'Send this');
  const second = new BriefConversationClient(f.api, storage); cleanups.push(() => second.stop()); await second.start();
  const input = f.client.send(a, 'Send this');
  second.store.setDraft(a, 'New question in the other window');
  f.turns.accept({ ...input, text: 'Send this' }).events.forEach(f.emit);
  expect(f.client.store.getSnapshot().conversations[a]?.draft).toBe('New question in the other window');
  const reloaded = new BriefConversationClient(f.api, storage); cleanups.push(() => reloaded.stop()); await reloaded.start();
  expect(reloaded.store.getSnapshot().conversations[a]?.draft).toBe('New question in the other window');
});
