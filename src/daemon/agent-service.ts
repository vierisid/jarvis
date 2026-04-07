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
import type { LLMStreamEvent } from '../llm/provider.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { PersonalityModel } from '../personality/model.ts';

import { LLMManager } from '../llm/manager.ts';
import { AnthropicProvider } from '../llm/anthropic.ts';
import { OpenAIProvider } from '../llm/openai.ts';
import { GroqProvider } from '../llm/groq.ts';
import { GeminiProvider } from '../llm/gemini.ts';
import { OllamaProvider } from '../llm/ollama.ts';
import { OpenRouterProvider } from '../llm/openrouter.ts';
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
import { buildSystemPrompt, type PromptContext } from '../roles/prompt-builder.ts';
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

  getTaskManager(): AgentTaskManager | null {
    return this.taskManager;
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
   */
  streamMessage(text: string, channel: string = 'websocket', siteContext?: string): {
    stream: AsyncIterable<LLMStreamEvent>;
    onComplete: (fullText: string) => Promise<void>;
  } {
    let systemPrompt = this.buildFullSystemPrompt(channel, text);
    if (siteContext) {
      systemPrompt += '\n\n' + siteContext;
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
   * Non-streaming message handler. Returns full response string.
   */
  async handleMessage(text: string, channel: string = 'websocket'): Promise<string> {
    const systemPrompt = this.buildFullSystemPrompt(channel, text);

    const response = await this.orchestrator.processMessage(systemPrompt, text);

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
  }

  /**
   * Handle periodic heartbeat with full tool access.
   * Accepts optional coalesced event summary to include in the prompt.
   * Uses processMessage() so the agent can take action (browse, run commands, etc.).
   */
  async handleHeartbeat(coalescedEvents?: string): Promise<string | null> {
    if (!this.role) return null;

    const systemPrompt = this.buildHeartbeatPrompt(coalescedEvents);

    // Build the heartbeat "user message" that triggers the agent
    const parts: string[] = ['[HEARTBEAT] Periodic check-in. Review your responsibilities and take action.'];

    if (coalescedEvents) {
      parts.push('');
      parts.push(coalescedEvents);
    }

    const heartbeatMessage = parts.join('\n');

    try {
      const response = await this.orchestrator.processMessage(systemPrompt, heartbeatMessage);
      if (response && response.trim().length > 0) {
        return response;
      }
      return null;
    } catch (err) {
      console.error('[AgentService] Heartbeat processing error:', err);
      return null;
    }
  }

  // --- Private methods ---

  private registerProviders(): void {
    const { llm } = this.config;
    let hasProvider = false;

    // Register Anthropic
    if (llm.anthropic?.api_key) {
      const provider = new AnthropicProvider(
        llm.anthropic.api_key,
        llm.anthropic.model
      );
      this.llmManager.registerProvider(provider);
      hasProvider = true;
      console.log('[AgentService] Registered Anthropic provider');
    }

    // Register OpenAI
    if (llm.openai?.api_key) {
      const provider = new OpenAIProvider(
        llm.openai.api_key,
        llm.openai.model
      );
      this.llmManager.registerProvider(provider);
      hasProvider = true;
      console.log('[AgentService] Registered OpenAI provider');
    }

    // Register Groq
    if (llm.groq?.api_key) {
      const provider = new GroqProvider(
        llm.groq.api_key,
        llm.groq.model
      );
      this.llmManager.registerProvider(provider);
      hasProvider = true;
      console.log('[AgentService] Registered Groq provider');
    }

    // Register Gemini
    if (llm.gemini?.api_key) {
      const provider = new GeminiProvider(
        llm.gemini.api_key,
        llm.gemini.model
      );
      this.llmManager.registerProvider(provider);
      hasProvider = true;
      console.log('[AgentService] Registered Gemini provider');
    }

    // Register OpenRouter
    if (llm.openrouter?.api_key) {
      const provider = new OpenRouterProvider(
        llm.openrouter.api_key,
        llm.openrouter.model
      );
      this.llmManager.registerProvider(provider);
      hasProvider = true;
      console.log('[AgentService] Registered OpenRouter provider');
    }

    // Register Ollama (always available, no API key needed)
    if (llm.ollama) {
      const provider = new OllamaProvider(
        llm.ollama.base_url,
        llm.ollama.model
      );
      this.llmManager.registerProvider(provider);
      hasProvider = true;
      console.log('[AgentService] Registered Ollama provider');
    }

    if (!hasProvider) {
      console.warn('[AgentService] No LLM providers configured. Responses will be placeholders.');
    }

    // Set primary and fallback chain
    if (hasProvider) {
      try {
        this.llmManager.setPrimary(llm.primary);
      } catch {
        // Primary provider not available, first registered is already primary
      }

      // Set fallback chain (only for providers that were registered)
      const registeredFallbacks = llm.fallback.filter(
        (name) => this.llmManager.getProvider(name) !== undefined
      );
      if (registeredFallbacks.length > 0) {
        this.llmManager.setFallbackChain(registeredFallbacks);
      }
    }
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

  private buildFullSystemPrompt(channel: string, userMessage?: string): string {
    if (!this.role) return '';

    // Build prompt context with live data + vault knowledge
    const context = this.buildPromptContext(userMessage);

    // Build base system prompt from role + context
    const rolePrompt = buildSystemPrompt(this.role, context);

    // Build personality prompt for this channel
    const personality = this.personality ?? getPersonality();
    const channelPersonality = getChannelPersonality(personality, channel);
    const personalityPrompt = personalityToPrompt(channelPersonality);

    return `${rolePrompt}\n\n${personalityPrompt}`;
  }

  private buildHeartbeatPrompt(coalescedEvents?: string): string {
    if (!this.role) return '';

    const context = this.buildPromptContext();
    const rolePrompt = buildSystemPrompt(this.role, context);

    const parts = [rolePrompt, '', '# Heartbeat Check', this.role.heartbeat_instructions];

    if (coalescedEvents) {
      parts.push('', '# Recent System Events', coalescedEvents);
    }

    // Inject commitment execution instructions
    parts.push('', '# COMMITMENT EXECUTION');
    parts.push('If any commitments are overdue or due soon, EXECUTE them now using your tools.');
    parts.push('Do not just mention them — actually perform the work. Use browse, terminal, file operations as needed.');

    // Inject background research instructions when idle
    if (this.researchQueue && this.researchQueue.queuedCount() > 0) {
      const next = this.researchQueue.getNext();
      if (next) {
        parts.push('', '# BACKGROUND RESEARCH');
        parts.push(`You have a research topic queued: "${next.topic}"`);
        parts.push(`Reason: ${next.reason}`);
        parts.push(`Research ID: ${next.id}`);
        parts.push('If nothing urgent needs your attention, research this topic now.');
        parts.push('Use your browser and tools to gather information, then use the research_queue tool with action "complete" to save your findings.');
      }
    } else {
      parts.push('', '# IDLE MODE');
      parts.push('No research topics queued. If nothing urgent, you may:');
      parts.push('- Check news or trends relevant to the user');
      parts.push('- Review and organize pending tasks');
      parts.push('- Or simply report "All clear" if nothing needs attention');
    }

    parts.push('', '# Important', 'You have full tool access during this heartbeat. If you need to take action (browse the web, run commands, check files), DO IT. Be proactive and aggressive about helping.');

    return parts.join('\n');
  }

  private buildPromptContext(userMessage?: string): PromptContext {
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

    // Get due commitments
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

    // Get active content pipeline items (not published)
    try {
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

    // Get recent observations
    try {
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
    // Get the primary provider for extraction
    const provider = this.llmManager.getProvider(this.config.llm.primary)
      ?? this.llmManager.getProvider('anthropic')
      ?? this.llmManager.getProvider('openai');

    await extractAndStore(userMessage, assistantResponse, provider);
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
