import type { BriefActivity, BriefChatEvent, BriefConversation, BriefPage, BriefTurnRef, BriefTurnState } from '../../../../src/brief/contracts';
import type { ConversationMessage } from '../../../../src/vault/conversations';
import type { ConversationTabs } from '../../../../src/vault/conversation-lifecycle';
import type { ChatTurnRepository } from '../../../../src/vault/chat-turns';

export type ChatSnapshot = ReturnType<ChatTurnRepository['snapshot']> & { subscribed: boolean };
export type ChatTurn = BriefTurnRef & { state: BriefTurnState; createdAt: number; assistantMessageId?: string; error?: { code: string; message: string } };
/** References only. F-05 owns file bytes, upload validation and submission binding. */
export interface ChatAttachment { attachmentId: string; name: string; size: number; mediaType: string; kind?: 'document' | 'image' | 'screenshot'; state?: 'uploading' | 'ready' | 'failed' | 'removing'; error?: string }
export interface ChatScroll { top: number; atBottom: boolean }
export type ChatActivity = BriefActivity & BriefTurnRef & {
  sequence: number;
  /** Stable placement; completion must not move a row to the end. */
  firstSequence: number;
  /** Entry animation is allowed only for a newly observed live start, never replay. */
  live: boolean;
};
export interface ConversationState {
  conversation: BriefConversation;
  messages: ConversationMessage[];
  turns: Record<string, ChatTurn>;
  activity: Record<string, ChatActivity>;
  approvals: Record<string, BriefTurnRef & { status: string; sequence: number }>;
  draft: string;
  attachments: ChatAttachment[];
  scroll: ChatScroll;
  unread: string[];
  readSequence: number;
  sequence: number;
  error: string | null;
  history: { state: 'idle' | 'loading' | 'ready' | 'error'; cursor: string | null; error?: string };
}
export interface ChatStoreState {
  workspaceId: string | null;
  order: string[];
  activeId: string | null;
  conversations: Record<string, ConversationState>;
  visible: boolean;
  persistenceError: string | null;
}
/**
 * removeItem, key and length let the store delete keys that hold nothing worth
 * keeping (#1088). A port without them stores empty values instead of removing
 * them, so a closed tab's view fields are overwritten with empties, not deleted.
 */
export type StoragePort = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem' | 'key' | 'length'>>;
type LocalState = Pick<ConversationState, 'draft' | 'attachments' | 'scroll' | 'unread' | 'readSequence'>;
type Projection = { messages: ConversationMessage[]; turns: Record<string, ChatTurn>; messageSequences: Map<string, number>; historyIds: Set<string> };
type Replay = { sequence: number; base: Projection; events: Map<string, BriefChatEvent> };
const localFields = ['draft', 'attachments', 'scroll', 'unread', 'readSequence'] as const;
/**
 * Fields that only restore how an open tab looked. A closed conversation keeps
 * its draft and attachment references (they survive close/reopen), never these.
 * Accepted cost: a conversation reopened in another window or after a reload
 * starts at the top with readSequence 0, so if it is reopened while the panel
 * is hidden its replayed answers show as unread until viewed.
 */
const viewFields: ReadonlySet<keyof LocalState> = new Set(['scroll', 'unread', 'readSequence']);
const terminal = (state: BriefTurnState) => ['completed', 'failed', 'cancelled'].includes(state);
const compareMessages = (a: ConversationMessage, b: ConversationMessage) => a.created_at - b.created_at || a.id.localeCompare(b.id);
const emptyLocal = (): LocalState => ({ draft: '', attachments: [], scroll: { top: 0, atBottom: true }, unread: [], readSequence: 0 });
const dictionary = <T>(): Record<string, T> => Object.create(null);

/** One store per authenticated workspace host, above rooms/themes/chat presentation. */
export class ConversationStore {
  private state: ChatStoreState = { workspaceId: null, order: [], activeId: null, conversations: dictionary(), visible: false, persistenceError: null };
  private listeners = new Set<() => void>();
  private replay = new Map<string, Replay>();
  private saved: Record<string, LocalState> = dictionary();
  /** Read-only fallback from the pre-field single-key format. */
  private legacy: Record<string, LocalState> = dictionary();
  /** Field keys this window read or wrote with a value; reset per workspace. */
  private present = new Set<string>();
  private storageKey = '';
  private requestErrors = new Map<string, string>();
  private dismissedFailures = new Map<string, string>();
  private consumedAttachments = new Map<string, Set<string>>();
  constructor(private readonly storage?: StoragePort) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private publish(persist = false) {
    if (persist && this.storage && this.storageKey) {
      try {
        const empty = emptyLocal();
        for (const [id, chat] of Object.entries(this.state.conversations)) {
          const saved = this.saved[id] ?? emptyLocal();
          for (const field of localFields) {
            // Each actual field edit is one atomic storage write. Another window's
            // draft cannot be replaced by this window's stream/scroll/read updates.
            // A closed tab persists no view state; it comes back if reopened here.
            const next = !chat.conversation.tab.open && viewFields.has(field) ? empty[field] : chat[field];
            if (JSON.stringify(next) !== JSON.stringify(saved[field])) {
              this.write(id, field, next);
              this.saved[id] = { ...(this.saved[id] ?? saved), [field]: next };
            }
          }
        }
        this.state = { ...this.state, persistenceError: null };
      } catch { this.state = { ...this.state, persistenceError: 'Chat changes are kept in this window but could not be saved on this device.' }; }
    }
    for (const listener of this.listeners) listener();
  }

  private fieldKey(id: string, field: keyof LocalState) {
    return `${this.storageKey}.field.${encodeURIComponent(id)}.${field}`;
  }

  /** True when an absent key reads back as the empty default for this field. */
  private removable(id: string, field: keyof LocalState, value: unknown) {
    const empty = JSON.stringify(emptyLocal()[field]);
    return !!this.storage?.removeItem && JSON.stringify(value) === empty
      && JSON.stringify(this.legacy[id]?.[field] ?? emptyLocal()[field]) === empty;
  }

  /** An empty field is removed rather than stored, so used conversations leave no keys behind (#1088). */
  private write(id: string, field: keyof LocalState, value: unknown) {
    const key = this.fieldKey(id, field);
    if (this.removable(id, field, value)) { this.storage!.removeItem!(key); this.present.delete(key); }
    else { this.storage!.setItem(key, JSON.stringify(value)); this.present.add(key); }
  }

  /**
   * Removes view-state keys of conversations that are not open tabs, including
   * keys left by other windows or older versions. Drafts and attachment
   * references are never swept: they are the user's unsent work, and another
   * window may be writing them.
   */
  private sweep(open: Set<string>) {
    const storage = this.storage;
    if (!storage?.removeItem || !storage.key || typeof storage.length !== 'number') return;
    const prefix = `${this.storageKey}.field.`, stale: string[] = [];
    try {
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length), dot = rest.lastIndexOf('.');
        const field = rest.slice(dot + 1) as keyof LocalState;
        if (dot < 1 || !viewFields.has(field)) continue;
        let id: string;
        try { id = decodeURIComponent(rest.slice(0, dot)); } catch { continue; }
        if (!open.has(id) && this.removable(id, field, emptyLocal()[field])) stale.push(key);
      }
      for (const key of stale) storage.removeItem(key);
    } catch { /* Cleanup is best effort; it never blocks opening the workspace. */ }
  }

  private localState(id: string): LocalState {
    let local = this.saved[id] ?? emptyLocal();
    for (const field of localFields) {
      try {
        const raw = this.storage?.getItem(this.fieldKey(id, field));
        if (raw != null) { this.present.add(this.fieldKey(id, field)); local = readLocal({ ...local, [field]: JSON.parse(raw) }) ?? local; }
      } catch { /* Preserve other fields and the legacy fallback if one key is corrupt. */ }
    }
    this.saved[id] = local;
    return local;
  }

  restoreTabs(tabs: ConversationTabs) {
    let sweep = false;
    if (this.state.workspaceId !== tabs.workspaceId) {
      this.replay.clear(); this.saved = dictionary(); this.legacy = dictionary(); this.present.clear(); sweep = true;
      this.requestErrors.clear(); this.dismissedFailures.clear();
      this.consumedAttachments.clear();
      this.state = { ...this.state, workspaceId: tabs.workspaceId, conversations: dictionary(), persistenceError: null };
      this.storageKey = `jarvis.brief.chat.v1.${encodeURIComponent(tabs.workspaceId)}`;
      try {
        const value = JSON.parse(this.storage?.getItem(this.storageKey) ?? 'null');
        if (value?.version === 1 && value.conversations && typeof value.conversations === 'object') {
          for (const [id, saved] of Object.entries(value.conversations)) {
            const local = readLocal(saved);
            if (local) { this.saved[id] = local; this.legacy[id] = local; }
          }
        }
      } catch { /* Bad/blocked storage never prevents a server-backed conversation from opening. */ }
    }
    const conversations = { ...this.state.conversations };
    for (const [id, chat] of Object.entries(conversations)) {
      conversations[id] = { ...chat, conversation: { ...chat.conversation, tab: { ...chat.conversation.tab, open: false } } };
    }
    for (const conversation of tabs.tabs) {
      if (conversation.workspaceId !== tabs.workspaceId) throw new Error('Conversation workspace mismatch');
      conversations[conversation.conversationId] = this.entry(conversation, conversations[conversation.conversationId]);
    }
    const order = tabs.tabs.map(chat => chat.conversationId);
    this.state = { ...this.state, conversations, order, activeId: tabs.activeConversationId && order.includes(tabs.activeConversationId) ? tabs.activeConversationId : null };
    // Once per workspace load: later restores (tab select, reconnect) add nothing
    // a reload would not sweep, and each sweep walks all of localStorage.
    this.markViewed(); this.publish(true); if (sweep) this.sweep(new Set(order));
  }

  private entry(conversation: BriefConversation, existing?: ConversationState): ConversationState {
    if (existing) return { ...existing, conversation };
    this.replay.set(conversation.conversationId, { sequence: 0, base: { messages: [], turns: dictionary(), messageSequences: new Map(), historyIds: new Set() }, events: new Map() });
    return { conversation, messages: [], turns: dictionary(), activity: dictionary(), approvals: dictionary(),
      ...this.localState(conversation.conversationId), sequence: 0, error: null, history: { state: 'idle', cursor: null } };
  }
  putConversation(conversation: BriefConversation, select = false) {
    if (conversation.workspaceId !== this.state.workspaceId) throw new Error('Conversation workspace mismatch');
    const id = conversation.conversationId;
    const conversations = { ...this.state.conversations, [id]: this.entry(conversation, this.state.conversations[id]) };
    const order = Object.values(conversations).filter(chat => chat.conversation.tab.open)
      .sort((a, b) => a.conversation.tab.order - b.conversation.tab.order || a.conversation.conversationId.localeCompare(b.conversation.conversationId))
      .map(chat => chat.conversation.conversationId);
    const activeId = select ? id : this.state.activeId === id && !conversation.tab.open ? this.adjacent(id) : this.state.activeId;
    this.state = { ...this.state, conversations, order, activeId };
    this.markViewed(); this.publish(true);
  }
  select(id: string | null) {
    if (id !== null && !this.state.order.includes(id)) throw new Error('Conversation tab is not open');
    this.state = { ...this.state, activeId: id }; this.markViewed(); this.publish(true);
  }
  adjacent(id: string): string | null {
    const index = this.state.order.indexOf(id);
    return this.state.order[index + 1] ?? this.state.order[index - 1] ?? null;
  }
  setVisible(visible: boolean) { this.state = { ...this.state, visible }; this.markViewed(); this.publish(true); }
  setDraft(id: string, draft: string) { this.update(id, { draft }); }
  acceptDraft(id: string, text: string) {
    if (this.state.conversations[id]?.draft !== text) return;
    try {
      const raw = this.storage?.getItem(this.fieldKey(id, 'draft'));
      const saved = raw == null ? text : JSON.parse(raw);
      if (typeof saved === 'string' && saved !== text) {
        // Acceptance in this window must not erase a newer edit saved elsewhere.
        this.saved[id] = { ...(this.saved[id] ?? emptyLocal()), draft: saved };
        this.update(id, { draft: saved }, false);
        return;
      }
    } catch { return; /* Keep the draft if its latest saved value cannot be checked. */ }
    this.setDraft(id, '');
  }
  setError(id: string, error: string | null) {
    if (error === null) this.requestErrors.delete(id); else this.requestErrors.set(id, error);
    this.update(id, {}, false);
  }
  dismissError(id: string) {
    const turn = latestTurn(this.state.conversations[id]?.turns ?? {});
    if (turn) this.dismissedFailures.set(id, turn.turnId);
    this.setError(id, null);
  }
  acceptAttachments(id: string, ids: string[]) {
    const chat = this.state.conversations[id]; if (!chat || !ids.length) return;
    const consumed = this.consumedAttachments.get(id) ?? new Set<string>();
    for (const attachmentId of ids) consumed.add(attachmentId);
    this.consumedAttachments.set(id, consumed);
    let items = chat.attachments;
    try {
      const raw = this.storage?.getItem(this.fieldKey(id, 'attachments'));
      // With removal on, an absent key that this window saw present is another
      // window's cleared list. One this window never managed to save (quota)
      // still holds only this window's references.
      const key = this.fieldKey(id, 'attachments');
      if (raw == null && this.storage?.removeItem && this.present.has(key)) { this.present.delete(key); items = []; }
      else if (raw != null) {
        const latest = readLocal({ ...emptyLocal(), attachments: JSON.parse(raw) });
        // Merge the latest saved references before clearing accepted identities.
        if (latest) items = latest.attachments;
      }
    } catch { /* Canonical acceptance still clears this window when storage is unavailable. */ }
    this.setAttachments(id, items);
  }
  setAttachments(id: string, attachments: ChatAttachment[]) {
    // Canonical consumption is permanent, including across delayed composer writes.
    this.update(id, { attachments: attachments.filter(item => !this.consumedAttachments.get(id)?.has(item.attachmentId)).map(({ attachmentId, name, size, mediaType, kind, state, error }) => ({ attachmentId, name, size, mediaType, ...(kind ? { kind } : {}), ...(state ? { state } : {}), ...(error ? { error } : {}) })) });
  }
  setScroll(id: string, scroll: ChatScroll) { this.update(id, { scroll: { top: Math.max(0, Number.isFinite(scroll.top) ? scroll.top : 0), atBottom: scroll.atBottom } }); }
  private update(id: string, patch: Partial<ConversationState>, persist = true) {
    const chat = this.state.conversations[id]; if (!chat) return;
    const updated = { ...chat, ...patch }, turn = latestTurn(updated.turns);
    updated.error = this.requestErrors.get(id) ?? (turn?.state === 'failed' && this.dismissedFailures.get(id) !== turn.turnId
      ? turn.error?.message ?? 'This response could not finish. You can send a new message to try again.' : null);
    this.state = { ...this.state, conversations: { ...this.state.conversations, [id]: updated } };
    this.markViewed(); this.publish(persist);
  }
  private markViewed() {
    const chat = this.state.activeId && this.state.conversations[this.state.activeId];
    if (!this.state.visible || !chat) return;
    this.state = { ...this.state, conversations: { ...this.state.conversations, [chat.conversation.conversationId]: {
      ...chat, unread: [], readSequence: Math.max(chat.readSequence, chat.sequence),
    } } };
  }

  applyEvent(event: BriefChatEvent, timestamp: number): boolean {
    const id = event.conversationId, chat = this.state.conversations[id], replay = this.replay.get(id);
    if (!chat || !replay) return false;
    if (replay.events.has(event.eventId)) return false;
    if (event.sequence > replay.sequence) replay.events.set(event.eventId, event);
    const metadata = this.metadata(chat, [event]);
    const { messageSequences: _watermarks, historyIds: _history, ...projected } = project(replay, timestamp);
    this.update(id, { ...metadata, ...projected, sequence: Math.max(chat.sequence, event.sequence) });
    if (event.payload.kind === 'message') this.acceptAttachments(id, event.payload.message.attachments?.map(ref => ref.attachmentId) ?? []);
    return replay.events.size >= 500;
  }
  applySnapshot(snapshot: ChatSnapshot) {
    const id = snapshot.conversationId, chat = this.state.conversations[id], replay = this.replay.get(id);
    if (!chat || !replay) return;
    if (snapshot.nextSequence >= replay.sequence) {
      for (const event of snapshot.events) if (event.sequence > replay.sequence) replay.events.set(event.eventId, event);
      // Only compact the replay prefix actually delivered, not the snapshot's
      // later watermark. Subsequent pages may contain messages outside its tail.
      const prefix = project({ ...replay, events: new Map([...replay.events].filter(([, event]) => event.sequence <= snapshot.nextSequence)) }, Date.now());
      const messages = new Map(prefix.messages.map(row => [row.id, row]));
      for (const row of snapshot.messages.items) if (snapshot.sequence >= (prefix.messageSequences.get(row.id) ?? 0)) {
        messages.set(row.id, row); prefix.messageSequences.set(row.id, snapshot.sequence);
        prefix.historyIds.delete(row.id);
      }
      const turns = { ...prefix.turns };
      for (const turn of snapshot.turns) turns[turn.turnId] = { ...turns[turn.turnId], ...turn };
      replay.base = { messages: [...messages.values()].sort(compareMessages), turns, messageSequences: prefix.messageSequences, historyIds: prefix.historyIds };
      replay.sequence = snapshot.nextSequence;
      for (const [key, event] of replay.events) if (event.sequence <= snapshot.nextSequence) replay.events.delete(key);
    }
    const metadata = this.metadata(chat, snapshot.events, false);
    const { messageSequences: _watermarks, historyIds: _history, ...projected } = project(replay, Date.now());
    this.update(id, { ...metadata, ...projected, sequence: Math.max(chat.sequence, snapshot.sequence),
      // A reconnect must not rewind the older-history cursor already consumed by the reader.
      history: chat.history.state === 'idle' ? { state: 'ready', cursor: snapshot.messages.nextCursor } : chat.history });
    this.acceptAttachments(id, [
      ...snapshot.messages.items.flatMap(message => message.attachments ?? []),
      ...snapshot.turns.flatMap(turn => turn.attachments ?? []),
      ...snapshot.events.flatMap(event => event.payload.kind === 'message' ? event.payload.message.attachments ?? [] : []),
    ].map(ref => ref.attachmentId));
  }
  private metadata(chat: ConversationState, events: BriefChatEvent[], live = true) {
    const activity = Object.fromEntries(Object.entries(chat.activity).map(([id, value]) => [id, live ? value : { ...value, live: false }]));
    const approvals = { ...chat.approvals }, unread = new Set(chat.unread);
    for (const event of events) {
      const { payload, sequence, conversationId, turnId, requestId } = event;
      const ref = { conversationId, turnId, requestId, sequence };
      if (payload.kind === 'activity') {
        const prior = activity[payload.activity.activityId];
        const firstSequence = Math.min(prior?.firstSequence ?? sequence, sequence);
        if (prior && (sequence <= prior.sequence || prior.phase !== 'started')) {
          activity[payload.activity.activityId] = { ...prior, firstSequence };
        } else activity[payload.activity.activityId] = { ...payload.activity, ...ref, firstSequence,
          live: live && !prior && payload.activity.phase === 'started' };
      }
      if (payload.kind === 'approval' && sequence > (approvals[payload.approvalId]?.sequence ?? -1)) approvals[payload.approvalId] = { ...ref, status: payload.status };
      if (payload.kind === 'delta' && sequence > chat.readSequence) unread.add(payload.messageId);
    }
    return { activity, approvals, unread: [...unread] };
  }
  setHistoryState(id: string, state: ConversationState['history']['state'], error?: string) {
    const chat = this.state.conversations[id]; if (chat) this.update(id, { history: { ...chat.history, state, error } }, false);
  }
  applyHistory(id: string, page: BriefPage<ConversationMessage>) {
    const replay = this.replay.get(id); if (!replay) return;
    // History has no event watermark. It can fill gaps, never replace a row updated by a stream/snapshot.
    const liveIds = new Set(this.state.conversations[id]?.messages.map(row => row.id));
    const messages = new Map(page.items.filter(row => !liveIds.has(row.id)).map(row => [row.id, row]));
    for (const messageId of messages.keys()) replay.base.historyIds.add(messageId);
    for (const row of replay.base.messages) messages.set(row.id, row);
    replay.base = { ...replay.base, messages: [...messages.values()].sort(compareMessages) };
    const { messageSequences: _watermarks, historyIds: _history, ...projected } = project(replay, Date.now());
    this.update(id, { ...projected, history: { state: 'ready', cursor: page.nextCursor } }, false);
    this.acceptAttachments(id, page.items.flatMap(message => message.attachments ?? []).map(ref => ref.attachmentId));
  }
}

/** D-15 consumes this order and the live hint without inventing replay animations. */
export function orderedActivities(chat: ConversationState): ChatActivity[] {
  return Object.values(chat.activity).sort((a, b) => a.firstSequence - b.firstSequence || a.activityId.localeCompare(b.activityId));
}

function project(replay: Replay, timestamp: number): Projection {
  const messages = new Map(replay.base.messages.map(row => [row.id, row]));
  const messageSequences = new Map(replay.base.messageSequences);
  const historyIds = new Set(replay.base.historyIds);
  const turns = { ...replay.base.turns };
  for (const event of [...replay.events.values()].sort((a, b) => a.sequence - b.sequence)) {
    const { conversationId, turnId, requestId, payload } = event;
    const turn: ChatTurn = turns[turnId] ?? { conversationId, turnId, requestId, state: 'queued', createdAt: timestamp };
    if (payload.kind === 'message') {
      const row = payload.message;
      if (event.sequence > (messageSequences.get(row.messageId) ?? 0)) {
        messages.set(row.messageId, { id: row.messageId, conversation_id: conversationId, role: row.role, content: row.content, created_at: row.createdAt, tool_calls: null, ...(row.attachments?.length ? { attachments: row.attachments } : {}) });
        messageSequences.set(row.messageId, event.sequence);
        historyIds.delete(row.messageId);
      }
      turns[turnId] = { ...turn, createdAt: row.createdAt };
    } else if (payload.kind === 'delta') {
      // REST rows have no sequence. If replay reaches a history-only answer,
      // reconstruct it from its events rather than appending to its full text.
      if (historyIds.delete(payload.messageId)) {
        const historical = messages.get(payload.messageId);
        if (historical) messages.set(payload.messageId, { ...historical, content: '' });
      }
      const row = messages.get(payload.messageId) ?? { id: payload.messageId, conversation_id: conversationId, role: 'assistant' as const, content: '', created_at: turn.createdAt + 1, tool_calls: null };
      if (event.sequence > (messageSequences.get(row.id) ?? 0)) {
        messages.set(row.id, { ...row, content: row.content + payload.text });
        messageSequences.set(row.id, event.sequence);
      }
      turns[turnId] = { ...turn, assistantMessageId: row.id };
    } else if (payload.kind === 'status' && !terminal(turn.state)) turns[turnId] = { ...turn, state: payload.state };
    else if (payload.kind === 'terminal') turns[turnId] = { ...turn, state: payload.state, error: payload.error };
  }
  return { messages: [...messages.values()].sort(compareMessages), turns, messageSequences, historyIds };
}

function latestTurn(turns: Record<string, ChatTurn>) {
  return Object.values(turns).reduce<ChatTurn | undefined>((latest, turn) => !latest || turn.createdAt > latest.createdAt
    || (turn.createdAt === latest.createdAt && turn.turnId > latest.turnId) ? turn : latest, undefined);
}

function readLocal(value: unknown): LocalState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as LocalState;
  if (typeof v.draft !== 'string' || !Array.isArray(v.attachments) || !v.attachments.every(a => a && typeof a.attachmentId === 'string' && typeof a.name === 'string' && typeof a.mediaType === 'string' && Number.isFinite(a.size) && a.size >= 0)
    || !v.scroll || !Number.isFinite(v.scroll.top) || v.scroll.top < 0 || typeof v.scroll.atBottom !== 'boolean'
    || !Array.isArray(v.unread) || !v.unread.every(id => typeof id === 'string') || !Number.isSafeInteger(v.readSequence) || v.readSequence < 0) return null;
  return { draft: v.draft, attachments: v.attachments.map(a => ({ attachmentId: a.attachmentId, name: a.name, mediaType: a.mediaType, size: a.size, ...(a.kind ? { kind: a.kind } : {}), ...(a.state ? { state: a.state } : {}), ...(a.error ? { error: a.error } : {}) })),
    scroll: { top: v.scroll.top, atBottom: v.scroll.atBottom }, unread: [...new Set(v.unread)], readSequence: v.readSequence };
}
