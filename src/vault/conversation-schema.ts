import type { Database } from 'bun:sqlite';

/** One authenticated brain owns one default workspace. Clients cannot choose it. */
export function defaultConversationWorkspace(db: Database): string {
  const row = db.query<{ workspace_id: string }, []>(
    'SELECT workspace_id FROM brief_conversation_workspace WHERE singleton = 1',
  ).get();
  if (!row) throw new Error('Conversation workspace is not initialized');
  return row.workspace_id;
}

/** Legacy writers may omit workspace_id; such rows belong only to this vault's default. */
export function ensureConversationTab(db: Database, id: string, title = 'Chat history'): void {
  if (db.query('SELECT conversation_id FROM conversation_tabs WHERE conversation_id = ?').get(id)) return;
  const root = defaultConversationWorkspace(db);
  const row = db.query<{ workspace_id: string }, [string, string]>(
    'SELECT COALESCE(workspace_id, ?) AS workspace_id FROM conversations WHERE id = ?',
  ).get(root, id);
  if (!row) throw new Error('Conversation not found');
  db.run('INSERT OR IGNORE INTO conversation_workspace_state (workspace_id) VALUES (?)', [row.workspace_id]);
  db.run(`INSERT OR IGNORE INTO conversation_tabs (conversation_id, title, tab_order)
    SELECT ?, ?, COALESCE(MAX(t.tab_order), -1) + 1
    FROM conversation_tabs t JOIN conversations c ON c.id = t.conversation_id
    WHERE COALESCE(c.workspace_id, ?) = ?`, [id, title, root, row.workspace_id]);
}

/** Additive and idempotent. Old inserts remain valid and history is never rewritten. */
export function ensureConversationSchema(db: Database): void {
  db.transaction(() => {
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(conversations)').all();
    if (!columns.some(column => column.name === 'workspace_id')) {
      db.run('ALTER TABLE conversations ADD COLUMN workspace_id TEXT');
    }
    db.run(`CREATE TABLE IF NOT EXISTS brief_conversation_workspace (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), workspace_id TEXT NOT NULL UNIQUE
    )`);
    db.run('INSERT OR IGNORE INTO brief_conversation_workspace (singleton, workspace_id) VALUES (1, ?)', [crypto.randomUUID()]);
    db.run(`CREATE TABLE IF NOT EXISTS conversation_workspace_state (
      workspace_id TEXT PRIMARY KEY,
      active_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS conversation_tabs (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      is_open INTEGER NOT NULL DEFAULT 0 CHECK(is_open IN (0, 1)),
      tab_order INTEGER NOT NULL CHECK(tab_order >= 0),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id, started_at, id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_conv_msg_cursor ON conversation_messages(conversation_id, created_at, id)');
    const root = defaultConversationWorkspace(db);
    db.run('INSERT OR IGNORE INTO conversation_workspace_state (workspace_id) VALUES (?)', [root]);
    // A prior binary can keep adding legacy conversations after a rollback.
    // Adopt only missing tab metadata on the next start, keeping existing order/titles.
    db.run(`INSERT OR IGNORE INTO conversation_workspace_state (workspace_id)
      SELECT DISTINCT COALESCE(workspace_id, ?) FROM conversations`, [root]);
    db.run(`WITH missing AS (
        SELECT c.id, COALESCE(c.workspace_id, ?) AS workspace_id, c.started_at
        FROM conversations c LEFT JOIN conversation_tabs t ON t.conversation_id = c.id
        WHERE t.conversation_id IS NULL
      ), offsets AS (
        SELECT COALESCE(c.workspace_id, ?) AS workspace_id, MAX(t.tab_order) + 1 AS next_order
        FROM conversations c JOIN conversation_tabs t ON t.conversation_id = c.id
        GROUP BY COALESCE(c.workspace_id, ?)
      )
      INSERT INTO conversation_tabs (conversation_id, title, tab_order)
      SELECT m.id, 'Chat history', COALESCE(o.next_order, 0)
        + ROW_NUMBER() OVER (PARTITION BY m.workspace_id ORDER BY m.started_at, m.id) - 1
      FROM missing m LEFT JOIN offsets o ON o.workspace_id = m.workspace_id`, [root, root, root]);
  })();
}
