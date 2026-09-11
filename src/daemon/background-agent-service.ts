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
import { activeTurns } from './active-turns.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { ResearchQueue } from './research-queue.ts';

import { AgentOrchestrator } from '../agents/orchestrator.ts';
import type { AuthorityEngine, AuthorityProfile } from '../authority/engine.ts';
import type { ApprovalManager, ApprovalRequest } from '../authority/approval.ts';
import type { AuditTrail } from '../authority/audit.ts';
import type { EmergencyController } from '../authority/emergency.ts';
import { loadRole } from '../roles/loader.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { NON_BROWSER_TOOLS, createBrowserTools } from '../actions/tools/builtin.ts';
import { BrowserController } from '../actions/browser/session.ts';
import { DESKTOP_TOOLS } from '../actions/tools/desktop.ts';
import { commitmentsTool } from '../actions/tools/commitments.ts';
import { researchQueueTool } from '../actions/tools/research.ts';
import { buildSystemPromptParts, type PromptContext, type SystemPromptParts } from '../roles/prompt-builder.ts';
import { getDueCommitments, getUpcoming } from '../vault/commitments.ts';
import { getRecentObservations, describeObservationForPrompt } from '../vault/observations.ts';
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
  private authorityEngine: AuthorityEngine | null = null;
  private authorityProfile: AuthorityProfile | null = null;
  /** Approval requests created by the turn in flight / the last finished turn. */
  private currentTurn: { approvalIds: string[] } = { approvalIds: [] };
  private lastTurn: { approvalIds: string[] } = { approvalIds: [] };
  /** Turns run strictly one after another on this chain. */
  private turnChain: Promise<void> = Promise.resolve();
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

  /**
   * Wire the SAME authority engine, approval manager, audit trail and
   * emergency controller the main agent uses, plus a profile that tightens
   * decisions for this agent only. Without this the orchestrator executes
   * every tool call ungated and unaudited.
   *
   * No deferred executor is wired on purpose: approvals from the background
   * agent are created in deferred mode, so the turn returns AWAITING_APPROVAL
   * immediately and the daemon's DeferredExecutor runs the tool when the user
   * approves it from the dashboard, chat or a notification.
   */
  setAuthority(opts: {
    engine: AuthorityEngine;
    profile: AuthorityProfile;
    approvalManager: ApprovalManager;
    auditTrail: AuditTrail;
    emergencyController: EmergencyController;
    onApprovalNeeded: (request: ApprovalRequest) => void;
  }): void {
    this.authorityEngine = opts.engine;
    this.authorityProfile = opts.profile;
    this.orchestrator.setAuthorityEngine(opts.engine);
    this.orchestrator.setAuthorityProfile(opts.profile);
    this.orchestrator.setApprovalManager(opts.approvalManager);
    this.orchestrator.setAuditTrail(opts.auditTrail);
    this.orchestrator.setEmergencyController(opts.emergencyController);
    this.orchestrator.setApprovalCallback((request) => {
      this.currentTurn.approvalIds.push(request.id);
      opts.onApprovalNeeded(request);
    });
  }

  /**
   * Approval requests the most recently FINISHED turn created. Read by the
   * commitment executor and the awareness handlers right after their
   * handleMessage resolves; a following queued turn cannot overwrite this
   * before then because it only publishes when it finishes.
   */
  lastTurnRequestedApproval(): boolean {
    return this.lastTurn.approvalIds.length > 0;
  }

  lastTurnApprovalIds(): string[] {
    return [...this.lastTurn.approvalIds];
  }

  /** Replace the profile after a settings reload. */
  setAuthorityProfile(profile: AuthorityProfile): void {
    this.authorityProfile = profile;
    this.orchestrator.setAuthorityProfile(profile);
  }

  getOrchestrator(): AgentOrchestrator {
    return this.orchestrator;
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
      // No request_approval here on purpose: the authority profile already
      // stops governed tool calls for approval, and an intent gate on top
      // would ask the user twice for the same action.

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
    // Don't START a background reaction once draining; count it in-flight
    // otherwise so the graceful drain awaits it too (same as the primary turns).
    if (activeTurns.isDraining) return 'skipped: draining';
    const endTurn = activeTurns.begin();

    // Strictly serialized: the primary agent has one message history, and a
    // gated turn can now sit on an approval for a while, so two turns must
    // never interleave on it. Each caller waits for the turns queued before
    // it instead of a bounded busy-wait that gave up and ran concurrently.
    const run = async (): Promise<string> => {
      this.busy = true;
      this.currentTurn = { approvalIds: [] };
      try {
        const systemPrompt = this.buildSystemPromptParts(channel);
        return await this.orchestrator.processMessage(systemPrompt, text);
      } catch (err) {
        console.error('[BackgroundAgent] Message error:', err);
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        this.lastTurn = this.currentTurn;
        this.busy = false;
      }
    };

    const result = this.turnChain.then(run, run);
    this.turnChain = result.then(() => undefined, () => undefined);
    try {
      return await result;
    } finally {
      endTurn();
    }
  }

  // --- Private methods ---

  private buildSystemPromptParts(_channel: string): SystemPromptParts {
    if (!this.role) return { static: '', dynamic: '' };
    const context = this.buildPromptContext();
    // Static role prefix is cache-marked downstream; the per-event context
    // (current time, due commitments) rides on the dynamic half.
    return buildSystemPromptParts(this.role, context);
  }

  private buildPromptContext(): PromptContext {
    const context: PromptContext = {
      currentTime: new Date().toISOString(),
      // No request_approval tool on this agent; the profile gate stops
      // governed calls by itself. The prompt must describe that, not a tool
      // the model does not have.
      approvalMode: 'automatic_gate',
    };

    // Tell the model which actions will stop for approval, so it plans a
    // "research, then propose" turn instead of discovering the gate mid-task.
    if (this.authorityEngine && this.role) {
      context.authorityRules = this.authorityEngine.describeRulesForAgent(
        this.role.authority_level,
        this.role.id,
        this.authorityProfile,
      );
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
          // Content-free: no OCR text, clipboard body or email snippet in the prompt.
          return `[${time}] ${describeObservationForPrompt(o)}`;
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
