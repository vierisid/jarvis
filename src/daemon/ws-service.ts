/**
 * WebSocket Service — The Mouth
 *
 * Wraps WebSocketServer and StreamRelay. Routes incoming messages
 * to the AgentService and relays streamed responses back to clients.
 */

import type { ServerWebSocket } from 'bun';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Service, ServiceStatus } from './services.ts';
import type { AgentService } from './agent-service.ts';
import type { CommitmentExecutor } from './commitment-executor.ts';
import type { ChannelService } from './channel-service.ts';
import type { Commitment } from '../vault/commitments.ts';
import type { ContentItem } from '../vault/content-pipeline.ts';
import type { STTProvider, TTSProvider } from '../comms/voice.ts';
import { setDefaultCwd } from '../actions/tools/builtin.ts';
import type { ApprovalRequest, ApprovalManager } from '../authority/approval.ts';
import type { DeferredExecutor } from '../authority/deferred-executor.ts';
import type { EmergencyState } from '../authority/emergency.ts';
import type { AuditTrail } from '../authority/audit.ts';
import { impactFromCategory, gateVoiceApprovalResolution } from '../roles/authority.ts';
import type { ActionCategory } from '../roles/authority.ts';
import { classifyVoiceIntent, type RecentTurn } from '../agents/voice-intent-classifier.ts';
import { getUserProfile } from '../vault/user-profile.ts';
import { formatUserProfileForPrompt } from '../user/profile.ts';
import { routeByConfidence, intentToRoomKey, intentIsBackToThread, type Intent, type RoomKey } from '../voice/intent.ts';
import { matchWindowControl, type WindowControl } from '../voice/window-control.ts';
import { containsWakePhrase } from '../voice/wake-phrase.ts';
import {
  createInterviewSession,
  runInterviewTurn,
  type InterviewSession,
} from './onboarding-interviewer.ts';
import { getMessages } from '../vault/conversations.ts';
import { createCommitment, updateCommitmentStatus, updateCommitmentAssignee } from '../vault/commitments.ts';
import { recordAgentActivity } from '../vault/agent-activity.ts';
import { WebSocketServer, type WSMessage } from '../comms/websocket.ts';
import { StreamRelay } from '../comms/streaming.ts';
import { resolveRealtimeVoice, type ResolvedRealtimeVoice } from '../config/realtime.ts';
import { BrowserAudioTransport } from '../comms/audio-transport.ts';
import { RealtimeVoiceSession } from './realtime-voice.ts';
import { REALTIME_NAV_TOOLS, REALTIME_NAV_TOOL_NAMES } from './realtime-nav-tools.ts';
import { RealtimeBudgetTracker } from './realtime-budget.ts';
import { classifyErrorString } from '../llm/provider.ts';
import { getOrCreateConversation, addMessage } from '../vault/conversations.ts';
import { maybeCreateUserProfileFollowupPrompt, recordUserProfileTurn } from '../user/profile-followup.ts';

type VoiceSession = {
  requestId: string;
  chunks: Buffer[];
  startedAt: number;
  /** Phase 6.7.C — current Room key (or "home") at utterance start. */
  currentRoom?: string;
};

/**
 * A voice utterance that's been STT'd but is held pending user confirmation
 * because the classifier wasn't confident enough to act unilaterally. The
 * REST resolution endpoint looks up the pending entry by id and either
 * forwards `transcript` to handleChat (confirm) or drops it (cancel).
 */
type PendingVoiceConfirmation = {
  id: string;
  intent: Intent;
  transcript: string;
  ws: ServerWebSocket<unknown>;
  channel: string;
  kind: 'clarifier' | 'repeat_back';
  createdAt: number;
};

/**
 * Voice confirmations are dropped after this many ms without resolution.
 * Tuned so a user who walks away has plenty of time to come back, but a
 * busy operator who triages "sometime later" doesn't grow the map forever.
 */
const VOICE_CONFIRMATION_TTL_MS = 10 * 60_000;

/**
 * How often the sweep timer fires. 60s is a good balance — granular enough
 * that an expired card is dismissed within ~1 minute of its TTL, cheap
 * enough that the sweep itself is invisible on real workloads.
 */
const VOICE_CONFIRMATION_SWEEP_INTERVAL_MS = 60_000;

/**
 * Pure cleanup helper: removes every per-socket entry from the WS-service
 * maps when a client disconnects. Extracted so the cleanup contract can
 * be unit-tested without spinning up a real WebSocket server.
 *
 * Returns the number of pendingVoiceConfirmations entries removed (the
 * other two are at most 1 each — one entry per ws). Mostly useful so the
 * test can assert "we swept N abandoned cards" without re-querying.
 */
export function cleanupPerSocketMaps<W>(
  ws: W,
  voiceSessions: Map<W, unknown>,
  interviewSessions: Map<W, unknown>,
  pendingVoiceConfirmations: Map<string, { ws: W }>,
): { voiceRemoved: boolean; interviewRemoved: boolean; pendingRemoved: number } {
  const voiceRemoved = voiceSessions.delete(ws);
  const interviewRemoved = interviewSessions.delete(ws);
  let pendingRemoved = 0;
  for (const [id, pending] of pendingVoiceConfirmations) {
    if (pending.ws === ws) {
      pendingVoiceConfirmations.delete(id);
      pendingRemoved += 1;
    }
  }
  return { voiceRemoved, interviewRemoved, pendingRemoved };
}

/**
 * Pure TTL-sweep helper: removes pendingVoiceConfirmations entries older
 * than `ttlMs` and returns the ids of removed entries so the caller can
 * notify the originating clients (`voice_confirmation_expired`).
 *
 * Extracted so the TTL contract can be unit-tested deterministically by
 * passing an explicit `now` rather than relying on real time.
 */
export function sweepExpiredVoiceConfirmations<W>(
  pendingVoiceConfirmations: Map<string, { ws: W; createdAt: number }>,
  now: number,
  ttlMs: number,
): Array<{ id: string; ws: W }> {
  const expired: Array<{ id: string; ws: W }> = [];
  for (const [id, pending] of pendingVoiceConfirmations) {
    if (now - pending.createdAt > ttlMs) {
      expired.push({ id, ws: pending.ws });
      pendingVoiceConfirmations.delete(id);
    }
  }
  return expired;
}

export class WebSocketService implements Service {
  name = 'websocket';
  private _status: ServiceStatus = 'stopped';
  private port: number;
  private agentService: AgentService;
  private wsServer: WebSocketServer;
  private streamRelay: StreamRelay;
  /** Tracks the commitment ID for the currently processing chat message */
  private activeTaskId: string | null = null;
  private commitmentExecutor: CommitmentExecutor | null = null;
  private channelService: ChannelService | null = null;
  private ttsProvider: TTSProvider | null = null;
  private sttProvider: STTProvider | null = null;
  private voiceSessions = new Map<ServerWebSocket<unknown>, VoiceSession>();
  private pendingVoiceConfirmations = new Map<string, PendingVoiceConfirmation>();
  /**
   * Premium realtime voice (gpt-realtime-2) sessions, keyed by socket. Present
   * only when `voice.realtime.enabled` resolves with a key. A realtime session
   * owns the full duplex audio loop (STT+LLM+TTS in one OpenAI connection), so
   * the socket's normal `voiceSessions` accumulator is bypassed while it lives.
   */
  private realtimeSessions = new Map<
    ServerWebSocket<unknown>,
    { session: RealtimeVoiceSession; transport: BrowserAudioTransport; timeout: ReturnType<typeof setTimeout>; startedAt: number }
  >();
  /**
   * Lazily-created monthly spend guard for realtime voice. Only used when a
   * `monthly_budget_usd` is configured; persists to the daemon data dir so the
   * cap survives restarts. See realtime-budget.ts.
   */
  private realtimeBudget: RealtimeBudgetTracker | null = null;
  /**
   * Phase B — per-WS onboarding interview sessions. Created on
   * `interview_start`, torn down on disconnect or after the agent
   * calls `wrap_interview`. In-memory only — the captured facts are
   * persisted via `appendUserProfileFact` inside the agent loop.
   */
  private interviewSessions = new Map<ServerWebSocket<unknown>, InterviewSession>();
  /**
   * Periodic sweep handle for `pendingVoiceConfirmations` TTL eviction.
   * Started in `start()`, cleared in `stop()` so the daemon shuts down
   * cleanly without a dangling timer.
   */
  private voiceConfirmationSweepTimer: ReturnType<typeof setInterval> | null = null;
  private siteBuilderService: import('../sites/service.ts').SiteBuilderService | null = null;
  // Phase 6.3.5b — voice approve/cancel for pending approvals.
  private approvalManager: ApprovalManager | null = null;
  private deferredExecutor: DeferredExecutor | null = null;
  // Audit trail used to tag voice-channel resolutions separately from
  // dashboard clicks. See gateVoiceApprovalResolution + resolveLatestPendingByVoice.
  private auditTrail: AuditTrail | null = null;

  constructor(port: number, agentService: AgentService) {
    this.port = port;
    this.agentService = agentService;
    this.wsServer = new WebSocketServer(port);
    this.streamRelay = new StreamRelay(this.wsServer);

    // Wire delegation callback: when PA delegates to a specialist,
    // update the active task's assigned_to on the task board
    this.agentService.setDelegationCallback((specialistName) => {
      if (!this.activeTaskId) return;
      try {
        const updated = updateCommitmentAssignee(this.activeTaskId, specialistName);
        if (updated) this.broadcastTaskUpdate(updated, 'updated');
      } catch (err) {
        console.error('[WSService] Failed to update task assignee:', err);
      }
    });
  }

  /**
   * Set the site builder service for project-scoped chat.
   */
  setSiteBuilderService(svc: import('../sites/service.ts').SiteBuilderService): void {
    this.siteBuilderService = svc;
  }

  /** Phase 6.3.5b — wire approval pipeline so voice approve/cancel can
   *  resolve pending approvals server-side without round-tripping REST. */
  setApprovalManager(mgr: ApprovalManager): void {
    this.approvalManager = mgr;
  }

  setDeferredExecutor(exec: DeferredExecutor): void {
    this.deferredExecutor = exec;
  }

  setAuditTrail(audit: AuditTrail): void {
    this.auditTrail = audit;
  }

  /**
   * Set the commitment executor for handling cancel commands.
   */
  setCommitmentExecutor(executor: CommitmentExecutor): void {
    this.commitmentExecutor = executor;
  }

  /**
   * Set the channel service for cross-channel broadcasts.
   */
  setChannelService(channelService: ChannelService): void {
    this.channelService = channelService;
  }

  /**
   * Set the TTS provider for voice responses.
   */
  setTTSProvider(provider: TTSProvider): void {
    this.ttsProvider = provider;
    console.log('[WSService] TTS provider set');
  }

  /**
   * Set the STT provider for voice input transcription.
   */
  setSTTProvider(provider: STTProvider): void {
    this.sttProvider = provider;
    console.log('[WSService] STT provider set');
  }

  /**
   * Get the underlying WebSocket server for direct broadcasting.
   */
  getServer(): WebSocketServer {
    return this.wsServer;
  }

  /**
   * Register API route handlers on the underlying WebSocket server.
   * Must be called before start().
   */
  setApiRoutes(routes: Record<string, any>): void {
    this.wsServer.setApiRoutes(routes);
  }

  /**
   * Phase A — true while first-run setup is incomplete (no LLM
   * provider/key/model saved yet). Read fresh from disk on every
   * call rather than caching: the user clears this flag by writing
   * config via `/api/onboarding/setup`, and we want the very next
   * chat/voice message to flip out of setup mode without a daemon
   * restart. The cost is one yaml read per chat send — negligible
   * vs the LLM round-trip that follows.
   */
  private isSetupMode(): boolean {
    try {
      const cfg = this.agentService.getConfig();
      return !cfg.onboarding?.setup_completed_at;
    } catch {
      // Fall back to "not setup mode" on any read failure so a config
      // glitch doesn't lock the user out of chat.
      return false;
    }
  }

  /**
   * Set directory for serving pre-built dashboard files.
   * Must be called before start().
   */
  setStaticDir(dir: string): void {
    this.wsServer.setStaticDir(dir);
  }

  setPublicDir(dir: string): void {
    this.wsServer.setPublicDir(dir);
  }

  setAuthToken(token: string): void {
    this.wsServer.setAuthToken(token);
  }

  async start(): Promise<void> {
    this._status = 'starting';

    try {
      // Set up message handler
      this.wsServer.setHandler({
        onMessage: (msg, ws) => this.routeMessage(msg, ws),
        onBinaryMessage: (data, ws) => this.handleVoiceAudio(data, ws),
        onConnect: (_ws) => {
          console.log('[WSService] Client connected');
        },
        onDisconnect: (ws) => {
          // Tear down any realtime voice session (closes the OpenAI WS + timer).
          this.closeRealtimeVoice(ws);
          // Clean up every per-socket map so a long-running daemon doesn't
          // accumulate dead-socket entries across reconnects. See
          // cleanupPerSocketMaps for the contract; tested in
          // ws-service-cleanup.test.ts.
          cleanupPerSocketMaps(
            ws,
            this.voiceSessions as unknown as Map<typeof ws, unknown>,
            this.interviewSessions as unknown as Map<typeof ws, unknown>,
            this.pendingVoiceConfirmations as unknown as Map<string, { ws: typeof ws }>,
          );
          console.log('[WSService] Client disconnected');
        },
      });

      // Start the server
      this.wsServer.start();

      // Periodic sweep of abandoned voice-confirmation cards. Without this,
      // an active client that receives a clarifier and then ignores it
      // (user walks away, switches context) leaves the entry forever.
      // 60s tick, 10-min TTL — see sweepExpiredVoiceConfirmations.
      this.voiceConfirmationSweepTimer = setInterval(() => {
        const expired = sweepExpiredVoiceConfirmations(
          this.pendingVoiceConfirmations as unknown as Map<string, { ws: ServerWebSocket<unknown>; createdAt: number }>,
          Date.now(),
          VOICE_CONFIRMATION_TTL_MS,
        );
        for (const { id, ws } of expired) {
          // Tell the originating client so the card UI can dismiss itself
          // rather than stay rendered forever.
          try {
            ws.send(JSON.stringify({
              type: 'voice_confirmation_expired',
              payload: { id },
              timestamp: Date.now(),
            }));
          } catch (err) {
            // Socket may have died between map-read and send; safe to
            // ignore. Use debug instead of warn so a burst of expirations
            // against half-closed sockets doesn't spam the daemon log.
            console.debug('[WSService] voice_confirmation_expired send failed:', err);
          }
        }
      }, VOICE_CONFIRMATION_SWEEP_INTERVAL_MS);

      this._status = 'running';
      console.log(`[WSService] Started on port ${this.port}`);
    } catch (error) {
      this._status = 'error';
      throw error;
    }
  }

  async stop(): Promise<void> {
    this._status = 'stopping';
    if (this.voiceConfirmationSweepTimer) {
      clearInterval(this.voiceConfirmationSweepTimer);
      this.voiceConfirmationSweepTimer = null;
    }
    this.wsServer.stop();
    this._status = 'stopped';
    console.log('[WSService] Stopped');
  }

  status(): ServiceStatus {
    return this._status;
  }

  /**
   * Broadcast a proactive heartbeat message to all connected clients
   * and external channels.
   */
  broadcastHeartbeat(text: string): void {
    const message: WSMessage = {
      type: 'chat',
      payload: {
        text,
        source: 'heartbeat',
      },
      priority: 'normal',
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(message);

    // Also push to external channels
    if (this.channelService) {
      this.channelService.broadcastToAll(text).catch(err =>
        console.error('[WSService] Channel heartbeat broadcast error:', err)
      );
    }
  }

  /**
   * Broadcast a notification with priority level.
   * Used by EventReactor for immediate event reactions.
   * Urgent notifications are also pushed to all external channels.
   */
  broadcastNotification(text: string, priority: 'urgent' | 'normal' | 'low'): void {
    const message: WSMessage = {
      type: 'chat',
      payload: {
        text,
        source: 'proactive',
      },
      priority,
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(message);

    // Push urgent notifications to external channels (Telegram, Discord)
    if (priority === 'urgent' && this.channelService) {
      this.channelService.broadcastToAll(`[URGENT] ${text}`).catch(err =>
        console.error('[WSService] Channel broadcast error:', err)
      );
    }
  }

  /**
   * Broadcast task (commitment) changes to all connected clients.
   * Used for real-time task board updates.
   */
  broadcastTaskUpdate(task: Commitment, action: 'created' | 'updated' | 'deleted'): void {
    const message: WSMessage = {
      type: 'notification',
      payload: {
        source: 'task_update',
        action,
        task,
      },
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(message);
  }

  private broadcastAssistantMessage(text: string, requestId?: string): void {
    const message: WSMessage = {
      type: 'notification',
      payload: {
        source: 'assistant_message',
        text,
      },
      id: requestId,
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(message);
  }

  /**
   * Broadcast content pipeline changes to all connected clients.
   * Used for real-time content pipeline updates.
   */
  broadcastContentUpdate(item: ContentItem, action: 'created' | 'updated' | 'deleted'): void {
    const message: WSMessage = {
      type: 'notification',
      payload: {
        source: 'content_update',
        action,
        item,
      },
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(message);
  }

  /**
   * Broadcast sub-agent progress events to all connected clients.
   * Used by the delegation system for real-time visibility.
   */
  broadcastSubAgentProgress(event: {
    type: 'text' | 'tool_call' | 'done';
    agentName: string;
    agentId: string;
    data: unknown;
  }): void {
    const message: WSMessage = {
      type: 'stream',
      payload: {
        ...event,
        source: 'sub-agent',
      },
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(message);

    // Persist for the Agents Room activity timeline (Phase 6.3). Same tick
    // as the broadcast so a fresh dashboard reload + a live tab can never
    // see different views of the same event. Failures are logged but never
    // bubble — broadcasting is the load-bearing path.
    try {
      recordAgentActivity({
        agent_id: event.agentId,
        agent_name: event.agentName,
        event_type: event.type,
        data: event.data,
        timestamp: message.timestamp,
      });
    } catch (err) {
      console.warn('[WSService] Failed to persist agent activity:', err);
    }
  }

  /**
   * Broadcast an approval request to all connected dashboard clients.
   * Always pushed via WS; urgent requests are also sent to external channels.
   */
  broadcastApprovalRequest(request: ApprovalRequest): void {
    const shortId = request.id.slice(0, 8);
    const impact = impactFromCategory(request.action_category);
    const intent = formatApprovalIntent(request);
    const message: WSMessage = {
      type: 'notification',
      payload: {
        source: 'approval_request',
        request,
        shortId,
        impact,
        intent,
      },
      priority: request.urgency === 'urgent' ? 'urgent' : 'normal',
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(message);

    // Push urgent approvals to external channels
    if (request.urgency === 'urgent' && this.channelService) {
      const text = `[APPROVAL NEEDED] ${request.agent_name} wants to run ${request.tool_name} (${request.action_category}).\nReason: ${request.reason}\nReply: approve ${shortId} / deny ${shortId}`;
      this.channelService.broadcastToAll(text).catch(err =>
        console.error('[WSService] Approval channel broadcast error:', err)
      );
    }
  }

  /**
   * Broadcast emergency state changes to all connected clients.
   */
  broadcastEmergencyState(state: EmergencyState): void {
    const message: WSMessage = {
      type: 'notification',
      payload: {
        source: 'emergency_state',
        state,
      },
      priority: 'urgent',
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(message);
  }

  /**
   * Broadcast an approval resolution (approved/denied/executed) to all clients.
   */
  /**
   * Broadcast an awareness event to all connected clients.
   */
  /**
   * Broadcast a sidecar event to all connected clients.
   */
  broadcastSidecarEvent(sidecarId: string, event: { type: string; data: Record<string, unknown>; timestamp: number }): void {
    const message: WSMessage = {
      type: 'notification',
      payload: {
        source: 'sidecar_event',
        sidecarId,
        event,
      },
      timestamp: event.timestamp,
    };
    this.wsServer.broadcast(message);
  }

  broadcastAwarenessEvent(event: { type: string; data: Record<string, unknown>; timestamp: number }): void {
    const message: WSMessage = {
      type: 'notification',
      payload: {
        source: 'awareness_event',
        event,
      },
      timestamp: event.timestamp,
    };
    this.wsServer.broadcast(message);
  }

  /**
   * Synthesize TTS for a proactive message and broadcast audio to all clients.
   * Used for awareness suggestions and other unsolicited voice notifications.
   */
  /**
   * Synthesize TTS for a proactive message and broadcast audio to all clients.
   * Used for awareness suggestions and other unsolicited voice notifications.
   */
  async broadcastProactiveVoice(text: string): Promise<void> {
    if (!this.ttsProvider || !text) {
      console.log(`[WSService] Proactive TTS skipped: ${!this.ttsProvider ? 'no TTS provider' : 'empty text'}`);
      return;
    }

    if (this.wsServer.getClientCount() === 0) {
      console.log('[WSService] Proactive TTS skipped: no connected clients');
      return;
    }

    try {
      const requestId = `proactive-${Date.now()}`;

      // Signal TTS start to all clients (with wake-phrase guard flag —
      // proactive TTS knows the full text up front so we can compute
      // it once).
      const startMsg: WSMessage = {
        type: 'tts_start',
        payload: { requestId, containsWake: containsWakePhrase(text) },
        timestamp: Date.now(),
      };
      this.wsServer.broadcast(startMsg);

      let chunkCount = 0;
      for await (const chunk of this.ttsProvider.synthesizeStream(text)) {
        // Send binary audio to all connected clients
        for (const ws of this.wsServer.getClients()) {
          try {
            ws.sendBinary(chunk);
          } catch { /* client may have disconnected */ }
        }
        chunkCount++;
      }

      // Signal TTS end
      const endMsg: WSMessage = {
        type: 'tts_end',
        payload: { requestId },
        timestamp: Date.now(),
      };
      this.wsServer.broadcast(endMsg);
      console.log(`[WSService] Proactive TTS complete: "${text.slice(0, 60)}..." (${chunkCount} chunks)`);
    } catch (err) {
      console.error('[WSService] Proactive TTS error:', err instanceof Error ? err.message : err);
      // Still send tts_end so client doesn't get stuck
      try {
        this.wsServer.broadcast({ type: 'tts_end', payload: {}, timestamp: Date.now() });
      } catch { /* ignore */ }
    }
  }

  /**
   * Broadcast a workflow execution event to all connected clients.
   */
  broadcastWorkflowEvent(event: { type: string; workflowId: string; executionId?: string; nodeId?: string; data: Record<string, unknown>; timestamp: number }): void {
    const message: WSMessage = {
      type: 'workflow_event',
      payload: event,
      timestamp: event.timestamp,
    };
    this.wsServer.broadcast(message);
  }

  /**
   * Broadcast a goal event to all connected clients.
   */
  broadcastGoalEvent(event: { type: string; goalId?: string; data: Record<string, unknown>; timestamp: number }): void {
    const message: WSMessage = {
      type: 'goal_event',
      payload: event,
      timestamp: event.timestamp,
    };
    this.wsServer.broadcast(message);
  }

  broadcastSiteEvent(event: { type: string; projectId: string; data: Record<string, unknown>; timestamp: number }): void {
    const message: WSMessage = {
      type: 'site_event',
      payload: event,
      timestamp: event.timestamp,
    };
    this.wsServer.broadcast(message);
  }

  /**
   * Broadcast a conv-tier task lifecycle event to all connected clients. The
   * UI uses these to render status pills like `[research running - 14s]`
   * while a delegated task is in flight, and to flash a "result ready" hint
   * when the task completes after the user has moved on.
   *
   * Full payload contract + consumer example: see the `task_event` comment
   * on `WSMessage` in `src/comms/websocket.ts`. Briefly:
   *   - task_started: show/update a pill for this task_id
   *   - task_completed/failed/cancelled: remove the pill, show summary
   *   - task_started CAN fire again on the same task_id when a paused task
   *     resumes (after the conv LLM provided a clarification reply)
   */
  broadcastTaskEvent(event: {
    type: 'task_started' | 'task_completed' | 'task_failed' | 'task_cancelled';
    task_id: string;
    template: string;
    intent: string;
    status: string;
    elapsedMs: number;
    summary?: string;
  }): void {
    const message: WSMessage = {
      type: 'task_event',
      payload: event,
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(message);
  }

  /**
   * Format a FileEntry tree into a compact text listing.
   */
  private formatFileTree(entry: { name: string; path: string; type: 'file' | 'directory'; children?: { name: string; type: 'file' | 'directory' }[] }): string {
    const lines: string[] = [];
    if (entry.children) {
      for (const child of entry.children) {
        lines.push(child.type === 'directory' ? `${child.name}/` : child.name);
      }
    }
    return lines.join('\n') + '\n';
  }

  broadcastApprovalUpdate(request: ApprovalRequest): void {
    const message: WSMessage = {
      type: 'notification',
      payload: {
        source: 'approval_update',
        request,
        impact: impactFromCategory(request.action_category),
        intent: formatApprovalIntent(request),
      },
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(message);
  }

  /**
   * Route incoming WebSocket messages to the appropriate handler.
   */
  private async routeMessage(msg: WSMessage, ws: ServerWebSocket<unknown>): Promise<WSMessage | void> {
    switch (msg.type) {
      case 'chat':
        return this.handleChat(msg, ws);

      case 'command':
        return this.handleCommand(msg);

      case 'status':
        return this.handleStatus();

      case 'voice_start': {
        const { requestId, currentRoom } = msg.payload as { requestId: string; currentRoom?: string };
        // Premium path: if realtime voice is enabled + keyed, open (or reuse) a
        // full-duplex realtime session and skip the STT accumulator entirely.
        if (this.tryStartRealtimeVoice(ws)) return undefined;
        this.voiceSessions.set(ws, {
          requestId,
          chunks: [],
          startedAt: Date.now(),
          currentRoom,
        });
        return undefined;
      }

      case 'voice_end': {
        const session = this.voiceSessions.get(ws);
        if (!session) return undefined;
        this.voiceSessions.delete(ws);
        // Fire-and-forget: transcribe → process → TTS response
        this.handleVoiceSession(session, ws).catch(err =>
          console.error('[WSService] Voice session error:', err)
        );
        return undefined;
      }

      case 'voice_text': {
        // Browser-side STT path: the dashboard already has a final transcript
        // (via the Web Speech API) and prefers it over daemon Whisper. Skip
        // STT entirely and run the same downstream pipeline.
        const payload = msg.payload as { requestId?: string; text?: string; currentRoom?: string };
        const requestId = payload?.requestId ?? msg.id ?? crypto.randomUUID();
        const text = (payload?.text ?? '').trim();
        const currentRoom = payload?.currentRoom;
        // If we have an in-flight audio session (parallel paths), drop it so
        // we don't double-process the same utterance.
        this.voiceSessions.delete(ws);
        if (!text) return undefined;
        this.processVoiceTranscript(text, requestId, ws, currentRoom).catch(err =>
          console.error('[WSService] voice_text pipeline error:', err)
        );
        return undefined;
      }

      case 'interview_start':
      case 'interview_user_message': {
        // Phase B — onboarding profile interview. Drives a separate
        // agent loop (see `onboarding-interviewer.ts`); doesn't touch
        // the primary chat agent or persist messages to vault
        // conversations.
        const payload = msg.payload as { text?: string; speakReply?: boolean };
        const userText = msg.type === 'interview_start' ? null : (payload?.text ?? '').trim();
        const speakReply = payload?.speakReply !== false; // default true
        this.handleInterviewMessage(ws, userText, speakReply).catch(err =>
          console.error('[WSService] interview pipeline error:', err)
        );
        return undefined;
      }

      default:
        return {
          type: 'error',
          payload: { message: `Unknown message type: ${msg.type}` },
          timestamp: Date.now(),
        };
    }
  }

  /**
   * Handle chat messages — stream response via StreamRelay.
   * Auto-creates a task for non-trivial messages so the task board tracks agent work.
   */
  private async handleChat(msg: WSMessage, ws?: ServerWebSocket<unknown>): Promise<WSMessage | void> {
    const payload = msg.payload as {
      text?: string;
      channel?: string;
      projectId?: string;
      currentRoom?: string;
      /** Set by `processVoiceTranscript` when it falls through to chat —
       *  the classifier already ran for that text, so we shouldn't re-run
       *  it here (avoids both duplicate latency and double-fire of any
       *  navigation/room_action interception). */
      skipIntercept?: boolean;
    };
    const text = payload?.text;
    const projectId = payload?.projectId ?? null;

    if (!text) {
      return {
        type: 'error',
        payload: { message: 'Missing text in chat payload' },
        id: msg.id,
        timestamp: Date.now(),
      };
    }

    // Phase A — onboarding setup-mode guard. Until the user has
    // completed first-run setup (LLM provider + API key + model
    // saved), the chat agent has no LLM to call. Short-circuit with
    // a friendly error so the dashboard's OnboardingGate stays in
    // control instead of the user typing into a half-broken thread.
    if (this.isSetupMode()) {
      return {
        type: 'error',
        payload: {
          code: 'setup_required',
          message: 'Finish first-run setup before chatting with Jarvis.',
        },
        id: msg.id,
        timestamp: Date.now(),
      };
    }

    const channel = payload.channel ?? 'websocket';
    const requestId = msg.id ?? crypto.randomUUID();

    // Text-driven Room navigation + room actions. Run the same intent
    // classifier the voice path uses on the typed text. If it parses
    // as a command (window control, navigation, room_action, "back to
    // thread"), handle it directly and skip the chat agent — so typing
    // "go to settings and disable TTS" works the same as saying it.
    // Voice's processVoiceTranscript sets skipIntercept when it falls
    // through to chat for plain conversational text, preventing a
    // double-classify.
    if (!payload.skipIntercept && !projectId) {
      const handled = await this.tryInterceptAsCommand(
        text,
        requestId,
        ws,
        payload.currentRoom,
      );
      if (handled) return undefined;
    }

    // Build site builder system prompt context (injected into system prompt, not user message)
    let siteContext: string | undefined;
    if (projectId && this.siteBuilderService) {
      // Project-scoped chat (from the Site Builder page)
      const project = await this.siteBuilderService.getProjectWithStatus(projectId);
      if (project) {
        let fileTreeText = '';
        try {
          const tree = this.siteBuilderService.projectManager.getFileTree(projectId, 1);
          fileTreeText = this.formatFileTree(tree);
        } catch { /* ignore */ }

        siteContext = `# Site Builder Context

You are working on project "${project.name}" (${project.framework}).
- Path: ${project.path}
- Branch: ${project.gitBranch ?? 'main'}
- Dev server: ${project.status}
${project.githubUrl ? `- GitHub: ${project.githubUrl}` : ''}
${fileTreeText ? `\n## Project Structure\n\`\`\`\n${fileTreeText}\`\`\`` : ''}

## Rules
- Use site_read_file, site_write_file, site_list_files, site_run_command, site_git_commit, site_github_push tools with project_id="${projectId}".
- Do NOT use regular read_file, write_file, or run_command — always use the site_* variants.
- Do NOT start dev servers via site_run_command. The dev server is managed by the dashboard (make dev runs automatically).
- Changes are auto-committed after this conversation turn completes.
- For the "bun-react" framework: the server uses Bun.serve() with HTML imports (import from "./index.html"). Run with "bun --hot index.ts", NOT vite or webpack.`;
      }
    } else if (this.siteBuilderService) {
      // General chat (main dashboard) — give the LLM awareness of site builder projects
      try {
        const projects = await this.siteBuilderService.listProjectsWithStatus();
        if (projects.length > 0) {
          const projectList = projects.map(p =>
            `  - "${p.name}" (id: ${p.id}, framework: ${p.framework}, branch: ${p.gitBranch ?? 'main'}${p.githubUrl ? `, github: ${p.githubUrl}` : ''})`
          ).join('\n');

          // Most-recently-opened, used as a fallback default when the
          // user's request offers no name hint at all.
          const mostRecent = [...projects].sort(
            (a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0),
          )[0];
          const fallbackLine = mostRecent
            ? `\nFALLBACK PROJECT (most recently opened, use ONLY if no project name keyword matches the user's request): "${mostRecent.name}" (id: ${mostRecent.id}).`
            : "";

          siteContext = `# Site Builder

You have access to the Site Builder feature with ${projects.length} project(s):
${projectList}${fallbackLine}

You can work on any of these projects using site builder tools (site_read_file, site_write_file, site_list_files, site_run_command, site_git_commit, site_github_push) by passing the project's id as project_id. You can also create a brand-new project with site_create_project (templates: vite-react default, vite-vue, vite-svelte, vite-vanilla, next, bun-react).

## CRITICAL — you cannot write files by typing.
You are an LLM. You can only edit files by emitting a \`site_write_file\` tool_use block. Producing prose like "the file is at X" or "your landing page is live" or "I've created Y" WITHOUT first emitting a tool call is a HALLUCINATION — the file doesn't actually exist. NEVER claim a file was created unless the previous turn in this exchange included a successful site_write_file tool call. If you haven't called the tool yet, do not describe results — just call the tool now.

## How to pick which project the user means
0. **NEW project request (do this FIRST).** If the user says "new project", "create a project", "make a new site/app/landing", "fresh project", "in a new repo", or otherwise indicates they want a NEW workspace (NOT to add a file to an existing one) — call \`site_create_project\` with a sensible name derived from the topic and continue with that new project's id. Do NOT reuse an existing project just because its name happens to match. Choose template by inferred stack ("react" → vite-react, "vue" → vite-vue, "static html" → vite-vanilla, "next.js" → next, otherwise vite-react default).
1. **Explicit existing-project name.** If the user named an existing project (e.g. "in jarvis-landing", "edit the SP500 calculator"), use that one.
2. **Name keyword match.** If the user did NOT ask for a new project AND did NOT name one explicitly, but their request shares a meaningful keyword with an existing project's name (request mentions "landing page" + "jarvis-landing" exists → use jarvis-landing; request mentions "calculator" + "SP500 ROI Calculator" exists → use that), pick that project.
3. **Fallback.** If none of the above apply, use the FALLBACK PROJECT shown above.

CRITICAL — when in genuine doubt between "make in a new project" vs "add to the existing one whose name overlaps", briefly ASK ONCE before acting. Better to ask once than to dump a file in the wrong project. But if the user has already said "no questions" / "just do it" / "you decide" earlier in the conversation, default to creating a new project rather than mutating an existing one (less destructive — they can always delete the new one).

## When the user asks you to build, edit, create files in, or work on a website / landing page / app:
- ACT, do not ask. Pick the project per the rule above, call site_list_files to see what's there, then call site_write_file to create or update the page directly.
- DO NOT ask "do you want a new file or update an existing one" — just pick: a new public-facing page (landing, marketing, about) usually means a new file like \`landing.html\` or \`pages/landing.tsx\`; "update the homepage" means edit the existing entry file.
- DO NOT ask the user for content, copy, sections, headlines, or styling preferences UNLESS they explicitly request a clarifier. If they say "you decide" / "drive the creativity" / "no questions", produce a complete, well-styled page on your own and write it.
- DO write a complete, runnable file in one site_write_file call (not a stub asking for confirmation). For HTML pages, include inline CSS or a <style> block so the page renders standalone.
- DO use \`site_write_file\` even for new files (it creates them).
- After the tool call returns success, summarize what you created in 1-2 sentences (file path + what's in it). Do NOT write the summary BEFORE the tool call. Do NOT promise to "get started" or "I'll create" — the file must already exist by the time you reply.

## What NOT to do:
- Do NOT use regular read_file, write_file, or run_command — always use the site_* variants with the project_id.
- Do NOT start dev servers via site_run_command (the dashboard manages that).
- Do NOT fabricate file paths, line counts, or "your file is now at X" descriptions without a successful site_write_file call backing them.`;
        }
      } catch { /* ignore — site builder may not be fully started */ }
    }

    // Auto-create a commitment only when the message has commitment-phrasing
    // (a scheduled, recurring, or explicitly deferred intent). Previously every
    // message >10 chars became a tracked commitment, which caused the
    // CommitmentExecutor to re-run the same request after the primary agent
    // already handled it — producing duplicate cards and bypassing intent gating.
    // A conversational request ("send email to X") is handled synchronously by
    // the streaming agent and doesn't need a tracked task.
    let taskCommitment: Commitment | null = null;

    if (looksLikeCommitment(text)) {
      try {
        const taskLabel = text.length > 80 ? text.slice(0, 77) + '...' : text;
        taskCommitment = createCommitment(taskLabel, {
          assigned_to: 'jarvis',
          created_from: 'user',
        });
        updateCommitmentStatus(taskCommitment.id, 'active');
        taskCommitment.status = 'active';
        this.activeTaskId = taskCommitment.id;
        this.broadcastTaskUpdate(taskCommitment, 'created');
      } catch (err) {
        console.error('[WSService] Failed to auto-create task:', err);
      }
    }

    // Persist user message
    try {
      const conversation = getOrCreateConversation(channel);
      recordUserProfileTurn(text);
      addMessage(conversation.id, { role: 'user', content: text });

      // Set default cwd for general tools (run_command, read_file, etc.)
      // so they operate in the project directory during site builder conversations
      if (projectId && this.siteBuilderService) {
        const projectPath = this.siteBuilderService.projectManager.getProjectPath(projectId);
        setDefaultCwd(projectPath);
      }

      const { stream, onComplete } = this.agentService.streamMessage(text, channel, siteContext);

      // Set up streaming TTS: speak sentences as they arrive
      const ttsActive = !!(this.ttsProvider && ws);
      let ttsSentenceQueue: string[] = [];
      let ttsSpeaking = false;
      let ttsStartSent = false;
      let ttsStreamFullyDone = false; // set AFTER relayStream returns, not per-turn 'done'
      let ttsSentenceCount = 0;
      let ttsChunkCount = 0;

      const speakNextSentence = async () => {
        if (ttsSpeaking || !ttsActive || !ws) return;
        const sentence = ttsSentenceQueue.shift();
        if (!sentence) {
          // Queue empty — send tts_end only if stream is fully done
          if (ttsStreamFullyDone && ttsStartSent) {
            console.log(`[WSService] TTS complete: ${ttsSentenceCount} sentences, ${ttsChunkCount} audio chunks`);
            this.wsServer.sendToClient(ws, {
              type: 'tts_end',
              payload: { requestId },
              id: requestId,
              timestamp: Date.now(),
            });
            ttsStartSent = false; // prevent duplicate tts_end
          }
          return;
        }

        // Wake-phrase self-trigger guard: tell the UI whether this
        // sentence contains "Jarvis" so it can suppress the wake
        // recognizer for the duration of the audio (otherwise TTS
        // playback echoes through the mic and self-triggers).
        const sentenceHasWake = containsWakePhrase(sentence);

        // Send tts_start exactly once before the first audio chunk
        if (!ttsStartSent) {
          ttsStartSent = true;
          this.wsServer.sendToClient(ws, {
            type: 'tts_start',
            payload: { requestId, containsWake: sentenceHasWake },
            id: requestId,
            timestamp: Date.now(),
          });
        } else if (sentenceHasWake) {
          // Subsequent sentence in the same turn that contains "Jarvis" —
          // notify so the UI can flip suppression on mid-turn. (We never
          // un-suppress mid-turn because earlier audio with "Jarvis" may
          // still be in the speaker buffer.)
          this.wsServer.sendToClient(ws, {
            type: 'tts_text',
            payload: { requestId, containsWake: true },
            id: requestId,
            timestamp: Date.now(),
          });
        }

        ttsSpeaking = true;
        ttsSentenceCount++;
        try {
          if (this.ttsProvider) {
            for await (const chunk of this.ttsProvider.synthesizeStream(sentence)) {
              ttsChunkCount++;
              this.wsServer.sendBinary(ws, chunk);
            }
          }
        } catch (err) {
          console.error('[WSService] TTS sentence error:', err);
        }
        ttsSpeaking = false;
        speakNextSentence();
      };

      // Relay stream to all WebSocket clients, collect full text.
      // onSentence fires for each complete sentence during streaming.
      // NOTE: onTextDone fires per LLM turn (tool loop), NOT once at the end.
      // We ignore onTextDone and use the relayStream return to mark stream completion.
      const fullText = await this.streamRelay.relayStream(stream, requestId, ttsActive ? {
        onSentence: (sentence) => {
          ttsSentenceQueue.push(sentence);
          speakNextSentence();
        },
      } : undefined);

      // Stream is now fully done (all tool loop turns complete)
      ttsStreamFullyDone = true;
      if (ttsActive) {
        if (!ttsSpeaking && ttsSentenceQueue.length === 0 && ttsStartSent) {
          // Everything already played, send tts_end now
          this.wsServer.sendToClient(ws!, {
            type: 'tts_end',
            payload: { requestId },
            id: requestId,
            timestamp: Date.now(),
          });
          ttsStartSent = false;
        }
        // Otherwise speakNextSentence will send tts_end when queue drains
      }

      // Persist assistant response
      addMessage(conversation.id, { role: 'assistant', content: fullText });

      const followupPrompt = maybeCreateUserProfileFollowupPrompt();
      if (followupPrompt) {
        this.broadcastAssistantMessage(followupPrompt);
        addMessage(conversation.id, { role: 'assistant', content: followupPrompt });
      }

      // Mark task as completed
      if (taskCommitment) {
        try {
          const resultSummary = fullText.length > 200 ? fullText.slice(0, 197) + '...' : fullText;
          const updated = updateCommitmentStatus(taskCommitment.id, 'completed', resultSummary);
          if (updated) this.broadcastTaskUpdate(updated, 'updated');
        } catch (err) {
          console.error('[WSService] Failed to complete task:', err);
        } finally {
          this.activeTaskId = null;
        }
      }

      // Clear site builder default cwd now that the turn is done
      setDefaultCwd(null);

      // Fire-and-forget: run post-processing (extraction, personality)
      onComplete(fullText).catch((err) =>
        console.error('[WSService] onComplete error:', err)
      );

      // Auto-commit site builder changes after chat turn
      if (projectId && this.siteBuilderService) {
        try {
          const projectPath = this.siteBuilderService.projectManager.getProjectPath(projectId);
          if (projectPath) {
            const commitMsg = text.length > 60 ? text.slice(0, 57) + '...' : text;
            const commit = await this.siteBuilderService.gitManager.autoCommit(projectPath, commitMsg);
            if (commit) {
              this.broadcastSiteEvent({
                type: 'git_commit',
                projectId,
                data: { commit },
                timestamp: Date.now(),
              });
            }
          }
        } catch (err) {
          console.error('[WSService] Site builder auto-commit error:', err);
        }
      }

      // Don't return a direct response — StreamRelay already broadcast everything
      return undefined;
    } catch (error) {
      console.error('[WSService] Chat error:', error);

      // Mark task as failed
      if (taskCommitment) {
        try {
          const reason = error instanceof Error ? error.message : 'Processing failed';
          const updated = updateCommitmentStatus(taskCommitment.id, 'failed', reason);
          if (updated) this.broadcastTaskUpdate(updated, 'updated');
        } catch (err) {
          console.error('[WSService] Failed to fail task:', err);
        } finally {
          this.activeTaskId = null;
        }
      }

      // If StreamRelay already broadcast the error to all clients (including
      // this requester), don't emit a second error WSMessage as the handler
      // return value - the user would see the same error twice.
      const broadcastFlag = (error as Error & { _streamErrorBroadcast?: boolean })?._streamErrorBroadcast;
      if (broadcastFlag) {
        return undefined;
      }

      const message = error instanceof Error ? error.message : 'Chat processing failed';
      return {
        type: 'error',
        payload: {
          message,
          code: classifyErrorString(message),
        },
        id: requestId,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Handle binary audio data from voice recording.
   * Accumulates chunks into the active voice session for this client.
   */
  private async handleVoiceAudio(data: Buffer, ws: ServerWebSocket<unknown>): Promise<void> {
    // Realtime path: stream the mic frame straight into the OpenAI session.
    const realtime = this.realtimeSessions.get(ws);
    if (realtime) {
      realtime.transport.pushMicChunk(data);
      return;
    }
    const session = this.voiceSessions.get(ws);
    if (!session) {
      console.warn('[WSService] Binary audio received with no active voice session');
      return;
    }
    session.chunks.push(data);
  }

  /**
   * Open (or reuse) a premium realtime voice session for this socket. Returns
   * true if realtime handled the `voice_start` (so the caller skips the normal
   * STT accumulator), false if realtime is disabled/unavailable.
   *
   * A single session spans the conversation: `voice_end` is a no-op for
   * realtime (OpenAI's semantic VAD detects turns), and the session is closed
   * on disconnect or after `max_session_minutes` (cost guard).
   */
  private tryStartRealtimeVoice(ws: ServerWebSocket<unknown>): boolean {
    if (this.realtimeSessions.has(ws)) return true; // already streaming

    let resolved: ResolvedRealtimeVoice;
    try {
      const res = resolveRealtimeVoice(this.agentService.getConfig());
      if (!res.ok) return false;
      resolved = res.resolved;
    } catch (err) {
      console.warn('[WSService] realtime voice resolve failed, using standard pipeline:', err);
      return false;
    }

    // Monthly spend guard: refuse new sessions once the estimated budget is
    // hit. Returns true (caller skips the standard accumulator) but opens no
    // session. Sent as `closed` (not `error`) + a message so the client stops
    // the mic via the normal close path and surfaces the reason, rather than a
    // bare error flash. Falling through to the standard pipeline would be wrong:
    // the client is already streaming raw realtime PCM, which the WAV-based path
    // can't consume.
    if (resolved.monthlyBudgetUsd && !this.getRealtimeBudget().canStart(resolved.monthlyBudgetUsd)) {
      console.warn('[WSService] realtime monthly budget reached — refusing new session');
      this.wsServer.sendToClient(ws, {
        type: 'realtime_status',
        payload: {
          state: 'closed',
          reason: 'budget',
          message: `Monthly realtime voice budget ($${resolved.monthlyBudgetUsd}) reached. Voice is paused until next month or until you raise the limit in Settings > Voice.`,
        },
        timestamp: Date.now(),
      });
      return true;
    }

    const orchestrator = this.agentService.getOrchestrator();
    const transport = new BrowserAudioTransport({
      sendAudio: (chunk) => this.wsServer.sendBinary(ws, chunk),
      signalStopPlayback: () =>
        this.wsServer.sendToClient(ws, { type: 'tts_end', payload: { bargeIn: true }, timestamp: Date.now() }),
      // OpenAI requires input rate >= 24kHz; the browser client must capture/
      // resample to this. Output is also 24kHz PCM.
      inputSampleRate: 24000,
      outputSampleRate: 24000,
    });

    const session = new RealtimeVoiceSession(resolved, transport, {
      // Agent tools + dashboard navigation/in-room-action tools so the model
      // can drive the UI by voice (open settings, turn off TTS, go back…).
      tools: [...orchestrator.getRealtimeTools(), ...REALTIME_NAV_TOOLS],
      // Lean voice prompt (~100 tokens) instead of the full ~5.6k-token agent
      // prompt — the big context was the dominant per-turn latency for simple
      // questions. Tools stay, so capability is unchanged. See agent-service.
      instructions: this.agentService.buildRealtimeVoiceInstructions(),
      executeToolCall: (name, args) => {
        // Dashboard nav/in-room actions are handled here (they broadcast to the
        // dashboard); everything else goes through the auto-approve tool bridge.
        const nav = this.executeRealtimeNavTool(name, args);
        if (nav !== null) return Promise.resolve(nav);
        return orchestrator.executeRealtimeToolCall(name, args, { blockedCategories: resolved.blockedCategories });
      },
      onTranscript: (t) =>
        this.wsServer.sendToClient(ws, {
          type: 'realtime_transcript',
          payload: { role: t.role, text: t.text, final: t.final },
          timestamp: Date.now(),
        }),
      onError: (err) => {
        console.error('[WSService] realtime voice error:', err);
        this.wsServer.sendToClient(ws, { type: 'realtime_status', payload: { state: 'error', message: err }, timestamp: Date.now() });
      },
      onClose: () => this.closeRealtimeVoice(ws),
    });

    const timeout = setTimeout(() => {
      console.log('[WSService] realtime session hit max_session_minutes, closing');
      this.closeRealtimeVoice(ws);
    }, resolved.maxSessionMinutes * 60_000);

    this.realtimeSessions.set(ws, { session, transport, timeout, startedAt: Date.now() });
    session.connect().then(
      () => this.wsServer.sendToClient(ws, { type: 'realtime_status', payload: { state: 'live', model: resolved.model }, timestamp: Date.now() }),
      (err) => {
        console.error('[WSService] realtime connect failed:', err);
        this.closeRealtimeVoice(ws);
      },
    );
    return true;
  }

  /**
   * Execute a dashboard navigation / in-room-action tool called by the realtime
   * voice model. Returns a short result string for the model to acknowledge, or
   * null if `name` isn't a navigation tool (so the caller falls through to the
   * normal tool bridge). Reuses the same broadcast* methods the standard voice
   * path uses, so the dashboard reacts identically.
   */
  private executeRealtimeNavTool(name: string, args: Record<string, unknown>): string | null {
    if (!REALTIME_NAV_TOOL_NAMES.has(name)) return null;
    const reqId = crypto.randomUUID();
    switch (name) {
      case 'open_dashboard_room': {
        const room = String(args.room ?? '');
        if (!room) return 'No room specified.';
        this.broadcastRoomNavigation(room as RoomKey, reqId);
        return `Opened the ${room} room.`;
      }
      case 'go_back_to_thread': {
        this.broadcastNavigateHome(reqId);
        return 'Back to the thread.';
      }
      case 'control_dashboard_window': {
        const action = String(args.action ?? '');
        const target = (args.target ? String(args.target) : 'most_recent') as RoomKey | 'most_recent';
        if (!action) return 'No window action specified.';
        this.broadcastWindowControl({ action: action as WindowControl['action'], target }, reqId);
        return `${action} done.`;
      }
      case 'dashboard_room_action': {
        const room = String(args.room ?? '');
        const action = String(args.action ?? '');
        if (!room || !action) return 'Room and action are required.';
        const innerArgs = (args.args && typeof args.args === 'object') ? args.args as Record<string, unknown> : {};
        // Auto-open the room first (no-op if already open), then dispatch —
        // mirrors the classifier path so the qualifier isn't dropped.
        this.broadcastRoomNavigation(room as RoomKey, reqId);
        this.broadcastRoomAction({ room, action, args: innerArgs }, reqId);
        return `Done: ${action} in ${room}.`;
      }
      default:
        return null;
    }
  }

  /** Lazily build the monthly spend tracker, persisted under the data dir. */
  private getRealtimeBudget(): RealtimeBudgetTracker {
    if (!this.realtimeBudget) {
      const dataDir = this.agentService.getConfig().daemon?.data_dir || join(homedir(), '.jarvis');
      this.realtimeBudget = RealtimeBudgetTracker.fromFile(join(dataDir, 'realtime-budget.json'));
    }
    return this.realtimeBudget;
  }

  /** Tear down a realtime voice session and notify the client. */
  private closeRealtimeVoice(ws: ServerWebSocket<unknown>): void {
    const entry = this.realtimeSessions.get(ws);
    if (!entry) return;
    this.realtimeSessions.delete(ws);
    clearTimeout(entry.timeout);
    // Record estimated spend against the monthly budget (only meaningful when a
    // budget is set; recording always is cheap and keeps the cap honest if one
    // is added mid-month).
    try {
      this.getRealtimeBudget().recordSessionSeconds((Date.now() - entry.startedAt) / 1000);
    } catch (err) {
      console.warn('[WSService] failed to record realtime spend:', err);
    }
    try { entry.session.close(); } catch { /* ignore */ }
    try {
      this.wsServer.sendToClient(ws, { type: 'realtime_status', payload: { state: 'closed' }, timestamp: Date.now() });
    } catch { /* socket may already be gone */ }
  }

  /**
   * Process a completed voice session: STT → classify → route by confidence.
   *
   * Routing (`routeByConfidence` in src/voice/intent.ts):
   *   - act         → forward transcript to the chat agent (existing flow)
   *   - clarify     → broadcast clarifier_request, hold transcript pending
   *   - repeat-back → broadcast repeat_back_request, hold transcript pending
   *
   * Held requests are resolved via REST `/api/voice/(clarifier|repeat-back)/:id/{confirm,cancel}`,
   * which call back into `resolveVoiceConfirmation`.
   */
  /**
   * Phase B — onboarding interview message handler. Drives the
   * `onboarding-interviewer` module's agent loop, streams the
   * assistant text back to the UI as an `interview_assistant`
   * message, and (optionally) speaks it via TTS so the orb can
   * play the question aloud.
   *
   * `userText === null` means "start the interview" (first turn);
   * the agent opens with its scripted intro + first question.
   * On wrap, sends an `interview_done` message so the UI flips back
   * to the regular dashboard.
   */
  private async handleInterviewMessage(
    ws: ServerWebSocket<unknown>,
    userText: string | null,
    speakReply: boolean,
  ): Promise<void> {
    let session = this.interviewSessions.get(ws);
    if (!session) {
      session = createInterviewSession();
      this.interviewSessions.set(ws, session);
    }

    const llm = this.agentService.getLLMManager();
    // Just check that at least one provider is registered. The interviewer
    // routes through llm.chatTier internally which resolves through the
    // configured default/tiers.
    if (llm.getProviderNames().length === 0) {
      this.wsServer.sendToClient(ws, {
        type: 'interview_error',
        payload: { message: 'No LLM configured. Finish setup first.' },
        timestamp: Date.now(),
      });
      return;
    }

    let result;
    try {
      result = await runInterviewTurn(session, llm, userText);
    } catch (err) {
      console.error('[WSService] Interview turn failed:', err);
      this.wsServer.sendToClient(ws, {
        type: 'interview_error',
        payload: { message: err instanceof Error ? err.message : String(err) },
        timestamp: Date.now(),
      });
      return;
    }

    const text = result.assistantText.trim();

    // Decide up-front whether audio will follow, and TELL the UI in the
    // text message. The UI must not guess: when it assumed TTS based on
    // its own (possibly stale) settings fetch and no `tts_start` ever
    // arrived — e.g. TTS disabled, or no provider loaded — it sat in
    // "Jarvis is thinking…" forever with the composer disabled.
    const willSpeak = Boolean(speakReply && this.ttsProvider && text);

    // Send the text reply for the UI to render in the chat-bubble
    // layout (always — the bubble is the visual record even when TTS
    // is on).
    this.wsServer.sendToClient(ws, {
      type: 'interview_assistant',
      payload: {
        text,
        facts_recorded: result.factsRecorded,
        done: result.done,
        will_speak: willSpeak,
      },
      timestamp: Date.now(),
    });

    // Stream the audio via the existing `tts_start` + binary chunks
    // pipeline so the UI's MicOrb plays it through the normal
    // "speaking" state machine.
    if (willSpeak && this.ttsProvider) {
      const requestId = `interview-${Date.now()}`;
      // Tracks whether the tts_start frame went out: the finally block
      // below closes it with tts_end exactly when it was opened, so a
      // provider that throws -- even before the first chunk -- never
      // strands the UI in "speaking" with no audio and no tts_end.
      let ttsStarted = false;
      try {
        this.wsServer.sendToClient(ws, {
          type: 'tts_start',
          // containsWake=true conservatively suppresses the wake
          // recognizer for the entire interview reply — interviews
          // are short and we don't need "Jarvis" interrupts here.
          payload: { requestId, containsWake: true },
          id: requestId,
          timestamp: Date.now(),
        });
        ttsStarted = true;
        for await (const chunk of this.ttsProvider.synthesizeStream(text)) {
          this.wsServer.sendBinary(ws, chunk);
        }
      } catch (err) {
        console.warn('[WSService] Interview TTS failed:', err);
      } finally {
        // Always close the TTS frame once it was opened — a synthesis
        // failure mid-stream must not leave the UI waiting forever.
        if (ttsStarted) {
          this.wsServer.sendToClient(ws, {
            type: 'tts_end',
            payload: { requestId },
            id: requestId,
            timestamp: Date.now(),
          });
        }
      }
    }

    if (result.done) {
      this.wsServer.sendToClient(ws, {
        type: 'interview_done',
        payload: {
          farewell: result.farewell,
          facts_recorded: result.factsRecorded,
        },
        timestamp: Date.now(),
      });
      this.interviewSessions.delete(ws);
    }
  }

  private async handleVoiceSession(session: VoiceSession, ws: ServerWebSocket<unknown>): Promise<void> {
    if (!this.sttProvider) {
      this.wsServer.sendToClient(ws, {
        type: 'error',
        payload: { message: 'STT not configured. Enable it in Settings > Channels.' },
        timestamp: Date.now(),
      });
      return;
    }

    const audioBuffer = Buffer.concat(session.chunks);
    if (audioBuffer.length === 0) return;

    try {
      const transcript = await this.sttProvider.transcribe(audioBuffer);
      if (!transcript.trim()) return;
      await this.processVoiceTranscript(transcript, session.requestId, ws, session.currentRoom);
    } catch (err) {
      console.error('[WSService] Voice session error:', err);
      const message = err instanceof Error ? err.message : 'Voice processing failed';
      this.wsServer.sendToClient(ws, {
        type: 'error',
        payload: { message },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Shared post-STT pipeline. Called by both `handleVoiceSession` (after
   * Whisper) and the `voice_text` handler (which skips STT and uses a
   * browser-supplied transcript). Echoes the transcript, runs the
   * window-control fast-path, then the intent classifier, and finally
   * routes by confidence (act / clarify / repeat-back).
   */

  /**
   * Text-driven Room navigation + room actions (Phase 6.8).
   *
   * Run the same intent classifier the voice path uses on the typed
   * text. If it parses as a command (window control, navigation,
   * room_action, "back to thread"), broadcast it directly and return
   * true; the caller skips the chat agent. Otherwise return false and
   * let the chat agent answer normally.
   *
   * Differences from voice's processVoiceTranscript:
   *   - No transcript echo (the UI optimistically adds the user's text
   *     to the thread on send).
   *   - No clarifier / repeat-back path — text users get an immediate
   *     answer instead of a confirmation prompt. Low-confidence
   *     commands fall through to the chat agent.
   *   - No thinking_start broadcast for handled-as-command (the
   *     interception is fast enough that the spinner just adds noise).
   */
  private async tryInterceptAsCommand(
    text: string,
    requestId: string,
    ws: ServerWebSocket<unknown> | undefined,
    currentRoom?: string,
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) return false;

    // Window-control fast path — regex-only, ~zero latency. Catches "close",
    // "minimize tools", "reorder layout" etc. without an LLM call.
    const winCtrl = matchWindowControl(trimmed);
    if (winCtrl) {
      console.log(
        `[WSService] (text) Window control: ${winCtrl.action} → ${winCtrl.target}`,
      );
      this.broadcastWindowControl(winCtrl, requestId);
      this.broadcastAssistantAck(ackForWindowControl(winCtrl), requestId);
      return true;
    }

    // The LLM-based voice_intent classifier used to run here for typed text
    // to catch "navigate to settings" / "open the goals room" before the
    // chat agent saw the message. That added 5-10s of latency on a slow
    // `low` tier (e.g. local ollama qwen3) - blocking ALL typed input on a
    // classification step the user didn't ask for. In conv-tier mode the
    // conv LLM owns this responsibility (it can navigate via its delegate
    // tool). Voice still runs the full classifier in processVoiceTranscript
    // because voice users can't easily click UI buttons. Regex window-control
    // above still fires for typed text - that's the cheap fast-path.
    return false;
  }

  private async processVoiceTranscript(
    transcript: string,
    requestId: string,
    ws: ServerWebSocket<unknown>,
    currentRoom?: string,
  ): Promise<void> {
    const trimmed = transcript.trim();
    if (!trimmed) return;

    console.log('[WSService] Voice transcript:', trimmed);

    // Echo transcript back so the UI shows it as a user message immediately,
    // regardless of which routing path the classifier picks.
    this.wsServer.sendToClient(ws, {
      type: 'chat',
      payload: { text: trimmed, source: 'voice_transcript' },
      id: requestId,
      timestamp: Date.now(),
    });

    // Phase A — onboarding setup-mode guard. The voice classifier
    // and the chat fall-through both need an LLM. Refuse politely
    // until first-run setup is done; window-control still works
    // (it's regex-only) so the user can navigate away if they
    // somehow opened a Room before the gate kicked in.
    if (this.isSetupMode()) {
      const winCtrlPre = matchWindowControl(trimmed);
      if (winCtrlPre) {
        this.broadcastWindowControl(winCtrlPre, requestId);
        this.broadcastAssistantAck(ackForWindowControl(winCtrlPre), requestId);
        return;
      }
      this.broadcastAssistantAck(
        "Finish first-run setup before talking to me.",
        requestId,
      );
      return;
    }

    // Window-control fast-path (Phase 6.1.5 follow-up): regex-match short
    // imperatives like "close", "expand the tools room", "minimize",
    // "shut" — these don't need the LLM classifier. Short-circuit on
    // match and broadcast the control to the dashboard directly.
    const winCtrl = matchWindowControl(trimmed);
    if (winCtrl) {
      console.log(
        `[WSService] Window control: ${winCtrl.action} → ${winCtrl.target}`,
      );
      this.broadcastWindowControl(winCtrl, requestId);
      this.broadcastAssistantAck(
        ackForWindowControl(winCtrl),
        requestId,
      );
      return;
    }

    // Run intent classifier. Failure-tolerant: returns a permissive intent
    // (verb=ask, confidence=0.85) on any error so we always land on `act`.
    const llm = this.agentService.getLLMManager();
    const recentTurns = this.recentTurns('websocket');
    const userProfilePrompt = formatUserProfileForPrompt(getUserProfile());
    const intent = await classifyVoiceIntent(trimmed, recentTurns, llm, currentRoom, userProfilePrompt);

    // Safety net: the classifier sometimes flags coherent multi-word
    // English as verb=unknown / low-confidence (especially conversational
    // openers like "I'm back at the PC, how are you?"). Repeat-back loops
    // on chitchat are a worse failure mode than just answering, so when
    // the transcript is plainly parseable English we upgrade to `ask` and
    // let the chat agent reply naturally.
    if (intent.verb === 'unknown' && intent.confidence < 0.6) {
      const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
      const hasChattySignal =
        /\b(i|i'm|im|you|how|what|when|where|why|can|could|would|should|hi|hey|hello|thanks|good|morning|evening|night)\b/i
          .test(trimmed);
      if (wordCount >= 4 && hasChattySignal) {
        console.log(
          `[WSService] Upgrading verb=unknown to verb=ask (coherent chat: ${wordCount} words).`,
        );
        intent.verb = 'ask';
        intent.impact = 'read';
        intent.confidence = 0.85;
      }
    }

    const route = routeByConfidence(intent);

    console.log(
      `[WSService] Voice intent: verb=${intent.verb} impact=${intent.impact} ` +
      `confidence=${intent.confidence.toFixed(2)} → ${route}`,
    );

    // Thinking signal: between STT-final and either chat-stream-start or
    // a clarifier broadcast. Lets the v2 orb show its thinking state with
    // accurate timing instead of inferring from the React side.
    this.broadcastThinkingStart(requestId);

    // Navigation interception: handle "back to thread" first (closes any
    // open Room) and then Room-opening intents. Both bypass the chat
    // agent (which has no concept of Rooms or the home view).
    if (route === 'act' && intentIsBackToThread(intent)) {
      this.broadcastNavigateHome(requestId);
      this.broadcastAssistantAck("Going back to the thread.", requestId);
      this.broadcastThinkingEnd(requestId);
      return;
    }

    // Phase 6.3.5 — Room action interception MUST run before room
    // navigation. Room actions are always more specific (e.g. "show
    // pending tasks" → set_filter status=pending) — if we navigate
    // first, the qualifier ("pending") gets dropped and the user sees
    // an unfiltered Room. Classifier emits room_action only when it's
    // confident the user wants in-room behavior, so trust it.
    if (route === 'act' && intent.room_action) {
      const ra = intent.room_action;
      // Auto-open the room (no-op if already open) so a "go to settings
      // and disable TTS"-style compound voice command also works when
      // the user is on the home thread. The UI bus queues the action
      // until the body mounts.
      this.broadcastRoomNavigation(ra.room as RoomKey, requestId);
      this.broadcastRoomAction(ra, requestId);
      this.broadcastAssistantAck(ackForRoomAction(ra), requestId);
      this.broadcastThinkingEnd(requestId);
      return;
    }

    const roomKey = route === 'act' ? intentToRoomKey(intent) : null;
    if (roomKey) {
      this.broadcastRoomNavigation(roomKey, requestId);
      this.broadcastAssistantAck(`Opening the ${roomKey} room.`, requestId);
      this.broadcastThinkingEnd(requestId);
      return;
    }

    // Phase 6.3.5b — voice approve/cancel for pending confirmations.
    // Resolve the most-recent pending action (approval > clarifier >
    // repeat-back). When nothing is pending, fall through to chat so
    // "yes" / "no" still work as conversational replies. Approvals run
    // through gateVoiceApprovalResolution first — destructive actions
    // refuse voice resolution outright; non-destructive require
    // confidence ≥ 0.85.
    if (route === 'act' && intent.confirmation_response) {
      const decision = intent.confirmation_response;
      try {
        const resolved = await this.resolveLatestPendingByVoice(decision, intent.confidence);
        if (resolved) {
          if (resolved.kind === 'gated') {
            this.broadcastVoiceApprovalGated(resolved.label, resolved.message, requestId);
          } else {
            const verb = decision === 'approve' ? 'Approving' : 'Cancelling';
            this.broadcastAssistantAck(`${verb} ${resolved.label}.`, requestId);
          }
          this.broadcastThinkingEnd(requestId);
          return;
        }
        // Nothing pending → fall through to chat below.
      } catch (err) {
        console.warn('[WSService] voice confirmation resolution failed:', err);
      }
    }

    if (route === 'act') {
      // Normal chat flow — thinking_end will be emitted on first stream chunk.
      // skipIntercept: classifier already ran above; don't double-classify.
      await this.handleChat({
        type: 'chat',
        payload: { text: trimmed, skipIntercept: true },
        id: requestId,
        timestamp: Date.now(),
      }, ws);
    } else {
      // Hold the transcript and ask the user to confirm before acting.
      const pending: PendingVoiceConfirmation = {
        id: intent.id,
        intent,
        transcript: trimmed,
        ws,
        channel: 'websocket',
        kind: route === 'clarify' ? 'clarifier' : 'repeat_back',
        createdAt: Date.now(),
      };
      this.pendingVoiceConfirmations.set(pending.id, pending);
      if (route === 'clarify') {
        this.broadcastClarifierRequest(pending);
      } else {
        this.broadcastRepeatBackRequest(pending);
      }
      // Thinking ends at the moment we hand control back to the user.
      this.broadcastThinkingEnd(requestId);
    }
  }

  /**
   * Look up the last few user/assistant turns from the active conversation,
   * for use as classifier context. Bounded at 6 (3 user + 3 assistant)
   * because anything older rarely informs intent.
   */
  private recentTurns(channel: string): RecentTurn[] {
    try {
      const conversation = getOrCreateConversation(channel);
      const messages = getMessages(conversation.id, { limit: 6 });
      return messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.content }));
    } catch (err) {
      console.warn('[WSService] recentTurns lookup failed:', err);
      return [];
    }
  }

  /**
   * Phase 6.3.5b — voice approve/cancel for the most-recent pending action.
   *
   * Priority order: pending approval (authority pipeline) > pending
   * clarifier/repeat-back (voice confirmation map). This matches the user's
   * mental model — destructive approvals are always more urgent than
   * voice transcript clarifications.
   *
   * Returns null when nothing is pending so the caller can fall through to
   * the chat agent (so "yes" still means "yes, I agree" in conversation).
   */
  async resolveLatestPendingByVoice(
    decision: 'approve' | 'cancel',
    confidence = 1,
  ): Promise<
    | { kind: 'approval' | 'clarifier' | 'repeat_back'; label: string }
    | { kind: 'gated'; label: string; message: string }
    | null
  > {
    // 1. Pending approvals — newest first.
    if (this.approvalManager) {
      const pending = this.approvalManager.getPending();
      if (pending.length > 0) {
        const latest = pending.reduce((a, b) => (a.created_at > b.created_at ? a : b));
        const label = (latest.reason && latest.reason.trim()) || latest.tool_name;

        // Two-tier safety: destructive impacts never resolve by voice;
        // non-destructive require confidence ≥ 0.85. Gate decision is a
        // pure helper so it's unit-testable without spinning up the
        // approval pipeline. See gateVoiceApprovalResolution.
        const gate = gateVoiceApprovalResolution(latest.action_category as ActionCategory, confidence);
        if (gate.kind === 'clarify') {
          // Pending approval STAYS in the queue — user can resolve via
          // dashboard click. We log a 'voice' channel audit row marked
          // approval_required so the gated event is forensically visible
          // even though no decision was applied.
          this.auditTrail?.log({
            agent_id: latest.agent_id,
            agent_name: latest.agent_name,
            tool_name: latest.tool_name,
            action_category: latest.action_category as ActionCategory,
            authority_decision: 'approval_required',
            approval_id: latest.id,
            executed: false,
            channel: 'voice',
          });
          return { kind: 'gated', label, message: gate.message };
        }

        if (decision === 'approve') {
          const approved = this.approvalManager.approve(latest.id, 'voice');
          if (!approved) return null;
          // Audit the voice resolution distinctly from the click path so
          // forensics can isolate any false-positive voice approvals.
          this.auditTrail?.log({
            agent_id: latest.agent_id,
            agent_name: latest.agent_name,
            tool_name: latest.tool_name,
            action_category: latest.action_category as ActionCategory,
            authority_decision: 'allowed',
            approval_id: latest.id,
            executed: false,
            channel: 'voice',
          });
          // Same skip-on-intent-only path as the REST endpoint.
          if (this.deferredExecutor && approved.tool_name !== 'request_approval') {
            try {
              await this.deferredExecutor.executeApproved(latest.id);
            } catch (err) {
              console.warn('[WSService] voice-approved execution failed:', err);
            }
          }
          const updated = this.approvalManager.getRequest(latest.id);
          if (updated) this.broadcastApprovalUpdate(updated);
          return { kind: 'approval', label };
        }
        // cancel
        const denied = this.approvalManager.deny(latest.id, 'voice');
        if (!denied) return null;
        this.auditTrail?.log({
          agent_id: latest.agent_id,
          agent_name: latest.agent_name,
          tool_name: latest.tool_name,
          action_category: latest.action_category as ActionCategory,
          authority_decision: 'denied',
          approval_id: latest.id,
          executed: false,
          channel: 'voice',
        });
        if (this.deferredExecutor) {
          this.deferredExecutor.recordDenial(denied);
        }
        const updated = this.approvalManager.getRequest(latest.id);
        if (updated) this.broadcastApprovalUpdate(updated);
        return { kind: 'approval', label };
      }
    }

    // 2. Pending clarifier / repeat-back — newest first within the map.
    if (this.pendingVoiceConfirmations.size > 0) {
      const latest = Array.from(this.pendingVoiceConfirmations.values()).reduce((a, b) =>
        a.createdAt > b.createdAt ? a : b,
      );
      const result = await this.resolveVoiceConfirmation(
        latest.id,
        decision === 'approve' ? 'confirm' : 'cancel',
      );
      if (!result.ok) return null;
      const label = latest.transcript.length > 60
        ? latest.transcript.slice(0, 60) + '…'
        : latest.transcript;
      return {
        kind: latest.kind === 'clarifier' ? 'clarifier' : 'repeat_back',
        label,
      };
    }

    return null;
  }

  /**
   * Resolve a pending voice confirmation. Called by the REST endpoints
   * `/api/voice/(clarifier|repeat-back)/:id/{confirm,cancel}`.
   *
   * On confirm: forwards the held transcript to the chat agent.
   * On cancel: drops the pending entry; the user-voice ThreadItem stays in
   * the thread but no assistant reply is generated.
   *
   * Either way, broadcasts a `voice_confirmation_resolved` notification so
   * the dashboard removes the clarifier/repeat-back card from the thread.
   */
  async resolveVoiceConfirmation(
    id: string,
    decision: 'confirm' | 'cancel',
  ): Promise<{ ok: boolean; reason?: string }> {
    const pending = this.pendingVoiceConfirmations.get(id);
    if (!pending) return { ok: false, reason: 'not-found' };

    this.pendingVoiceConfirmations.delete(id);

    const message: WSMessage = {
      type: 'notification',
      payload: {
        source: 'voice_confirmation_resolved',
        id,
        decision,
        kind: pending.kind,
      },
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(message);

    if (decision === 'cancel') {
      return { ok: true };
    }

    try {
      this.broadcastThinkingStart(pending.id);
      await this.handleChat({
        type: 'chat',
        payload: { text: pending.transcript, skipIntercept: true },
        id: pending.id,
        timestamp: Date.now(),
      }, pending.ws);
      return { ok: true };
    } catch (err) {
      console.error('[WSService] resolveVoiceConfirmation chat error:', err);
      return { ok: false, reason: err instanceof Error ? err.message : 'chat-failed' };
    }
  }

  /** Broadcast: classifier wants confirmation between alternative interpretations. */
  private broadcastClarifierRequest(pending: PendingVoiceConfirmation): void {
    const message: WSMessage = {
      type: 'notification',
      payload: {
        source: 'clarifier_request',
        id: pending.id,
        intent: pending.intent,
        transcript: pending.transcript,
      },
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(message);
  }

  /**
   * Broadcast a "voice approval gated" notice — the user's spoken yes/no
   * was heard but suppressed because either the action is destructive
   * (always click) or STT confidence was too low (please repeat or click).
   *
   * The pending approval STAYS in the queue; this notice tells the UI
   * to show a transient banner so the user knows their voice didn't
   * resolve anything (vs silent no-op which would be confusing).
   */
  private broadcastVoiceApprovalGated(label: string, message: string, requestId?: string): void {
    const wsMessage: WSMessage = {
      type: 'notification',
      payload: {
        source: 'voice_approval_gated',
        label,
        message,
      },
      id: requestId,
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(wsMessage);
  }

  /** Broadcast: classifier didn't understand; ask the user to confirm the verbatim transcript. */
  private broadcastRepeatBackRequest(pending: PendingVoiceConfirmation): void {
    const message: WSMessage = {
      type: 'notification',
      payload: {
        source: 'repeat_back_request',
        id: pending.id,
        transcript: pending.transcript,
        confidence: pending.intent.confidence,
      },
      timestamp: Date.now(),
    };
    this.wsServer.broadcast(message);
  }

  /**
   * Public exposure of `formatApprovalIntent` so api-routes can produce the
   * same intent string for REST responses (Phase 5B audit fix). Falls back
   * to `reason || tool_name` if the helper isn't available.
   */
  computeApprovalIntent(request: ApprovalRequest): string {
    return formatApprovalIntent(request);
  }

  /**
   * Tell the dashboard to open a Room. Emitted when a voice intent like
   * "open workflows" classifies cleanly (verb=show, object.type maps to a
   * RoomKey) — bypasses the chat agent.
   */
  broadcastRoomNavigation(key: RoomKey, requestId?: string): void {
    this.wsServer.broadcast({
      type: 'notification',
      payload: { source: 'navigate_room', key, requestId },
      timestamp: Date.now(),
    });
  }

  /**
   * Tell the dashboard to close any open Room and return to the home thread
   * view. Emitted on "back to thread" / "close the room" voice intents.
   */
  broadcastNavigateHome(requestId?: string): void {
    this.wsServer.broadcast({
      type: 'notification',
      payload: { source: 'navigate_home', requestId },
      timestamp: Date.now(),
    });
  }

  /**
   * Tell the dashboard to operate a RoomWindow's chrome — close / minimize
   * / expand / restore — without going through the chat agent. Emitted by
   * the regex window-control matcher in `handleVoiceSession`.
   */
  broadcastWindowControl(ctrl: WindowControl, requestId?: string): void {
    this.wsServer.broadcast({
      type: 'notification',
      payload: {
        source: 'window_control',
        action: ctrl.action,
        target: ctrl.target,
        requestId,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Phase 6.3.5 — drive a Room's UI directly from voice. The dashboard's
   * action bus dispatches to whichever Room is currently mounted matching
   * `room`. Args are per-action and validated client-side.
   */
  broadcastRoomAction(
    action: { room: string; action: string; args?: Record<string, unknown> },
    requestId?: string,
  ): void {
    this.wsServer.broadcast({
      type: 'notification',
      payload: {
        source: 'room_action',
        room: action.room,
        action: action.action,
        args: action.args ?? {},
        requestId,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Short assistant-side acknowledgement message broadcast as a chat row.
   * Used when the daemon handled the user's request itself (e.g. opening
   * a Room) and the chat agent isn't going to produce its own reply.
   */
  broadcastAssistantAck(text: string, requestId?: string): void {
    this.wsServer.broadcast({
      type: 'notification',
      payload: { source: 'assistant_message', text },
      id: requestId,
      timestamp: Date.now(),
    });
  }

  /** Voice pipeline: STT-final received, agent now reasoning. */
  broadcastThinkingStart(requestId: string): void {
    this.wsServer.broadcast({
      type: 'thinking_start',
      payload: { requestId },
      id: requestId,
      timestamp: Date.now(),
    });
  }

  /** Voice pipeline: agent emitted first response token (or handed back to user). */
  broadcastThinkingEnd(requestId: string): void {
    this.wsServer.broadcast({
      type: 'thinking_end',
      payload: { requestId },
      id: requestId,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle system commands.
   */
  private async handleCommand(msg: WSMessage): Promise<WSMessage> {
    const payload = msg.payload as { command?: string };
    const command = payload?.command;

    switch (command) {
      case 'health':
        return {
          type: 'status',
          payload: {
            status: 'ok',
            service: this.name,
            clients: this.wsServer.getClientCount(),
          },
          id: msg.id,
          timestamp: Date.now(),
        };

      case 'ping':
        return {
          type: 'status',
          payload: { pong: true },
          id: msg.id,
          timestamp: Date.now(),
        };

      case 'cancel_execution': {
        const commitmentId = (msg.payload as any)?.commitmentId;
        if (this.commitmentExecutor && commitmentId) {
          const cancelled = this.commitmentExecutor.cancelExecution(commitmentId);
          return {
            type: 'status',
            payload: { cancelled, commitmentId },
            id: msg.id,
            timestamp: Date.now(),
          };
        }
        return {
          type: 'error',
          payload: { message: 'No executor available or missing commitmentId' },
          id: msg.id,
          timestamp: Date.now(),
        };
      }

      default:
        return {
          type: 'error',
          payload: { message: `Unknown command: ${command}` },
          id: msg.id,
          timestamp: Date.now(),
        };
    }
  }

  /**
   * Handle status requests.
   */
  private handleStatus(): WSMessage {
    return {
      type: 'status',
      payload: {
        service: this.name,
        status: this._status,
        clients: this.wsServer.getClientCount(),
        port: this.port,
      },
      timestamp: Date.now(),
    };
  }
}

/**
 * Heuristic: does this chat text look like a commitment (scheduled, recurring,
 * or explicitly deferred intent) that deserves to be tracked by the
 * CommitmentExecutor? Returns false for conversational requests that the
 * primary streaming agent already handles in real time.
 *
 * Positive signals (any one triggers):
 *   - "remind me to …", "tell me when …"
 *   - "every day/week/month/monday/…", "daily/weekly"
 *   - time anchors: "at 3pm", "tomorrow", "on Friday", "next week"
 *   - explicit scheduling verbs: "schedule", "plan", "book"
 *
 * Anything else — including "send email to X", "open Y", "run Z", questions —
 * is treated as a synchronous conversational request.
 */
function looksLikeCommitment(text: string): boolean {
  const t = text.trim();
  if (t.length < 10) return false;
  const lower = t.toLowerCase();

  // Explicit commitment phrases
  const phrasePatterns = [
    /\bremind me\b/,
    /\btell me when\b/,
    /\b(schedule|plan|book)\b/,
    /\bevery (day|week|month|morning|evening|night|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
    /\b(daily|weekly|monthly|hourly)\b/,
  ];
  for (const rx of phrasePatterns) {
    if (rx.test(lower)) return true;
  }

  // Time anchors — "at 3pm", "at 10:30", "by 5pm", "at noon"
  if (/\b(at|by)\s+(\d{1,2}(:\d{2})?\s*(am|pm)?|noon|midnight)\b/.test(lower)) return true;

  // Day anchors — "tomorrow", "next week", "on Friday", "this evening"
  if (/\b(tomorrow|tonight|this (morning|afternoon|evening|night))\b/.test(lower)) return true;
  if (/\bnext (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lower)) return true;
  if (/\bon (mon|tue|wed|thu|fri|sat|sun)(day)?\b/.test(lower)) return true;

  return false;
}

/**
 * Build a short imperative sentence describing an approval request, for use
 * as the `intent` field in the dashboard ApprovalCard. Prefers the LLM-supplied
 * reason when it looks like a complete sentence; otherwise synthesizes one
 * from tool_name + arguments.
 */
function formatApprovalIntent(request: ApprovalRequest): string {
  const reason = (request.reason ?? '').trim();

  // `reason` is usually an imperative sentence drafted by the LLM (e.g.,
  // "Reply to Anya — move Monday review to 3pm"). Keep it as-is when present.
  if (reason.length > 0) return reason;

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(request.tool_arguments ?? '{}');
  } catch {
    // fall through with empty args
  }

  // Per-tool fallbacks for the common destructive/external intents.
  switch (request.tool_name) {
    case 'send_email': {
      const to = asString(args.to) ?? 'someone';
      const subject = asString(args.subject);
      return subject
        ? `Send email to ${to} — "${subject}"`
        : `Send email to ${to}`;
    }
    case 'send_message': {
      const channel = asString(args.channel) ?? 'channel';
      return `Send message via ${channel}`;
    }
    case 'run_command':
    case 'execute_command': {
      const cmd = asString(args.command) ?? 'a shell command';
      return `Run: ${cmd}`;
    }
    case 'delete_file':
    case 'delete_data': {
      const path = asString(args.path) ?? asString(args.target) ?? 'the target';
      return `Delete ${path}`;
    }
    case 'install_software': {
      const pkg = asString(args.package) ?? asString(args.name) ?? 'software';
      return `Install ${pkg}`;
    }
    case 'make_payment': {
      const amount = asString(args.amount) ?? asString(args.total);
      const to = asString(args.recipient) ?? asString(args.to) ?? 'recipient';
      return amount ? `Pay ${amount} to ${to}` : `Make a payment to ${to}`;
    }
    case 'spawn_agent': {
      const role = asString(args.role) ?? 'an agent';
      return `Spawn ${role}`;
    }
    default: {
      const verb = request.tool_name.replace(/_/g, ' ');
      return `${verb}`.replace(/^./, (c) => c.toUpperCase());
    }
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Short ack message for window-control voice commands. Mirrors the
 * "Opening the X room." style of the navigation acks.
 */
function ackForWindowControl(ctrl: WindowControl): string {
  const target = ctrl.target === 'most_recent' ? 'the room' : `the ${ctrl.target} room`;
  switch (ctrl.action) {
    case 'close':
      return `Closing ${target}.`;
    case 'minimize':
      return `Minimizing ${target}.`;
    case 'expand':
      return `Expanding ${target}.`;
    case 'restore':
      return `Restoring ${target}.`;
    case 'reorder':
      return `Tidying up. Bringing all rooms back inline.`;
  }
}

/**
 * Phase 6.3.5 — short ack for Room action voice commands. Reads naturally
 * for the most common per-Room actions; falls back to a generic "Done" for
 * anything not enumerated so future Room action vocabularies don't need
 * code changes here.
 */
function ackForRoomAction(ra: { room: string; action: string; args?: Record<string, unknown> }): string {
  const a = ra.args ?? {};
  switch (ra.action) {
    case 'switch_tab':
      return `Switching to ${String(a.tab ?? 'tab')} view.`;
    case 'open_spawn_dialog':
      return `Opening the spawn dialog.`;
    case 'close_dialog':
      return `Closing the dialog.`;
    case 'set_search':
      return `Searching for ${String(a.query ?? '')}.`;
    case 'spawn_agent': {
      const spec = String(a.specialist ?? 'agent').replace(/-/g, ' ');
      return a.task ? `Spawning a ${spec} for ${String(a.task)}.` : `Spawning a ${spec}.`;
    }
    case 'set_filter':
      return `Filtering by ${String(a.filter ?? '')}.`;
    case 'search':
      return `Searching for ${String(a.query ?? '')}.`;
    case 'select':
      return `Selecting ${String(a.name ?? '')}.`;
    case 'toggle_source':
      return `Toggling ${String(a.source ?? '')} logs.`;
    case 'set_time_window': {
      const w = String(a.window ?? '');
      const label =
        w === '1h' ? 'last hour' :
        w === '24h' ? 'last day' :
        w === '7d' ? 'last week' :
        w === 'all' ? 'all time' : w;
      return `Showing ${label}.`;
    }
    case 'toggle_live_tail':
      return `Toggling live tail.`;
    case 'refresh':
      return `Refreshing.`;
    case 'run':
      return a.name ? `Running ${String(a.name)}.` : `Running the selected workflow.`;
    case 'pause':
      return a.name ? `Pausing ${String(a.name)}.` : `Pausing the selected workflow.`;
    case 'enable':
      return a.name ? `Enabling ${String(a.name)}.` : `Enabling the selected workflow.`;
    case 'create_from_nl':
      return a.prompt
        ? `Creating a workflow that ${String(a.prompt)}.`
        : `Creating a new workflow.`;
    case 'remember_that':
      return a.subject && a.predicate && a.object
        ? `Remembered that ${String(a.subject)}'s ${String(a.predicate)} is ${String(a.object)}.`
        : `Remembering that.`;
    case 'grant_access':
      return a.action
        ? `Granting ${String(a.action).replace(/_/g, ' ')}.`
        : `Granting access.`;
    case 'revoke_access':
      return a.action
        ? `Revoking ${String(a.action).replace(/_/g, ' ')}.`
        : `Revoking access.`;
    case 'switch_view':
      return `Switching to ${String(a.view ?? 'view')} view.`;
    case 'select_event':
      return a.title ? `Opening ${String(a.title)}.` : `Opening that event.`;
    case 'schedule_event': {
      const title = a.title ? String(a.title) : 'event';
      const when = a.when ? ` for ${String(a.when)}` : '';
      return `Scheduling ${title}${when}.`;
    }
    case 'create_goal': {
      const title = a.title ? String(a.title) : 'goal';
      const level = a.level ? ` (${String(a.level).replace(/_/g, ' ')})` : '';
      return `Creating goal "${title}"${level}.`;
    }
    case 'create_task': {
      const title = a.title ? String(a.title) : 'task';
      const when = a.when ? ` for ${String(a.when)}` : '';
      return `Creating task "${title}"${when}.`;
    }
    case 'complete_task':
      return a.name ? `Marking "${String(a.name)}" complete.` : `Marking task complete.`;
    case 'update_priority':
      return a.name && a.level
        ? `Setting "${String(a.name)}" to ${String(a.level)} priority.`
        : `Updating priority.`;
    case 'reassign':
      return a.name && a.agent
        ? `Reassigning "${String(a.name)}" to ${String(a.agent)}.`
        : `Reassigning task.`;
    case 'create_content': {
      const title = a.title ? String(a.title) : 'content';
      const type = a.type ? ` (${String(a.type)})` : '';
      return `Creating ${title}${type}.`;
    }
    case 'advance':
      return a.name ? `Advancing "${String(a.name)}".` : `Advancing.`;
    case 'regress':
      return a.name ? `Moving "${String(a.name)}" back.` : `Moving back.`;
    case 'schedule':
      return a.name && a.when
        ? `Scheduling "${String(a.name)}" for ${String(a.when)}.`
        : `Scheduling.`;
    case 'select_project':
      return a.name ? `Opening "${String(a.name)}".` : `Opening that project.`;
    case 'back_to_list':
      return `Back to projects.`;
    case 'create_project': {
      const name = a.name ? String(a.name) : 'project';
      const tpl = a.template ? ` (${String(a.template)})` : '';
      return `Creating project "${name}"${tpl}.`;
    }
    case 'start_server':
      return a.name ? `Starting "${String(a.name)}".` : `Starting the dev server.`;
    case 'stop_server':
      return a.name ? `Stopping "${String(a.name)}".` : `Stopping the dev server.`;
    case 'read_status':
      return `Reading current settings.`;
    case 'set_primary_llm':
      return a.provider ? `Setting primary LLM to ${String(a.provider)}.` : `Setting primary LLM.`;
    case 'set_fallback_llm':
      return `Updating fallback chain.`;
    case 'set_model':
      return a.provider && a.model
        ? `Setting ${String(a.provider)} model to ${String(a.model)}.`
        : `Updating model.`;
    case 'test_provider':
      return a.provider ? `Testing ${String(a.provider)}.` : `Testing provider.`;
    case 'enable_telegram':
      return `Enabling Telegram. Restart Jarvis to apply.`;
    case 'disable_telegram':
      return `Disabling Telegram. Restart Jarvis to apply.`;
    case 'enable_discord':
      return `Enabling Discord. Restart Jarvis to apply.`;
    case 'disable_discord':
      return `Disabling Discord. Restart Jarvis to apply.`;
    case 'set_stt_provider':
      return a.provider
        ? `Setting STT to ${String(a.provider)}. Restart Jarvis to apply.`
        : `Updating STT provider.`;
    case 'enable_tts':
      return `Turning on text to speech.`;
    case 'disable_tts':
      return `Turning off text to speech.`;
    case 'set_tts_provider':
      return a.provider ? `Switching TTS to ${String(a.provider)}.` : `Updating TTS provider.`;
    case 'set_tts_voice':
      return a.voice ? `Setting voice to ${String(a.voice)}.` : `Updating voice.`;
    case 'set_heartbeat_interval':
      return a.minutes ? `Setting heartbeat to ${String(a.minutes)} minutes.` : `Updating heartbeat.`;
    case 'set_heartbeat_aggressiveness':
      return a.level ? `Setting heartbeat to ${String(a.level)}.` : `Updating heartbeat.`;
    case 'restart_daemon':
      return `Restarting Jarvis. The dashboard will reconnect in a few seconds.`;
    case 'replay_onboarding': {
      const sc = a.scope ? String(a.scope) : 'all';
      const label =
        sc === 'setup'
          ? 'the setup screens'
          : sc === 'profile'
            ? 'the profile interview'
            : sc === 'tutorial'
              ? 'the tutorial'
              : 'onboarding';
      return `Replaying ${label}. The dashboard will reload in a moment.`;
    }
    default:
      return `Done.`;
  }
}
