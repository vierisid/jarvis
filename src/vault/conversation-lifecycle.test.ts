import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb, getDb } from './schema.ts';
import { addMessage, getOrCreateConversation, getRecentConversation } from './conversations.ts';
import { ConversationRepository } from './conversation-lifecycle.ts';

const directories: string[] = [];
afterEach(() => {
  closeDb();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function memory() { return new ConversationRepository(initDatabase(':memory:', { quiet: true })); }

test('explicit chats retain separate identities, messages and tab state across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-f02-'));
  directories.push(dir);
  const file = join(dir, 'vault.db');
  let repo = new ConversationRepository(initDatabase(file, { quiet: true }));
  const workspaceId = repo.workspaceId;
  const a = repo.create({ title: 'First' });
  const b = repo.create({ title: 'Second' });
  expect(a.conversationId).not.toBe(b.conversationId);
  addMessage(a.conversationId, { role: 'user', content: 'Only first' });
  addMessage(b.conversationId, { role: 'assistant', content: 'Only second' });
  repo.reorder([b.conversationId, a.conversationId]);
  repo.activate(a.conversationId);
  const closed = repo.setOpen(a.conversationId, false);
  expect(closed.tab).toEqual({ open: false, order: 1 });
  expect(repo.tabs().activeConversationId).toBe(b.conversationId);
  closeDb();
  repo = new ConversationRepository(initDatabase(file, { quiet: true }));
  expect(repo.workspaceId).toBe(workspaceId);
  expect(repo.get(a.conversationId).title).toBe('First');
  expect(repo.messages(a.conversationId).items.map(m => m.content)).toEqual(['Only first']);
  expect(repo.messages(b.conversationId).items.map(m => m.content)).toEqual(['Only second']);
  expect(repo.setOpen(a.conversationId, true).tab).toEqual({ open: true, order: 1 });
  expect(repo.tabs().tabs.map(c => c.conversationId)).toEqual([b.conversationId, a.conversationId]);
  expect(repo.tabs().activeConversationId).toBe(b.conversationId);
});

test('unknown and foreign IDs are rejected by every scoped operation without changing state', () => {
  const repo = memory();
  const foreign = new ConversationRepository(getDb(), 'fixture-other-workspace');
  const a = repo.create();
  const other = foreign.create();
  addMessage(other.conversationId, { role: 'user', content: 'Foreign history' });
  const before = repo.tabs();
  for (const id of ['unknown', other.conversationId]) {
    for (const operation of [
      () => repo.get(id), () => repo.messages(id), () => repo.rename(id, 'No'),
      () => repo.setOpen(id, false), () => repo.activate(id), () => repo.reorder([id]),
    ]) expect(operation).toThrow('Conversation not found');
  }
  expect(repo.list().items.map(c => c.conversationId)).toEqual([a.conversationId]);
  expect(repo.tabs()).toEqual(before);
  expect(foreign.messages(other.conversationId).items[0]?.content).toBe('Foreign history');
});

test('closing a tab preserves messages and metadata; reopening restores its place', () => {
  const repo = memory();
  const a = repo.create({ title: 'Keep me' });
  const b = repo.create();
  addMessage(a.conversationId, { role: 'user', content: 'Persist this' });
  const history = repo.messages(a.conversationId);
  repo.setOpen(a.conversationId, false);
  expect(repo.list({ closed: true }).items.map(c => c.conversationId)).toEqual([a.conversationId]);
  expect(repo.messages(a.conversationId)).toEqual(history);
  repo.setOpen(a.conversationId, true);
  expect(repo.get(a.conversationId)).toMatchObject({ title: 'Keep me', tab: { open: true, order: 0 } });
  expect(repo.tabs().tabs.map(c => c.conversationId)).toEqual([a.conversationId, b.conversationId]);
  expect(repo.messages(a.conversationId)).toEqual(history);
});

test('renames persist trimmed titles and reject stale revisions without losing another edit', () => {
  const repo = memory();
  const a = repo.create();
  const renamed = repo.rename(a.conversationId, '  Real title  ', a.revision);
  expect(renamed.title).toBe('Real title');
  expect(renamed.revision).not.toBe(a.revision);
  expect(() => repo.rename(a.conversationId, 'Stale edit', a.revision)).toThrow('Conversation changed');
  for (const title of ['', ' '.repeat(3), 'a'.repeat(161), 'line\nbreak']) {
    expect(() => repo.rename(a.conversationId, title)).toThrow();
  }
  expect(repo.get(a.conversationId).title).toBe('Real title');
});

test('tab ordering keeps closed slots stable and rejects incomplete or duplicate orders atomically', () => {
  const repo = memory();
  const a = repo.create(); const b = repo.create(); const c = repo.create();
  repo.setOpen(b.conversationId, false);
  repo.reorder([c.conversationId, a.conversationId]);
  expect(repo.get(b.conversationId).tab.order).toBe(1);
  expect(() => repo.activate(b.conversationId)).toThrow('Conversation tab is closed');
  const before = repo.tabs();
  expect(() => repo.reorder([a.conversationId])).toThrow();
  expect(() => repo.reorder([a.conversationId, a.conversationId])).toThrow();
  expect(repo.tabs()).toEqual(before);
  repo.setOpen(b.conversationId, true);
  expect(repo.tabs().tabs.map(v => v.conversationId)).toEqual([c.conversationId, b.conversationId, a.conversationId]);
});

test('message cursors traverse equal timestamps exactly once and reject cross-chat or malformed reuse', () => {
  const repo = memory();
  const a = repo.create(); const b = repo.create();
  for (const id of ['m1', 'm4', 'm2', 'm3', 'm5']) {
    getDb().run('INSERT INTO conversation_messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)', [id, a.conversationId, 'user', id, 100]);
  }
  const page1 = repo.messages(a.conversationId, { limit: 2 });
  expect(page1.items.map(m => m.id)).toEqual(['m4', 'm5']);
  const page2 = repo.messages(a.conversationId, { limit: 2, cursor: page1.nextCursor! });
  expect(page2.items.map(m => m.id)).toEqual(['m2', 'm3']);
  const page3 = repo.messages(a.conversationId, { limit: 2, cursor: page2.nextCursor! });
  expect(page3.items.map(m => m.id)).toEqual(['m1']);
  expect(page3.nextCursor).toBeNull();
  expect(() => repo.messages(b.conversationId, { cursor: page1.nextCursor! })).toThrow('Invalid cursor');
  expect(() => repo.messages(a.conversationId, { cursor: 'not-a-cursor' })).toThrow('Invalid cursor');
  expect(() => repo.messages(a.conversationId, { limit: -1 })).toThrow();
});

test('history cursors use a timestamp and ID tie-breaker and are bound to their workspace and filter', () => {
  const repo = memory();
  const records = Array.from({ length: 5 }, () => repo.create());
  getDb().run('UPDATE conversations SET started_at = 10');
  const first = repo.list({ limit: 2 });
  const second = repo.list({ limit: 2, cursor: first.nextCursor! });
  const third = repo.list({ limit: 2, cursor: second.nextCursor! });
  const ids = [...first.items, ...second.items, ...third.items].map(v => v.conversationId);
  expect(ids).toEqual(records.map(v => v.conversationId).sort().reverse());
  expect(new Set(ids).size).toBe(5);
  expect(third.nextCursor).toBeNull();
  expect(() => repo.list({ closed: true, cursor: first.nextCursor! })).toThrow('Invalid cursor');
  expect(() => new ConversationRepository(getDb(), 'foreign').list({ cursor: first.nextCursor! })).toThrow('Invalid cursor');
});

test('legacy channel reuse and history restoration remain separate from explicit Brief chats', () => {
  const repo = memory();
  const legacy = getOrCreateConversation('websocket');
  addMessage(legacy.id, { role: 'user', content: 'Legacy history' });
  const explicit = repo.create({ title: 'Explicit' });
  addMessage(explicit.conversationId, { role: 'user', content: 'Explicit history' });
  expect(getOrCreateConversation('websocket').id).toBe(legacy.id);
  expect(getRecentConversation('websocket')?.messages.map(m => m.content)).toEqual(['Legacy history']);
  const foreign = new ConversationRepository(getDb(), 'foreign-legacy-test').create();
  getDb().run('UPDATE conversations SET channel = ?, last_message_at = ? WHERE id = ?', ['websocket', Date.now() + 10_000, foreign.conversationId]);
  expect(getOrCreateConversation('websocket').id).toBe(legacy.id);
  expect(getRecentConversation('websocket')?.conversation.id).toBe(legacy.id);
  expect(repo.get(legacy.id).tab.open).toBe(false);
  expect(repo.messages(legacy.id).items[0]?.content).toBe('Legacy history');
  repo.setOpen(legacy.id, true);
  expect(repo.messages(explicit.conversationId).items[0]?.content).toBe('Explicit history');
});
