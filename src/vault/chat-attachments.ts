import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { ATTACHMENT_LIMITS as limits, type BriefAttachmentRef, type BriefAttachmentKind } from '../brief/attachment-contracts';
import { ConversationRepository, ConversationRequestError } from './conversation-lifecycle';

export const attachmentProjection = `attachment_id AS attachmentId, conversation_id AS conversationId, kind, name,
  media_type AS mediaType, size, sha256, expires_at AS expiresAt, state, turn_id AS turnId`;
export const attachmentId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ConversationRequestError('Invalid attachment identity');
  return value;
};
export function attachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limits.perTurn) throw new ConversationRequestError(`Choose at most ${limits.perTurn} attachments`);
  const ids = value.map(attachmentId).sort();
  if (new Set(ids).size !== ids.length) throw new ConversationRequestError('Duplicate attachment identity');
  return ids;
}
export interface AttachmentUpload {
  attachmentId: string; conversationId: string; kind: BriefAttachmentKind; name: string;
  mediaType: string; bytes: Uint8Array; text: string | null; sourceDeviceId?: string;
}

/** Metadata and bytes share the vault transaction with canonical turn acceptance. */
export class ChatAttachmentRepository {
  readonly conversations: ConversationRepository;
  constructor(readonly db: Database, workspaceId?: string, private readonly now = Date.now) {
    this.conversations = new ConversationRepository(db, workspaceId);
  }
  get workspaceId() { return this.conversations.workspaceId; }
  requireOpen(conversationId: string) {
    if (!this.conversations.get(conversationId).tab.open) throw new ConversationRequestError('Reopen the conversation before attaching files', 409);
  }
  expire() {
    this.db.run(`UPDATE brief_chat_attachments SET bytes = NULL, extracted_text = NULL,
      state = CASE WHEN state = 'ready' THEN 'expired' ELSE state END
      WHERE workspace_id = ? AND expires_at <= ? AND bytes IS NOT NULL`, [this.workspaceId, this.now()]);
  }
  find(conversationId: string, id: string): BriefAttachmentRef | null {
    this.conversations.get(conversationId); attachmentId(id); this.expire();
    const row = this.db.query<BriefAttachmentRef & { workspaceId: string }, [string]>(`SELECT ${attachmentProjection}, workspace_id AS workspaceId
      FROM brief_chat_attachments WHERE attachment_id = ?`).get(id);
    if (row && (row.workspaceId !== this.workspaceId || row.conversationId !== conversationId)) throw new ConversationRequestError('Attachment not found', 404);
    if (!row) return null;
    const { workspaceId: _workspace, ...ref } = row; return ref;
  }
  forTurn(conversationId: string, turnId: string): BriefAttachmentRef[] {
    this.conversations.get(conversationId);
    return this.db.query<BriefAttachmentRef, [string, string, string]>(`SELECT ${attachmentProjection} FROM brief_chat_attachments
      WHERE workspace_id = ? AND conversation_id = ? AND turn_id = ? ORDER BY attachment_id`).all(this.workspaceId, conversationId, turnId);
  }
  save(input: AttachmentUpload): BriefAttachmentRef {
    return this.db.transaction(() => {
      this.requireOpen(input.conversationId);
      const existing = this.find(input.conversationId, input.attachmentId);
      const sha256 = createHash('sha256').update(input.bytes).digest('hex');
      if (existing) {
        if (!['ready', 'accepted'].includes(existing.state) || existing.expiresAt <= this.now()
          || existing.sha256 !== sha256 || existing.kind !== input.kind || existing.name !== input.name || existing.mediaType !== input.mediaType) {
          throw new ConversationRequestError('Attachment identity already used or expired; choose the file again', 409);
        }
        return existing;
      }
      const used = this.db.query<{ total: number }, [string]>(`SELECT COALESCE(SUM(length(bytes)), 0) AS total
        FROM brief_chat_attachments WHERE workspace_id = ?`).get(this.workspaceId)!.total;
      if (used + input.bytes.byteLength > limits.workspaceBytes) throw new ConversationRequestError('Attachment storage is full; remove unused files or wait for expiry', 413);
      this.db.run(`INSERT INTO brief_chat_attachments
        (attachment_id, workspace_id, conversation_id, kind, name, media_type, size, sha256, bytes, extracted_text, expires_at, state, source_device_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
      [input.attachmentId, this.workspaceId, input.conversationId, input.kind, input.name, input.mediaType, input.bytes.byteLength,
        sha256, input.bytes, input.text, this.now() + limits.ttlMs, input.sourceDeviceId ?? null]);
      return this.find(input.conversationId, input.attachmentId)!;
    })();
  }
  remove(conversationId: string, id: string) {
    return this.db.transaction(() => {
      const prior = this.find(conversationId, id);
      if (prior?.turnId) throw new ConversationRequestError('An accepted attachment belongs to its original turn', 409);
      // A remove racing an upload must win, even when the decode has not finished.
      if (!prior) this.db.run(`INSERT INTO brief_chat_attachments
        (attachment_id, workspace_id, conversation_id, kind, name, media_type, size, sha256, expires_at, state)
        VALUES (?, ?, ?, 'document', '', '', 0, '', ?, 'removed')`, [id, this.workspaceId, conversationId, this.now()]);
      else this.db.run("UPDATE brief_chat_attachments SET state = 'removed', bytes = NULL, extracted_text = NULL WHERE attachment_id = ?", [id]);
      return this.find(conversationId, id)!;
    })();
  }
  /** Called inside the turn transaction after the turn row exists. All or nothing. */
  bind(conversationId: string, turnId: string, ids: string[]) {
    this.requireOpen(conversationId);
    let total = 0;
    for (const id of attachmentIds(ids)) {
      const ref = this.find(conversationId, id);
      if (!ref || ref.state !== 'ready' || ref.expiresAt <= this.now()) throw new ConversationRequestError('Attachment is missing, expired, removed, or already accepted', 409);
      total += ref.size;
      if (total > limits.turnBytes) throw new ConversationRequestError('Attachments exceed the turn size limit', 413);
      this.db.run("UPDATE brief_chat_attachments SET state = 'accepted', turn_id = ? WHERE attachment_id = ?", [turnId, id]);
    }
  }
  content(conversationId: string, turnId: string) {
    const refs = this.forTurn(conversationId, turnId); this.expire();
    return refs.map(ref => {
      const row = this.db.query<{ bytes: Uint8Array | null; text: string | null }, [string, string, string]>(`SELECT bytes, extracted_text AS text
        FROM brief_chat_attachments WHERE workspace_id = ? AND conversation_id = ? AND attachment_id = ?`).get(this.workspaceId, conversationId, ref.attachmentId);
      if (!row?.bytes || ref.expiresAt <= this.now()) throw new ConversationRequestError('Attachment content expired; attach the file to a new message', 409);
      return { ref, bytes: row.bytes, text: row.text };
    });
  }
}
