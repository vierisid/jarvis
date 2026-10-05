import type { Database } from 'bun:sqlite';
import type { BriefConversation, BriefPage, BriefPageQuery } from '../brief/contracts.ts';
import type { ConversationMessage } from './conversations.ts';
import { defaultConversationWorkspace, ensureConversationTab } from './conversation-schema.ts';

export const MAX_OPEN_CONVERSATIONS = 50;
export class ConversationRequestError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 | 413 = 400) { super(message); }
}
export interface ConversationTabs {
  workspaceId: string;
  activeConversationId: string | null;
  revision: string;
  tabs: BriefConversation[];
}
type Row = {
  id: string; workspace_id: string; title: string; revision: number;
  is_open: number; tab_order: number; started_at: number; last_message_at: number; message_count: number;
};
type Cursor = { v: 1; kind: string; workspace: string; scope: string; time: number; id: string };
function limitOf(value = 50): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new ConversationRequestError('Limit must be an integer from 1 to 100');
  return value;
}
function titleOf(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ConversationRequestError('Title must contain 1 to 160 characters without control characters');
  }
  return value.trim();
}
function project(row: Row): BriefConversation {
  return {
    conversationId: row.id, workspaceId: row.workspace_id, title: row.title, revision: String(row.revision),
    tab: { open: row.is_open === 1, order: row.tab_order },
    lastMessageAt: row.message_count > 0 ? row.last_message_at : null,
  };
}

/** Workspace is supplied by the authenticated daemon, never taken from a request body. */
export class ConversationRepository {
  readonly workspaceId: string;
  private readonly rootWorkspace: string;
  constructor(private readonly db: Database, workspaceId?: string) {
    this.rootWorkspace = defaultConversationWorkspace(db);
    this.workspaceId = workspaceId ?? this.rootWorkspace;
    if (!this.workspaceId || this.workspaceId.length > 200) throw new ConversationRequestError('Invalid workspace');
    db.run('INSERT OR IGNORE INTO conversation_workspace_state (workspace_id) VALUES (?)', [this.workspaceId]);
  }

  private select = `SELECT c.id, COALESCE(c.workspace_id, ?) AS workspace_id,
    c.started_at, c.last_message_at, c.message_count, t.title, t.revision, t.is_open, t.tab_order
    FROM conversations c JOIN conversation_tabs t ON t.conversation_id = c.id
    WHERE COALESCE(c.workspace_id, ?) = ?`;
  private scopeArgs(): [string, string, string] { return [this.rootWorkspace, this.rootWorkspace, this.workspaceId]; }
  private row(id: string): Row {
    if (typeof id !== 'string' || !id || id.length > 200) throw new ConversationRequestError('Conversation not found', 404);
    const row = this.db.query(this.select + ' AND c.id = ?').get(...this.scopeArgs(), id) as Row | null;
    if (!row) throw new ConversationRequestError('Conversation not found', 404);
    return row;
  }
  private bumpWorkspace(): void {
    this.db.run('UPDATE conversation_workspace_state SET revision = revision + 1 WHERE workspace_id = ?', [this.workspaceId]);
  }
  private cursor(kind: string, scope: string, time: number, id: string): string {
    return Buffer.from(JSON.stringify({ v: 1, kind, workspace: this.workspaceId, scope, time, id } satisfies Cursor)).toString('base64url');
  }
  private decode(value: string | undefined, kind: string, scope: string): Cursor | null {
    if (value === undefined) return null;
    try {
      if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
      const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
      if (!cursor || cursor.v !== 1 || cursor.kind !== kind || cursor.workspace !== this.workspaceId || cursor.scope !== scope
        || !Number.isSafeInteger(cursor.time) || cursor.time < 0 || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 200) throw new Error();
      return cursor;
    } catch { throw new ConversationRequestError('Invalid cursor'); }
  }

  get(id: string): BriefConversation { return project(this.row(id)); }

  create(options: { title?: string } = {}): BriefConversation {
    const title = titleOf(options.title ?? 'New chat');
    return this.db.transaction(() => {
      if (this.tabs().tabs.length >= MAX_OPEN_CONVERSATIONS) throw new ConversationRequestError('Open conversation limit reached', 409);
      const id = crypto.randomUUID(); const now = Date.now();
      this.db.run(`INSERT INTO conversations (id, workspace_id, started_at, last_message_at, message_count)
        VALUES (?, ?, ?, ?, 0)`, [id, this.workspaceId, now, now]);
      ensureConversationTab(this.db, id, title);
      this.db.run('UPDATE conversation_tabs SET is_open = 1 WHERE conversation_id = ?', [id]);
      this.db.run('UPDATE conversation_workspace_state SET active_conversation_id = ?, revision = revision + 1 WHERE workspace_id = ?', [id, this.workspaceId]);
      return this.get(id);
    })();
  }

  list(query: BriefPageQuery & { closed?: boolean } = {}): BriefPage<BriefConversation> {
    const limit = limitOf(query.limit);
    if (query.closed !== undefined && typeof query.closed !== 'boolean') throw new ConversationRequestError('Invalid history filter');
    const scope = query.closed ? 'closed' : 'all';
    const cursor = this.decode(query.cursor, 'conversations', scope);
    const sql = this.select + (query.closed ? ' AND t.is_open = 0' : '')
      + (cursor ? ' AND (c.started_at < ? OR (c.started_at = ? AND c.id < ?))' : '')
      + ' ORDER BY c.started_at DESC, c.id DESC LIMIT ?';
    const rows = this.db.query(sql).all(...this.scopeArgs(), ...(cursor ? [cursor.time, cursor.time, cursor.id] : []), limit + 1) as Row[];
    const page = rows.slice(0, limit); const last = page.at(-1);
    return { items: page.map(project), nextCursor: rows.length > limit && last ? this.cursor('conversations', scope, last.started_at, last.id) : null };
  }

  rename(id: string, title: string, revision?: string): BriefConversation {
    const clean = titleOf(title);
    return this.db.transaction(() => {
      const row = this.row(id);
      if (revision !== undefined && revision !== String(row.revision)) throw new ConversationRequestError('Conversation changed', 409);
      if (row.title !== clean) {
        this.db.run('UPDATE conversation_tabs SET title = ?, revision = revision + 1 WHERE conversation_id = ?', [clean, id]);
        this.bumpWorkspace();
      }
      return this.get(id);
    })();
  }

  tabs(): ConversationTabs {
    const state = this.db.query<{ active_conversation_id: string | null; revision: number }, [string]>(
      'SELECT active_conversation_id, revision FROM conversation_workspace_state WHERE workspace_id = ?',
    ).get(this.workspaceId)!;
    const rows = this.db.query(this.select + ' AND t.is_open = 1 ORDER BY t.tab_order, c.id').all(...this.scopeArgs()) as Row[];
    return { workspaceId: this.workspaceId, activeConversationId: state.active_conversation_id, revision: String(state.revision), tabs: rows.map(project) };
  }

  setOpen(id: string, open: boolean): BriefConversation {
    if (typeof open !== 'boolean') throw new ConversationRequestError('Open must be a boolean');
    return this.db.transaction(() => {
      const row = this.row(id);
      if ((row.is_open === 1) === open) return project(row);
      const before = this.tabs();
      if (open && before.tabs.length >= MAX_OPEN_CONVERSATIONS) throw new ConversationRequestError('Open conversation limit reached', 409);
      this.db.run('UPDATE conversation_tabs SET is_open = ?, revision = revision + 1 WHERE conversation_id = ?', [open ? 1 : 0, id]);
      let active = before.activeConversationId;
      if (!open && active === id) active = this.tabs().tabs[0]?.conversationId ?? null;
      if (open && active === null) active = id;
      this.db.run('UPDATE conversation_workspace_state SET active_conversation_id = ?, revision = revision + 1 WHERE workspace_id = ?', [active, this.workspaceId]);
      return this.get(id);
    })();
  }

  activate(id: string | null): ConversationTabs {
    return this.db.transaction(() => {
      if (id !== null && this.row(id).is_open !== 1) throw new ConversationRequestError('Conversation tab is closed', 409);
      if (this.tabs().activeConversationId !== id) {
        this.db.run('UPDATE conversation_workspace_state SET active_conversation_id = ?, revision = revision + 1 WHERE workspace_id = ?', [id, this.workspaceId]);
      }
      return this.tabs();
    })();
  }

  /** Reorder open tabs within their existing slots; a closed tab keeps its saved slot. */
  reorder(ids: string[]): ConversationTabs {
    if (!Array.isArray(ids) || ids.length > MAX_OPEN_CONVERSATIONS || new Set(ids).size !== ids.length) throw new ConversationRequestError('Invalid tab order');
    return this.db.transaction(() => {
      for (const id of ids) if (this.row(id).is_open !== 1) throw new ConversationRequestError('Conversation tab is closed', 409);
      const before = this.tabs();
      if (ids.length !== before.tabs.length) throw new ConversationRequestError('Order must include every open tab');
      let changed = false;
      ids.forEach((id, index) => {
        const order = before.tabs[index]!.tab.order;
        if (this.row(id).tab_order === order) return;
        this.db.run('UPDATE conversation_tabs SET tab_order = ?, revision = revision + 1 WHERE conversation_id = ?', [order, id]);
        changed = true;
      });
      if (changed) this.bumpWorkspace();
      return this.tabs();
    })();
  }

  messages(id: string, query: BriefPageQuery = {}): BriefPage<ConversationMessage> {
    this.row(id);
    const limit = limitOf(query.limit);
    const cursor = this.decode(query.cursor, 'messages', id);
    const rows = this.db.query(`SELECT * FROM conversation_messages WHERE conversation_id = ?`
      + (cursor ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : '')
      + ' ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(id, ...(cursor ? [cursor.time, cursor.time, cursor.id] : []), limit + 1) as Array<Omit<ConversationMessage, 'tool_calls'> & { tool_calls: string | null }>;
    const page = rows.slice(0, limit); const last = page.at(-1);
    return {
      items: page.reverse().map(row => {
        const attachments = this.db.query<import('../brief/attachment-contracts').BriefAttachmentRef, [string, string, string]>(`SELECT
          a.attachment_id AS attachmentId, a.conversation_id AS conversationId, a.kind, a.name, a.media_type AS mediaType,
          a.size, a.sha256, a.expires_at AS expiresAt, a.state, a.turn_id AS turnId
          FROM brief_chat_attachments a JOIN brief_chat_turns t ON t.turn_id = a.turn_id
          WHERE a.workspace_id = ? AND a.conversation_id = ? AND t.user_message_id = ? ORDER BY a.attachment_id`).all(this.workspaceId, id, row.id);
        return { ...row, tool_calls: row.tool_calls ? JSON.parse(row.tool_calls) : null, ...(attachments.length ? { attachments } : {}) };
      }),
      nextCursor: rows.length > limit && last ? this.cursor('messages', id, last.created_at, last.id) : null,
    };
  }
}
