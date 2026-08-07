/**
 * Sub-Agent Runner — Generic LLM+Tool Loop
 *
 * Runs any AgentInstance through the LLM+tool execution loop.
 * Mirrors orchestrator.processMessage() but parameterized on agent
 * instead of hardcoded to primary. Supports progress callbacks for
 * real-time streaming to clients.
 */

import type { AgentInstance } from './agent.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { LLMMessage, LLMResponse, LLMToolCall, LLMTool } from '../llm/provider.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { toolDefToLLMTool, BUILTIN_TOOLS } from '../actions/tools/builtin.ts';
import type { ActionCategory, Impact } from '../roles/authority.ts';
import { impactFromCategory } from '../roles/authority.ts';
import type { AuthorityEngine } from '../authority/engine.ts';
import type { AuditTrail } from '../authority/audit.ts';
import type { EmergencyController } from '../authority/emergency.ts';
import { getActionForTool } from '../authority/tool-action-map.ts';

const MAX_TOOL_ITERATIONS = 100; // Lower than primary's 200 — sub-agents should be focused
const MAX_TOOL_RESULT_CHARS = 6000;

/**
 * Ordering over `Impact` so a run can declare a ceiling ("nothing above
 * write") without enumerating every category. Kept here rather than in
 * roles/authority.ts because it is a policy ordering, not a fact about the
 * categories.
 */
const IMPACT_RANK: Record<Impact, number> = {
  read: 0,
  write: 1,
  external: 2,
  destructive: 3,
};

/** True when `impact` is above the ceiling and must therefore be refused. */
export function exceedsImpactCeiling(impact: Impact, ceiling: Impact): boolean {
  return IMPACT_RANK[impact] > IMPACT_RANK[ceiling];
}

/**
 * Why the loop ended. `completed` is the happy path (LLM stopped requesting
 * tools). `max_iterations` means we exhausted the iteration cap with the
 * model still asking for tools -- callers should treat the answer as
 * partial. `error` is set when an exception escaped the loop. Surfacing
 * this lets workflow callers (jarvis-agent.delegate) map directly to the
 * piece's `{completed | max_iterations | error}` status field instead of
 * inferring from `success` + `response`.
 *
 * P0.4 adds three bounded-resource endings, all of them partial answers:
 *   `cancelled`      -- the caller aborted (AgentTaskManager.cancel, shutdown)
 *   `timeout`        -- the per-task wall-clock budget elapsed
 *   `token_budget`   -- the agent's max_token_budget was reached
 */
export type SubAgentTerminationReason =
  | 'completed'
  | 'max_iterations'
  | 'error'
  | 'cancelled'
  | 'timeout'
  | 'token_budget';

export type SubAgentResult = {
  success: boolean;
  response: string;
  toolsUsed: string[];
  tokensUsed: { input: number; output: number };
  terminationReason: SubAgentTerminationReason;
  /**
   * Full message log of the sub-agent's run -- system prompt, the user task,
   * every intermediate `assistant` message (with `tool_calls` when the LLM
   * requested any), every `tool` result message, and the final assistant
   * answer. Callers that need a tool-call trace (the workflow piece's
   * `jarvis-agent.delegate`) walk this array instead of `agent.getMessages()`,
   * which only sees the simple user/assistant turns. Returned even on error.
   */
  messages: LLMMessage[];
};

/**
 * The authority components a caller must forward for a sub-agent run to be
 * gated + audited. Bundled as one type so a new caller can't quietly forward
 * three of the four -- the failure mode P0.1 exists to fix.
 */
export type SubAgentAuthorityContext = {
  authorityEngine?: AuthorityEngine;
  auditTrail?: AuditTrail;
  emergencyController?: EmergencyController;
  temporaryGrants: Map<string, ActionCategory[]>;
};

export type ProgressCallback = (event: {
  type: 'text' | 'tool_call' | 'done';
  agentName: string;
  agentId: string;
  data: unknown;
}) => void;

export type RunSubAgentOptions = {
  agent: AgentInstance;
  task: string;
  context: string;
  llmManager: LLMManager;
  toolRegistry: ToolRegistry;
  onProgress?: ProgressCallback;
  maxIterations?: number;
  // Authority engine components (optional — if not provided, no gate applied)
  authorityEngine?: AuthorityEngine;
  auditTrail?: AuditTrail;
  emergencyController?: EmergencyController;
  temporaryGrants?: Map<string, ActionCategory[]>;
  /**
   * P0.1 — hard ceiling on the impact class this run may execute, checked
   * BEFORE (and independently of) the authority engine. A run with
   * `impactCeiling: 'write'` can never send email, browse, delete, pay or
   * shell out, no matter what the numeric authority level or the engine's
   * overrides say.
   *
   * This exists because the numeric level and the engine's per-action
   * overrides are configured for what the USER may do through an agent. A
   * non-user-initiated agent needs a second, narrower bound that no config
   * knob can widen. Omitted = no ceiling (engine decides alone), which is
   * the pre-existing behaviour for user-initiated runs.
   */
  impactCeiling?: Impact;
  /**
   * P0.4 — cooperative cancellation. Checked before each LLM call and
   * before each tool execution, so a cancelled run stops at the next
   * boundary rather than mid-tool. In-flight LLM calls are not aborted;
   * the loop exits once they return.
   */
  signal?: AbortSignal;
  /**
   * P0.4 — total (input + output) token ceiling for this run. When the
   * running total reaches it, the loop stops and returns whatever text the
   * agent has produced with `terminationReason: 'token_budget'`. Defaults
   * to the agent's own `authority.max_token_budget`, which until now was
   * stored, halved on every spawn, and never read by anything.
   */
  tokenBudget?: number;
};

/**
 * Build a system prompt for a sub-agent from its role definition.
 */
/**
 * Sub-agent system prompt, split at the prompt-cache boundary. The static
 * half depends only on the role, so across a sub-agent's loop iterations
 * (and across runs of the same role within the cache TTL) the provider can
 * serve tools + static prompt from cache. The per-task `context` rides on
 * the dynamic half.
 */
function buildSubAgentPromptParts(agent: AgentInstance, context: string): { static: string; dynamic: string } {
  const role = agent.agent.role;

  const staticParts = [
    `You are ${role.name}.`,
    '',
    role.description,
    '',
    '## Your Responsibilities',
    ...role.responsibilities.map(r => `- ${r}`),
    '',
    '## Rules',
    '- Focus on completing the specific task assigned to you.',
    '- Use your tools to accomplish the task — don\'t just describe what you would do.',
    '- Be thorough but efficient. Don\'t do unnecessary work.',
    '- Return a clear, structured result when done.',
  ];

  return {
    static: staticParts.join('\n'),
    dynamic: context ? ['## Context', context].join('\n') : '',
  };
}

/**
 * Get LLM-formatted tools from a scoped ToolRegistry.
 */
function getLLMTools(registry: ToolRegistry): LLMTool[] | undefined {
  if (registry.count() === 0) return undefined;
  return registry.list().map(toolDefToLLMTool);
}

/**
 * Execute a single tool call via a ToolRegistry.
 * Includes optional authority gate for sub-agents.
 */
async function executeTool(
  registry: ToolRegistry,
  toolCall: LLMToolCall,
  agent: AgentInstance,
  impactCeiling: Impact | undefined,
  authorityCtx?: {
    agent: AgentInstance;
    engine: AuthorityEngine;
    auditTrail?: AuditTrail;
    emergencyController?: EmergencyController;
    temporaryGrants?: Map<string, ActionCategory[]>;
  }
): Promise<string> {
  // Impact ceiling (P0.1). Runs first and independently of the authority
  // engine so the bound holds even where no engine is wired (embedded use,
  // tests) — "no engine" must not mean "no limit" for a capped run.
  if (impactCeiling) {
    const tool = registry.get(toolCall.name);
    const actionCategory = getActionForTool(toolCall.name, tool?.category ?? 'unknown');
    const impact = impactFromCategory(actionCategory);
    if (exceedsImpactCeiling(impact, impactCeiling)) {
      authorityCtx?.auditTrail?.log({
        agent_id: agent.id,
        agent_name: agent.agent.role.name,
        tool_name: toolCall.name,
        action_category: actionCategory,
        authority_decision: 'denied',
        executed: false,
      });
      return (
        `[AUTHORITY DENIED] ${toolCall.name}: this agent run is capped at "${impactCeiling}" impact ` +
        `and ${actionCategory} is "${impact}". This task was not initiated by the user, so it cannot ` +
        `take actions that reach outside the machine or are hard to undo. Report what you found and ` +
        `what you would have done instead.`
      );
    }
  }

  // Authority gate (if engine provided)
  if (authorityCtx) {
    const { agent, engine, auditTrail, emergencyController, temporaryGrants } = authorityCtx;

    // Emergency check
    if (emergencyController && !emergencyController.canExecute()) {
      return `[SYSTEM ${emergencyController.getState().toUpperCase()}] Tool execution suspended.`;
    }

    const tool = registry.get(toolCall.name);
    const actionCategory = getActionForTool(toolCall.name, tool?.category ?? 'unknown');

    const decision = engine.checkAuthority({
      agentId: agent.id,
      agentAuthorityLevel: agent.agent.authority.max_authority_level,
      agentRoleId: agent.agent.role.id,
      toolName: toolCall.name,
      toolCategory: tool?.category ?? 'unknown',
      actionCategory,
      temporaryGrants: temporaryGrants ?? new Map(),
      // P0.5 — lets a research-analyst actually browse without raising its
      // authority level (which would also unlock execute_command).
      scopedGrants: agent.agent.authority.scoped_grants,
    });

    auditTrail?.log({
      agent_id: agent.id,
      agent_name: agent.agent.role.name,
      tool_name: toolCall.name,
      action_category: actionCategory,
      authority_decision: decision.allowed ? 'allowed' : 'denied',
      executed: decision.allowed,
    });

    if (!decision.allowed) {
      return `[AUTHORITY DENIED] ${toolCall.name}: ${decision.reason}`;
    }

    // Sub-agents don't get approval flow — they're denied outright for governed actions
    if (decision.requiresApproval) {
      return `[AUTHORITY DENIED] ${toolCall.name} requires user approval. Sub-agents cannot request approvals directly.`;
    }
  }

  try {
    const raw = await registry.execute(toolCall.name, toolCall.arguments);
    let result: string = typeof raw === 'string' ? raw : JSON.stringify(raw);

    if (result.length > MAX_TOOL_RESULT_CHARS) {
      result = result.slice(0, MAX_TOOL_RESULT_CHARS) + `\n... (truncated, was ${result.length} chars)`;
    }

    return result;
  } catch (err) {
    return `Error executing ${toolCall.name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Run a sub-agent through the full LLM+tool execution loop.
 *
 * This is the core engine that powers sub-agent execution.
 * It works exactly like the primary agent's processMessage() loop
 * but operates on any AgentInstance with its own scoped tools.
 */
export async function runSubAgent(opts: RunSubAgentOptions): Promise<SubAgentResult> {
  const {
    agent,
    task,
    context,
    llmManager,
    toolRegistry,
    onProgress,
    maxIterations = MAX_TOOL_ITERATIONS,
    authorityEngine,
    auditTrail,
    emergencyController,
    temporaryGrants,
    impactCeiling,
    signal,
  } = opts;

  // Build authority context if engine provided
  const authorityCtx = authorityEngine ? {
    agent,
    engine: authorityEngine,
    auditTrail,
    emergencyController,
    temporaryGrants,
  } : undefined;

  // P0.4 — `max_token_budget` has been carried on every agent (and halved on
  // every spawn) since the hierarchy was written, and nothing has ever read
  // it. A budget of 0 or less is treated as "unbounded" so an explicit opt-out
  // is still possible; the shipped default is 100_000, halved per generation.
  const configuredBudget = opts.tokenBudget ?? agent.agent.authority.max_token_budget;
  const tokenBudget = configuredBudget > 0 ? configuredBudget : Infinity;

  const agentName = agent.agent.role.name;
  const agentId = agent.id;
  const toolsUsed: string[] = [];
  const totalUsage = { input: 0, output: 0 };

  // Set the task on the agent
  agent.setTask(task);
  agent.activate();

  // Build system prompt (static half cache-marked, per-task context dynamic)
  const systemPrompt = buildSubAgentPromptParts(agent, context);

  // Add the task as a user message
  agent.addMessage('user', task);

  // Build messages array
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt.static, cache: true },
    ...(systemPrompt.dynamic ? [{ role: 'system', content: systemPrompt.dynamic } satisfies LLMMessage] : []),
    ...agent.getMessages(),
  ];

  const tools = getLLMTools(toolRegistry);
  let finalText = '';
  let reachedFinal = false;
  // Set when a bounded resource ran out. Wins over the iteration-count
  // reasons because it says something more specific about why we stopped.
  let stoppedBy: 'cancelled' | 'timeout' | 'token_budget' | null = null;

  /** Reason the abort signal fired, mapped to a termination reason. */
  const abortReason = (): 'cancelled' | 'timeout' =>
    (signal?.reason as { name?: string } | undefined)?.name === 'TimeoutError' ? 'timeout' : 'cancelled';

  try {
    // Tool execution loop
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (signal?.aborted) {
        stoppedBy = abortReason();
        break;
      }
      if (totalUsage.input + totalUsage.output >= tokenBudget) {
        console.warn(
          `[SubAgent:${agent.agent.role.name}] token budget exhausted ` +
          `(${totalUsage.input + totalUsage.output}/${tokenBudget}) — stopping`,
        );
        stoppedBy = 'token_budget';
        break;
      }

      const llmResponse: LLMResponse = await llmManager.chatTier('medium', 'sub_agent', messages, { tools });

      totalUsage.input += llmResponse.usage.input_tokens;
      totalUsage.output += llmResponse.usage.output_tokens;

      if (llmResponse.finish_reason === 'tool_use' && llmResponse.tool_calls.length > 0) {
        // Add assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: llmResponse.content,
          tool_calls: llmResponse.tool_calls,
        });

        // Notify about text if any
        if (llmResponse.content && onProgress) {
          onProgress({ type: 'text', agentName, agentId, data: llmResponse.content });
        }

        // Execute each tool
        for (const tc of llmResponse.tool_calls) {
          toolsUsed.push(tc.name);

          // Cancellation lands between tool calls, never mid-tool: a
          // half-executed side effect is worse than a slightly late stop.
          // The remaining calls in this batch get a result message anyway so
          // the message log stays well-formed for the trace extractor.
          if (signal?.aborted) {
            stoppedBy = abortReason();
            messages.push({
              role: 'tool',
              content: `[CANCELLED] ${tc.name} was not executed — the task was ${stoppedBy === 'timeout' ? 'timed out' : 'cancelled'}.`,
              tool_call_id: tc.id,
            });
            continue;
          }

          // Notify about tool call
          if (onProgress) {
            onProgress({
              type: 'tool_call',
              agentName,
              agentId,
              data: { name: tc.name, arguments: tc.arguments },
            });
          }

          const result = await executeTool(toolRegistry, tc, agent, impactCeiling, authorityCtx);
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id,
          });

          console.log(`[SubAgent:${agentName}] Tool ${tc.name} -> ${result.slice(0, 100)}...`);
        }

        if (stoppedBy) break;
        continue;
      }

      // No tool calls — this is the final response
      finalText = llmResponse.content;
      reachedFinal = true;

      if (onProgress) {
        onProgress({ type: 'text', agentName, agentId, data: finalText });
        onProgress({ type: 'done', agentName, agentId, data: { tokensUsed: totalUsage } });
      }

      break;
    }

    // A run stopped by a bounded resource has no final answer. Say so in the
    // response text rather than returning an empty string that reads like a
    // silent success to every caller downstream.
    if (stoppedBy && !reachedFinal) {
      finalText = {
        cancelled: 'Task cancelled before the agent finished. Partial work only.',
        timeout: 'Task stopped at its wall-clock timeout before the agent finished. Partial work only.',
        token_budget: 'Task stopped at its token budget before the agent finished. Partial work only.',
      }[stoppedBy];
    }

    // Add final response to agent's history
    agent.addMessage('assistant', finalText);

    return {
      // `cancelled` / `timeout` / `token_budget` are not errors, but they are
      // not successes either -- the goal wasn't reached. Callers that branch
      // on `success` (the sub-pebble rail, the workflow delegator) must not
      // render a truncated run as a completed one.
      success: !stoppedBy,
      response: finalText,
      toolsUsed: [...new Set(toolsUsed)],
      tokensUsed: totalUsage,
      terminationReason: stoppedBy ?? (reachedFinal ? 'completed' : 'max_iterations'),
      messages,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[SubAgent:${agentName}] Error:`, errorMsg);

    return {
      success: false,
      response: `Sub-agent error: ${errorMsg}`,
      toolsUsed: [...new Set(toolsUsed)],
      tokensUsed: totalUsage,
      terminationReason: 'error',
      messages,
    };
  } finally {
    agent.idle();
  }
}

/**
 * Create a scoped ToolRegistry for a sub-agent.
 * Only includes builtin tools whose category is in the allowed list.
 */
export function createScopedToolRegistry(allowedCategories: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) {
    if (allowedCategories.includes(tool.category)) {
      registry.register(tool);
    }
  }
  return registry;
}
