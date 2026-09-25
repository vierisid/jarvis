import type { RoleDefinition } from '../roles/types.ts';
import type { SystemPromptParts } from '../roles/prompt-builder.ts';
import type { LLMMessage, LLMResponse, LLMStreamEvent, LLMToolCall, LLMTool, ContentBlock } from '../llm/provider.ts';
import { guardImageSize } from '../llm/provider.ts';
import { LLMManager } from '../llm/manager.ts';
import type { Tier } from '../llm/tiers.ts';
import { AgentInstance, canSpawnChildren } from './agent.ts';
import { AgentHierarchy } from './hierarchy.ts';
import { ToolRegistry, type ToolDefinition, isToolResult } from '../actions/tools/registry.ts';
import { toolDefToLLMTool } from '../actions/tools/builtin.ts';
import type { ActionCategory } from '../roles/authority.ts';
import type { AuthorityEngine, AuthorityProfile } from '../authority/engine.ts';
import { markUntrustedToolResult, markUntrustedToolBlocks, markUntrustedToolFailure, isTaintSourceTool } from '../roles/untrusted.ts';
import { ActionOutcomeError } from '../actions/action-outcome.ts';
import { taintProfile, mergeProfiles, TAINT_PROFILE_LABEL, type TaintGating } from '../authority/taint-gating.ts';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Rebuild a turn's taint from a resumed conversation: every tool call the
 * assistant made earlier in it that reads outside content counts, whether or
 * not its result was wrapped (delegate_task's is not).
 */
export function seedTaintFromHistory(history: LLMMessage[], taint: Set<string>, registry: ToolRegistry | null): void {
  for (const m of history) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      if (isTaintSourceTool(tc.name, registry?.get(tc.name)?.category)) taint.add(tc.name);
    }
  }
}
import type { ApprovalManager, ApprovalRequest } from '../authority/approval.ts';
import type { AuditTrail } from '../authority/audit.ts';
import type { DeferredExecutor } from '../authority/deferred-executor.ts';
import { ABOVE_LEVEL_SUBSTITUTION } from '../authority/deferred-executor.ts';
import type { EmergencyController } from '../authority/emergency.ts';
import { getActionForTool, resolveToolGate, gateContext } from '../authority/tool-action-map.ts';
import { decideTools, realtimeToolDecision } from '../actions/tools/tool-relevance/filter.ts';
import { DISCOVER_TOOLS, ToolExposureLedger } from '../actions/tools/tool-relevance/ledger.ts';
import {
  admissionAuditName, interceptDiscovery, interceptOffList, DISCOVER_TOOLS_LLM, type DiscoveryContext,
} from '../actions/tools/tool-relevance/discover.ts';
import { getToolFilterPolicy } from '../actions/tools/tool-relevance/policy.ts';
import type { LLMProviderEntry } from '../config/types.ts';
import { combineDecisions, type AuthorityDecision } from '../authority/engine.ts';
import { progressAcknowledgement } from './progress.ts';
import { runWithOrigin } from '../llm/origin.ts';

/**
 * Convert a system prompt (legacy string or static/dynamic parts) into the
 * leading system messages of a conversation.
 *
 * Parts form: the static half is marked as a provider cache boundary
 * (`cache: true`) - it is byte-stable turn-over-turn, so Anthropic can cache
 * tools + static prompt across requests. The dynamic half follows unmarked.
 *
 * Legacy string form: a single unmarked system message. It may embed per-turn
 * volatile content, so marking it would pay cache-write premiums with no
 * reads; within-loop caching still applies via the provider's last-message
 * breakpoint.
 */
function toSystemMessages(systemPrompt: string | SystemPromptParts): LLMMessage[] {
  if (typeof systemPrompt === 'string') {
    return [{ role: 'system', content: systemPrompt }];
  }
  const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt.static, cache: true }];
  if (systemPrompt.dynamic) {
    messages.push({ role: 'system', content: systemPrompt.dynamic });
  }
  return messages;
}

const MAX_TOOL_ITERATIONS = 200;
const MAX_TOOL_RESULT_CHARS = 6000; // Cap individual tool results to control context size
// How long the authority gate blocks waiting for the user to approve a
// gated tool call before falling back to the deferred (fire-and-forget)
// path. Long enough to click a permission panel, short enough that an
// ignored panel doesn't hang the conversation turn indefinitely.
const APPROVAL_WAIT_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Special tool exposed only on processTaskCall. The orchestrator intercepts
 * calls to this name and returns a paused state instead of dispatching it
 * through the tool registry. Lets a task-tier LLM signal "I need more info
 * from the user before I can continue" without ending the work it's done so
 * far - the conversation buffer is captured for later resume.
 */
const ASK_FOR_CLARIFICATION_TOOL: LLMTool = {
  name: 'ask_for_clarification',
  description:
    "Pause this task and ask the user a clarifying question. Use this ONLY when the user's intent is genuinely ambiguous and a single concrete question would unblock you (e.g., 'Which Sarah - Chen or Park?'). Do not use this for general chit-chat or to avoid making reasonable inferences. When you call this, the task pauses; the conversation agent will read the question to the user and resume your task with the user's answer appended.",
  parameters: {
    type: 'object',
    required: ['question'],
    properties: {
      question: {
        type: 'string',
        description: 'The exact question to ask the user. Should be specific and answerable in one sentence.',
      },
    },
  },
};

/**
 * Prepended to the task tier's own system prompt (fresh calls only, and only
 * when the caller sets `requireToolUse`). The task tier is handed the FULL
 * conversational role prompt - persona included - and some model families
 * anchor on that persona and answer the way a chat assistant would: by
 * acknowledging the request. This says, at the position closest to the user
 * message, that there is nobody to acknowledge.
 */
const TASK_EXECUTOR_FRAMING =
  'You are not talking to anyone right now. You are running as a BACKGROUND ' +
  'TASK EXECUTOR: the text you produce is stored as this task\'s result and is ' +
  'read only once you stop. Nothing you merely announce gets carried out ' +
  'afterwards - if you end your turn without calling a tool, the task ends ' +
  'having done nothing at all. Call the tools you need first; your final ' +
  'message reports what they actually returned. If one detail is genuinely ' +
  'missing, call ask_for_clarification.';

/**
 * Pushed back at a task-tier model that answered without calling a single
 * tool while nothing had been done yet. Such an answer is almost always an
 * ANNOUNCEMENT of intent ("On it - I'll open Notepad, then verify it's in the
 * foreground"), and `processTaskCall` would otherwise hand it to the
 * dispatcher as the task's result - which the conversation tier then reads
 * back to the user as a progress note instead of an outcome.
 *
 * Measured against the hosted medium tier while its upstream was swapped
 * between families: across 25 tasks the split is clean and model-determined,
 * not random. Every GPT-era task returned an announcement after ONE call in
 * 1.9-6.4s; every task on the other families ran a real tool loop (3 or more
 * calls, 7-147s) on the same intents, including the same "open notepad"
 * wording. So the tools, the prompt and the wire format are all fine - the
 * behaviour has to be corrected in the loop rather than assumed away.
 */
const NO_WORK_NUDGE =
  'You replied with a message and did not call a single tool, so nothing has ' +
  'been done yet. You are running as a BACKGROUND TASK EXECUTOR: nobody sees ' +
  'this text while the task runs and there is no one to reply to it - it is ' +
  'stored verbatim as the task result. Do the work now using the tools in ' +
  'your registry, then report only what actually happened (what you called, ' +
  'what came back). If one detail is genuinely missing, call ' +
  'ask_for_clarification instead. If your previous message really was the ' +
  'complete final result and no tool was needed, repeat it as your answer.';

/** How many times a single task may be pushed back before its answer stands. */
const MAX_NO_WORK_NUDGES = 2;

/**
 * Result of a task-tier call. Either completed (final assistant text +
 * the whole conversation buffer) or paused (the LLM called the
 * `ask_for_clarification` tool; the conversation is captured so the task
 * can resume from this exact point when the user replies).
 */
export type TaskCallResult =
  | { kind: 'completed'; text: string; conversation: LLMMessage[] }
  | { kind: 'paused'; question: string; conversation: LLMMessage[] };

export class AgentOrchestrator {
  private hierarchy: AgentHierarchy;
  private llmManager: LLMManager | null;
  private toolRegistry: ToolRegistry | null;

  // Authority engine components
  private authorityEngine: AuthorityEngine | null = null;
  private approvalManager: ApprovalManager | null = null;
  private deferredExecutor: DeferredExecutor | null = null;
  private auditTrail: AuditTrail | null = null;
  private emergencyController: EmergencyController | null = null;
  private temporaryGrants: Map<string, ActionCategory[]> = new Map();
  private onApprovalNeeded: ((request: ApprovalRequest) => void) | null = null;
  /** Per-orchestrator restrictions passed into every authority check. */
  private authorityProfile: AuthorityProfile | null = null;
  /** Taint gating config (main agent); null = off. */
  private taintGating: TaintGating | null = null;
  /**
   * Per-turn taint. Each turn owns a Set that executeTool enters via
   * AsyncLocalStorage, so concurrent turns (a Telegram message alongside a
   * dashboard stream, two dispatched tasks) neither see nor reset each
   * other's taint, and a tool running inside the turn (delegate_task) can
   * read the parent turn's taint through getEffectiveProfile().
   */
  private taintStore = new AsyncLocalStorage<Set<string>>();
  /** Realtime voice has no turn objects; its taint lives per session here. */
  private realtimeTaint: Set<string> = new Set();
  /** Logged once: tools ran with no authority engine wired (tests, embedded use). */
  private warnedNoAuthority = false;
  /**
   * Grow-only tool exposure, one ledger per conversation (keyed by agent id).
   * Empty and inert unless the relevance filter is switched on.
   */
  private exposureLedgers = new Map<string, ToolExposureLedger>();
  /**
   * Provider entries from the post-DB-merge `llm` config, for model-class
   * eligibility. Absent is safe: the classifier then reads a provider's KIND
   * from its NAME, which is correct for the canonical entries and fails
   * closed (ineligible, so unfiltered) for custom-named ones.
   */
  private toolFilterProviders: Record<string, LLMProviderEntry | undefined> | undefined;

  constructor() {
    this.hierarchy = new AgentHierarchy();
    this.llmManager = null;
    this.toolRegistry = null;
  }

  setLLMManager(llm: LLMManager): void {
    this.llmManager = llm;
  }

  getLLMManager(): LLMManager | null {
    return this.llmManager;
  }

  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  getToolRegistry(): ToolRegistry | null {
    return this.toolRegistry;
  }

  /**
   * Public tool schema for realtime voice sessions. Same shared `LLMTool[]`
   * the text providers consume (decision #3 — single source of truth).
   */
  getRealtimeTools(): LLMTool[] {
    if (!this.toolRegistry || this.toolRegistry.count() === 0) return [];
    // Routed through the same gate as every other call site so the decision
    // is explicit and testable rather than realtime simply being forgotten
    // the way it was in #475 -- but the gate always says no here. A realtime
    // session's tools are fixed when buildSessionUpdate runs, so a filter
    // would break per-turn re-filtering AND the escape hatch at once:
    // `discover_tools` could not take effect, because the session's tool
    // list cannot change. A dead-end hatch is worse than no filter.
    return realtimeToolDecision(this.toolRegistry.list()).tools.map(toolDefToLLMTool);
  }

  /**
   * Provider entries for model-class eligibility. Called by the daemon after
   * the DB merge; also re-callable on an `llm` hot reload, since the tier
   * map and the provider set can both change under a running orchestrator.
   */
  setToolFilterProviders(providers: Record<string, LLMProviderEntry | undefined> | undefined): void {
    this.toolFilterProviders = providers;
  }

  /**
   * The same provider entries, for the sub-agent launchers to hand to
   * `runSubAgent`. Without them the sub-agent gate falls back to reading
   * the provider NAME as its kind, so a custom-named ollama provider is
   * never eligible there -- safe, but the call sites then disagree.
   */
  getToolFilterProviders(): Record<string, LLMProviderEntry | undefined> | undefined {
    return this.toolFilterProviders;
  }

  // --- Authority setters ---

  setAuthorityEngine(engine: AuthorityEngine): void {
    this.authorityEngine = engine;
  }

  setApprovalManager(manager: ApprovalManager): void {
    this.approvalManager = manager;
  }

  /**
   * Enables inline approval execution: the authority gate blocks on the
   * user's decision and runs the approved tool itself, so the result flows
   * back through the task loop instead of a detached notification.
   */
  setDeferredExecutor(executor: DeferredExecutor): void {
    this.deferredExecutor = executor;
  }

  setAuditTrail(trail: AuditTrail): void {
    this.auditTrail = trail;
  }

  setEmergencyController(controller: EmergencyController): void {
    this.emergencyController = controller;
  }

  setApprovalCallback(cb: (request: ApprovalRequest) => void): void {
    this.onApprovalNeeded = cb;
  }

  /**
   * Restrictions layered on the shared engine for THIS orchestrator only.
   * The engine and its config stay the single source of truth (dashboard
   * edits, overrides, emergency state all still apply); the profile can only
   * tighten the outcome. Pass null to clear.
   */
  setAuthorityProfile(profile: AuthorityProfile | null): void {
    this.authorityProfile = profile;
  }

  getAuthorityProfile(): AuthorityProfile | null {
    return this.authorityProfile;
  }

  /**
   * Audit-trail name. Both orchestrators run the same role, so the profile
   * label is what tells a background-originated action from a chat one.
   */
  private auditAgentName(roleName: string): string {
    const label = this.authorityProfile?.label;
    return label ? `${roleName} (${label})` : roleName;
  }

  // --- Taint gating ---

  /** Enable or disable taint gating; see src/authority/taint-gating.ts. */
  setTaintGating(gating: TaintGating | null): void {
    this.taintGating = gating;
  }

  /** The taint set of the turn currently executing, or the realtime session's. */
  private currentTaint(): Set<string> {
    return this.taintStore.getStore() ?? this.realtimeTaint;
  }

  /** Sources of outside content read so far in the calling turn (or voice session). */
  getTurnTaint(): ReadonlySet<string> {
    return this.currentTaint();
  }

  /** Voice sessions have no turn objects: the WS layer calls this on each final user transcript. */
  resetRealtimeTaint(): void {
    this.realtimeTaint.clear();
  }

  private noteTaint(toolName: string, category: string | undefined): void {
    if (isTaintSourceTool(toolName, category)) this.currentTaint().add(toolName);
  }

  /**
   * Static profile plus, while the calling turn is tainted, the taint
   * profile. Tighten-only. Public so tools that spawn sub-agents inside a
   * turn (delegate_task, manage_agents) can hand the sub-agent the same
   * restrictions the parent is under.
   */
  getEffectiveProfile(): AuthorityProfile | null {
    return mergeProfiles(this.authorityProfile, taintProfile(this.taintGating, this.currentTaint()));
  }

  // --- Accessors for tools that run sub-agents ---

  getAuthorityEngine(): AuthorityEngine | null {
    return this.authorityEngine;
  }

  getAuditTrail(): AuditTrail | null {
    return this.auditTrail;
  }

  getEmergencyController(): EmergencyController | null {
    return this.emergencyController;
  }

  getTemporaryGrants(): Map<string, ActionCategory[]> {
    return this.temporaryGrants;
  }

  getTaintGating(): TaintGating | null {
    return this.taintGating;
  }

  /**
   * Grant a temporary permission to a specific agent (for parent escalation).
   */
  grantTemporary(agentId: string, action: ActionCategory): void {
    const existing = this.temporaryGrants.get(agentId) ?? [];
    if (!existing.includes(action)) {
      existing.push(action);
      this.temporaryGrants.set(agentId, existing);
    }
  }

  /**
   * Revoke a temporary permission from an agent.
   */
  revokeTemporary(agentId: string, action: ActionCategory): void {
    const existing = this.temporaryGrants.get(agentId);
    if (existing) {
      this.temporaryGrants.set(agentId, existing.filter(a => a !== action));
    }
  }

  /**
   * Clear all temporary grants for an agent (called when task completes).
   */
  clearTemporaryGrants(agentId: string): void {
    this.temporaryGrants.delete(agentId);
  }

  /**
   * Create the primary agent from a role.
   * No inline system prompt — the AgentService builds a rich dynamic prompt each turn.
   */
  createPrimary(role: RoleDefinition): AgentInstance {
    const existing = this.hierarchy.getPrimary();
    if (existing) {
      throw new Error('Primary agent already exists. Terminate it first.');
    }

    const agent = new AgentInstance(role);
    this.hierarchy.addAgent(agent);
    return agent;
  }

  /**
   * Spawn a sub-agent under a parent
   */
  spawnSubAgent(
    parentId: string,
    role: RoleDefinition,
    opts?: { memory_scope?: string[] }
  ): AgentInstance {
    const parent = this.hierarchy.getAgent(parentId);
    if (!parent) {
      throw new Error(`Parent agent not found: ${parentId}`);
    }

    // The authority engine is the PRIME decider for spawning. The user's
    // explicit configuration (per-action overrides, context rules, the
    // authority slider) wins over the role-derived capability flag in
    // BOTH directions: a `spawn_agent` deny blocks a delegation-capable
    // role, and an allow unblocks a role that never declared delegation.
    // This also covers spawn paths that bypass the tool-level gate
    // (dashboard spawn dialog, workflow delegator). The role flag is
    // only the fallback when no engine is wired (tests, embedded use).
    if (this.authorityEngine) {
      const decision = this.authorityEngine.checkAuthority({
        agentId: parent.id,
        agentAuthorityLevel: parent.agent.authority.max_authority_level,
        agentRoleId: parent.agent.role.id,
        toolName: 'spawn_sub_agent',
        toolCategory: 'delegation',
        actionCategory: 'spawn_agent',
        temporaryGrants: this.temporaryGrants,
        profile: this.getEffectiveProfile(),
      });
      if (!decision.allowed) {
        throw new Error(`Authority denied spawning a sub-agent: ${decision.reason}`);
      }
      // `requiresApproval` is intentionally treated as allowed here: the
      // soft gate runs at the TOOL layer (executeTool intercepts
      // delegate_task/manage_agents before they execute), so by the time
      // we get here the approval either wasn't needed or was granted.
    } else if (!parent.agent.authority.can_spawn_children) {
      throw new Error(
        `Agent role "${parent.agent.role.id}" cannot spawn sub-agents: the role declares neither the "delegation" tool nor any sub_roles. Add "delegation" to the role's tools list to enable delegation.`,
      );
    }

    // Create child agent with reduced authority
    const childAuthority = {
      max_authority_level: Math.min(
        role.authority_level,
        parent.agent.authority.max_authority_level - 1
      ),
      allowed_tools: role.tools.filter((tool) =>
        parent.agent.authority.allowed_tools.includes(tool)
      ),
      denied_tools: parent.agent.authority.denied_tools,
      max_token_budget: Math.floor(parent.agent.authority.max_token_budget / 2),
      can_spawn_children: canSpawnChildren(role),
    };

    const agent = new AgentInstance(role, {
      parent_id: parentId,
      authority: childAuthority,
      memory_scope: opts?.memory_scope ?? [],
    });

    this.hierarchy.addAgent(agent);

    // Add system message with role context for sub-agents. Communication
    // style is optional - only inject the line when the role declares one.
    const styleLine = role.communication_style
      ? `\n\nCommunication style: ${role.communication_style.tone} tone, ${role.communication_style.verbosity} verbosity, ${role.communication_style.formality} formality.`
      : '';
    agent.addMessage(
      'system',
      `You are ${role.name}, spawned by ${parent.agent.role.name}. ${role.description}\n\nResponsibilities:\n${role.responsibilities.map((r) => `- ${r}`).join('\n')}\n\nYou report to: ${parent.agent.role.name}.${styleLine}`,
    );

    return agent;
  }

  /**
   * Terminate an agent and its children
   */
  terminateAgent(agentId: string): void {
    const agent = this.hierarchy.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Recursively terminate children first
    const children = this.hierarchy.getChildren(agentId);
    for (const child of children) {
      this.terminateAgent(child.id);
    }

    // Terminate this agent
    agent.terminate();
    this.hierarchy.removeAgent(agentId);
    // The exposure ledger is keyed by agent id and only ever grows, so a
    // terminated agent's entry would otherwise sit in the map for the life
    // of the process.
    this.exposureLedgers.delete(agentId);
  }

  getPrimary(): AgentInstance | undefined {
    return this.hierarchy.getPrimary();
  }

  getAgent(agentId: string): AgentInstance | undefined {
    return this.hierarchy.getAgent(agentId);
  }

  getAllAgents(): AgentInstance[] {
    return this.hierarchy.getAllAgents();
  }

  getHierarchy(): AgentHierarchy {
    return this.hierarchy;
  }

  /**
   * Process a user message through the primary agent (non-streaming).
   * Includes the tool execution loop: LLM → tool_calls → execute → re-call → repeat.
   *
   * @param tier Which task tier runs the LLM call (default 'medium' for
   *   classic mode). Conv-tier delegation passes through with the requested
   *   tier so delegated work uses the full primary tool registry on the
   *   chosen model.
   * @param subsystem Usage-tracking label for the tier call.
   */
  async processMessage(
    systemPrompt: string | SystemPromptParts,
    message: string,
    tier: Tier = 'medium',
    subsystem: string = 'chat_orchestrator',
  ): Promise<string> {
    const primary = this.getPrimary();
    if (!primary) {
      throw new Error('No primary agent exists. Create one first.');
    }

    // A message from the user is the turn boundary for taint gating: this
    // turn's reads gate this turn's later calls and nothing else.
    const turnTaint = new Set<string>();

    // Add user message to persistent history
    primary.addMessage('user', message);

    // If no LLM manager, return placeholder
    if (!this.llmManager) {
      const response = `[No LLM configured] Received: ${message}`;
      primary.addMessage('assistant', response);
      return response;
    }

    // Build local messages array for this turn (system + history)
    const messages: LLMMessage[] = [
      ...toSystemMessages(systemPrompt),
      ...primary.getMessages(),
    ];

    // Decided once for the turn and held across the loop. Recomputing per
    // iteration would invalidate the provider's cached prefix every time,
    // because the tool list sits at the head of it.
    const ledger = this.ledgerFor(primary.id);
    let decided = this.decideTurnTools(messages, tier, ledger);
    let tools = decided.llm;
    let finalText = '';

    // Tool execution loop
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const llmResponse: LLMResponse = await this.llmManager.chatTier(tier, subsystem, messages, { tools });

      if (llmResponse.finish_reason === 'tool_use' && llmResponse.tool_calls.length > 0) {
        // Add assistant message with tool calls to local messages
        messages.push({
          role: 'assistant',
          content: llmResponse.content,
          tool_calls: llmResponse.tool_calls,
        });

        // Execute each tool and add results
        let widened = false;
        for (const tc of llmResponse.tool_calls) {
          const discovery = this.handleDiscoveryCall(tc, decided.exposed, ledger);
          if (discovery) {
            widened ||= discovery.grew;
            messages.push({ role: 'tool', content: discovery.result, tool_call_id: tc.id });
            continue;
          }
          // A tool the model was not offered: admitted and recomputed, and
          // not run at all if running it would strand outside content
          // unframed. See interceptOffList.
          const offList = this.handleOffListCall(tc, decided.exposed, ledger);
          if (offList) widened = true;
          if (offList?.refusal) {
            messages.push({ role: 'tool', content: offList.refusal, tool_call_id: tc.id });
            continue;
          }
          // Everything the model actually calls stays exposed for the rest
          // of the conversation, so a later turn cannot strip a tool an
          // in-flight task is using.
          this.noteToolUse(ledger, tc.name);
          const result = await this.executeTool(tc, undefined, turnTaint);
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id,
          });
          const logStr = typeof result === 'string' ? result.slice(0, 100) : `[${result.length} content blocks]`;
          console.log(`[Orchestrator] Tool ${tc.name} → ${logStr}...`);

          // Capture document markers so they appear in the final response
          if (typeof result === 'string') {
            const docMarker = result.match(/<!-- jarvis:document id="[^"]+" title="[^"]+" format="[^"]+" size="[^"]+" -->/);
            if (docMarker) {
              finalText += '\n' + docMarker[0] + '\n';
            }
          }
        }

        // Only a widening justifies recomputing the tool list mid-turn: an
        // admission (the escape hatch would be pointless if the admitted
        // tools only appeared on the next user turn), or a call to a tool
        // the model was not offered (see interceptOffList).
        if (widened) {
          decided = this.decideTurnTools(messages, tier, ledger);
          tools = decided.llm;
        }

        // Continue loop to re-call LLM with tool results
        continue;
      }

      // No tool calls — this is the final response
      finalText = llmResponse.content;

      // Warn on truncation
      if (llmResponse.finish_reason === 'length') {
        finalText += '\n\n[Response was truncated due to output token limits. If you asked for long content, ask to continue or use shorter chunks.]';
      }

      break;
    }

    // Add final response to persistent history
    primary.addMessage('assistant', finalText);
    return finalText;
  }

  /**
   * Task-tier call with pause/resume semantics. Runs the same tool execution
   * loop as `processMessage`, but:
   *   - Does NOT touch the primary agent's persistent history (task tier
   *     conversations are scoped to a single task, not the global thread).
   *   - Exposes the `ask_for_clarification` tool to the LLM so it can pause
   *     execution and request user input.
   *   - Accepts an optional `history` so a paused task can be resumed by
   *     re-entering the loop with the saved messages + a new user reply.
   *
   * Returns either a completed result (text + final conversation snapshot)
   * or a paused result (the question + the conversation up to the pause).
   * In the paused case, the caller stores the conversation on the task
   * record so a subsequent `resume` can continue from the same buffer.
   */
  async processTaskCall(opts: {
    systemPrompt: string | SystemPromptParts;
    userMessage: string;
    tier: Tier;
    subsystem: string;
    /** When resuming, pass the conversation captured at the pause + the new user reply. */
    history?: LLMMessage[];
    signal?: AbortSignal;
    /**
     * Opt in to the two anti-announcement layers: TASK_EXECUTOR_FRAMING on
     * the way in, and the bounded NO_WORK_NUDGE push-back when the model
     * still produces final text before any tool has run. Off by default so
     * callers that expect a pure text answer keep their single-call
     * behaviour.
     */
    requireToolUse?: boolean;
  }): Promise<TaskCallResult> {
    if (!this.llmManager) {
      return { kind: 'completed', text: '[No LLM configured]', conversation: [] };
    }

    // Fresh call or a resume with the user's reply. On a resume the earlier
    // tool results are still in the history, and a page could have said
    // "ask first, then run it", so the taint is rebuilt from the history
    // instead of starting clean.
    const turnTaint = new Set<string>();
    if (opts.history) seedTaintFromHistory(opts.history, turnTaint, this.toolRegistry);

    // Build the running conversation buffer. On a fresh call: system + user
    // message. On resume: prior conversation + a new user message (the
    // clarification reply).
    const messages: LLMMessage[] = opts.history
      ? [...opts.history, { role: 'user', content: opts.userMessage }]
      : [
          ...toSystemMessages(opts.systemPrompt),
          ...(opts.requireToolUse
            ? [{ role: 'system', content: TASK_EXECUTOR_FRAMING } satisfies LLMMessage]
            : []),
          { role: 'user', content: opts.userMessage },
        ];

    // Include the standard tools plus the special clarification tool.
    //
    // The task path's buffer IS durable -- it is persisted whole onto the
    // task record and replayed as opts.history -- so the ledger can be
    // seeded from it, which restores admissions across a pause/resume.
    //
    // The ledger is the PRIMARY's, not a fresh one per task. This loop is the
    // router-first path's tool executor, and it sees only the user's latest
    // message (the dialogue rides in as system context, which selection does
    // not read), so a fresh ledger per task was #483's mid-task stripping
    // again: task 1 "open example.com" uses browser_navigate, task 2 "now do
    // the same for the second result" is offered none of it. Grow-only, so
    // concurrent tasks sharing it can only widen each other.
    const primaryAgent = this.getPrimary();
    const ledger = primaryAgent ? this.ledgerFor(primaryAgent.id) : new ToolExposureLedger();
    // Seeding writes into the long-lived primary ledger, so it follows the
    // same rule as noteToolUse: nothing at all while the filter is off.
    if (getToolFilterPolicy().enabled) {
      ledger.seedFromMessages(opts.history, (n) => this.toolRegistry?.has(n) ?? false);
    }
    let decided = this.decideTurnTools(messages, opts.tier, ledger);
    // ask_for_clarification is appended AFTER the filter, and is therefore
    // never part of its accounting. #475's fail-open guard counted it as
    // though it were a registry tool, which is half of why that guard could
    // never fire.
    let tools: LLMTool[] = [...(decided.llm ?? []), ASK_FOR_CLARIFICATION_TOOL];

    let finalText = '';
    // Seeded from the resumed buffer, not 0: a task that ran tools before it
    // paused HAS done work, and the push-back below would otherwise tell it
    // "nothing has been done yet ... do the work now" - an instruction to
    // re-run side-effecting tools it already ran (re-send the mail, re-create
    // the workflow).
    let toolsExecuted = opts.history?.some((m) => m.role === 'tool') ? 1 : 0;
    let nudges = 0;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (opts.signal?.aborted) {
        return { kind: 'completed', text: finalText, conversation: messages };
      }

      const llmResponse: LLMResponse = await this.llmManager.chatTier(
        opts.tier,
        opts.subsystem,
        messages,
        { tools },
      );

      if (llmResponse.finish_reason === 'tool_use' && llmResponse.tool_calls.length > 0) {
        // First, scan tool calls for `ask_for_clarification` - that breaks
        // the loop and returns a paused result without executing anything
        // else in this batch. We DO record the assistant message + the
        // clarification call in the conversation so resume can replay the
        // LLM's "I need more info" turn.
        const clarifyCall = llmResponse.tool_calls.find((tc) => tc.name === ASK_FOR_CLARIFICATION_TOOL.name);
        if (clarifyCall) {
          const args = clarifyCall.arguments as { question?: string };
          const question = (args.question ?? '').trim() || 'I need more information to continue.';
          messages.push({
            role: 'assistant',
            content: llmResponse.content,
            tool_calls: llmResponse.tool_calls,
          });
          // The tool result is a stub that says "asked the user" - lets the
          // model see what it asked when it resumes.
          messages.push({
            role: 'tool',
            content: `[Paused: asked user "${question}" - resume will append the user's reply.]`,
            tool_call_id: clarifyCall.id,
          });
          // Every OTHER call in the same batch needs a result too. The
          // assistant message above carries the whole tool_calls array, and
          // a tool_use with no matching tool_result is rejected by the
          // providers when this conversation is replayed on resume. Latent
          // before `discover_tools` existed; likely now, because a confused
          // small model will ask for a tool and say "I need more info" in
          // the same batch.
          for (const other of llmResponse.tool_calls) {
            if (other.id === clarifyCall.id) continue;
            messages.push({
              role: 'tool',
              content: '[Not run: the task paused to ask the user a question first.]',
              tool_call_id: other.id,
            });
          }
          return { kind: 'paused', question, conversation: messages };
        }

        messages.push({
          role: 'assistant',
          content: llmResponse.content,
          tool_calls: llmResponse.tool_calls,
        });

        let widened = false;
        for (const tc of llmResponse.tool_calls) {
          const discovery = this.handleDiscoveryCall(tc, decided.exposed, ledger);
          if (discovery) {
            widened ||= discovery.grew;
            messages.push({ role: 'tool', content: discovery.result, tool_call_id: tc.id });
            continue;
          }
          const offList = this.handleOffListCall(tc, decided.exposed, ledger);
          if (offList) widened = true;
          if (offList?.refusal) {
            messages.push({ role: 'tool', content: offList.refusal, tool_call_id: tc.id });
            continue;
          }
          this.noteToolUse(ledger, tc.name);
          const result = await this.executeTool(tc, opts.signal, turnTaint);
          toolsExecuted++;
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id,
          });
        }
        if (widened) {
          decided = this.decideTurnTools(messages, opts.tier, ledger);
          tools = [...(decided.llm ?? []), ASK_FOR_CLARIFICATION_TOOL];
        }
        continue;
      }

      // Final text before anything was actually done - see NO_WORK_NUDGE.
      // Bounded, and only when the caller asked for it: a task that
      // legitimately needs no tools (drafting prose) must still be able to
      // answer in a single call.
      const strandedToolCalls = (llmResponse.tool_calls?.length ?? 0) > 0;
      if (
        opts.requireToolUse
        && toolsExecuted === 0
        && nudges < MAX_NO_WORK_NUDGES
        // Calls the provider reported without a `tool_use` finish reason land
        // here (Gemini marks every function call `STOP` - see its
        // `tool_calls_present`). The model DID call a tool, so telling it that
        // it did not is both false and destructive: the push-back would drop
        // the calls from the buffer it re-sends.
        && !strandedToolCalls
        // A truncated or filtered turn is not an announcement. Nudging burns
        // two more expensive generations and loses the truncation marker
        // appended below.
        && llmResponse.finish_reason !== 'length'
        && llmResponse.finish_reason !== 'error'
      ) {
        nudges++;
        // Only when it actually said something: an empty assistant message is
        // re-sent on the next iteration, and providers reject empty content
        // (AnthropicProvider.convertMessages passes assistant turns through
        // verbatim). Before this loop re-sent the buffer, an empty final
        // message was harmless.
        if (llmResponse.content.trim()) {
          messages.push({ role: 'assistant', content: llmResponse.content });
        }
        messages.push({ role: 'user', content: NO_WORK_NUDGE });
        continue;
      }

      finalText = llmResponse.content;
      if (llmResponse.finish_reason === 'length') {
        finalText += '\n\n[Response was truncated due to output token limits.]';
      }
      messages.push({ role: 'assistant', content: finalText });
      break;
    }

    return { kind: 'completed', text: finalText, conversation: messages };
  }

  /**
   * Stream one tier call, retrying on `fallbackTier` if the requested tier
   * fails before emitting any content.
   *
   * `streamTier` reports total failure as a terminal `error` event rather than
   * throwing, and it only crosses the provider boundary for errors that name
   * model availability — a "this model does not support images" 400 is not one
   * of them. Combined with `TIER_FALLBACK.conversation` being empty, a
   * conv-tier model that cannot see would otherwise dead-end the caller with
   * no recourse. Retrying only when nothing has been emitted keeps a mid-
   * stream failure honest instead of silently restarting a partial answer.
   */
  private async *streamTierWithFallback(
    tier: Tier,
    fallbackTier: Tier | undefined,
    subsystem: string,
    messages: LLMMessage[],
    options: import('../llm/provider.ts').LLMOptions,
    onFallback?: () => void,
  ): AsyncIterable<LLMStreamEvent> {
    if (!this.llmManager) return;
    if (!fallbackTier || fallbackTier === tier) {
      yield* this.llmManager.streamTier(tier, subsystem, messages, options);
      return;
    }

    let emittedContent = false;
    for await (const event of this.llmManager.streamTier(tier, subsystem, messages, options)) {
      if (event.type === 'error' && !emittedContent) {
        console.warn(
          `[Orchestrator] ${tier} tier failed for ${subsystem} before any output (${event.error}) — retrying on ${fallbackTier}.`,
        );
        onFallback?.();
        yield* this.llmManager.streamTier(fallbackTier, subsystem, messages, options);
        return;
      }
      if (event.type === 'text' || event.type === 'tool_call') emittedContent = true;
      yield event;
    }
  }

  /**
   * Stream a message through the primary agent with tool execution loop.
   * Yields text/tool_call events through all iterations.
   * Only emits 'done' when the final response is complete.
   *
   * @param tier Which tier runs the stream. Defaults to 'medium' — the classic
   *   single-orchestrator mode runs the full ReAct loop here, and that is task
   *   work. Callers that are really carrying a *dialogue* turn (the pebble
   *   image path, which bypasses the conv orchestrator because it has no
   *   image route) pass 'conversation' so those turns bill the chat model
   *   instead of the task model.
   * @param subsystem Usage-tracking label for the tier call.
   * @param fallbackTier Tier to retry on when `tier` dies before producing any
   *   output. Needed because `conversation` has an empty fallback chain — see
   *   streamTierWithFallback().
   */
  async *streamMessage(
    systemPrompt: string | SystemPromptParts,
    message: string | import('../llm/provider.ts').ContentBlock[],
    tier: Tier = 'medium',
    subsystem: string = 'chat_orchestrator_stream',
    fallbackTier?: Tier,
  ): AsyncIterable<LLMStreamEvent> {
    const primary = this.getPrimary();
    if (!primary) {
      throw new Error('No primary agent exists. Create one first.');
    }

    // A message from the user is the turn boundary for taint gating: this
    // turn's reads gate this turn's later calls and nothing else.
    const turnTaint = new Set<string>();

    // Add user message to persistent history
    primary.addMessage('user', message);

    // If no LLM manager, yield placeholder
    if (!this.llmManager) {
      const stub = typeof message === 'string' ? message : '[image+text content]';
      const response = `[No LLM configured] Received: ${stub}`;
      primary.addMessage('assistant', response);
      yield { type: 'text', text: response };
      yield {
        type: 'done',
        response: {
          content: response,
          tool_calls: [],
          usage: { input_tokens: 0, output_tokens: 0 },
          model: 'none',
          finish_reason: 'stop',
        },
      };
      return;
    }

    // Build local messages array for this turn
    const messages: LLMMessage[] = [
      ...toSystemMessages(systemPrompt),
      ...primary.getMessages(),
    ];

    // `fallbackTier` MUST reach the gate. It is a caller-supplied retry
    // tier, not a TIER_FALLBACK one -- agent-service passes 'medium' here
    // with tier 'conversation', and TIER_FALLBACK.conversation is
    // deliberately empty. Without it the gate would clear a small local
    // conversation model and then hand the filtered list to the frontier
    // task model the instant the local one died before first output.
    const ledger = this.ledgerFor(primary.id);
    let decided = this.decideTurnTools(messages, tier, ledger, fallbackTier);
    let tools = decided.llm;
    const totalUsage = { input_tokens: 0, output_tokens: 0 };
    let finalText = '';
    let responseModel = 'unknown';
    let acknowledgedWork = false;
    // Once a tier has proved it cannot handle this conversation, stay off it.
    // The tool loop re-enters the stream per iteration with the SAME messages
    // (image included), so without this a blind conv model would be re-asked —
    // and re-billed — on every iteration.
    let activeTier = tier;

    // Tool execution loop
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      let accumulatedText = '';
      const toolCalls: LLMToolCall[] = [];
      let doneResponse: LLMResponse | null = null;

      // Stream from LLM
      for await (const event of this.streamTierWithFallback(
        activeTier,
        fallbackTier,
        subsystem,
        messages,
        { tools },
        () => { activeTier = fallbackTier!; },
      )) {
        if (event.type === 'text') {
          accumulatedText += event.text;
          yield event; // Forward text chunks to client
        } else if (event.type === 'tool_call') {
          toolCalls.push(event.tool_call);
          yield event; // Forward tool_call events to client
        } else if (event.type === 'done') {
          doneResponse = event.response;
          totalUsage.input_tokens += event.response.usage.input_tokens;
          totalUsage.output_tokens += event.response.usage.output_tokens;
          responseModel = event.response.model;
          // Don't yield done yet — may need more iterations
        } else if (event.type === 'error') {
          yield event;
          return;
        }
      }

      // Ensure doneResponse is never null (stream may end without 'done' event)
      if (!doneResponse) {
        doneResponse = {
          content: accumulatedText,
          tool_calls: toolCalls,
          usage: { input_tokens: 0, output_tokens: 0 },
          model: responseModel,
          finish_reason: 'stop',
        };
      }

      // No tool calls — this is the final response
      if (toolCalls.length === 0) {
        finalText += accumulatedText;

        // Check if we stopped due to token limit (truncation)
        const wasLength = doneResponse?.finish_reason === 'length';
        if (wasLength && !finalText.includes('[SYSTEM WARNING')) {
          const truncWarning = '\n\n[Response was truncated due to output token limits. If you asked for long content, ask to continue or use shorter chunks.]';
          finalText += truncWarning;
          yield { type: 'text', text: truncWarning };
        }

        yield {
          type: 'done',
          response: {
            content: finalText,
            tool_calls: [],
            usage: totalUsage,
            model: responseModel,
            finish_reason: wasLength ? 'length' : 'stop',
          },
        };
        // Add final response to persistent history (only user-facing text)
        primary.addMessage('assistant', finalText);
        return;
      }

      // Tool calls present — execute them
      if (!accumulatedText.trim() && !acknowledgedWork) {
        // Display-only activity narration for a model that called tools
        // silently. It trails a blank line so the answer that follows doesn't
        // run into it, and it stays out of `messages` — the model never said
        // this, and attributing it back to the model would make the next turn
        // reason from words it didn't write.
        const narration = progressAcknowledgement(toolCalls) + '\n\n';
        acknowledgedWork = true;
        yield { type: 'text', text: narration, segmentEnd: true };
        finalText += narration;
      }
      if (accumulatedText.trim()) acknowledgedWork = true;
      finalText += accumulatedText;

      // Add assistant message with tool calls to local messages
      messages.push({
        role: 'assistant',
        content: accumulatedText,
        tool_calls: toolCalls,
      });

      // Execute each tool and add results
      let widened = false;
      for (const tc of toolCalls) {
        const discovery = this.handleDiscoveryCall(tc, decided.exposed, ledger);
        if (discovery) {
          widened ||= discovery.grew;
          messages.push({ role: 'tool', content: discovery.result, tool_call_id: tc.id });
          continue;
        }
        const offList = this.handleOffListCall(tc, decided.exposed, ledger);
        if (offList) widened = true;
        if (offList?.refusal) {
          messages.push({ role: 'tool', content: offList.refusal, tool_call_id: tc.id });
          continue;
        }
        this.noteToolUse(ledger, tc.name);
        const result = await this.executeTool(tc, undefined, turnTaint);
        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        });
        const logStr = typeof result === 'string' ? result.slice(0, 100) : `[${result.length} content blocks]`;
        console.log(`[Orchestrator] Tool ${tc.name} → ${logStr}...`);

        // Inject document markers into the stream so the UI can render download cards
        if (typeof result === 'string') {
          const docMarker = result.match(/<!-- jarvis:document id="[^"]+" title="[^"]+" format="[^"]+" size="[^"]+" -->/);
          if (docMarker) {
            yield { type: 'text' as const, text: '\n' + docMarker[0] + '\n' };
          }
        }
      }

      if (widened) {
        decided = this.decideTurnTools(messages, activeTier, ledger, fallbackTier);
        tools = decided.llm;
      }

      // Continue loop — will stream next LLM response
    }

    // Max iterations reached
    yield { type: 'text', text: '\n[Max tool iterations reached]' };
    yield {
      type: 'done',
      response: {
        content: finalText + '\n[Max tool iterations reached]',
        tool_calls: [],
        usage: totalUsage,
        model: responseModel,
        finish_reason: 'stop',
      },
    };
    primary.addMessage('assistant', finalText);
  }

  /**
   * Heartbeat: let the primary agent check for proactive actions.
   */
  async heartbeat(systemPrompt: string): Promise<string | null> {
    const primary = this.getPrimary();
    if (!primary || !this.llmManager) {
      return null;
    }

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...primary.getMessages(),
    ];

    const llmResponse: LLMResponse = await this.llmManager.chatTier('medium', 'chat_orchestrator_subagent', messages);

    if (llmResponse.content && llmResponse.content.trim().length > 0) {
      primary.addMessage('assistant', llmResponse.content);
      return llmResponse.content;
    }

    return null;
  }

  // --- Private helpers ---

  /**
   * The grow-only exposure ledger for one conversation.
   *
   * Held here rather than derived from the history because neither
   * `processMessage` nor `streamMessage` persists tool calls at all:
   * `AgentInstance.addMessage` takes only user/assistant/system text, so the
   * assistant-with-tool_calls messages and every tool result live in the
   * loop-local buffer and are gone when the turn ends. Reading "tools
   * already used" back out of `getMessages()` would always come up empty,
   * which is #483's mid-task stripping defect exactly. See ledger.ts.
   */
  private ledgerFor(agentId: string): ToolExposureLedger {
    let l = this.exposureLedgers.get(agentId);
    if (!l) {
      l = new ToolExposureLedger();
      this.exposureLedgers.set(agentId, l);
    }
    return l;
  }

  /**
   * Decide the tool list for ONE TURN. Call before the tool loop and hold
   * the result across it; see filter.ts on why this is not per iteration.
   */
  private decideTurnTools(
    messages: readonly LLMMessage[],
    tier: Tier,
    ledger: ToolExposureLedger,
    fallbackTier?: Tier,
  ): { llm: LLMTool[] | undefined; exposed: ReadonlySet<string> } {
    if (!this.toolRegistry || this.toolRegistry.count() === 0) {
      // undefined, not []: the providers treat the two differently.
      return { llm: undefined, exposed: new Set() };
    }
    const all = this.toolRegistry.list();
    const decision = decideTools({
      all,
      messages,
      ledger,
      tier,
      fallbackTier,
      // Guarded: embedded and test callers pass a minimal LLM manager stub,
      // and the filter must never be the thing that breaks a call site. No
      // tier map means no tier resolves, which the gate reads as
      // ineligible -- unfiltered, the correct fallback.
      tiers: (() => {
        const fn = (this.llmManager as Partial<LLMManager> | null)?.getTierMap;
        if (typeof fn !== 'function' || !this.llmManager) return {};
        try { return fn.call(this.llmManager) ?? {}; } catch { return {}; }
      })(),
      providers: this.toolFilterProviders,
    });
    // The escape hatch goes on the wire as DISCOVER_TOOLS_LLM, not through
    // toolDefToLLMTool: the converter drops `items` from an array parameter
    // (ToolParameter has no such field), and Gemini rejects an ARRAY with no
    // element type.
    const llm = decision.tools.map((t) =>
      (t.name === DISCOVER_TOOLS ? DISCOVER_TOOLS_LLM : toolDefToLLMTool(t)));
    return { llm, exposed: decision.exposed };
  }

  /**
   * Intercept `discover_tools` before dispatch.
   *
   * Returns null when this is not a discovery call. Otherwise it handles the
   * call inline -- the tool is synthetic and is never in the registry -- and
   * returns the tool result plus whether the exposed set grew, which tells
   * the loop to recompute its tool list before the next provider call.
   *
   * Two things the `ask_for_clarification` precedent does NOT give us and
   * that are done explicitly here: the emergency-stop check (a halted system
   * must not enumerate its catalogue) and an audit row. `discover_tools`
   * takes model-authored input and durably widens the exposed set.
   */
  private handleDiscoveryCall(
    tc: LLMToolCall,
    exposed: ReadonlySet<string>,
    ledger: ToolExposureLedger,
  ): { result: string; grew: boolean } | null {
    return interceptDiscovery(tc.name, tc.arguments, this.discoveryContext(exposed, ledger));
  }

  /**
   * Intercept a call to a registered tool the model was not offered.
   *
   * Returns null for an ordinary call. Otherwise the call has been admitted
   * into the ledger (and audited), `grew` asks the loop to recompute, and a
   * non-null `refusal` is the tool result to hand back INSTEAD of
   * dispatching: an unframed fetch the offered set was keeping away from
   * hidden framed readers is not run. See `interceptOffList`.
   */
  private handleOffListCall(
    tc: LLMToolCall,
    exposed: ReadonlySet<string>,
    ledger: ToolExposureLedger,
  ): { refusal: string | null; grew: boolean } | null {
    return interceptOffList(tc.name, this.discoveryContext(exposed, ledger));
  }

  /** What both interceptors need: the gate, the emergency check, the audit hook. */
  private discoveryContext(exposed: ReadonlySet<string>, ledger: ToolExposureLedger): DiscoveryContext {
    return {
      all: this.toolRegistry?.list() ?? [],
      ledger,
      exposed,
      filterEnabled: getToolFilterPolicy().enabled,
      haltedState: () =>
        (this.emergencyController && !this.emergencyController.canExecute()
          ? this.emergencyController.getState()
          : null),
      onAdmitted: (admitted, via) => {
        const agent = this.getPrimary();
        try {
          this.auditTrail?.log({
            agent_id: agent?.id ?? 'unknown',
            agent_name: this.auditAgentName(agent?.agent.role.name ?? 'unknown'),
            tool_name: admissionAuditName(admitted, via),
            action_category: 'read_data',
            authority_decision: 'allowed',
            executed: true,
          });
        } catch (err) {
          // An audit failure must not take the turn down, but it must be
          // visible: this row is the only record that the exposed set grew.
          console.warn('[Orchestrator] could not audit a discover_tools admission:',
            err instanceof Error ? err.message : err);
        }
      },
      onRefused: (tool) => {
        const agent = this.getPrimary();
        try {
          this.auditTrail?.log({
            agent_id: agent?.id ?? 'unknown',
            agent_name: this.auditAgentName(agent?.agent.role.name ?? 'unknown'),
            tool_name: tool.name,
            action_category: getActionForTool(tool.name, tool.category),
            authority_decision: 'denied',
            executed: false,
          });
        } catch (err) {
          console.warn('[Orchestrator] could not audit an off-list refusal:',
            err instanceof Error ? err.message : err);
        }
      },
    };
  }

  /**
   * Record a dispatched tool in the conversation's exposure ledger.
   *
   * Two guards, both learned the hard way:
   *   - only REGISTERED names, so a model that emits nonsense tool names
   *     cannot grow an unbounded set of strings that lives as long as the
   *     process;
   *   - nothing at all when the filter is off, so the default posture is a
   *     genuine no-op rather than "inert except for the bookkeeping".
   */
  private noteToolUse(ledger: ToolExposureLedger, name: string): void {
    if (!getToolFilterPolicy().enabled) return;
    if (!this.toolRegistry?.has(name)) return;
    ledger.add(name);
  }

  /**
   * Execute a single tool call via the ToolRegistry.
   * Includes authority gate: checks emergency state, authority level, and governed categories.
   * Returns a string for text-only results, or ContentBlock[] for multi-modal results (images).
   *
   * `signal` (task-tier calls) lets a cancelled task break out of the
   * blocking approval wait instead of holding the dispatch open.
   */
  /**
   * `taint` is required so a tool loop cannot forget its turn set (tsc
   * catches a missed call site); the fallback only guards an untyped caller.
   */
  private async executeTool(toolCall: LLMToolCall, signal: AbortSignal | undefined, taint: Set<string>): Promise<string | ContentBlock[]> {
    // Enter the turn's taint set for the duration of the call so noteTaint,
    // getEffectiveProfile and any sub-agent spawned by the tool see it.
    return this.taintStore.run(taint ?? new Set<string>(), () => this.executeToolInner(toolCall, signal));
  }

  private async executeToolInner(toolCall: LLMToolCall, signal?: AbortSignal): Promise<string | ContentBlock[]> {
    if (!this.toolRegistry) {
      return `Error: No tool registry configured`;
    }

    // --- Authority Gate ---

    // 1. Emergency check
    if (this.emergencyController && !this.emergencyController.canExecute()) {
      const state = this.emergencyController.getState();
      return `[SYSTEM ${state.toUpperCase()}] All tool execution is currently suspended. The user has ${state} the system.`;
    }

    // 1a. Bypass for the intent-gating tool itself.
    // request_approval IS the authority mechanism — gating it would recurse.
    // Its arguments carry the semantic action_category, so auditing happens
    // inside the tool on resolution.
    if (toolCall.name === 'request_approval') {
      try {
        const raw = await this.toolRegistry.execute(toolCall.name, toolCall.arguments);
        if (isToolResult(raw)) return raw.content.map(guardImageSize);
        return typeof raw === 'string' ? raw : JSON.stringify(raw);
      } catch (err) {
        return `Error executing request_approval: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 2. Authority check
    const primary = this.getPrimary();
    if (!this.authorityEngine && !this.warnedNoAuthority) {
      // Every production orchestrator must be wired (see daemon/index.ts).
      // An unwired one executes every tool call ungated and unaudited, which
      // is what the background agent silently did before it got a profile.
      this.warnedNoAuthority = true;
      console.warn(`[Orchestrator] Executing "${toolCall.name}" with NO authority engine wired: tool calls are ungated and unaudited`);
    }
    if (this.authorityEngine && !primary) {
      // Fail closed: a wired gate with nobody to evaluate for must not run the tool.
      return `[AUTHORITY DENIED] Cannot execute ${toolCall.name}: no primary agent is active.`;
    }
    // A name the registry does not hold is not a governance decision. Dispatch
    // would throw "not found in registry" a few lines below anyway, so gating
    // it first only produces a misleading [AUTHORITY DENIED] (which reads to
    // the model as "you lack the authority" rather than "that tool does not
    // exist"), an audit row for a call that cannot happen, and -- since the
    // unmapped default is execute_command, a governed category under the
    // background and taint profiles -- a real approval card for an invented
    // tool. A model steered by injected page text can emit those at will.
    if (!this.toolRegistry.has(toolCall.name)) {
      // Point at discover_tools only when it is answered. With the filter
      // off it is neither offered nor intercepted, so the hint sent the
      // model round a loop: call it, be told it does not exist, be told to
      // call it.
      return getToolFilterPolicy().enabled
        ? `Error: no tool named "${toolCall.name}" is available. Call discover_tools to see what is.`
        : `Error: no tool named "${toolCall.name}" is available.`;
    }

    if (this.authorityEngine && primary) {
      const tool = this.toolRegistry.get(toolCall.name);
      // What this call reaches: the tool's static category, raised by its
      // own per-call gate when it has one (run_skill classifies the stored
      // steps it is about to replay).
      const gate = resolveToolGate(tool, toolCall.name, toolCall.arguments);
      const check = (category: ActionCategory): AuthorityDecision => this.authorityEngine!.checkAuthority({
        agentId: primary.id,
        agentAuthorityLevel: primary.agent.authority.max_authority_level,
        agentRoleId: primary.agent.role.id,
        toolName: toolCall.name,
        toolCategory: tool?.category ?? 'unknown',
        actionCategory: category,
        temporaryGrants: this.temporaryGrants,
        profile: this.getEffectiveProfile(),
      });

      // The call must clear every category it reaches (a skill that clicks
      // and sends a message is checked as control_app AND send_message).
      let decision = combineDecisions(gate.categories.map(check));

      // A gated call (above_level or mandatory review) whose worst case is above the agent's level turns into
      // an approval instead of a denial, provided the agent clears the
      // tool's floor on its own: the same substitution request_approval
      // makes for a declared intent. Only a pure level shortfall qualifies;
      // an override, a context rule or a profile cap that denies still
      // denies.
      if (gate.confirm && !decision.allowed && decision.deniedByLevel && decision.actionCategory !== gate.floorCategory) {
        const floor = check(gate.floorCategory);
        if (floor.allowed) {
          decision = {
            ...floor,
            allowed: true,
            requiresApproval: true,
            actionCategory: decision.actionCategory,
            // Carry the floor's profile label through. deferred-executor
            // keeps taint-gated approvals out of the approval learner by
            // looking for TAINT_PROFILE_LABEL in `reason`; rewriting `reason`
            // from scratch silently exempted every substituted approval from
            // that exclusion, so routine approvals here could train a
            // suggestion to auto-allow the whole category -- globally, for
            // every tool, and evaluated before the level check.
            //
            // The label goes INSIDE the sentence, not appended after it:
            // formatApprovalIntent decides whether the engine wrote this
            // reason, and one of its two tests is
            // `endsWith('requires user approval')`. For the TAINT label
            // specifically its other test (`includes(TAINT_PROFILE_LABEL)`)
            // would still match a trailing parenthetical -- but the
            // background profile's label has no such second test, so
            // appending would make its card lead with this sentence instead
            // of the one naming the actual effect.
            reason: `${decision.actionCategory} ${ABOVE_LEVEL_SUBSTITUTION}`
              + `${floor.profileLabel ? ` (${floor.profileLabel})` : ''}`
              + ` and requires user approval`,
          };
        }
      }

      // A call that must be confirmed by the person is never auto-allowed,
      // whatever the level, the overrides or the learned approvals say.
      if (gate.confirm === 'always' && decision.allowed && !decision.requiresApproval) {
        decision = { ...decision, requiresApproval: true, reason: `${toolCall.name} requires user approval` };
      }

      // The category the decision was made on: the worst case when allowed,
      // the one that denied or asked for approval otherwise. The audit row
      // and the card carry it.
      const actionCategory = decision.actionCategory;

      // Determine decision type for audit
      const decisionType = decision.allowed
        ? (decision.requiresApproval ? 'approval_required' as const : 'allowed' as const)
        : 'denied' as const;

      // 3. Log to audit trail
      this.auditTrail?.log({
        agent_id: primary.id,
        agent_name: this.auditAgentName(primary.agent.role.name),
        tool_name: toolCall.name,
        action_category: actionCategory,
        authority_decision: decisionType,
        approval_id: null,
        executed: decision.allowed && !decision.requiresApproval,
        execution_time_ms: null,
      });

      // 4. Denied
      if (!decision.allowed) {
        return `[AUTHORITY DENIED] Cannot execute ${toolCall.name}: ${decision.reason}. Your authority level is insufficient for ${actionCategory} actions.`;
      }

      // 5. Requires approval
      if (decision.requiresApproval && this.approvalManager) {
        const urgency = this.determineUrgency(actionCategory);
        // Inline mode: block here until the user decides, then execute the
        // tool ourselves so the result returns through the task loop (and
        // from there to the conversation tier), instead of being executed
        // detached on approval and broadcast as a raw notification.
        // Deferred mode is the fallback when no executor is wired.
        const inline = this.deferredExecutor !== null;
        const request = this.approvalManager.createRequest({
          agentId: primary.id,
          agentName: this.auditAgentName(primary.agent.role.name),
          toolName: toolCall.name,
          toolArguments: toolCall.arguments,
          actionCategory,
          urgency,
          reason: decision.reason,
          context: gateContext(gate, toolCall.name, toolCall.arguments),
          executionMode: inline ? 'inline' : 'deferred',
          toolRegistry: this.toolRegistry,
        });

        // Emit approval request event
        this.onApprovalNeeded?.(request);

        if (!inline) {
          return `[AWAITING_APPROVAL] Request #${request.id.slice(0, 8)} submitted. ` +
                 `Action: ${toolCall.name} (${actionCategory}). ` +
                 `Reason: ${decision.reason}. ` +
                 `The user will be notified and can approve or deny this action.`;
        }

        const resolved = await this.approvalManager.waitForResolution(request.id, {
          timeoutMs: APPROVAL_WAIT_TIMEOUT_MS,
          signal,
        });

        // Approved results are still outside content when the tool reads it.
        const frame = (text: string): string => {
          this.noteTaint(toolCall.name, tool?.category);
          return markUntrustedToolResult(toolCall.name, tool?.category, text);
        };

        switch (resolved.status) {
          case 'approved':
            // The approve endpoints skip execution for inline requests; we
            // are the single executor. executeApproved handles markExecuted,
            // audit, and approval learning.
            return frame(await this.deferredExecutor!.executeApproved(request.id, 'inline-gate'));
          case 'executed':
            // Another path already ran it (shouldn't happen for inline
            // requests; tolerated for robustness). Surface its result.
            return frame(resolved.execution_result ?? `[EXECUTED] ${toolCall.name} completed.`);
          case 'denied':
            return `[APPROVAL DENIED] The user denied permission to execute ${toolCall.name}. ` +
                   `Do not retry the action. Briefly tell the user it was not performed.`;
          case 'expired':
            return `[APPROVAL EXPIRED] The approval request for ${toolCall.name} expired before the user decided. ` +
                   `Ask the user whether they still want this done.`;
          case 'pending':
          default: {
            // Timed out waiting (or the task was cancelled mid-wait). Hand
            // the request to the deferred path so a late click still
            // executes it. demoteToDeferred only succeeds while the request
            // is still pending, so it cannot race an approve into a double
            // execution: if the user approved in the meantime, the demotion
            // fails and we execute inline after all.
            if (!this.approvalManager.demoteToDeferred(request.id)) {
              const recheck = this.approvalManager.getRequest(request.id);
              if (recheck?.status === 'approved') {
                return frame(await this.deferredExecutor!.executeApproved(request.id, 'inline-gate'));
              }
              if (recheck?.status === 'executed') {
                return frame(recheck.execution_result ?? `[EXECUTED] ${toolCall.name} completed.`);
              }
              if (recheck?.status === 'denied') {
                return `[APPROVAL DENIED] The user denied permission to execute ${toolCall.name}. ` +
                       `Do not retry the action. Briefly tell the user it was not performed.`;
              }
            }
            return `[AWAITING_APPROVAL] Request #${request.id.slice(0, 8)} submitted. ` +
                   `Action: ${toolCall.name} (${actionCategory}). ` +
                   `Reason: ${decision.reason}. ` +
                   `The user has not responded yet. They can still approve or deny it later; ` +
                   `if approved later, it will be executed and the user will be notified.`;
          }
        }
      } else if (decision.requiresApproval) {
        // Fail closed. A gate that asks for approval with nobody to ask must
        // not fall through to execution.
        this.auditTrail?.log({
          agent_id: primary.id,
          agent_name: this.auditAgentName(primary.agent.role.name),
          tool_name: toolCall.name,
          action_category: actionCategory,
          authority_decision: 'approval_required',
          approval_id: null,
          executed: false,
          execution_time_ms: null,
        });
        return `[APPROVAL UNAVAILABLE] ${toolCall.name} (${actionCategory}) requires user approval but no approval channel is configured. ` +
               `The action was not performed; tell the user what you wanted to do.`;
      }
    }

    // --- Normal execution ---
    try {
      const startTime = Date.now();
      const raw = await this.toolRegistry.execute(toolCall.name, toolCall.arguments);
      const executionTimeMs = Date.now() - startTime;

      // Update audit entry with execution time (for allowed actions)
      // We already logged above; for simplicity we log execution separately if needed

      const category = this.toolRegistry.get(toolCall.name)?.category;
      // From here on this turn has read outside content (if the tool does).
      this.noteTaint(toolCall.name, category);

      // Multi-modal result (e.g. screenshot with image data)
      if (isToolResult(raw)) {
        return markUntrustedToolBlocks(toolCall.name, category, raw.content.map(guardImageSize));
      }

      // Plain text result
      let result = typeof raw === 'string' ? raw : JSON.stringify(raw);

      // Cap tool result size to control context growth
      if (result.length > MAX_TOOL_RESULT_CHARS) {
        result = result.slice(0, MAX_TOOL_RESULT_CHARS) + `\n... (truncated, was ${result.length} chars)`;
      }

      // Outside content (pages, screen text, clipboard, files) is framed as data.
      return markUntrustedToolResult(toolCall.name, category, result);
    } catch (err) {
      // A typed failure carries the same text the tool used to RETURN, so it
      // gets the same treatment: an offline sidecar's message is harmless, a
      // remote handler's rejection is content from the other trust domain.
      if (err instanceof ActionOutcomeError) {
        const category = this.toolRegistry.get(toolCall.name)?.category;
        this.noteTaint(toolCall.name, category);
        return markUntrustedToolFailure(toolCall.name, category, err.message, MAX_TOOL_RESULT_CHARS);
      }
      return `Error executing ${toolCall.name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Execute a tool call originating from a premium realtime (gpt-realtime-2)
   * voice session. Mirrors `executeTool`'s authority gate BUT auto-approves:
   * a `requiresApproval` decision is treated as granted so the audio loop is
   * never blocked (decision #2, see docs/GPT_REALTIME_2_INTEGRATION.md §4 Phase 3).
   *
   * Still enforced: emergency state, explicit hard denies, and the
   * user-configured `blockedCategories` backstop. Every call is written to the
   * audit trail tagged `channel:'voice'`; an auto-approved call is recorded as
   * `approval_required` + `executed:true` so the trail shows no human confirmed it.
   *
   * Always returns a string (the tool result or an error/denial marker) — the
   * realtime session feeds this straight back to the model as function output.
   */
  async executeRealtimeToolCall(
    name: string,
    args: Record<string, unknown>,
    opts: { blockedCategories?: string[] } = {},
  ): Promise<string> {
    // A realtime voice session is the person talking (src/llm/origin.ts).
    return runWithOrigin('user', () => this.executeRealtimeToolCallInner(name, args, opts));
  }

  private async executeRealtimeToolCallInner(
    name: string,
    args: Record<string, unknown>,
    opts: { blockedCategories?: string[] },
  ): Promise<string> {
    if (!this.toolRegistry) return 'Error: No tool registry configured';

    // 1. Emergency check (same as text path).
    if (this.emergencyController && !this.emergencyController.canExecute()) {
      const state = this.emergencyController.getState();
      return `[SYSTEM ${state.toUpperCase()}] Tool execution is currently suspended.`;
    }

    // Same reason as the task path: an unknown name is not a governance
    // decision, and on an open mic it must not become a blocked-category
    // announcement about a tool that does not exist.
    if (!this.toolRegistry.has(name)) {
      return `Error: no tool named "${name}" is available.`;
    }

    const primary = this.getPrimary();
    const tool = this.toolRegistry.get(name);
    const gate = resolveToolGate(tool, name, args);
    const actionCategory = gate.actionCategory;

    const logAudit = (decision: 'allowed' | 'denied' | 'approval_required', executed: boolean) => {
      if (!primary) return;
      this.auditTrail?.log({
        agent_id: primary.id,
        agent_name: primary.agent.role.name,
        tool_name: name,
        action_category: actionCategory,
        authority_decision: decision,
        approval_id: null,
        executed,
        channel: 'voice',
      });
    };

    // 2. User backstop: categories that stay blocked even under auto-approve.
    const blocked = gate.categories.find((c) => opts.blockedCategories?.includes(c));
    if (blocked) {
      logAudit('denied', false);
      return `[BLOCKED] ${name} (${blocked}) is in the realtime blocked-categories list and was not executed.`;
    }

    // 2b. A call the person must confirm on a card cannot be auto-approved by
    // a voice session. Refuse, and let the model say so.
    if (gate.confirm === 'always') {
      logAudit('denied', false);
      return `[BLOCKED] ${name} needs the user's confirmation in the dashboard and cannot be started from a voice session. Tell the user what you wanted to do and ask them to confirm it there.`;
    }

    // 3. Authority check — hard denies enforced; approval auto-granted.
    if (this.authorityEngine && primary) {
      const decision = combineDecisions(gate.categories.map((category) => this.authorityEngine!.checkAuthority({
        agentId: primary.id,
        agentAuthorityLevel: primary.agent.authority.max_authority_level,
        agentRoleId: primary.agent.role.id,
        toolName: name,
        toolCategory: tool?.category ?? 'unknown',
        actionCategory: category,
        temporaryGrants: this.temporaryGrants,
        profile: this.getEffectiveProfile(),
      })));

      if (!decision.allowed) {
        logAudit('denied', false);
        return `[AUTHORITY DENIED] Cannot execute ${name}: ${decision.reason}.`;
      }

      // Taint-gated approvals cannot be auto-approved: the whole point is
      // that content the session read must not turn into an action without
      // the user. Refuse, and let the model say so out loud.
      if (decision.requiresApproval && decision.profileLabel?.includes(TAINT_PROFILE_LABEL)) {
        logAudit('denied', false);
        return `[BLOCKED] ${name} (${actionCategory}) was not run: this session read outside content (${[...this.realtimeTaint].join(', ')}) and voice cannot approve it. ` +
               `Tell the user what you wanted to do and ask them to say it again as a fresh request.`;
      }

      // Other requiresApproval -> auto-approved in realtime; audited as such.
      logAudit(decision.requiresApproval ? 'approval_required' : 'allowed', true);
    }

    // 4. Execute.
    try {
      const raw = await this.toolRegistry.execute(name, args);
      const category = tool?.category;
      this.noteTaint(name, category);
      if (isToolResult(raw)) {
        // Realtime function output is text; flatten non-text blocks to a tag.
        const flat = raw.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
        return markUntrustedToolResult(name, category, flat);
      }
      let result = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (result.length > MAX_TOOL_RESULT_CHARS) {
        result = result.slice(0, MAX_TOOL_RESULT_CHARS) + `\n... (truncated, was ${result.length} chars)`;
      }
      return markUntrustedToolResult(name, category, result);
    } catch (err) {
      if (err instanceof ActionOutcomeError) {
        this.noteTaint(name, tool?.category);
        return markUntrustedToolFailure(name, tool?.category, err.message, MAX_TOOL_RESULT_CHARS);
      }
      return `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Determine urgency for an approval request based on action category.
   */
  private determineUrgency(actionCategory: ActionCategory): 'urgent' | 'normal' {
    // Financial actions are always urgent
    if (actionCategory === 'make_payment') return 'urgent';
    return 'normal';
  }
}
