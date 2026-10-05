import type { ServerWebSocket } from 'bun';
import type { Database } from 'bun:sqlite';
import type { ApprovalRequest } from '../authority/approval.ts';
import type { WSMessage } from '../comms/websocket.ts';
import type { TTSProvider } from '../comms/voice.ts';
import type { LLMMessage, LLMStreamEvent } from '../llm/provider.ts';
import { withExecutionScope } from '../actions/execution-scope.ts';
import { createLimiter } from '../util/concurrency.ts';
import { runWithOrigin } from '../llm/origin.ts';
import { getDb } from '../vault/schema.ts';
import { ChatTurnRepository, isTerminalTurn, type ChatTurn } from '../vault/chat-turns.ts';
import { ConversationRequestError } from '../vault/conversation-lifecycle.ts';
import type { BriefProvider } from './providers.ts';
import type { BriefChatEvent, BriefSendTurn, BriefTurnRef } from './contracts.ts';
import type { BriefCapabilities } from './capabilities.ts';
import { currentBriefTurn, withBriefTurn } from './chat-context.ts';

type Client = ServerWebSocket<unknown>;
export interface ScopedChatInput extends BriefTurnRef {
  text: string;
  history: LLMMessage[];
  contextKey: string;
  signal: AbortSignal;
}
export interface ScopedChatRunner {
  ready(): boolean;
  stream(input: ScopedChatInput): { stream: AsyncIterable<LLMStreamEvent>; onComplete: (text: string) => Promise<void> };
}

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ConversationRequestError('Invalid chat fields');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ConversationRequestError('Invalid chat identity');
  return value;
}
function ref(value: Record<string, unknown>): BriefTurnRef {
  return { conversationId: id(value.conversationId), turnId: id(value.turnId), requestId: id(value.requestId) };
}

/** Rejections echo only valid routing IDs, never arbitrary client payloads. */
export function safeChatIdentity(payload: unknown): Partial<BriefTurnRef> {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  return Object.fromEntries(['conversationId', 'turnId', 'requestId'].flatMap(key =>
    typeof data[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data[key] as string) ? [[key, data[key]]] : []));
}

/** Explicit subscribers only. Legacy clients never receive these frames or audio bytes. */
export class BriefChatTransport implements BriefProvider {
  readonly repository: ChatTurnRepository;
  private clients = new Map<Client, Set<string>>();
  private controllers = new Map<string, AbortController>();
  private audioOwners = new Map<string, { turn: ChatTurn; client: Client; started: boolean }>();
  private jobs = new Set<Promise<void>>();
  private stopped = false;
  private limit: ReturnType<typeof createLimiter>;

  constructor(private readonly deps: {
    db: Database;
    runner: ScopedChatRunner;
    send: (client: Client, message: WSMessage) => void;
    tts?: () => TTSProvider | null;
    workspaceId?: string;
    /** Test harnesses can interleave isolated fake runners; production stays at one. */
    concurrency?: number;
  }) {
    this.repository = new ChatTurnRepository(deps.db, deps.workspaceId);
    this.repository.recover();
    this.limit = createLimiter(deps.concurrency ?? 1);
  }

  readiness(): 'ready' | 'unavailable' {
    try { return !this.stopped && getDb() === this.deps.db && this.deps.runner.ready() ? 'ready' : 'unavailable'; }
    catch { return 'unavailable'; }
  }
  hasClient(client: Client): boolean { return this.clients.has(client); }
  detach(client: Client): void { this.endClientAudio(client); this.clients.delete(client); }
  async idle(): Promise<void> { await Promise.all([...this.jobs]); }
  stop(): void {
    this.stopped = true;
    for (const turn of this.repository.pending()) this.cancel(turn);
    this.clients.clear();
  }

  async handle(message: WSMessage, client: Client, capabilities: BriefCapabilities): Promise<void> {
    try {
      if (!capabilities.hasProvider('chatTransport', this)) throw new ConversationRequestError('Chat transport is unsupported', 409);
      // An admitted client can still cancel its turn while the agent drains.
      const admittedCancel = message.type === 'brief_chat_cancel' && this.hasClient(client);
      if (!capabilities.snapshot().capabilities.chatTransport.enabled && !admittedCancel) {
        this.send(client, 'brief_chat_error', { ...safeChatIdentity(message.payload), code: 'unavailable', message: 'Conversation chat is not enabled.' }, message.id);
        return;
      }
      switch (message.type) {
        case 'brief_chat_send': {
          const data = fields(message.payload, ['conversationId', 'turnId', 'requestId', 'text', 'speak']);
          const identity = ref(data);
          if (typeof data.text !== 'string' || !data.text.trim() || Buffer.byteLength(data.text) > 65_536 ||
              (data.speak !== undefined && typeof data.speak !== 'boolean')) throw new ConversationRequestError('Invalid chat text or speech setting');
          const input: BriefSendTurn = { ...identity, text: data.text, speak: Boolean(data.speak) };
          this.checkSubscription(client, input.conversationId);
          const accepted = this.repository.accept(input, () => {
            if (input.speak && !this.deps.tts?.()) throw new ConversationRequestError('Speech is unavailable', 409);
          });
          this.subscribe(client, input.conversationId);
          this.send(client, 'brief_chat_ack', { ...identity, state: accepted.turn.state, sequence: this.repository.sequence(input.conversationId), duplicate: !accepted.created }, input.requestId);
          for (const event of accepted.events) this.emit(event);
          if (accepted.created) this.schedule(accepted.turn, client);
          return;
        }
        case 'brief_chat_cancel': {
          const identity = ref(fields(message.payload, ['conversationId', 'turnId', 'requestId']));
          const turn = this.repository.get(identity);
          this.cancel(turn);
          this.send(client, 'brief_chat_ack', { ...identity, state: this.repository.get(identity).state, sequence: this.repository.sequence(identity.conversationId) }, identity.requestId);
          return;
        }
        case 'brief_chat_subscribe': {
          const data = fields(message.payload, ['conversationId', 'afterSequence']);
          const conversationId = id(data.conversationId);
          const snapshot = this.repository.snapshot(conversationId, (data.afterSequence ?? 0) as number);
          // Register only after catching up, synchronously with the final snapshot.
          // No live event can overtake a still-unread replay page on this socket.
          if (!this.clients.has(client)) this.clients.set(client, new Set());
          if (snapshot.hasMore) this.endClientAudio(client, conversationId);
          this.clients.get(client)!.delete(conversationId);
          if (!snapshot.hasMore) this.subscribe(client, conversationId);
          this.send(client, 'brief_chat_sync', { ...snapshot, subscribed: !snapshot.hasMore }, message.id);
          return;
        }
        case 'brief_chat_unsubscribe': {
          const data = fields(message.payload, ['conversationId']);
          const conversationId = id(data.conversationId);
          this.repository.conversations.get(conversationId);
          this.endClientAudio(client, conversationId);
          this.clients.get(client)?.delete(conversationId);
          this.send(client, 'brief_chat_ack', { conversationId, subscribed: false, sequence: this.repository.sequence(conversationId) }, message.id);
          return;
        }
      }
    } catch (error) {
      const safe = error instanceof ConversationRequestError;
      this.send(client, 'brief_chat_error', { ...safeChatIdentity(message.payload), code: safe ? String(error.status) : 'unavailable', message: safe ? error.message : 'Conversation chat is unavailable.' }, message.id);
    }
  }

  /** Requests retain their canonical approval ID even after cancellation, tab switch or restart. */
  approval(request: ApprovalRequest): boolean {
    const context = currentBriefTurn();
    const owner = context ?? this.repository.approvalOwner(request.id);
    if (!owner) return false;
    this.emit(this.repository.approval(owner, request.id, request.status));
    return true;
  }

  private subscribe(client: Client, conversationId: string): void {
    this.checkSubscription(client, conversationId);
    let subscriptions = this.clients.get(client);
    if (!subscriptions) { subscriptions = new Set(); this.clients.set(client, subscriptions); }
    subscriptions.add(conversationId);
  }
  private checkSubscription(client: Client, conversationId: string): void {
    const subscriptions = this.clients.get(client);
    if (subscriptions && subscriptions.size >= 50 && !subscriptions.has(conversationId)) throw new ConversationRequestError('Too many chat subscriptions', 409);
  }
  private send(client: Client, type: WSMessage['type'], payload: unknown, requestId?: string): void {
    try { this.deps.send(client, { type, payload, ...(requestId ? { id: requestId } : {}), timestamp: Date.now() }); }
    catch { this.detach(client); }
  }
  private emit(event: BriefChatEvent | null): void {
    if (!event) return;
    for (const [client, subscriptions] of this.clients) if (subscriptions.has(event.conversationId)) this.send(client, 'brief_chat_event', event, event.requestId);
  }
  private cancel(turn: ChatTurn): void {
    this.endAudio(turn.turnId, true);
    this.emit(this.repository.finish(turn, 'cancelled'));
    this.controllers.get(turn.turnId)?.abort(new DOMException('Turn cancelled', 'AbortError'));
  }
  private schedule(turn: ChatTurn, client: Client): void {
    const controller = new AbortController();
    this.controllers.set(turn.turnId, controller);
    // Admission owns speech even before synthesis starts. Leaving the chat
    // removes this entry permanently, so returning cannot join encoded audio
    // midway or unexpectedly start speech for a turn the user left.
    if (turn.speak) this.audioOwners.set(turn.turnId, { turn, client, started: false });
    const job = this.limit(() => this.execute(turn, client, controller), controller.signal).catch(error => {
      if (!controller.signal.aborted) console.error('[BriefChat] Turn storage became unavailable:', error instanceof Error ? error.name : 'unknown');
    }).finally(() => {
      this.audioOwners.delete(turn.turnId);
      this.controllers.delete(turn.turnId);
      this.jobs.delete(job);
    });
    this.jobs.add(job);
  }
  private endClientAudio(client: Client, conversationId?: string): void {
    for (const owner of this.audioOwners.values()) {
      if (owner.client === client && (!conversationId || owner.turn.conversationId === conversationId)) this.endAudio(owner.turn.turnId, true);
    }
  }
  private endAudio(turnId: string, cancelled: boolean): void {
    const owner = this.audioOwners.get(turnId);
    if (!owner) return;
    this.audioOwners.delete(turnId);
    const { turn, client } = owner;
    if (!owner.started || !this.clients.get(client)?.has(turn.conversationId)) return;
    this.send(client, 'brief_chat_audio', { conversationId: turn.conversationId, turnId, requestId: turn.requestId,
      sequence: this.repository.nextSequence(turn.conversationId), phase: 'end', cancelled }, turn.requestId);
  }
  private async execute(turn: ChatTurn, client: Client, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const identity = { conversationId: turn.conversationId, turnId: turn.turnId, requestId: turn.requestId };
    const progress = (phase: 'started' | 'completed' | 'failed') => {
      if (signal.aborted) return;
      this.emit(this.repository.activity(turn, { kind: 'activity', activity: {
        activityId: crypto.randomUUID(), phase,
        summary: phase === 'started' ? 'Working on your request.' : phase === 'completed' ? 'Work finished.' : 'Work could not finish.', refs: [],
      } }));
    };
    const audio = (payload: object) => {
      if (!this.audioOwners.has(turn.turnId) || !this.clients.get(client)?.has(turn.conversationId)) return;
      this.send(client, 'brief_chat_audio', { ...identity, sequence: this.repository.nextSequence(turn.conversationId), ...payload }, turn.requestId);
    };
    try {
      if (signal.aborted || isTerminalTurn(this.repository.get(turn).state)) return;
      this.emit(this.repository.start(turn));
      await runWithOrigin('user', () => withBriefTurn({ ...identity, signal, progress }, () => withExecutionScope(() => signal.throwIfAborted(), async () => {
        const history = this.repository.history(turn);
        const { stream, onComplete } = this.deps.runner.stream({ ...identity, text: turn.text, history, signal,
          contextKey: `brief:${this.repository.workspaceId}:${turn.conversationId}` });
        let fullText = '';
        let done = false;
        for await (const event of stream) {
          signal.throwIfAborted();
          if (event.type === 'text') {
            fullText += event.text;
            this.emit(this.repository.text(turn, event.text));
          } else if (event.type === 'tool_call') progress('started');
          else if (event.type === 'error') throw new Error('Model stream failed');
          else if (event.type === 'done') { done = true; break; }
        }
        signal.throwIfAborted();
        if (!done) throw new Error('Model stream ended without completion');
        const tts = turn.speak ? this.deps.tts?.() : null;
        const audioOwner = this.audioOwners.get(turn.turnId);
        if (tts && fullText && audioOwner) {
          audioOwner.started = true;
          audio({ phase: 'start' });
          try {
            for await (const chunk of tts.synthesizeStream(fullText)) {
              signal.throwIfAborted();
              if (!this.audioOwners.has(turn.turnId)) break;
              audio({ phase: 'chunk', data: Buffer.from(chunk).toString('base64') });
            }
          } finally { this.endAudio(turn.turnId, signal.aborted); }
        }
        signal.throwIfAborted();
        this.emit(this.repository.finish(turn, 'completed'));
        // Existing knowledge/personality processing stays outside stream completion.
        void onComplete(fullText).catch(error => console.error('[BriefChat] Post-processing failed:', error instanceof Error ? error.name : 'unknown'));
      }, signal)));
    } catch {
      this.endAudio(turn.turnId, signal.aborted);
      this.emit(this.repository.finish(turn, signal.aborted ? 'cancelled' : 'failed', signal.aborted ? undefined : {
        code: 'generation_failed', message: 'This response could not finish. You can send a new message to try again.',
      }));
    }
  }
}
