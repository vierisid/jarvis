/**
 * getRecentConversation (#1167): the channel's own conversation, never a
 * sender's (#1123), and -- checked, not changed -- no stale dialogue for a
 * turn whose writer starts a new conversation after the 4-hour gap (#1131).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from './schema.ts';
import { addMessage, getOrCreateConversation, getRecentConversation } from './conversations.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

test('a sender\'s conversation is never handed to a caller that names none', () => {
  const own = getOrCreateConversation('telegram');
  addMessage(own.id, { role: 'user', content: 'owner turn' });
  const stranger = getOrCreateConversation('telegram', { sender: 'tg:999' });
  addMessage(stranger.id, { role: 'user', content: 'stranger turn' });
  // The stranger's is the newest on the channel.
  getDb().run('UPDATE conversations SET last_message_at = last_message_at + 1000 WHERE id = ?', [stranger.id]);

  const recent = getRecentConversation('telegram');
  expect(recent?.conversation.id).toBe(own.id);
  expect(recent?.messages.map((m) => m.content)).toEqual(['owner turn']);
});

test('a channel with only senders\' conversations has none of its own', () => {
  addMessage(getOrCreateConversation('discord', { sender: 'dc:1' }).id, { role: 'user', content: 'hi' });
  expect(getRecentConversation('discord')).toBeNull();
});

test('the dashboard turn after days away reads a fresh conversation, because its writer starts one first (#1131 premise)', () => {
  // Last week's chat.
  const old = getOrCreateConversation('websocket');
  addMessage(old.id, { role: 'user', content: 'open the browser' });
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  getDb().run('UPDATE conversations SET last_message_at = ?, started_at = ? WHERE id = ?', [weekAgo, weekAgo, old.id]);

  // What ws-service handleChat does, in its order: store the turn, then the
  // agent reads the channel's dialogue (AgentService.loadRecentDialogue).
  const now = getOrCreateConversation('websocket');
  addMessage(now.id, { role: 'user', content: 'do that again' });
  expect(now.id).not.toBe(old.id);
  const recent = getRecentConversation('websocket');
  expect(recent?.conversation.id).toBe(now.id);
  expect(recent?.messages.map((m) => m.content)).toEqual(['do that again']);
});
