import { getDb, generateId } from './schema.ts';

export type MessageRole = 'user' | 'assistant' | 'system';

export type ConversationMessage = {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  tool_calls: unknown[] | null;
  created_at: number;
};

export type Conversation = {
  id: string;
  agent_id: string | null;
  channel: string | null;
  started_at: number;
  last_message_at: number;
  message_count: number;
  metadata: Record<string, unknown> | null;
};

type ConversationRow = {
  id: string;
  agent_id: string | null;
  channel: string | null;
  started_at: number;
  last_message_at: number;
  message_count: number;
  metadata: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  tool_calls: string | null;
  created_at: number;
};

function parseConversation(row: ConversationRow): Conversation {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

function parseMessage(row: MessageRow): ConversationMessage {
  return {
    ...row,
    tool_calls: row.tool_calls ? JSON.parse(row.tool_calls) : null,
  };
}

/**
 * Get or create the active conversation for a channel.
 * Returns the most recent conversation for the channel, or creates a new one.
 */
export function getOrCreateConversation(channel: string): Conversation {
  const db = getDb();
  const now = Date.now();

  // Look for a recent conversation on this channel (within last 4 hours)
  const cutoff = now - 4 * 60 * 60 * 1000;
  const existing = db.prepare(
    'SELECT * FROM conversations WHERE channel = ? AND last_message_at > ? ORDER BY last_message_at DESC LIMIT 1'
  ).get(channel, cutoff) as ConversationRow | null;

  if (existing) {
    return parseConversation(existing);
  }

  // Create new conversation
  const id = generateId();
  db.prepare(
    'INSERT INTO conversations (id, channel, started_at, last_message_at, message_count) VALUES (?, ?, ?, ?, 0)'
  ).run(id, channel, now, now);

  return {
    id,
    agent_id: null,
    channel,
    started_at: now,
    last_message_at: now,
    message_count: 0,
    metadata: null,
  };
}

/**
 * Add a message to a conversation.
 * Updates conversation metadata (last_message_at, message_count).
 */
export function addMessage(
  conversationId: string,
  msg: { role: MessageRole; content: string; tool_calls?: unknown[] }
): ConversationMessage {
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  db.prepare(
    'INSERT INTO conversation_messages (id, conversation_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    conversationId,
    msg.role,
    msg.content,
    msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
    now
  );

  // Update conversation
  db.prepare(
    'UPDATE conversations SET last_message_at = ?, message_count = message_count + 1 WHERE id = ?'
  ).run(now, conversationId);

  return {
    id,
    conversation_id: conversationId,
    role: msg.role,
    content: msg.content,
    tool_calls: msg.tool_calls ?? null,
    created_at: now,
  };
}

/**
 * Get messages for a conversation, ordered by time ascending.
 */
export function getMessages(
  conversationId: string,
  opts?: { limit?: number; before?: number }
): ConversationMessage[] {
  const db = getDb();
  const limit = opts?.limit ?? 100;

  if (opts?.before) {
    const rows = db.prepare(
      'SELECT * FROM conversation_messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?'
    ).all(conversationId, opts.before, limit) as MessageRow[];
    return rows.map(parseMessage);
  }

  // Get the last N messages, ordered ascending
  const rows = db.prepare(
    'SELECT * FROM (SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC'
  ).all(conversationId, limit) as MessageRow[];

  return rows.map(parseMessage);
}

/**
 * Get the most recent conversation for a channel, with its messages.
 */
export function getRecentConversation(channel: string): {
  conversation: Conversation;
  messages: ConversationMessage[];
} | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM conversations WHERE channel = ? ORDER BY last_message_at DESC LIMIT 1'
  ).get(channel) as ConversationRow | null;

  if (!row) return null;

  const conversation = parseConversation(row);
  const messages = getMessages(conversation.id);

  return { conversation, messages };
}
