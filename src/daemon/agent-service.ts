/**
 * Agent Service — The Brain
 *
 * Owns the LLM manager, agent orchestrator, and personality state.
 * Builds dynamic system prompts each turn with role context, personality,
 * commitments, and observations.
 */

import { join } from 'node:path';
import type { Service, ServiceStatus } from './services.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { LLMStreamEvent, LLMMessage, LLMErrorCode } from '../llm/provider.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { PersonalityModel } from '../personality/model.ts';

import { LLMManager } from '../llm/manager.ts';
import { activeTurns, DrainingError } from './active-turns.ts';
import { registerLLMProviders, configureLLMTiers } from '../llm/config-binding.ts';
import { effectiveLlmForBinding } from './usejarvis-ai.ts';

/** Wrap a turn's stream so the in-flight count is released when it settles
 *  (exhausted, errored, or the consumer breaks). `endTurn` is idempotent. */
async function* trackTurnStream(
  inner: AsyncIterable<LLMStreamEvent>,
  endTurn: () => void,
): AsyncGenerator<LLMStreamEvent> {
  try {
    yield* inner;
  } finally {
    endTurn();
  }
}
import { getDb } from '../vault/schema.ts';
import { AgentOrchestrator } from '../agents/orchestrator.ts';
import { loadRole } from '../roles/loader.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { BUILTIN_TOOLS, browser } from '../actions/tools/builtin.ts';
import { createDelegateTool, type DelegateToolDeps } from '../actions/tools/delegate.ts';
import { createManageAgentsTool, type AgentToolDeps } from '../actions/tools/agents.ts';
import { contentPipelineTool } from '../actions/tools/content.ts';
import { commitmentsTool } from '../actions/tools/commitments.ts';
import { researchQueueTool } from '../actions/tools/research.ts';
import { documentTool } from '../actions/tools/documents.ts';
import { AgentTaskManager } from '../agents/task-manager.ts';
import { discoverSpecialists, formatSpecialistList } from '../agents/role-discovery.ts';
import { buildSystemPromptParts, type PromptContext, type SystemPromptParts } from '../roles/prompt-builder.ts';
import { piecesManagedByHost } from '../workflows/pieces-library/shared.ts';
import { resolveSharedRuntimePaths } from '../workflows/runtime/shared-runtime-paths.ts';
import type { ProgressCallback } from '../agents/sub-agent-runner.ts';
import {
  getPersonality,
  savePersonality,
} from '../personality/model.ts';
import {
  getChannelPersonality,
  personalityToPrompt,
} from '../personality/adapter.ts';
import {
  extractSignals,
  applySignals,
  recordInteraction,
} from '../personality/learner.ts';
import { getDueCommitments, getUpcoming } from '../vault/commitments.ts';
import { findContent } from '../vault/content-pipeline.ts';
import { getRecentObservations } from '../vault/observations.ts';
import { extractAndStore } from '../vault/extractor.ts';
import { getKnowledgeForMessage } from '../vault/retrieval.ts';
import { formatUserProfileForPrompt } from '../user/profile.ts';
import { getUserProfile } from '../vault/user-profile.ts';
import type { ResearchQueue } from './research-queue.ts';
import type { IAgentService } from './agent-service-interface.ts';
import type { AuthorityEngine } from '../authority/engine.ts';
import { getSidecarManager } from '../actions/tools/sidecar-route.ts';
import { ConvOrchestrator } from '../agents/conv/conv-orchestrator.ts';
import { TaskRegistry } from '../agents/conv/task-registry.ts';
import { TaskDispatcher } from '../agents/conv/task-dispatcher.ts';
import { DialogueCompactor } from '../agents/conv/dialogue-compactor.ts';
import type { ConvTaskEvent } from '../agents/conv/conv-orchestrator.ts';
import { getRecentConversation, getMessages } from '../vault/conversations.ts';

export class AgentService implements Service, IAgentService {
  name = 'agent';
  private _status: ServiceStatus = 'stopped';
  private config: JarvisConfig;
  private llmManager: LLMManager;
  private orchestrator: AgentOrchestrator;
  private role: RoleDefinition | null = null;
  private personality: PersonalityModel | null = null;
  private specialists: Map<string, RoleDefinition> = new Map();
  private specialistListText: string = '';
  private delegationProgressCallback: ProgressCallback | null = null;
  private delegationCallback: ((specialistName: string, task: string) => void) | null = null;
  private researchQueue: ResearchQueue | null = null;
  private taskManager: AgentTaskManager | null = null;
  private authorityEngine: AuthorityEngine | null = null;
  // Phase 4: conv-tier infrastructure. Constructed lazily when the
  // conversation tier is configured. Null in classic single-orchestrator mode.
  private taskRegistry: TaskRegistry | null = null;
  private taskDispatcher: TaskDispatcher | null = null;
  private convOrchestrator: ConvOrchestrator | null = null;
  private convTaskEventListener: ((event: ConvTaskEvent) => void) | null = null;
  private dialogueCompactor: DialogueCompactor | null = null;

  constructor(config: JarvisConfig) {
    this.config = config;
    this.llmManager = new LLMManager();
    this.orchestrator = new AgentOrchestrator();
  }

  /**
   * Set callback for sub-agent progress events (delegation visibility).
   * Typically wired to WebSocket broadcast by the daemon.
   */
  setDelegationProgressCallback(cb: ProgressCallback): void {
    this.delegationProgressCallback = cb;
  }

  /**
   * Set callback fired when the PA delegates a task to a specialist.
   * Used by ws-service to update task board ownership in real time.
   */
  setDelegationCallback(cb: (specialistName: string, task: string) => void): void {
    this.delegationCallback = cb;
  }

  /**
   * Set the research queue for idle-time background research.
   */
  setResearchQueue(queue: ResearchQueue): void {
    this.researchQueue = queue;
  }

  setAuthorityEngine(engine: AuthorityEngine): void {
    this.authorityEngine = engine;
  }


  getOrchestrator(): AgentOrchestrator {
    return this.orchestrator;
  }

  getLLMManager(): LLMManager {
    return this.llmManager;
  }

  /**
   * Public accessor for the daemon config snapshot. Used by WSService's
   * onboarding setup-mode guard to read `onboarding.setup_completed_at`
   * without poking at private state. Returns the same reference the
   * daemon holds so config writes are visible immediately.
   */
  getConfig(): JarvisConfig {
    return this.config;
  }

  getTaskManager(): AgentTaskManager | null {
    return this.taskManager;
  }

  getSpecialists(): Map<string, RoleDefinition> {
    return new Map(this.specialists);
  }

  async start(): Promise<void> {
    this._status = 'starting';

    try {
      // 1. Create LLM providers from config
      this.registerProviders();

      // 2. Load role YAML
      this.role = this.loadActiveRole();

      // 3. Wire LLM manager to orchestrator
      this.orchestrator.setLLMManager(this.llmManager);

      // 4. Discover specialist roles
      this.specialists = discoverSpecialists('roles/specialists');
      if (this.specialists.size > 0) {
        this.specialistListText = formatSpecialistList(this.specialists);
        console.log(`[AgentService] Discovered ${this.specialists.size} specialists: ${Array.from(this.specialists.keys()).join(', ')}`);
      }

      // 5. Register tools (builtin + delegation)
      const toolRegistry = new ToolRegistry();
      for (const tool of BUILTIN_TOOLS) {
        toolRegistry.register(tool);
      }

      // Register content pipeline tool
      toolRegistry.register(contentPipelineTool);

      // Register commitments tool
      toolRegistry.register(commitmentsTool);

      // Register research queue tool
      toolRegistry.register(researchQueueTool);

      // Register document tool (vault-stored documents)
      toolRegistry.register(documentTool);

      // Register delegate_task tool if specialists are available
      if (this.specialists.size > 0) {
        const delegateDeps: DelegateToolDeps = {
          orchestrator: this.orchestrator,
          llmManager: this.llmManager,
          specialists: this.specialists,
          onProgress: (event) => {
            if (this.delegationProgressCallback) {
              this.delegationProgressCallback(event);
            }
          },
          onDelegation: (specialistName, task) => {
            if (this.delegationCallback) {
              this.delegationCallback(specialistName, task);
            }
          },
        };
        const delegateTool = createDelegateTool(delegateDeps);
        toolRegistry.register(delegateTool);
        console.log('[AgentService] Registered delegate_task tool');

        // Register manage_agents tool for persistent/async agents
        this.taskManager = new AgentTaskManager();
        const agentToolDeps: AgentToolDeps = {
          orchestrator: this.orchestrator,
          llmManager: this.llmManager,
          specialists: this.specialists,
          taskManager: this.taskManager,
          onProgress: (event) => {
            if (this.delegationProgressCallback) {
              this.delegationProgressCallback(event);
            }
          },
        };
        const agentTool = createManageAgentsTool(agentToolDeps);
        toolRegistry.register(agentTool);
        console.log('[AgentService] Registered manage_agents tool');
      }

      this.orchestrator.setToolRegistry(toolRegistry);
      console.log(`[AgentService] Registered ${toolRegistry.count()} tools total`);

      // 6. Create primary agent
      this.orchestrator.createPrimary(this.role);

      // 7. Load personality
      this.personality = getPersonality();

      this._status = 'running';
      console.log(`[AgentService] Started with role: ${this.role.name}`);
    } catch (error) {
      this._status = 'error';
      throw error;
    }
  }

  async stop(): Promise<void> {
    this._status = 'stopping';
    const primary = this.orchestrator.getPrimary();
    if (primary) {
      this.orchestrator.terminateAgent(primary.id);
    }

    // Disconnect browser (stops auto-launched Chrome if any)
    if (browser.connected) {
      await browser.disconnect();
    }

    this._status = 'stopped';
    console.log('[AgentService] Stopped');
  }

  status(): ServiceStatus {
    return this._status;
  }

  /**
   * Stream a message through the agent. Returns a stream and an onComplete callback.
   *
   * Routing mirrors handleMessage(): if a conversation tier is configured, we
   * run the router-first conv orchestrator and wrap its (non-streaming)
   * result in a single text + done event so the WebSocket UI keeps working.
   * Token-level streaming through the conv path is a Phase 6 follow-up.
   */
  streamMessage(text: string, channel: string = 'websocket', siteContext?: string): {
    stream: AsyncIterable<LLMStreamEvent>;
    onComplete: (fullText: string) => Promise<void>;
  } {
    // Refuse new turns once draining; otherwise count this one in-flight so a
    // graceful drain can await it (released when the tracked stream settles).
    if (activeTurns.isDraining) throw new DrainingError();
    const endTurn = activeTurns.begin();
    try {
      const inner = this.streamMessageInner(text, channel, siteContext);
      return { stream: trackTurnStream(inner.stream, endTurn), onComplete: inner.onComplete };
    } catch (err) {
      endTurn();
      throw err;
    }
  }

  private streamMessageInner(text: string, channel: string = 'websocket', siteContext?: string): {
    stream: AsyncIterable<LLMStreamEvent>;
    onComplete: (fullText: string) => Promise<void>;
  } {
    if (this.convOrchestrator) {
      return this.streamMessageConv(text, channel);
    }

    const systemPrompt = this.buildFullSystemPromptParts(channel, text);
    if (siteContext) {
      systemPrompt.dynamic += '\n\n' + siteContext;
    }

    const stream = this.orchestrator.streamMessage(systemPrompt, text);

    const onComplete = async (fullText: string): Promise<void> => {
      // Note: orchestrator already adds assistant response to history
      // Run extraction and learning in parallel, wait for both to settle
      await Promise.allSettled([
        this.extractKnowledge(text, fullText).catch((err) =>
          console.error('[AgentService] Extraction error:', err instanceof Error ? err.message : err)
        ),
        this.learnFromInteraction(text, fullText, channel).catch((err) =>
          console.error('[AgentService] Learning error:', err instanceof Error ? err.message : err)
        ),
      ]);
    };

    return { stream, onComplete };
  }

  /**
   * Stream path for router-first conv mode. Relays the ConvOrchestrator's
   * streaming events to the UI: acknowledgment text appears immediately when
   * the conv LLM emits it alongside a delegate tool call, then the task tier
   * runs (during which we surface task lifecycle events via the listener),
   * then the final verbalization text appears.
   */
  private streamMessageConv(text: string, channel: string): {
    stream: AsyncIterable<LLMStreamEvent>;
    onComplete: (fullText: string) => Promise<void>;
  } {
    const self = this;
    const stream = (async function* (): AsyncGenerator<LLMStreamEvent> {
      if (!self.convOrchestrator) {
        yield { type: 'error', error: 'Conv orchestrator not initialized' };
        return;
      }
      let fullText = '';
      try {
        const identity = self.buildUserIdentityBlock();
        const userProfile = self.buildUserProfileBlock();
        const recentDialogue = await self.loadRecentDialogue(channel);
        const ambient = self.buildAmbientFactsBlock(text);

        // Task lifecycle events go through the listener IN REAL TIME (during
        // the dispatcher's await), independent of the text stream. The
        // generator below yields only text/done events.
        const taskListener = self.convTaskEventListener ?? undefined;

        for await (const event of self.convOrchestrator.streamTurn(text, {
          userIdentity: identity,
          userProfile,
          recentDialogue,
          ambientFacts: ambient,
        }, taskListener)) {
          if (event.type === 'text') {
            // Insert a separator so the acknowledgment text doesn't blur into
            // the later verbalization on the client side.
            const separator = event.newSegment && fullText && !fullText.endsWith('\n') ? '\n\n' : '';
            const chunk = separator + event.text;
            fullText += chunk;
            // A segmentEnd-only event has no text; forward the signal so TTS
            // can speak the finished acknowledgment without waiting.
            yield { type: 'text', text: chunk, segmentEnd: event.segmentEnd };
          }
          // 'done' is implicit - the generator ends.
        }

        yield {
          type: 'done',
          response: {
            content: fullText,
            tool_calls: [],
            usage: { input_tokens: 0, output_tokens: 0 },
            model: 'conv',
            finish_reason: 'stop',
          },
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const code = err && typeof err === 'object'
          ? (err as { code?: LLMErrorCode }).code
          : undefined;
        console.error('[AgentService] Conv stream error:', errorMsg);
        yield { type: 'error', error: errorMsg, code };
      }
    })();

    const onComplete = async (fullText: string): Promise<void> => {
      await Promise.allSettled([
        this.extractKnowledge(text, fullText).catch((err) =>
          console.error('[AgentService] Extraction error:', err instanceof Error ? err.message : err)
        ),
        this.learnFromInteraction(text, fullText, channel).catch((err) =>
          console.error('[AgentService] Learning error:', err instanceof Error ? err.message : err)
        ),
      ]);
    };

    return { stream, onComplete };
  }

  /**
   * Multi-modal stream — same as streamMessage but the user message
   * carries both an inline base64 image (e.g. a region screenshot
   * captured by the pebble) and the user's text. Used by T19's
   * "help with this" flow.
   *
   * NOTE: unlike streamMessage, this always uses the base primary agent and
   * does NOT route through convOrchestrator when conv (router-first) mode is
   * active — the conv path doesn't carry vision. Consequence: in conv mode,
   * image turns run through a different agent than text turns, and the conv
   * text stream's tool_call events (which drive the pebble's action narration)
   * won't fire for image turns. Intentional for now; revisit if conv gains
   * vision support.
   */
  streamMessageWithImage(
    text: string,
    imageBase64: string,
    mediaType: string,
    channel: string = 'websocket',
    siteContext?: string,
  ): {
    stream: AsyncIterable<LLMStreamEvent>;
    onComplete: (fullText: string) => Promise<void>;
  } {
    // Same drain gate + in-flight tracking as streamMessage (the pebble image
    // turn is a real turn — must not start mid-drain or run uncounted).
    if (activeTurns.isDraining) throw new DrainingError();
    const endTurn = activeTurns.begin();
    try {
      const systemPrompt = this.buildFullSystemPromptParts(channel, text);
      if (siteContext) systemPrompt.dynamic += '\n\n' + siteContext;

      const content: import('../llm/provider.ts').ContentBlock[] = [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text },
      ];
      // This is the one dialogue path that cannot go through the conv
      // orchestrator — it has no image route — so it runs the classic
      // orchestrator directly. Without this, a router-first install pays the
      // task-tier model for every pebble image turn even though the user is
      // just talking. Route it at the conv tier when one is configured; in
      // classic mode there is none and 'medium' stays correct. Nothing records
      // whether a model accepts images and the conv tier has no fallback
      // chain, so a text-only conv model falls back to the task tier rather
      // than dead-ending the turn.
      const useConvTier = this.llmManager.hasConversationTier();
      const stream = this.orchestrator.streamMessage(
        systemPrompt,
        content,
        useConvTier ? 'conversation' : 'medium',
        'chat_orchestrator_image',
        useConvTier ? 'medium' : undefined,
      );

      const onComplete = async (fullText: string): Promise<void> => {
        await Promise.allSettled([
          this.extractKnowledge(text, fullText).catch((err) =>
            console.error('[AgentService] Extraction error:', err instanceof Error ? err.message : err)
          ),
          this.learnFromInteraction(text, fullText, channel).catch((err) =>
            console.error('[AgentService] Learning error:', err instanceof Error ? err.message : err)
          ),
        ]);
      };

      return { stream: trackTurnStream(stream, endTurn), onComplete };
    } catch (err) {
      endTurn();
      throw err;
    }
  }

  /**
   * Non-streaming message handler. Returns full response string.
   *
   * Routing:
   *   - If `llm.tiers.conversation` is configured AND the ConvOrchestrator has
   *     been initialized, the router-first path runs: the conv LLM owns
   *     dialogue and emits delegate() tool calls that drive task tiers.
   *   - Otherwise the classic orchestrator runs (full role prompt, all tools,
   *     ReAct loop on the medium tier).
   */
  async handleMessage(text: string, channel: string = 'websocket'): Promise<string> {
    // Non-streaming turn entry (external channels, etc). Background reactions go
    // through BackgroundAgentService.handleMessage, which is gated separately.
    if (activeTurns.isDraining) throw new DrainingError();
    const endTurn = activeTurns.begin();
    try {
      let response: string;

      if (this.convOrchestrator) {
        response = await this.handleMessageConv(text, channel);
      } else {
        const systemPrompt = this.buildFullSystemPromptParts(channel, text);
        response = await this.orchestrator.processMessage(systemPrompt, text);
      }

      // Run extraction and learning in parallel (non-blocking but tracked)
      Promise.allSettled([
        this.extractKnowledge(text, response).catch((err) =>
          console.error('[AgentService] Extraction error:', err instanceof Error ? err.message : err)
        ),
        this.learnFromInteraction(text, response, channel).catch((err) =>
          console.error('[AgentService] Learning error:', err instanceof Error ? err.message : err)
        ),
      ]);

      return response;
    } finally {
      endTurn();
    }
  }

  /**
   * Router-first message handler. Builds a tight conv-tier context (user
   * identity + recent dialogue) and lets the conv LLM decide whether to
   * delegate or answer directly.
   */
  private async handleMessageConv(text: string, channel: string = 'websocket'): Promise<string> {
    if (!this.convOrchestrator) {
      // Should be unreachable - caller checks this.convOrchestrator first.
      throw new Error('Conv orchestrator not initialized');
    }
    const identity = this.buildUserIdentityBlock();
    const recentDialogue = await this.loadRecentDialogue(channel);
    const result = await this.convOrchestrator.processTurn(
      text,
      {
        userIdentity: identity,
        userProfile: this.buildUserProfileBlock(),
        recentDialogue,
        ambientFacts: this.buildAmbientFactsBlock(text),
      },
      this.convTaskEventListener ?? undefined,
    );
    return result.text;
  }

  /**
   * Pull recent messages from the persistent conversation for the conv LLM.
   * When the conversation is long, the DialogueCompactor condenses old turns
   * into a summary system message and keeps the most-recent N verbatim. This
   * keeps the conv-tier context budget tight without losing continuity.
   */
  private async loadRecentDialogue(channel: string): Promise<LLMMessage[]> {
    try {
      const recent = getRecentConversation(channel);
      if (!recent) return [];
      // Pull a wider window than we'll inject so the compactor has material
      // to summarize when the conversation is long. The compactor caps the
      // final list size (last 20 verbatim by default; older bucketed into a
      // background-built summary when conversation exceeds 40 messages).
      const messages = getMessages(recent.conversation.id, { limit: 80 });
      const dialogue: LLMMessage[] = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      if (!this.dialogueCompactor) return dialogue.slice(-10);
      return await this.dialogueCompactor.compact(recent.conversation.id, dialogue);
    } catch (err) {
      console.warn('[AgentService] Failed to load recent dialogue:', err);
      return [];
    }
  }

  /** One-line identity facts the conv LLM sees in every turn. */
  private buildUserIdentityBlock(): string {
    const parts: string[] = [];
    const name = this.config.user?.name;
    if (name) parts.push(`Name: ${name}`);
    parts.push(`Local time: ${new Date().toLocaleString()}`);
    return parts.join('. ');
  }

  /**
   * Full user profile (wizard answers + interview facts) for the conv LLM,
   * giving it the same rich context about the user that the classic path
   * injects via buildPromptContext -> formatUserProfileForPrompt. Rendered
   * as its own cache-marked system block, so it stays out of the volatile
   * identity line - keep anything that changes per turn out of here.
   */
  private buildUserProfileBlock(): string | undefined {
    try {
      const profile = getUserProfile();
      const profileContext = formatUserProfileForPrompt(profile);
      if (!profileContext) return undefined;
      return `# User Profile\n${profileContext}`;
    } catch (err) {
      console.warn('[AgentService] Error loading user profile for conv prompt:', err);
      return undefined;
    }
  }

  /**
   * Compact ambient state for the conv LLM: knowledge graph facts relevant to
   * the current message + a tiny commitment summary. The vault retrieval is
   * already entity-match-driven so it stays empty when the message doesn't
   * mention anything we remember (zero-cost on small-talk turns).
   */
  private buildAmbientFactsBlock(text: string): string {
    const parts: string[] = [];
    try {
      const knowledge = getKnowledgeForMessage(text);
      if (knowledge && knowledge.trim().length > 0) {
        parts.push('Relevant knowledge about entities in this message:');
        parts.push(knowledge);
      }
    } catch (err) {
      console.warn('[AgentService] Failed to retrieve conv ambient knowledge:', err);
    }
    return parts.join('\n');
  }

  /**
   * Wire a listener for task lifecycle events emitted by the conv orchestrator.
   * The daemon's WS service uses this to surface status pills in the UI.
   */
  setConvTaskEventListener(listener: (event: ConvTaskEvent) => void): void {
    this.convTaskEventListener = listener;
  }

  /**
   * Expose the task registry for diagnostics / API endpoints. Null when
   * running in classic mode.
   */
  getTaskRegistry(): TaskRegistry | null {
    return this.taskRegistry;
  }

  // --- Private methods ---

  private registerProviders(): void {
    // Bind through the effective view: hosted tier defaults live only in this
    // per-bind copy (explicit ref → llm.default → plan alias), never in
    // config.llm, so they can never leak into a persistence path.
    const llm = effectiveLlmForBinding(this.config);
    const hasProvider = registerLLMProviders(this.llmManager, llm.providers ?? {}, {
      promptCache: llm.prompt_cache !== false,
    });

    if (!hasProvider) {
      console.warn('[AgentService] No LLM providers configured. Responses will be placeholders.');
    }

    if (hasProvider) {
      configureLLMTiers(this.llmManager, llm);
    }

    // Phase 4: initialize conv-tier infrastructure ONLY when the user has
    // configured llm.tiers.conversation. Otherwise we stay in classic
    // single-orchestrator mode (and handleMessage uses this.orchestrator).
    if (this.llmManager.hasConversationTier()) {
      // Persist task records so paused (needs_input) tasks survive daemon
      // restarts. getDb is called lazily (resolver function) so a DB re-open
      // between hot-reloads stays consistent. hydrate() runs immediately to
      // reconcile any tasks that were in-flight at shutdown.
      this.taskRegistry = new TaskRegistry({ db: () => { try { return getDb(); } catch { return null; } } });
      this.taskRegistry.hydrate();
      // Task runner: route delegations through the primary orchestrator so
      // task tiers run with the full tool registry, role prompt, authority
      // gating, and Jarvis-specific feature knowledge. Uses processTaskCall
      // (not processMessage) so the LLM has access to the
      // `ask_for_clarification` tool for pause/resume and the conversation
      // buffer is scoped to one task (not polluting the primary agent's
      // global history).
      const runner: import('../agents/conv/task-dispatcher.ts').TaskRunner = async ({
        tier,
        subsystem,
        template,
        intent,
        originalMessage,
        signal,
        history,
      }) => {
        const baseSystem = this.buildFullSystemPromptParts('conv', originalMessage);
        const templateNote = TaskDispatcher.templatePromptFor(template);
        // Attach the conv LLM's routing intent as system context so the task
        // tier sees both the user's verbatim ask AND the conv's framing -
        // but the user's words are the primary signal. Both are per-task
        // volatile, so they ride on the dynamic half of the prompt.
        const systemPrompt: SystemPromptParts = {
          static: baseSystem.static,
          dynamic: `${baseSystem.dynamic}\n\n${templateNote}\n\nConversation routing note: ${intent}`,
        };
        const result = await this.orchestrator.processTaskCall({
          systemPrompt,
          userMessage: originalMessage,
          tier,
          subsystem,
          history: history as import('../llm/provider.ts').LLMMessage[] | undefined,
          signal,
          // Every template but `write` exists to DO something, so a final
          // answer that ran no tools is a model that announced its plan and
          // stopped - push back once rather than storing the announcement as
          // the result. `write` drafts prose and legitimately needs no tools.
          requireToolUse: template !== 'write',
        });
        return result;
      };
      this.taskDispatcher = new TaskDispatcher(this.llmManager, this.taskRegistry, runner);
      this.dialogueCompactor = new DialogueCompactor(this.llmManager);
      const persona = this.buildPersona();
      this.convOrchestrator = new ConvOrchestrator(
        this.llmManager,
        this.taskRegistry,
        this.taskDispatcher,
        persona,
      );
      console.log('[AgentService] Conversation tier configured - router-first mode active.');
    } else {
      console.log('[AgentService] No conversation tier - classic orchestrator mode.');
    }
  }

  /**
   * Build the conversation persona string injected into the conv-tier system
   * prompt. Reads from `config.personality` so users can customize tone
   * without touching code.
   */
  private buildPersona(): string {
    const p = this.config.personality;
    const traits = (p?.core_traits ?? []).join(', ');
    const name = p?.assistant_name ?? 'JARVIS';
    return [
      `You are ${name}, the user's conversational assistant.`,
      traits ? `Core traits: ${traits}.` : '',
      'Be concise, natural, and direct. Anticipate needs without being intrusive.',
    ].filter(Boolean).join(' ');
  }

  private loadActiveRole(): RoleDefinition {
    const roleName = this.config.active_role;

    // Try multiple locations for role YAML (package-root-relative for global install)
    const pkgRoot = join(import.meta.dir, '../..');
    const paths = [
      join(pkgRoot, `roles/${roleName}.yaml`),
      join(pkgRoot, `roles/${roleName}.yml`),
      join(pkgRoot, `config/roles/${roleName}.yaml`),
      join(pkgRoot, `config/roles/${roleName}.yml`),
      // Also try CWD-relative for local dev
      `roles/${roleName}.yaml`,
      `roles/${roleName}.yml`,
    ];

    for (const rolePath of paths) {
      try {
        const role = loadRole(rolePath);
        console.log(`[AgentService] Loaded role '${role.name}' from ${rolePath}`);
        return role;
      } catch {
        // Try next path
      }
    }

    // Fatal — cannot start without a role
    throw new Error(
      `[AgentService] Could not load role '${roleName}'. Searched: ${paths.join(', ')}`
    );
  }

  /**
   * Build the full system prompt used by chat turns. Public so other code
   * paths (workflow's `jarvis-ask` piece, etc.) can give the LLM the same
   * Jarvis identity + role + personality + vault context that chat gets.
   *
   * `channel` selects channel-specific personality overrides (telegram,
   * discord, etc.); unknown channel names fall back to the default
   * personality.
   *
   * `userMessage` is optional -- when provided we pull message-relevant
   * knowledge / webapp instructions from the vault to inject into the
   * prompt. Pass it for "the user said X" turns; omit for heartbeats.
   */
  /**
   * Lean system prompt for premium realtime voice (gpt-realtime-2).
   *
   * The full agent prompt is ~5.6k tokens and, with ~32 tool definitions
   * (~3.4k tokens), made the realtime model digest ~10k tokens of context
   * before EVERY spoken reply — the dominant per-turn latency (a simple "how
   * are you" took 1–2s). The realtime model is built for a concise,
   * conversational prompt, so here we give it just identity + tone + a
   * live-voice framing (~100 tokens). Tools stay available, so JARVIS can still
   * act; we only drop the heavyweight role/KPI/commitments/vault context that a
   * spoken chat doesn't need. This is removal of bloat, NOT a behavioral
   * directive (no "be brief / don't narrate" — those suppressed preambles and
   * made it deliberate).
   */
  buildRealtimeVoiceInstructions(): string {
    const name = this.config.personality?.assistant_name?.trim() || this.role?.name || 'JARVIS';
    const userName = this.config.user?.name?.trim() || getUserProfile()?.answers.preferred_name?.trim();
    const traits = (this.config.personality?.core_traits ?? []).slice(0, 6).join(', ');
    return [
      `You are ${name}${userName ? `, ${userName}'s personal AI assistant` : ', a personal AI assistant'}, in a live, real-time voice conversation.`,
      'Speak naturally and conversationally, the way a person talks out loud.',
      traits ? `Your character: ${traits}.` : '',
      'You can take real actions with your tools whenever the user asks.',
      `Current time: ${new Date().toISOString()}.`,
    ].filter(Boolean).join('\n');
  }

  buildFullSystemPrompt(channel: string, userMessage?: string): string {
    const parts = this.buildFullSystemPromptParts(channel, userMessage);
    if (!parts.static && !parts.dynamic) return '';
    return parts.dynamic ? `${parts.static}\n\n${parts.dynamic}` : parts.static;
  }

  /**
   * System prompt split at the prompt-cache boundary: `static` is byte-stable
   * turn-over-turn for a given channel (role prompt + channel personality),
   * `dynamic` carries the per-turn context (time, observations, goals, ...).
   * Callers hand the parts to the orchestrator, which marks the static half
   * as a provider cache boundary.
   */
  buildFullSystemPromptParts(channel: string, userMessage?: string): SystemPromptParts {
    if (!this.role) return { static: '', dynamic: '' };

    // Build prompt context with live data + vault knowledge.
    // For latency-sensitive voice channels (pebble), build a slimmer
    // context: skip observations / content pipeline / commitments since
    // conversational voice queries rarely benefit from them and the
    // extra prompt tokens slow first-token-out by hundreds of ms.
    const context = channel === 'pebble'
      ? this.buildPromptContext(userMessage, { slim: true })
      : this.buildPromptContext(userMessage);

    // Build base system prompt from role + context, split at the boundary
    const roleParts = buildSystemPromptParts(this.role, context);

    // Build personality prompt for this channel. Config-derived and
    // time-invariant, so it belongs to the static (cacheable) half.
    const personality = this.personality ?? getPersonality();
    const channelPersonality = getChannelPersonality(personality, channel);
    const personalityPrompt = personalityToPrompt(channelPersonality);

    return {
      static: `${roleParts.static}\n\n${personalityPrompt}`,
      dynamic: roleParts.dynamic,
    };
  }

  /**
   * Whether a host owns the pieces catalog. Resolved from config the daemon
   * read at boot and memoized: the tool guide it feeds lands in the
   * prompt-cached static section, so a value that moved between turns would
   * silently break that cache for no reason.
   */
  private piecesManagedCache: boolean | null = null;
  private piecesManaged(): boolean {
    this.piecesManagedCache ??= piecesManagedByHost(
      resolveSharedRuntimePaths(this.config).piecesDir,
    );
    return this.piecesManagedCache;
  }

  private buildPromptContext(userMessage?: string, opts?: { slim?: boolean }): PromptContext {
    // Slim mode: voice channels skip the heavyweight context blocks
    // (observations, content pipeline, commitments) so the LLM has
    // hundreds fewer prompt tokens to chew through before first response.
    const slim = opts?.slim === true;
    // Check if any sidecars are enrolled (cheap DB query, controls tool guide content)
    let hasSidecars = false;
    try {
      const mgr = getSidecarManager();
      if (mgr) hasSidecars = mgr.listSidecars().length > 0;
    } catch { /* ignore */ }

    const context: PromptContext = {
      userName: this.config.user?.name || undefined,
      currentTime: new Date().toISOString(),
      availableSpecialists: this.specialistListText || undefined,
      hasSidecars,
      // Derived from config, so it is stable turn over turn and safe to sit
      // in the prompt-CACHED static section alongside hasSidecars.
      piecesManaged: this.piecesManaged(),
    };

    try {
      const profile = getUserProfile();
      const preferredName = profile?.answers.preferred_name?.trim();
      if (preferredName) {
        context.userName = preferredName;
      }

      const profileContext = formatUserProfileForPrompt(profile);
      if (profileContext) {
        context.userProfile = profileContext;
      }
    } catch (err) {
      console.error('[AgentService] Error loading user profile:', err);
    }

    // Retrieve relevant knowledge from vault based on user message
    if (userMessage) {
      try {
        const knowledge = getKnowledgeForMessage(userMessage);
        if (knowledge) {
          context.knowledgeContext = knowledge;
        }
      } catch (err) {
        console.error('[AgentService] Error retrieving knowledge:', err);
      }
    }

    // Get due commitments — skipped in slim/voice mode.
    if (!slim) {
      try {
        const due = getDueCommitments();
        const upcoming = getUpcoming(5);
        const allCommitments = [...due, ...upcoming];

        if (allCommitments.length > 0) {
          context.activeCommitments = allCommitments.map((c) => {
            const dueStr = c.when_due
              ? ` (due: ${new Date(c.when_due).toLocaleString()})`
              : '';
            return `[${c.priority}] ${c.what}${dueStr} — ${c.status}`;
          });
        }
      } catch (err) {
        console.error('[AgentService] Error loading commitments:', err);
      }
    }

    // Get active content pipeline items (not published) — skipped in slim/voice mode.
    if (!slim) try {
      const activeContent = findContent({}).filter(
        (c) => c.stage !== 'published'
      ).slice(0, 10);
      if (activeContent.length > 0) {
        context.contentPipeline = activeContent.map((c) => {
          const tags = c.tags.length > 0 ? ` [${c.tags.join(', ')}]` : '';
          return `"${c.title}" (${c.content_type}) — ${c.stage}${tags}`;
        });
      }
    } catch (err) {
      console.error('[AgentService] Error loading content pipeline:', err);
    }

    // Get recent observations — skipped in slim/voice mode.
    if (!slim) try {
      const observations = getRecentObservations(undefined, 10);
      if (observations.length > 0) {
        context.recentObservations = observations.map((o) => {
          const time = new Date(o.created_at).toLocaleTimeString();
          return `[${time}] ${o.type}: ${JSON.stringify(o.data).slice(0, 200)}`;
        });
      }
    } catch (err) {
      console.error('[AgentService] Error loading observations:', err);
    }

    // Active goals context for the system prompt
    try {
      const { getActiveGoalsSummary } = require('../vault/retrieval.ts');
      const goalsSummary = getActiveGoalsSummary();
      if (goalsSummary) {
        context.activeGoals = goalsSummary;
      }
    } catch {
      // Goals module may not be available — ignore
    }

    // Authority rules for the system prompt
    if (this.authorityEngine && this.role) {
      try {
        context.authorityRules = this.authorityEngine.describeRulesForAgent(
          this.role.authority_level,
          this.role.id
        );
        const configLevel = this.authorityEngine.getConfig().default_level;
        context.effectiveAuthorityLevel = Math.max(this.role.authority_level, configLevel);
      } catch (err) {
        console.error('[AgentService] Error building authority rules:', err);
      }
    }

    return context;
  }

  private async extractKnowledge(userMessage: string, assistantResponse: string): Promise<void> {
    // The extractor uses the `low` tier internally - it's structured
    // extraction work that doesn't need the conversation model's smarts.
    await extractAndStore(userMessage, assistantResponse, this.llmManager);
  }

  private async learnFromInteraction(
    userMessage: string,
    assistantResponse: string,
    _channel: string
  ): Promise<void> {
    let personality = this.personality ?? getPersonality();

    // Extract signals from the interaction
    const signals = extractSignals(userMessage, assistantResponse);

    // Apply signals if any
    if (signals.length > 0) {
      personality = applySignals(personality, signals);
    }

    // Record the interaction (increments message count, adjusts trust)
    personality = recordInteraction(personality);

    // Save updated personality
    savePersonality(personality);
    this.personality = personality;
  }
}
