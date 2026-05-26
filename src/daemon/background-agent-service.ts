/**
 * Background Agent Service — Independent Monitoring Brain
 *
 * Runs heartbeats, event reactions, and commitment executions on a
 * SEPARATE agent with its own browser instance (CDP port 9223).
 * User chat on the main AgentService is never blocked.
 *
 * Shares: LLMManager (same API keys), SQLite vault (same DB)
 * Separate: BrowserController, AgentOrchestrator, ToolRegistry, conversation history
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Service, ServiceStatus } from './services.ts';
import type { IAgentService } from './agent-service-interface.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { ResearchQueue } from './research-queue.ts';

import { AgentOrchestrator } from '../agents/orchestrator.ts';
import { loadRole } from '../roles/loader.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { NON_BROWSER_TOOLS, createBrowserTools } from '../actions/tools/builtin.ts';
import { BrowserController } from '../actions/browser/session.ts';
import { DESKTOP_TOOLS } from '../actions/tools/desktop.ts';
import { commitmentsTool } from '../actions/tools/commitments.ts';
import { researchQueueTool } from '../actions/tools/research.ts';
import { buildSystemPrompt, type PromptContext } from '../roles/prompt-builder.ts';
import { getDueCommitments, getUpcoming } from '../vault/commitments.ts';
import { getRecentObservations } from '../vault/observations.ts';
import { findContent } from '../vault/content-pipeline.ts';

const BG_CDP_PORT = 9223;
const BG_PROFILE_DIR = join(homedir(), '.jarvis', 'browser', 'bg-profile');

export class BackgroundAgentService implements Service, IAgentService {
  name = 'background-agent';
  private _status: ServiceStatus = 'stopped';
  private config: JarvisConfig;
  private llmManager: LLMManager;
  private orchestrator: AgentOrchestrator;
  private bgBrowser: BrowserController;
  private role: RoleDefinition | null = null;
  private researchQueue: ResearchQueue | null = null;
  private busy = false;

  constructor(config: JarvisConfig, llmManager: LLMManager) {
    this.config = config;
    this.llmManager = llmManager;
    this.orchestrator = new AgentOrchestrator();
    this.bgBrowser = new BrowserController(BG_CDP_PORT, BG_PROFILE_DIR);
  }

  setResearchQueue(queue: ResearchQueue): void {
    this.researchQueue = queue;
  }

  async start(): Promise<void> {
    this._status = 'starting';

    try {
      // 1. Wire shared LLM manager
      this.orchestrator.setLLMManager(this.llmManager);

      // 2. Load the same role as the main agent
      this.role = this.loadActiveRole();

      // 3. Build tool registry with background browser
      const toolRegistry = new ToolRegistry();

      for (const tool of NON_BROWSER_TOOLS) {
        toolRegistry.register(tool);
      }

      const bgBrowserTools = createBrowserTools(this.bgBrowser);
      for (const tool of bgBrowserTools) {
        toolRegistry.register(tool);
      }

      // Desktop tools (routed via sidecar RPC)
      for (const tool of DESKTOP_TOOLS) {
        toolRegistry.register(tool);
      }

      toolRegistry.register(commitmentsTool);
      toolRegistry.register(researchQueueTool);

      this.orchestrator.setToolRegistry(toolRegistry);

      // 4. Create primary agent for background operations
      this.orchestrator.createPrimary(this.role);

      this._status = 'running';
      console.log(`[BackgroundAgent] Started with role: ${this.role.name}, browser on port ${BG_CDP_PORT}`);
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

    if (this.bgBrowser.connected) {
      await this.bgBrowser.disconnect();
    }

    this._status = 'stopped';
    console.log('[BackgroundAgent] Stopped');
  }

  status(): ServiceStatus {
    return this._status;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /**
   * Handle a reactive event message (from EventReactor / CommitmentExecutor).
   */
  async handleMessage(text: string, channel: string = 'system'): Promise<string> {
    // Wait if busy — event reactor already has its own queue, so this is a safety net
    const waitStart = Date.now();
    while (this.busy && Date.now() - waitStart < 60_000) {
      await new Promise(r => setTimeout(r, 1000));
    }

    this.busy = true;
    try {
      const systemPrompt = this.buildSystemPrompt(channel);
      return await this.orchestrator.processMessage(systemPrompt, text);
    } catch (err) {
      console.error('[BackgroundAgent] Message error:', err);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = false;
    }
  }

  // --- Private methods ---

  private buildSystemPrompt(channel: string): string {
    if (!this.role) return '';
    const context = this.buildPromptContext();
    return buildSystemPrompt(this.role, context);
  }

  private buildPromptContext(): PromptContext {
    const context: PromptContext = {
      currentTime: new Date().toISOString(),
    };

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
      console.error('[BackgroundAgent] Error loading commitments:', err);
    }

    // Get active content pipeline items
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
      console.error('[BackgroundAgent] Error loading content pipeline:', err);
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
      console.error('[BackgroundAgent] Error loading observations:', err);
    }

    return context;
  }

  private loadActiveRole(): RoleDefinition {
    const roleName = this.config.active_role;

    // Package-root-relative paths for global install compatibility
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
        console.log(`[BackgroundAgent] Loaded role '${role.name}' from ${rolePath}`);
        return role;
      } catch {
        // Try next path
      }
    }

    throw new Error(
      `[BackgroundAgent] Could not load role '${roleName}'. Searched: ${paths.join(', ')}`
    );
  }
}
