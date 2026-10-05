import { isBriefCapabilityEnabled } from '../../../../src/brief/capabilities';
import type { BriefChatEvent, BriefSendTurn, BriefTurnRef } from '../../../../src/brief/contracts';
import { uuid } from '../../lib/uuid';
import type { WebSocketChatAdapter, WSMessage } from '../../hooks/useWebSocket';
import type { ConversationTabs } from '../../../../src/vault/conversation-lifecycle';
import { ChatApiError, conversationApi, isMessagePage, type ConversationApi } from './api';
import { ConversationStore, type ChatSnapshot } from './store';

export interface ChatClientState {
  mode: 'disabled' | 'loading' | 'scoped' | 'legacy' | 'unavailable';
  reason: string | null;
  error: string | null;
  connected: boolean;
  pending: number;
  pendingSends: BriefTurnRef[];
}
const canUseChat = (value: unknown) => (['conversations', 'chatTransport', 'chatState'] as const).every(id => isBriefCapabilityEnabled(value, id));
const activeTurn = (state: string) => state === 'queued' || state === 'running';

/** HTTP mutations are serialized. Streams/history always address their captured conversation ID. */
export class BriefConversationClient {
  readonly store: ConversationStore;
  private state: ChatClientState = { mode: 'disabled', reason: null, error: null, connected: false, pending: 0, pendingSends: [] };
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private generation = 0;
  private socket: WebSocket | null = null;
  private syncRequests = new Map<string, { id: string; after: number }>();
  private subscriptions = new Set<string>();
  private checkpoints = new Map<string, number>();
  private historyRequests = new Map<string, symbol>();
  private outbox = new Map<string, BriefSendTurn>();
  private queue: Promise<unknown> = Promise.resolve();
  readonly adapter: WebSocketChatAdapter;
  constructor(private readonly api: ConversationApi = conversationApi(), storage?: Pick<Storage, 'getItem' | 'setItem'>) {
    this.store = new ConversationStore(storage);
    this.adapter = {
      onOpen: socket => { void this.openSocket(socket); },
      onClose: () => { this.socket = null; this.syncRequests.clear(); this.subscriptions.clear(); this.patch({ connected: false }); },
      onMessage: frame => this.receive(frame),
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(patch: Partial<ChatClientState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  async start() {
    this.stop();
    this.lifetime = new AbortController(); const generation = this.generation;
    this.patch({ mode: 'loading', reason: null, error: null });
    try {
      const capabilities = await this.api.capabilities(this.lifetime.signal);
      if (generation !== this.generation) return;
      if (!canUseChat(capabilities)) { this.patch({ mode: 'legacy', reason: 'Conversation tabs are not enabled on this backend.' }); return; }
      const tabs = await this.api.tabs(this.lifetime.signal);
      if (generation !== this.generation) return;
      if (this.store.getSnapshot().workspaceId !== tabs.workspaceId) { this.checkpoints.clear(); this.outbox.clear(); this.publishOutbox(); }
      this.store.restoreTabs(tabs); this.patch({ mode: 'scoped' });
    } catch (error) {
      if (generation !== this.generation) return;
      this.failedDiscovery(error);
    }
  }
  stop() {
    this.generation++; this.lifetime.abort(); this.socket = null;
    this.syncRequests.clear(); this.subscriptions.clear();
    for (const id of this.historyRequests.keys()) this.store.setHistoryState(id, 'error', 'Earlier message loading was interrupted.');
    this.historyRequests.clear(); this.queue = Promise.resolve();
    this.patch({ mode: 'disabled', connected: false, pending: 0 });
  }
  private failedDiscovery(error: unknown) {
    if (error instanceof ChatApiError && (error.status === 404 || error.status === 501)) this.patch({ mode: 'legacy', reason: 'This backend supports single chat only.', connected: false });
    else this.patch({ mode: 'unavailable', reason: 'Conversation state could not be loaded. Retry when the backend is available.', connected: false });
  }
  private async openSocket(socket: WebSocket) {
    const generation = this.generation;
    this.socket = socket; this.syncRequests.clear(); this.subscriptions.clear();
    try {
      // Recheck readiness on each actual connection, never on room/theme renders.
      const capabilities = await this.api.capabilities(this.lifetime.signal);
      if (generation !== this.generation || this.socket !== socket) return;
      if (!canUseChat(capabilities)) { this.patch({ mode: 'legacy', reason: 'Conversation tabs are no longer enabled.', connected: false }); return; }
      const restore = this.queue.then(async () => {
        if (generation !== this.generation || this.socket !== socket) return;
        const tabs = await this.api.tabs(this.lifetime.signal);
        if (generation !== this.generation || this.socket !== socket) return;
        this.store.restoreTabs(tabs); this.patch({ connected: true, error: null });
        for (const id of this.store.getSnapshot().order) this.sync(id, this.checkpoints.get(id) ?? 0);
      });
      this.queue = restore.catch(() => {});
      await restore;
    } catch (error) {
      if (generation === this.generation && this.socket === socket) this.failedDiscovery(error);
    }
  }
  private sendFrame(type: string, payload: unknown, id = uuid()) {
    if (!this.socket || this.socket.readyState !== 1) throw new Error('Chat is disconnected.');
    this.socket.send(JSON.stringify({ type, payload, id, timestamp: Date.now() }));
    return id;
  }
  private restoreTabs(tabs: ConversationTabs) {
    this.store.restoreTabs(tabs);
    if (!this.state.connected) return;
    const open = new Set(this.store.getSnapshot().order);
    for (const id of new Set([...this.subscriptions, ...this.syncRequests.keys()])) if (!open.has(id)) {
      this.sendFrame('brief_chat_unsubscribe', { conversationId: id });
      this.subscriptions.delete(id); this.syncRequests.delete(id);
    }
    for (const id of open) if (!this.subscriptions.has(id)) this.sync(id, this.checkpoints.get(id) ?? 0);
  }
  private sync(id: string, after: number) {
    if (!this.state.connected || this.syncRequests.has(id) || !this.store.getSnapshot().order.includes(id)) return;
    const requestId = uuid(); this.syncRequests.set(id, { id: requestId, after });
    try { this.sendFrame('brief_chat_subscribe', { conversationId: id, afterSequence: after }, requestId); }
    catch { this.syncRequests.delete(id); this.store.setError(id, 'Conversation could not be synchronized.'); }
  }
  private receive(frame: WSMessage): boolean {
    if (!frame.type.startsWith('brief_chat_')) {
      // Scoped sockets must never adopt the old global chat/voice stream as a tab's content.
      return ['chat', 'stream', 'status', 'thinking_start', 'thinking_end', 'realtime_transcript', 'tts_start', 'tts_text', 'tts_end'].includes(frame.type);
    }
    const payload = frame.payload;
    if (!payload || typeof payload.conversationId !== 'string') return true;
    const id = payload.conversationId;
    if (!this.store.getSnapshot().conversations[id]) return true;
    if (frame.type === 'brief_chat_event' && isChatEvent(payload)) {
      if (this.store.applyEvent(payload, frame.timestamp)) this.sync(id, this.store.getSnapshot().conversations[id]!.sequence);
      if (payload.payload.kind === 'message' || payload.payload.kind === 'terminal') this.accepted(payload.requestId);
    } else if (frame.type === 'brief_chat_sync') {
      const pending = this.syncRequests.get(id);
      if (!pending || frame.id !== pending.id) return true;
      if (!isSnapshot(payload) || payload.nextSequence < pending.after || (payload.hasMore && payload.nextSequence <= pending.after)) {
        this.syncRequests.delete(id); this.store.setError(id, 'Invalid conversation synchronization response.'); return true;
      }
      this.syncRequests.delete(id); this.store.applySnapshot(payload); this.store.setError(id, null);
      for (const turn of payload.turns) this.accepted(turn.requestId);
      if (payload.hasMore) this.sync(id, payload.nextSequence);
      else {
        this.subscriptions.add(id); this.checkpoints.set(id, payload.nextSequence);
        // An uncertain send keeps its original identity. It can never become a second model turn.
        for (const input of this.outbox.values()) if (input.conversationId === id) this.sendFrame('brief_chat_send', input, input.requestId);
      }
    } else if (frame.type === 'brief_chat_ack' && typeof payload.requestId === 'string') {
      // Duplicate send acknowledgments may have no replay; restore canonical message IDs.
      if (payload.duplicate) this.sync(id, 0);
    } else if (frame.type === 'brief_chat_error') {
      if (typeof payload.requestId === 'string') { this.outbox.delete(payload.requestId); this.publishOutbox(); }
      const pending = this.syncRequests.get(id);
      if (pending?.id === frame.id) this.syncRequests.delete(id);
      this.store.setError(id, typeof payload.message === 'string' ? payload.message : 'Conversation request failed.');
    }
    return true;
  }
  private accepted(requestId: string) {
    const input = this.outbox.get(requestId);
    if (input && this.store.getSnapshot().conversations[input.conversationId]?.draft === input.text) this.store.setDraft(input.conversationId, '');
    this.outbox.delete(requestId);
    this.publishOutbox();
  }
  private publishOutbox() {
    this.patch({ pendingSends: [...this.outbox.values()].map(({ conversationId, turnId, requestId }) => ({ conversationId, turnId, requestId })) });
  }
  private mutate<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const generation = this.generation, signal = this.lifetime.signal;
    this.patch({ pending: this.state.pending + 1, error: null });
    const result = this.queue.then(async () => {
      if (generation !== this.generation || signal.aborted || this.state.mode !== 'scoped') throw new Error('Conversation state is not available.');
      try { return await operation(signal); }
      catch (error) {
        if (generation === this.generation) {
          this.patch({ error: error instanceof Error ? error.message : 'Conversation change failed.' });
          // Recover partial metadata writes without discarding drafts or any history.
          try { const tabs = await this.api.tabs(signal); if (generation === this.generation) this.restoreTabs(tabs); } catch { /* Keep the last known state and visible failure. */ }
        }
        throw error;
      }
    }).finally(() => { if (generation === this.generation) this.patch({ pending: this.state.pending - 1 }); });
    this.queue = result.catch(() => {}); return result;
  }
  add = () => this.mutate(async signal => {
    const conversation = await this.api.create(signal); if (signal.aborted) throw new Error('Conversation request was interrupted.');
    this.store.putConversation(conversation, true); this.sync(conversation.conversationId, 0); return conversation.conversationId;
  });
  select = (id: string | null) => this.mutate(async signal => {
    const tabs = await this.api.select(id, signal); if (!signal.aborted) this.restoreTabs(tabs);
  });
  close = (id: string) => this.mutate(async signal => {
    const state = this.store.getSnapshot(); if (!state.order.includes(id)) return;
    const next = state.activeId === id ? this.store.adjacent(id) : state.activeId;
    // Persist the neighbor before closing so F-02's first-tab fallback cannot replace it.
    if (state.activeId === id) await this.api.select(next, signal);
    const conversation = await this.api.tab(id, false, signal); if (signal.aborted) return;
    this.store.putConversation(conversation); this.store.select(next);
    this.syncRequests.delete(id); this.subscriptions.delete(id);
    if (this.state.connected) this.sendFrame('brief_chat_unsubscribe', { conversationId: id });
  });
  reopen = (id: string) => this.mutate(async signal => {
    const conversation = await this.api.tab(id, true, signal);
    await this.api.select(id, signal); if (signal.aborted) return;
    this.store.putConversation(conversation, true); this.sync(id, 0);
  });
  async loadOlder(id: string) {
    const chat = this.store.getSnapshot().conversations[id];
    if (!chat || this.state.mode !== 'scoped' || this.historyRequests.has(id) || (chat.history.state === 'ready' && chat.history.cursor === null)) return;
    const token = Symbol(), generation = this.generation;
    this.historyRequests.set(id, token); this.store.setHistoryState(id, 'loading');
    try {
      const page = await this.api.history(id, chat.history.cursor, this.lifetime.signal);
      if (generation === this.generation && this.historyRequests.get(id) === token) this.store.applyHistory(id, page);
    } catch {
      if (generation === this.generation && this.historyRequests.get(id) === token) this.store.setHistoryState(id, 'error', 'Earlier messages could not be loaded.');
    } finally { if (this.historyRequests.get(id) === token) this.historyRequests.delete(id); }
  }
  send(id: string, text: string): BriefTurnRef {
    const chat = this.store.getSnapshot().conversations[id];
    if (this.state.mode !== 'scoped' || !this.state.connected || !this.store.getSnapshot().order.includes(id) || !this.subscriptions.has(id) || this.syncRequests.has(id)) throw new Error('Wait for this conversation to synchronize.');
    if (!text.trim() || new TextEncoder().encode(text).length > 65_536) throw new Error('Enter a message of at most 65,536 bytes.');
    if (chat?.attachments.length) throw new Error('Attachment sending is not available yet.');
    if (Object.values(chat?.turns ?? {}).some(turn => activeTurn(turn.state)) || [...this.outbox.values()].some(turn => turn.conversationId === id)) throw new Error('This conversation already has an active turn.');
    const input = { conversationId: id, turnId: uuid(), requestId: uuid(), text, speak: false };
    this.store.setError(id, null);
    this.outbox.set(input.requestId, input);
    this.publishOutbox();
    try { this.sendFrame('brief_chat_send', input, input.requestId); }
    catch (error) { this.outbox.delete(input.requestId); this.publishOutbox(); throw error; }
    // Keep the draft until canonical acceptance. A failed/uncertain request must not erase it.
    return input;
  }
  cancel(ref: BriefTurnRef) {
    if (this.state.mode !== 'scoped') throw new Error('Conversation state is not available.');
    this.sendFrame('brief_chat_cancel', ref, ref.requestId);
  }
}

function isChatEvent(value: unknown): value is BriefChatEvent {
  const v = value as BriefChatEvent;
  if (!v || typeof v.conversationId !== 'string' || typeof v.turnId !== 'string' || typeof v.requestId !== 'string'
    || typeof v.eventId !== 'string' || !Number.isSafeInteger(v.sequence) || v.sequence < 1 || !v.payload) return false;
  const p = v.payload;
  switch (p.kind) {
    case 'message': return !!p.message && p.message.conversationId === v.conversationId && p.message.turnId === v.turnId && p.message.requestId === v.requestId && typeof p.message.messageId === 'string' && typeof p.message.content === 'string' && Number.isFinite(p.message.createdAt) && ['user', 'assistant', 'system'].includes(p.message.role);
    case 'delta': return typeof p.messageId === 'string' && typeof p.text === 'string';
    case 'status': return activeTurn(p.state);
    case 'terminal': return ['completed', 'failed', 'cancelled'].includes(p.state);
    case 'activity': return !!p.activity && typeof p.activity.activityId === 'string' && typeof p.activity.summary === 'string' && ['started', 'completed', 'failed'].includes(p.activity.phase) && Array.isArray(p.activity.refs);
    case 'approval': return typeof p.approvalId === 'string' && typeof p.status === 'string';
    default: return false;
  }
}
function isSnapshot(value: unknown): value is ChatSnapshot {
  const v = value as ChatSnapshot;
  return !!v && Number.isSafeInteger(v.sequence) && v.sequence >= 0 && Number.isSafeInteger(v.nextSequence) && v.nextSequence >= 0
    && v.nextSequence <= v.sequence && typeof v.hasMore === 'boolean' && v.subscribed === !v.hasMore
    && isMessagePage(v.messages, v.conversationId) && Array.isArray(v.events) && v.events.every(e => isChatEvent(e) && e.conversationId === v.conversationId && e.sequence <= v.sequence)
    && Array.isArray(v.turns) && v.turns.every(t => t && t.conversationId === v.conversationId && typeof t.turnId === 'string' && typeof t.requestId === 'string'
      && ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(t.state) && Number.isFinite(t.createdAt));
}
