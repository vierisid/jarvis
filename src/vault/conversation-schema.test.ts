import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, closeDb } from './schema.ts';
import { ConversationRepository, MAX_OPEN_CONVERSATIONS } from './conversation-lifecycle.ts';

let directory: string | undefined;
afterEach(() => { closeDb(); if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

test('migration preserves old histories, adopts rollback-era inserts, and keeps saved tab metadata', () => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-f02-migration-')); const file = join(directory, 'vault.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, agent_id TEXT, channel TEXT, started_at INTEGER NOT NULL,
    last_message_at INTEGER NOT NULL, message_count INTEGER DEFAULT 0, metadata TEXT);
    CREATE TABLE conversation_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, created_at INTEGER NOT NULL);`);
  old.run(`INSERT INTO conversations VALUES ('legacy-a', NULL, 'websocket', 1, 2, 1, '{"keep":"metadata"}')`);
  old.run(`INSERT INTO conversation_messages VALUES ('legacy-message', 'legacy-a', 'user', 'Preserve verbatim', NULL, 2)`);
  old.close();
  let db = initDatabase(file, { quiet: true }); let repo = new ConversationRepository(db);
  const root = repo.workspaceId;
  expect(repo.get('legacy-a')).toMatchObject({ workspaceId: root, title: 'Chat history', tab: { open: false, order: 0 } });
  repo.rename('legacy-a', 'Saved title'); repo.setOpen('legacy-a', true);
  const saved = repo.get('legacy-a'); const messages = repo.messages('legacy-a');
  // The old binary's INSERT shape remains legal on the expanded schema.
  db.run(`INSERT INTO conversations (id, channel, started_at, last_message_at, message_count) VALUES ('rollback-b', 'websocket', 3, 3, 0)`);
  db.run(`INSERT INTO conversation_messages (id, conversation_id, role, content, created_at) VALUES ('rollback-message', 'rollback-b', 'user', 'Old writer', 4)`);
  closeDb();
  db = initDatabase(file, { quiet: true }); repo = new ConversationRepository(db);
  expect(repo.workspaceId).toBe(root);
  expect(repo.get('legacy-a')).toEqual(saved);
  expect(repo.messages('legacy-a')).toEqual(messages);
  expect(repo.get('rollback-b').tab).toEqual({ open: false, order: 1 });
  expect(repo.messages('rollback-b').items[0]?.content).toBe('Old writer');
  expect(db.query('SELECT metadata FROM conversations WHERE id = ?').get('legacy-a')).toEqual({ metadata: '{"keep":"metadata"}' });
  closeDb();
  repo = new ConversationRepository(initDatabase(file, { quiet: true }));
  expect(repo.list().items).toHaveLength(2);
  expect(repo.get('rollback-b').tab.order).toBe(1);
});

test('open-tab limit rejects extra creation atomically and reopening respects the same bound', () => {
  const db = initDatabase(':memory:', { quiet: true }); const repo = new ConversationRepository(db);
  const first = repo.create(); repo.setOpen(first.conversationId, false);
  for (let i = 0; i < MAX_OPEN_CONVERSATIONS; i++) repo.create();
  const before = db.query('SELECT COUNT(*) AS total FROM conversations').get();
  expect(() => repo.create()).toThrow('Open conversation limit reached');
  expect(() => repo.setOpen(first.conversationId, true)).toThrow('Open conversation limit reached');
  expect(db.query('SELECT COUNT(*) AS total FROM conversations').get()).toEqual(before);
  expect(repo.get(first.conversationId).tab.open).toBe(false);
  expect(repo.tabs().tabs).toHaveLength(MAX_OPEN_CONVERSATIONS);
});
