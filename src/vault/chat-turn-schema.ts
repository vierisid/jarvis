import type { Database } from 'bun:sqlite';

/** Transport metadata is additive; canonical messages remain in conversation_messages. */
export function ensureChatTurnSchema(db: Database): void {
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS brief_chat_turns (
      turn_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      input TEXT NOT NULL,
      speak INTEGER NOT NULL DEFAULT 0 CHECK(speak IN (0, 1)),
      state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      user_message_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE(workspace_id, request_id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS brief_chat_sequences (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence >= 0)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS brief_chat_events (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL REFERENCES brief_chat_turns(turn_id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      PRIMARY KEY(conversation_id, sequence)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS brief_chat_approvals (
      approval_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES brief_chat_turns(turn_id) ON DELETE CASCADE
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_brief_chat_turns_conversation ON brief_chat_turns(conversation_id, created_at, turn_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_brief_chat_turns_pending ON brief_chat_turns(workspace_id, state)');
  })();
}
