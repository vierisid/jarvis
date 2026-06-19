import { afterEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from './schema.ts';
import {
  addMessage,
  getMessages,
  getOrCreateConversation,
  getRecentConversation,
} from './conversations.ts';

describe('Vault — Conversations', () => {
  afterEach(() => {
    closeDb();
  });

  test('reuses the recent conversation for a channel within the idle window', () => {
    initDatabase(':memory:');

    const first = getOrCreateConversation('websocket');
    addMessage(first.id, { role: 'user', content: 'hi' });
    const second = getOrCreateConversation('websocket');

    expect(second.id).toBe(first.id);
  });

  test('forceNew starts a fresh conversation but keeps the old messages', () => {
    initDatabase(':memory:');

    const old = getOrCreateConversation('websocket');
    addMessage(old.id, { role: 'user', content: 'remember this' });

    const fresh = getOrCreateConversation('websocket', { forceNew: true });
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.message_count).toBe(0);

    // Old conversation's messages are untouched (soft cutoff, not a delete).
    expect(getMessages(old.id)).toHaveLength(1);

    // The fresh, empty conversation is now the most recent one — so the next
    // turn loads no replayed dialogue.
    const recent = getRecentConversation('websocket');
    expect(recent?.conversation.id).toBe(fresh.id);
    expect(recent?.messages).toHaveLength(0);
  });

  test('a message older than the idle window starts a new conversation', () => {
    initDatabase(':memory:');

    const old = getOrCreateConversation('websocket');
    addMessage(old.id, { role: 'user', content: 'hi' });

    // Idle window of 0ms → the existing conversation is always considered stale.
    const next = getOrCreateConversation('websocket', { idleResetMs: 0 });
    expect(next.id).not.toBe(old.id);
  });
});
