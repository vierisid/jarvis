import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, getDb, closeDb } from './schema.ts';
import { ChatTurnRepository } from './chat-turns.ts';
import { ConversationRepository } from './conversation-lifecycle.ts';
import { addMessage, getMessages, getOrCreateConversation } from './conversations.ts';
import { ensureChatTurnSchema } from './chat-turn-schema.ts';

afterEach(() => closeDb());
function setup() {
  initDatabase(':memory:', { quiet: true });
  const repo = new ChatTurnRepository(getDb());
  const conversationId = repo.conversations.create().conversationId;
  return { repo, input: { conversationId, turnId: 'turn-1', requestId: 'request-1', text: 'First question' } };
}

test('turn settlement uses an indexed lookup on fresh and upgraded retained event history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-progress-index-'));
  const file = join(directory, 'fixture.db');
  try {
    initDatabase(file, { quiet: true });
    const repo = new ChatTurnRepository(getDb());
    const input = { conversationId: repo.conversations.create().conversationId, turnId: 'turn', requestId: 'request', text: 'Question' };
    repo.accept(input); repo.start(input); repo.text(input, 'Retained history');
    const before = repo.snapshot(input.conversationId, 0);
    const plan = () => getDb().query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN
      SELECT payload FROM brief_chat_events WHERE turn_id = ? AND json_extract(payload, '$.kind') = 'activity' ORDER BY sequence`).all(input.turnId).map(row => row.detail).join('\n');
    expect(plan()).toContain('USING INDEX idx_brief_chat_events_turn');
    expect(plan()).not.toMatch(/SCAN brief_chat_events|TEMP B-TREE/);
    // Simulate an older on-disk vault, then exercise the additive migration twice.
    closeDb();
    const legacy = new Database(file);
    try { legacy.run('DROP INDEX idx_brief_chat_events_turn'); } finally { legacy.close(); }
    initDatabase(file, { quiet: true });
    ensureChatTurnSchema(getDb()); ensureChatTurnSchema(getDb());
    expect(plan()).toContain('USING INDEX idx_brief_chat_events_turn');
    expect(plan()).not.toMatch(/SCAN brief_chat_events|TEMP B-TREE/);
    expect(new ChatTurnRepository(getDb()).snapshot(input.conversationId, 0)).toEqual(before);
  } finally { closeDb(); rmSync(directory, { recursive: true, force: true }); }
});

test('request identity commits one user message and rejects conflicting reuse atomically', () => {
  const { repo, input } = setup();
  const first = repo.accept(input);
  expect(first.created).toBe(true);
  expect(repo.accept(input).created).toBe(false);
  expect(() => repo.accept({ ...input, text: 'Different request' })).toThrow('identity');
  expect(() => repo.accept({ ...input, turnId: 'turn-2' })).toThrow('identity');
  expect(() => repo.accept({ ...input, requestId: 'request-2' })).toThrow('identity');
  expect(() => repo.accept({ ...input, turnId: 'turn-2', requestId: 'request-2' })).toThrow('active turn');
  expect(getMessages(input.conversationId).map(message => message.content)).toEqual([input.text]);
  expect(repo.conversations.get(input.conversationId).lastMessageAt).not.toBeNull();
  expect(getDb().query<{ message_count: number }, [string]>('SELECT message_count FROM conversations WHERE id = ?').get(input.conversationId)?.message_count).toBe(1);
});

test('partial text, terminal state and monotonic events are durable and terminal writes are idempotent', () => {
  const { repo, input } = setup();
  const turn = repo.accept(input).turn;
  repo.start(turn);
  repo.text(turn, 'Partial ');
  repo.text(turn, 'reply');
  expect(repo.finish(turn, 'cancelled')?.payload).toEqual({ kind: 'terminal', state: 'cancelled' });
  expect(repo.finish(turn, 'completed')).toBeNull();
  expect(repo.text(turn, ' late')).toBeNull();
  const snapshot = repo.snapshot(input.conversationId, 0);
  expect(snapshot.events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(snapshot.events.every(event => event.turnId === input.turnId && event.requestId === input.requestId)).toBe(true);
  expect(snapshot.events.filter(event => event.payload.kind === 'terminal')).toHaveLength(1);
  expect(snapshot.messages.items.map(message => message.content)).toEqual(['First question', 'Partial reply']);
  expect(repo.accept(input).turn.state).toBe('cancelled');
  const next = repo.accept({ ...input, turnId: 'turn-2', requestId: 'request-2', text: 'Continue' }).turn;
  expect(repo.history(next)).toEqual([{ role: 'user', content: 'First question' }, { role: 'assistant', content: 'Partial reply' }]);
  expect(repo.finish(turn, 'cancelled')).toBeNull();
  expect(repo.get(next).state).toBe('queued');
  expect(getDb().query<{ message_count: number }, [string]>('SELECT message_count FROM conversations WHERE id = ?').get(input.conversationId)?.message_count).toBe(3);
});

test('workspace checks protect sends, replay, history, approval association and cancel identities', () => {
  const { repo, input } = setup();
  const foreign = new ChatTurnRepository(getDb(), 'foreign-workspace');
  const foreignId = foreign.conversations.create().conversationId;
  const other = foreign.accept({ conversationId: foreignId, turnId: 'other-turn', requestId: 'other-request', text: 'Private' }).turn;
  const mine = repo.accept(input).turn;
  foreign.approval(other, 'other-approval', 'pending');
  expect(() => repo.accept({ ...input, conversationId: foreignId })).toThrow('Conversation not found');
  expect(() => repo.snapshot(foreignId, 0)).toThrow('Conversation not found');
  expect(() => repo.history(other)).toThrow('Conversation not found');
  expect(() => repo.finish({ ...mine, requestId: 'wrong-request' }, 'cancelled')).toThrow('Turn not found');
  expect(() => repo.finish({ ...mine, conversationId: foreignId }, 'cancelled')).toThrow('Conversation not found');
  expect(repo.approvalOwner('other-approval')).toBeNull();
  expect(foreign.get(other).state).toBe('queued');
  expect(repo.get(mine).state).toBe('queued');
});

test('restart fails interrupted work once, preserves messages and approvals, and never reruns a send', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-f03-restart-'));
  try {
    const path = join(directory, 'vault.sqlite');
    initDatabase(path, { quiet: true });
    const before = new ChatTurnRepository(getDb());
    const conversationId = before.conversations.create().conversationId;
    const input = { conversationId, turnId: 'restart-turn', requestId: 'restart-request', text: 'Restart fixture' };
    const accepted = before.accept(input).turn;
    before.start(accepted); before.text(accepted, 'Saved partial');
    before.approval(accepted, 'approval-stable', 'pending');
    const cursor = before.sequence(conversationId);
    closeDb();
    initDatabase(path, { quiet: true });
    const after = new ChatTurnRepository(getDb());
    after.recover(); after.recover();
    const replay = after.snapshot(conversationId, cursor);
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]?.payload).toMatchObject({ kind: 'terminal', state: 'failed', error: { code: 'interrupted' } });
    expect(after.accept(input)).toMatchObject({ created: false, turn: { state: 'failed', userMessageId: accepted.userMessageId } });
    expect(getMessages(conversationId).map(message => message.content)).toEqual(['Restart fixture', 'Saved partial']);
    expect(after.approvalOwner('approval-stable')?.turnId).toBe(input.turnId);
    expect(after.approval(accepted, 'approval-stable', 'approved').sequence).toBeGreaterThan(replay.sequence);
  } finally { closeDb(); rmSync(directory, { recursive: true, force: true }); }
});

test('replay pages use stable sequences with transient audio gaps and reject future or malformed cursors', () => {
  const { repo, input } = setup();
  const turn = repo.accept(input).turn;
  repo.start(turn);
  for (let i = 0; i < 503; i++) repo.text(turn, 'x');
  repo.nextSequence(input.conversationId);
  repo.finish(turn, 'completed');
  const first = repo.snapshot(input.conversationId, 0);
  const second = repo.snapshot(input.conversationId, first.nextSequence);
  expect(first.events).toHaveLength(500);
  expect(first.hasMore).toBe(true);
  expect(second.hasMore).toBe(false);
  expect(new Set([...first.events, ...second.events].map(event => event.eventId)).size).toBe(507);
  expect(second.nextSequence).toBe(508);
  for (const cursor of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 509]) expect(() => repo.snapshot(input.conversationId, cursor)).toThrow('cursor');
});

test('additive transport migration preserves legacy writers and adoption across rollback', () => {
  setup();
  const legacy = getOrCreateConversation('websocket');
  const message = addMessage(legacy.id, { role: 'user', content: 'Legacy history' });
  ensureChatTurnSchema(getDb()); ensureChatTurnSchema(getDb());
  expect(getMessages(legacy.id)).toEqual([message]);
  const repo = new ConversationRepository(getDb());
  expect(repo.get(legacy.id).lastMessageAt).toBe(message.created_at);
});
