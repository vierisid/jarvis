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
import { setDefaultCwd } from '../actions/tools/builtin.ts';
import type { ApprovalRequest } from '../authority/approval.ts';
import type { EmergencyState } from '../authority/emergency.ts';
import { impactFromCategory } from '../roles/authority.ts';
import { classifyVoiceIntent, type RecentTurn } from '../agents/voice-intent-classifier.ts';
import { routeByConfidence, intentToRoomKey, intentIsBackToThread, type Intent, type RoomKey } from '../voice/intent.ts';
import { matchWindowControl, type WindowControl } from '../voice/window-control.ts';
import { getMessages } from '../vault/conversations.ts';
import { createCommitment, updateCommitmentStatus, updateCommitmentAssignee } from '../vault/commitments.ts';
import { recordAgentActivity } from '../vault/agent-activity.ts';
import { WebSocketServer, type WSMessage } from '../comms/websocket.ts';
import { StreamRelay } from '../comms/streaming.ts';
import { classifyErrorString } from '../llm/provider.ts';
import { getOrCreateConversation, addMessage } from '../vault/conversations.ts';
import { maybeCreateUserProfileFollowupPrompt, recordUserProfileTurn } from '../user/profile-followup.ts';

type VoiceSession = {
  requestId: string;
  chunks: Buffer[];
  startedAt: number;
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
  private siteBuilderService: import('../sites/service.ts').SiteBuilderService | null = null;

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

  broadcastSiteEvent(event: { type: string; projectId: string; data: Record<string, unknown>; timestamp: number }): void {
    const message: WSMessage = {
      type: 'site_event',
      payload: event,
      timestamp: event.timestamp,
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

      case 'voice_text': {
        // Browser-side STT path: the dashboard already has a final transcript
        // (via the Web Speech API) and prefers it over daemon Whisper. Skip
        // STT entirely and run the same downstream pipeline.
        const payload = msg.payload as { requestId?: string; text?: string };
        const requestId = payload?.requestId ?? msg.id ?? crypto.randomUUID();
        const text = (payload?.text ?? '').trim();
        // If we have an in-flight audio session (parallel paths), drop it so
        // we don't double-process the same utterance.
        this.voiceSessions.delete(ws);
        if (!text) return undefined;
        this.processVoiceTranscript(text, requestId, ws).catch(err =>
          console.error('[WSService] voice_text pipeline error:', err)
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
    const payload = msg.payload as { text?: string; channel?: string; projectId?: string };
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

    const channel = payload.channel ?? 'websocket';
    const requestId = msg.id ?? crypto.randomUUID();

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

          siteContext = `# Site Builder

You have access to the Site Builder feature with ${projects.length} project(s):
${projectList}

You can work on any of these projects using site builder tools (site_read_file, site_write_file, site_list_files, site_run_command, site_git_commit, site_github_push) by passing the project's id as project_id.
When the user asks you to build, edit, or work on a website/app, use these tools to make changes directly in the project files.
If the user wants to create a new project, tell them to use the Site Builder page (Sites tab in the sidebar) to create one first.`;
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
    const session = this.voiceSessions.get(ws);
    if (!session) {
      console.warn('[WSService] Binary audio received with no active voice session');
      return;
    }
    session.chunks.push(data);
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
      await this.processVoiceTranscript(transcript, session.requestId, ws);
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
  private async processVoiceTranscript(
    transcript: string,
    requestId: string,
    ws: ServerWebSocket<unknown>,
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
    const intent = await classifyVoiceIntent(trimmed, recentTurns, llm);
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

    const roomKey = route === 'act' ? intentToRoomKey(intent) : null;
    if (roomKey) {
      this.broadcastRoomNavigation(roomKey, requestId);
      this.broadcastAssistantAck(`Opening the ${roomKey} room.`, requestId);
      this.broadcastThinkingEnd(requestId);
      return;
    }

    // Phase 6.3.5 — Room action interception. When the classifier emits a
    // structured `room_action`, drive the Room's UI directly via the
    // dashboard's action bus. Bypasses chat (the LLM has no concept of
    // tabs/dialogs/filters). Same confidence gating as chat — low-confidence
    // room actions still go through the clarifier.
    if (route === 'act' && intent.room_action) {
      const ra = intent.room_action;
      this.broadcastRoomAction(ra, requestId);
      this.broadcastAssistantAck(ackForRoomAction(ra), requestId);
      this.broadcastThinkingEnd(requestId);
      return;
    }

    if (route === 'act') {
      // Normal chat flow — thinking_end will be emitted on first stream chunk.
      await this.handleChat({
        type: 'chat',
        payload: { text: trimmed },
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
        payload: { text: pending.transcript },
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
    default:
      return `Done.`;
  }
}
