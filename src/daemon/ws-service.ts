/**
 * WebSocket Service — The Mouth
 *
 * Wraps WebSocketServer and StreamRelay. Routes incoming messages
 * to the AgentService and relays streamed responses back to clients.
 */

import type { ServerWebSocket } from 'bun';
import type { Service, ServiceStatus } from './services.ts';
import type { AgentService } from './agent-service.ts';
import type { CommitmentExecutor } from './commitment-executor.ts';
import type { ChannelService } from './channel-service.ts';
import type { Commitment } from '../vault/commitments.ts';
import type { ContentItem } from '../vault/content-pipeline.ts';
import type { STTProvider, TTSProvider } from '../comms/voice.ts';
import type { ApprovalRequest } from '../authority/approval.ts';
import type { EmergencyState } from '../authority/emergency.ts';
import { createCommitment, updateCommitmentStatus, updateCommitmentAssignee } from '../vault/commitments.ts';
import { WebSocketServer, type WSMessage } from '../comms/websocket.ts';
import { StreamRelay } from '../comms/streaming.ts';
import { getOrCreateConversation, addMessage } from '../vault/conversations.ts';

type VoiceSession = {
  requestId: string;
  chunks: Buffer[];
  startedAt: number;
};

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
          // Clean up any pending voice session for this client
          this.voiceSessions.delete(ws);
          console.log('[WSService] Client disconnected');
        },
      });

      // Start the server
      this.wsServer.start();
      this._status = 'running';
      console.log(`[WSService] Started on port ${this.port}`);
    } catch (error) {
      this._status = 'error';
      throw error;
    }
  }

  async stop(): Promise<void> {
    this._status = 'stopping';
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
  }

  /**
   * Broadcast an approval request to all connected dashboard clients.
   * Always pushed via WS; urgent requests are also sent to external channels.
   */
  broadcastApprovalRequest(request: ApprovalRequest): void {
    const shortId = request.id.slice(0, 8);
    const message: WSMessage = {
      type: 'notification',
      payload: {
        source: 'approval_request',
        request,
        shortId,
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

      // Signal TTS start to all clients
      const startMsg: WSMessage = {
        type: 'tts_start',
        payload: { requestId },
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

  broadcastApprovalUpdate(request: ApprovalRequest): void {
    const message: WSMessage = {
      type: 'notification',
      payload: {
        source: 'approval_update',
        request,
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
        const { requestId } = msg.payload as { requestId: string };
        this.voiceSessions.set(ws, { requestId, chunks: [], startedAt: Date.now() });
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
    const payload = msg.payload as { text?: string; channel?: string };
    const text = payload?.text;

    if (!text) {
      return {
        type: 'error',
        payload: { message: 'Missing text in chat payload' },
        id: msg.id,
        timestamp: Date.now(),
      };
    }

    const channel = payload.channel ?? 'websocket';
    const requestId = msg.id ?? crypto.randomUUID();

    // Auto-create a task for non-trivial messages
    const isTrivial = text.trim().length < 10;
    let taskCommitment: Commitment | null = null;

    if (!isTrivial) {
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
      addMessage(conversation.id, { role: 'user', content: text });

      const { stream, onComplete } = this.agentService.streamMessage(text, channel);

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

        // Send tts_start exactly once before the first audio chunk
        if (!ttsStartSent) {
          ttsStartSent = true;
          this.wsServer.sendToClient(ws, {
            type: 'tts_start',
            payload: { requestId },
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

      // Fire-and-forget: run post-processing (extraction, personality)
      onComplete(fullText).catch((err) =>
        console.error('[WSService] onComplete error:', err)
      );

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

      return {
        type: 'error',
        payload: {
          message: error instanceof Error ? error.message : 'Chat processing failed',
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
    const session = this.voiceSessions.get(ws);
    if (!session) {
      console.warn('[WSService] Binary audio received with no active voice session');
      return;
    }
    session.chunks.push(data);
  }

  /**
   * Process a completed voice session: STT → chat → TTS response.
   */
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

      console.log('[WSService] Voice transcript:', transcript);

      // Echo transcript back so the UI shows it as a user message
      this.wsServer.sendToClient(ws, {
        type: 'chat',
        payload: { text: transcript, source: 'voice_transcript' },
        id: session.requestId,
        timestamp: Date.now(),
      });

      // Reuse existing chat flow
      await this.handleChat({
        type: 'chat',
        payload: { text: transcript },
        id: session.requestId,
        timestamp: Date.now(),
      }, ws);
    } catch (err) {
      console.error('[WSService] STT error:', err);
      this.wsServer.sendToClient(ws, {
        type: 'error',
        payload: { message: 'Voice transcription failed' },
        timestamp: Date.now(),
      });
    }
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
