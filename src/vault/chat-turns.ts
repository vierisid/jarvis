import type { Database } from 'bun:sqlite';
import type { ApprovalStatus } from '../authority/approval.ts';
import type { LLMMessage } from '../llm/provider.ts';
import type { BriefChatEvent, BriefChatPayload, BriefSendTurn, BriefTurnRef, BriefTurnState } from '../brief/contracts.ts';
import { ConversationRepository, ConversationRequestError } from './conversation-lifecycle.ts';
import { ChatAttachmentRepository, attachmentIds } from './chat-attachments';
import type { BriefAttachmentRef } from '../brief/attachment-contracts';
import { insertConversationMessage } from './conversations.ts';

export interface ChatTurn extends BriefTurnRef {
  text: string;
  attachments: BriefAttachmentRef[];
  speak: boolean;
  state: BriefTurnState;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: number;
}
const projection = `turn_id AS turnId, conversation_id AS conversationId, request_id AS requestId,
  input AS text, speak, state, user_message_id AS userMessageId, assistant_message_id AS assistantMessageId,
  created_at AS createdAt`;
export const isTerminalTurn = (state: BriefTurnState) => state === 'completed' || state === 'failed' || state === 'cancelled';
const MAX_PENDING_TURNS = 32;
const MAX_OUTPUT_CHARS = 256_000;

/** All writes are synchronous SQLite transactions, including message/event/terminal commits. */
export class ChatTurnRepository {
  readonly conversations: ConversationRepository;
  readonly attachments: ChatAttachmentRepository;
  constructor(readonly db: Database, workspaceId?: string) {
    this.conversations = new ConversationRepository(db, workspaceId);
    this.attachments = new ChatAttachmentRepository(db, workspaceId);
  }

  get workspaceId(): string { return this.conversations.workspaceId; }

  get(ref: BriefTurnRef): ChatTurn {
    this.conversations.get(ref.conversationId);
    const row = this.db.query<ChatTurn, [string, string, string, string]>(`SELECT ${projection} FROM brief_chat_turns
      WHERE workspace_id = ? AND conversation_id = ? AND turn_id = ? AND request_id = ?`).get(this.workspaceId, ref.conversationId, ref.turnId, ref.requestId);
    if (!row) throw new ConversationRequestError('Turn not found', 404);
    return { ...row, speak: Boolean(row.speak), attachments: this.attachments.forTurn(row.conversationId, row.turnId) };
  }

  accept(input: BriefSendTurn, validateNewTurn: () => void = () => {}): { turn: ChatTurn; created: boolean; events: BriefChatEvent[] } {
    return this.db.transaction(() => {
      this.conversations.get(input.conversationId);
      const ids = attachmentIds(input.attachmentIds);
      const existing = this.db.query<ChatTurn, [string, string, string]>(`SELECT ${projection} FROM brief_chat_turns
        WHERE workspace_id = ? AND (request_id = ? OR turn_id = ?)`).all(this.workspaceId, input.requestId, input.turnId);
      if (existing.length) {
        const row = existing[0]!;
        if (existing.length !== 1 || row.conversationId !== input.conversationId || row.turnId !== input.turnId ||
            row.requestId !== input.requestId || row.text !== input.text || Boolean(row.speak) !== Boolean(input.speak) ||
            JSON.stringify(this.attachments.forTurn(row.conversationId, row.turnId).map(ref => ref.attachmentId)) !== JSON.stringify(ids)) {
          throw new ConversationRequestError('Request identity already used for different input', 409);
        }
        return { turn: this.get(input), created: false, events: [] };
      }
      validateNewTurn();
      const pending = this.pending();
      if (pending.some(turn => turn.conversationId === input.conversationId)) throw new ConversationRequestError('Conversation already has an active turn', 409);
      if (pending.length >= MAX_PENDING_TURNS) throw new ConversationRequestError('Chat queue is full', 409);
      const userMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();
      const createdAt = this.messageTime(input.conversationId);
      this.db.run(`INSERT INTO brief_chat_turns
        (turn_id, workspace_id, conversation_id, request_id, input, speak, state, user_message_id, assistant_message_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      [input.turnId, this.workspaceId, input.conversationId, input.requestId, input.text, input.speak ? 1 : 0, userMessageId, assistantMessageId, createdAt]);
      if (ids.length) this.attachments.bind(input.conversationId, input.turnId, ids);
      insertConversationMessage(this.db, input.conversationId, { role: 'user', content: input.text }, userMessageId, createdAt);
      const turn = this.get(input);
      return { turn, created: true, events: [
        this.append(turn, { kind: 'message', message: { ...this.ref(turn), messageId: userMessageId, role: 'user', content: input.text, createdAt, ...(turn.attachments.length ? { attachments: turn.attachments } : {}) } }),
        this.append(turn, { kind: 'status', state: 'queued' }),
      ] };
    })();
  }

  pending(): ChatTurn[] {
    return this.db.query<ChatTurn, [string]>(`SELECT ${projection} FROM brief_chat_turns
      WHERE workspace_id = ? AND state IN ('queued', 'running') ORDER BY created_at, turn_id`).all(this.workspaceId);
  }

  start(ref: BriefTurnRef): BriefChatEvent | null {
    return this.db.transaction(() => {
      const turn = this.get(ref);
      if (turn.state !== 'queued') return null;
      this.db.run("UPDATE brief_chat_turns SET state = 'running' WHERE turn_id = ?", [turn.turnId]);
      return this.append(turn, { kind: 'status', state: 'running' });
    })();
  }

  text(ref: BriefTurnRef, text: string): BriefChatEvent | null {
    return this.db.transaction(() => {
      const turn = this.get(ref);
      if (isTerminalTurn(turn.state) || !text) return null;
      const prior = this.db.query<{ content: string }, [string]>('SELECT content FROM conversation_messages WHERE id = ?').get(turn.assistantMessageId);
      if ((prior?.content.length ?? 0) + text.length > MAX_OUTPUT_CHARS) throw new ConversationRequestError('Response exceeded the chat output limit', 413);
      if (prior) this.db.run('UPDATE conversation_messages SET content = content || ? WHERE id = ?', [text, turn.assistantMessageId]);
      else {
        const at = this.messageTime(turn.conversationId);
        insertConversationMessage(this.db, turn.conversationId, { role: 'assistant', content: text }, turn.assistantMessageId, at);
      }
      return this.append(turn, { kind: 'delta', messageId: turn.assistantMessageId, text });
    })();
  }

  activity(ref: BriefTurnRef, payload: Extract<BriefChatPayload, { kind: 'activity' }>): BriefChatEvent | null {
    return this.db.transaction(() => {
      const turn = this.get(ref);
      return isTerminalTurn(turn.state) ? null : this.append(turn, payload);
    })();
  }

  finish(ref: BriefTurnRef, state: 'completed' | 'failed' | 'cancelled', error?: { code: string; message: string }): BriefChatEvent | null {
    return this.db.transaction(() => {
      const turn = this.get(ref);
      if (isTerminalTurn(turn.state)) return null;
      this.db.run('UPDATE brief_chat_turns SET state = ?, finished_at = ? WHERE turn_id = ?', [state, Date.now(), turn.turnId]);
      return this.append(turn, { kind: 'terminal', state, ...(error ? { error } : {}) });
    })();
  }

  /** A restart never retries effects. Reconnect replays the one persisted failed terminal. */
  recover(): void {
    for (const turn of this.pending()) this.finish(turn, 'failed', { code: 'interrupted', message: 'The daemon restarted before this turn finished.' });
  }

  history(ref: BriefTurnRef): LLMMessage[] {
    const turn = this.get(ref);
    return this.db.query<{ role: 'user' | 'assistant'; content: string }, [string, string, string]>(`SELECT role, content FROM conversation_messages
      WHERE conversation_id = ? AND role IN ('user', 'assistant') AND id NOT IN (?, ?)
      ORDER BY created_at DESC, id DESC LIMIT 80`).all(turn.conversationId, turn.userMessageId, turn.assistantMessageId).reverse();
  }

  snapshot(conversationId: string, afterSequence: number) {
    this.conversations.get(conversationId);
    const sequence = this.sequence(conversationId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > sequence) throw new ConversationRequestError('Invalid event cursor');
    const rows = this.db.query<BriefTurnRef & { eventId: string; sequence: number; payload: string }, [string, number]>(`SELECT e.conversation_id AS conversationId,
      e.turn_id AS turnId, t.request_id AS requestId, e.event_id AS eventId, e.sequence, e.payload
      FROM brief_chat_events e JOIN brief_chat_turns t ON t.turn_id = e.turn_id
      WHERE e.conversation_id = ? AND e.sequence > ? ORDER BY e.sequence LIMIT 501`).all(conversationId, afterSequence);
    const events: BriefChatEvent[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, 500)) {
      const size = Buffer.byteLength(row.payload);
      if (events.length && bytes + size > 1_048_576) break;
      events.push({ ...row, payload: JSON.parse(row.payload) });
      bytes += size;
    }
    const hasMore = rows.length > events.length;
    const nextSequence = hasMore ? events.at(-1)!.sequence : sequence;
    const turns = this.db.query<ChatTurn, [string]>(`SELECT ${projection} FROM brief_chat_turns WHERE conversation_id = ?
      ORDER BY created_at DESC, turn_id DESC LIMIT 50`).all(conversationId).map(({ text: _input, ...turn }) => ({ ...turn, speak: Boolean(turn.speak), attachments: this.attachments.forTurn(turn.conversationId, turn.turnId) }));
    return { conversationId, sequence, nextSequence, hasMore, events, turns, messages: this.conversations.messages(conversationId, { limit: 10 }) };
  }

  sequence(conversationId: string): number {
    this.conversations.get(conversationId);
    return this.db.query<{ sequence: number }, [string]>('SELECT sequence FROM brief_chat_sequences WHERE conversation_id = ?').get(conversationId)?.sequence ?? 0;
  }

  /** Audio is transient: allocate its order durably, but never retain/replay audio bytes. */
  nextSequence(conversationId: string): number {
    this.conversations.get(conversationId);
    const current = this.sequence(conversationId);
    if (current >= Number.MAX_SAFE_INTEGER) throw new Error('Chat event sequence exhausted');
    this.db.run(`INSERT INTO brief_chat_sequences (conversation_id, sequence) VALUES (?, 1)
      ON CONFLICT(conversation_id) DO UPDATE SET sequence = sequence + 1`, [conversationId]);
    return this.sequence(conversationId);
  }

  approval(ref: BriefTurnRef, approvalId: string, status: ApprovalStatus): BriefChatEvent {
    return this.db.transaction(() => {
      const turn = this.get(ref);
      this.db.run('INSERT OR IGNORE INTO brief_chat_approvals (approval_id, turn_id) VALUES (?, ?)', [approvalId, turn.turnId]);
      const owner = this.approvalOwner(approvalId);
      if (!owner || owner.turnId !== turn.turnId) throw new Error('Approval already belongs to another turn');
      return this.append(turn, { kind: 'approval', approvalId, status });
    })();
  }

  approvalOwner(approvalId: string): ChatTurn | null {
    const row = this.db.query<ChatTurn, [string, string]>(`SELECT ${projection} FROM brief_chat_turns
      WHERE workspace_id = ? AND turn_id = (SELECT turn_id FROM brief_chat_approvals WHERE approval_id = ?)`).get(this.workspaceId, approvalId);
    return row ? this.get(row) : null;
  }

  private ref(turn: BriefTurnRef): BriefTurnRef { return { conversationId: turn.conversationId, turnId: turn.turnId, requestId: turn.requestId }; }
  private append(turn: BriefTurnRef, payload: BriefChatPayload): BriefChatEvent {
    const event: BriefChatEvent = { ...this.ref(turn), eventId: crypto.randomUUID(), sequence: this.nextSequence(turn.conversationId), payload };
    this.db.run('INSERT INTO brief_chat_events (conversation_id, sequence, event_id, turn_id, payload) VALUES (?, ?, ?, ?, ?)',
      [turn.conversationId, event.sequence, event.eventId, turn.turnId, JSON.stringify(payload)]);
    return event;
  }
  private messageTime(conversationId: string): number {
    const latest = this.db.query<{ at: number | null }, [string]>('SELECT MAX(created_at) AS at FROM conversation_messages WHERE conversation_id = ?').get(conversationId)?.at ?? 0;
    return Math.max(Date.now(), latest + 1);
  }
}
