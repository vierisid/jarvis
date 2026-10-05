import type { Database } from 'bun:sqlite';

/** Additive, workspace-owned bytes. Removal/expiry retain identity tombstones. */
export function ensureChatAttachmentSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS brief_chat_attachments (
    attachment_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('document','image','screenshot')),
    name TEXT NOT NULL, media_type TEXT NOT NULL,
    size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    bytes BLOB, extracted_text TEXT,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('ready','accepted','removed','expired')),
    turn_id TEXT REFERENCES brief_chat_turns(turn_id),
    source_device_id TEXT
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_brief_attachments_owner ON brief_chat_attachments(workspace_id, conversation_id, turn_id)');
}
