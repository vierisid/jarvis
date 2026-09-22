/**
 * Sub-Agent Runner — Generic LLM+Tool Loop
 *
 * Runs any AgentInstance through the LLM+tool execution loop.
 * Mirrors orchestrator.processMessage() but parameterized on agent
 * instead of hardcoded to primary. Supports progress callbacks for
 * real-time streaming to clients.
 *
 * A tool call the gate says needs approval has two honest answers. Without a
 * governed dispatch there is nobody to hold the approval, so the call is
 * denied and audited as needing approval. With one, the dispatch decides:
 * it can run the tool under an approval it already holds, report a denial
 * or a failure, or pause. A pause ends this run before any effect, and the
 * caller keeps the message log so a later run can resume exactly where it
 * stopped. A caller can also checkpoint after every completed turn and
 * resume from there when nothing was pending.
 */

import type { AgentInstance } from './agent.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { LLMMessage, LLMResponse, LLMToolCall, LLMTool } from '../llm/provider.ts';
import { ToolRegistry, type ToolDefinition } from '../actions/tools/registry.ts';
import { checkpointExecution } from '../actions/execution-scope.ts';
import type { TierMap } from '../llm/tiers.ts';
import { decideTools } from '../actions/tools/tool-relevance/filter.ts';
import { DISCOVER_TOOLS, ToolExposureLedger } from '../actions/tools/tool-relevance/ledger.ts';
import { interceptDiscovery, DISCOVER_TOOLS_LLM } from '../actions/tools/tool-relevance/discover.ts';
import { getToolFilterPolicy } from '../actions/tools/tool-relevance/policy.ts';
import { toolDefToLLMTool, BUILTIN_TOOLS } from '../actions/tools/builtin.ts';
import type { ActionCategory } from '../roles/authority.ts';
import type { AuthorityEngine, AuthorityProfile } from '../authority/engine.ts';
import type { AuditTrail } from '../authority/audit.ts';
import type { EmergencyController } from '../authority/emergency.ts';
import { resolveToolGate } from '../authority/tool-action-map.ts';
import { combineDecisions } from '../authority/engine.ts';
import { markUntrustedToolResult, markUntrustedToolFailure, isTaintSourceTool } from '../roles/untrusted.ts';
import { ActionOutcomeError } from '../actions/action-outcome.ts';
import { mergeProfiles, taintProfile, type TaintGating } from '../authority/taint-gating.ts';

const MAX_TOOL_ITERATIONS = 100; // Lower than primary's 200 — sub-agents should be focused
const MAX_TOOL_RESULT_CHARS = 6000;

/**
 * Why the loop ended. `completed` is the happy path (LLM stopped requesting
 * tools). `max_iterations` means we exhausted the iteration cap with the
 * model still asking for tools -- callers should treat the answer as
 * partial. `error` is set when an exception escaped the loop. `paused`
 * means a governed tool call is waiting on an approval; nothing ran for it
 * and `paused` on the result says what is waiting. Surfacing this lets
 * workflow callers (jarvis-agent.delegate) map directly to the piece's
 * status field instead of inferring from `success` + `response`.
 */
export type SubAgentTerminationReason = 'completed' | 'max_iterations' | 'error' | 'paused';

/** A durable approval the caller will wait on before the paused tool can run. */
export type SubAgentApprovalRef = { effectId: string; approvalId: string; waitpointId: string };

/** The identity the gate judged a call with; the dispatch judges it with the same one. */
export type SubAgentPrincipal = {
  agentId: string;
  agentRoleId: string;
  agentAuthorityLevel: number;
  /** The parent's restrictions merged with this run's taint at the time of the call. */
  profile: AuthorityProfile | null;
};

export type GovernedToolCall = {
  toolCall: LLMToolCall;
  /** Position of this call in the whole run, first call is 1; stable across a resume. */
  sequence: number;
  actionCategory: ActionCategory;
  toolCategory: string;
  principal: SubAgentPrincipal;
  /** Why the gate required approval. */
  reason: string;
};

export type GovernedToolResult =
  | { kind: 'executed'; result: string }
  /** The dispatch ran the tool, or found its record, and it failed. */
  | { kind: 'failed'; result: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'paused'; approval: SubAgentApprovalRef };

/**
 * Dispatch for a tool call the gate says needs approval. It owns the
 * approval: it may run the tool under one it already holds, report that the
 * user declined or that the run failed, or pause the run at a durable
 * waitpoint. It is asked again for the same call on resume and must then
 * answer from what was decided.
 */
export type GovernedToolDispatch = (call: GovernedToolCall) => Promise<GovernedToolResult>;

/** An error the dispatch raised, as opposed to the model or the loop. */
export class GovernedDispatchError extends Error {
  override readonly name = 'GovernedDispatchError';
  constructor(message: string, readonly raised: unknown) { super(message); }
}

export type SubAgentPause = GovernedToolCall & {
  approval: SubAgentApprovalRef;
  /** Tool calls from the same assistant turn that were not reached. */
  remaining: LLMToolCall[];
  /** The loop iteration the pause happened in; resume continues after it. */
  iteration: number;
};

/** The state a caller keeps between turns, and everything a paused run needs to continue later. */
export type SubAgentCheckpoint = {
  messages: LLMMessage[];
  toolsUsed: string[];
  tokensUsed: { input: number; output: number };
  sequence: number;
  /** The next loop iteration to run when nothing is pending. */
  iteration: number;
  /** Outside content the run had read; restored so a resumed agent stays gated. */
  taint: string[];
  /** Tool call ids whose result was a failure, denial or refusal. */
  failedToolCalls: string[];
};

export type SubAgentResume = SubAgentCheckpoint & {
  /** Present when the run paused on a governed call; absent to continue after a completed turn. */
  pending?: SubAgentPause;
};

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
  /** Tool calls dispatched so far in this run, including a paused one. Absent from results built elsewhere. */
  sequence?: number;
  /** Tool call ids whose result was a failure, denial or refusal, so a trace need not guess from text. */
  failedToolCalls?: string[];
  /** Outside content the run read. */
  taint?: string[];
  /** Set when `terminationReason` is `paused`. */
  paused?: SubAgentPause;
  /** Set on `error` when the governed dispatch raised it, not the model or the loop. */
  dispatchError?: boolean;
  /** The enclosing execution was cancelled between turns; nothing more started. */
  canceled?: boolean;
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
  /** The parent's effective profile (static + taint); tighten-only. */
  profile?: AuthorityProfile | null;
  /** Taint gating for what the sub-agent itself reads during its run. */
  taintGating?: TaintGating | null;
  /** Holds approvals for governed tool calls. Absent: such calls are denied. */
  governedTools?: GovernedToolDispatch;
  /** Called after every completed tool turn with the state a later run could continue from. */
  onTurn?: (state: SubAgentCheckpoint) => void;
  /** Continue a run from its saved state instead of starting one. */
  resume?: SubAgentResume;
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
 * Get LLM-formatted tools from a scoped ToolRegistry, with the relevance
 * filter applied.
 *
 * This site matters more than it looks. The scoped registry for the DEFAULT
 * delegation target, `research-analyst`, is `[browser, terminal, file-ops]`
 * -- all ten browser tools plus `run_command`, `read_file`, `write_file` and
 * `list_directory`. That is precisely the "drop the browser group, keep the
 * shell" shape #475 was rejected for, so the coupling invariant is more
 * load-bearing here than on the main agent, not less.
 *
 * Note the other direction too: some scoped registries have no framed
 * perception tool at all (`software-engineer` is terminal + file-ops). The
 * invariant is quantified over what the call site registered, so retaining
 * the shell there is that agent's status quo rather than a regression -- and
 * the filter must never add a tool the registry does not contain.
 */
/**
 * The tier map, if this manager has one.
 *
 * The filter must never be able to break a call site. Embedded and test
 * callers pass a minimal LLM manager stub with only `chatTier` on it, and an
 * unguarded `llmManager.getTierMap()` turns "no optimisation" into "the
 * sub-agent throws before its first turn". An absent map means no tier
 * resolves, which the eligibility gate reads as ineligible -- unfiltered,
 * which is the correct fallback.
 */
function tierMapOf(manager: LLMManager): TierMap {
  const fn = (manager as Partial<LLMManager>).getTierMap;
  if (typeof fn !== 'function') return {};
  try {
    return fn.call(manager) ?? {};
  } catch {
    return {};
  }
}

function getLLMTools(
  registry: ToolRegistry,
  messages: readonly LLMMessage[],
  ledger: ToolExposureLedger,
  tiers: TierMap,
): { llm: LLMTool[] | undefined; exposed: ReadonlySet<string> } {
  if (registry.count() === 0) return { llm: undefined, exposed: new Set() };
  const all = registry.list();
  const decision = decideTools({
    all,
    messages,
    ledger,
    // The sub-agent loop always runs on the medium tier (see chatTier below).
    tier: 'medium',
    tiers,
    providers: undefined,
  });
  // DISCOVER_TOOLS_LLM rather than the converted definition:
  // toolDefToLLMTool drops `items` from an array parameter.
  const llm = decision.tools.map((t) =>
    (t.name === DISCOVER_TOOLS ? DISCOVER_TOOLS_LLM : toolDefToLLMTool(t)));
  return { llm, exposed: decision.exposed };
}

type AuthorityContext = {
  agent: AgentInstance;
  engine: AuthorityEngine;
  auditTrail?: AuditTrail;
  emergencyController?: EmergencyController;
  temporaryGrants?: Map<string, ActionCategory[]>;
  profile?: AuthorityProfile | null;
  taintGating?: TaintGating | null;
  /** Outside content the sub-agent read so far in this run. */
  taint: Set<string>;
  governedTools?: GovernedToolDispatch;
};

/** The enclosing execution scope refused to let another action start. */
class SubAgentCanceled extends Error {
  constructor(readonly raised: unknown) { super(raised instanceof Error ? raised.message : String(raised)); this.name = 'SubAgentCanceled'; }
}

type ToolDispatch =
  | { text: string; failed?: boolean }
  | { paused: Omit<SubAgentPause, 'remaining' | 'iteration'> };

const denialText = (name: string, reason: string) =>
  `[APPROVAL DENIED] ${name}: ${reason} Do not retry the action; report that it was not performed.`;

function boundedResult(raw: unknown): string {
  let result: string = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (result.length > MAX_TOOL_RESULT_CHARS) {
    result = result.slice(0, MAX_TOOL_RESULT_CHARS) + `\n... (truncated, was ${result.length} chars)`;
  }
  return result;
}

/** Turn the dispatch's answer for a governed call into the tool's result. */
function governedText(ctx: AuthorityContext, toolCall: LLMToolCall, toolCategory: string, governed: Exclude<GovernedToolResult, { kind: 'paused' }>): { text: string; failed?: boolean } {
  if (governed.kind === 'denied') return { text: denialText(toolCall.name, governed.reason), failed: true };
  if (governed.kind === 'failed') return { text: markUntrustedToolFailure(toolCall.name, toolCategory, governed.result, MAX_TOOL_RESULT_CHARS), failed: true };
  if (isTaintSourceTool(toolCall.name, toolCategory)) ctx.taint.add(toolCall.name);
  return { text: markUntrustedToolResult(toolCall.name, toolCategory, boundedResult(governed.result)) };
}

/**
 * Execute a single tool call via a ToolRegistry.
 * Includes optional authority gate for sub-agents.
 */
async function executeTool(
  registry: ToolRegistry,
  toolCall: LLMToolCall,
  sequence: number,
  authorityCtx?: AuthorityContext,
): Promise<ToolDispatch> {
  // The audit row says what happened, so it is written once the outcome is
  // known: a refusal or a pause with `executed: false`, an execution after
  // the tool returned. Nothing is recorded as executed before it ran.
  let audit: ((decision: 'allowed' | 'denied' | 'approval_required', executed: boolean, approvalId?: string) => void) | null = null;

  // Authority gate (if engine provided)
  if (authorityCtx) {
    const { agent, engine, auditTrail, emergencyController, temporaryGrants, taintGating, taint, governedTools } = authorityCtx;
    // The parent's restrictions plus whatever this run has read itself: a
    // browsing specialist that read a page cannot then write or run clean.
    const profile = mergeProfiles(authorityCtx.profile ?? null, taintProfile(taintGating ?? null, taint));

    // Emergency check
    if (emergencyController && !emergencyController.canExecute()) {
      return { text: `[SYSTEM ${emergencyController.getState().toUpperCase()}] Tool execution suspended.`, failed: true };
    }

    const tool = registry.get(toolCall.name);
    const toolCategory = tool?.category ?? 'unknown';
    const gate = resolveToolGate(tool, toolCall.name, toolCall.arguments);
    const actionCategory = gate.actionCategory;

    // A call the person must confirm cannot be made by a sub-agent at all.
    if (gate.confirm === 'always') {
      auditTrail?.log({
        agent_id: agent.id,
        agent_name: agent.agent.role.name,
        tool_name: toolCall.name,
        action_category: actionCategory,
        authority_decision: 'denied',
        executed: false,
      });
      return { text: `[AUTHORITY DENIED] ${toolCall.name} requires the user's confirmation. Sub-agents cannot request approvals directly.`, failed: true };
    }

    const decision = combineDecisions(gate.categories.map((category) => engine.checkAuthority({
      agentId: agent.id,
      agentAuthorityLevel: agent.agent.authority.max_authority_level,
      agentRoleId: agent.agent.role.id,
      toolName: toolCall.name,
      toolCategory,
      actionCategory: category,
      temporaryGrants: temporaryGrants ?? new Map(),
      profile: profile ?? null,
    })));

    audit = (authorityDecision, executed, approvalId) => auditTrail?.log({
      agent_id: agent.id,
      agent_name: agent.agent.role.name,
      tool_name: toolCall.name,
      action_category: actionCategory,
      authority_decision: authorityDecision,
      approval_id: approvalId ?? null,
      executed,
    });

    if (!decision.allowed) {
      audit('denied', false);
      return { text: `[AUTHORITY DENIED] ${toolCall.name}: ${decision.reason}`, failed: true };
    }

    if (decision.requiresApproval) {
      if (!governedTools) {
        // Nobody can hold the approval, so the call is refused. The row says
        // approval was required and nothing ran.
        audit('approval_required', false);
        return { text: `[AUTHORITY DENIED] ${toolCall.name} requires user approval. Sub-agents cannot request approvals directly.`, failed: true };
      }
      // The dispatch judges the call with the same identity the gate did,
      // runs it under its own durable record and audits that dispatch; the
      // row written here records only the gate's decision.
      const principal: SubAgentPrincipal = { agentId: agent.id, agentRoleId: agent.agent.role.id,
        agentAuthorityLevel: agent.agent.authority.max_authority_level, profile: profile ?? null };
      let governed: GovernedToolResult;
      try {
        governed = await governedTools({ toolCall, sequence, actionCategory, toolCategory, principal, reason: decision.reason });
      } catch (err) {
        audit('approval_required', false);
        throw new GovernedDispatchError(err instanceof Error ? err.message : String(err), err);
      }
      if (governed.kind === 'paused') {
        audit('approval_required', false, governed.approval.approvalId);
        return { paused: { toolCall, sequence, actionCategory, toolCategory, principal, reason: decision.reason, approval: governed.approval } };
      }
      audit(governed.kind === 'denied' ? 'denied' : 'approval_required', governed.kind === 'executed');
      return governedText(authorityCtx, toolCall, toolCategory, governed);
    }
  }

  try {
    const raw = await registry.execute(toolCall.name, toolCall.arguments);
    const category = registry.get(toolCall.name)?.category;
    if (authorityCtx && isTaintSourceTool(toolCall.name, category)) authorityCtx.taint.add(toolCall.name);
    audit?.('allowed', true);
    return { text: markUntrustedToolResult(toolCall.name, category, boundedResult(raw)) };
  } catch (err) {
    audit?.('allowed', false);
    // Same reasoning as the orchestrator: a typed failure is a tool result.
    if (err instanceof ActionOutcomeError) {
      const category = registry.get(toolCall.name)?.category;
      if (authorityCtx && isTaintSourceTool(toolCall.name, category)) authorityCtx.taint.add(toolCall.name);
      return { text: markUntrustedToolFailure(toolCall.name, category, err.message, MAX_TOOL_RESULT_CHARS), failed: true };
    }
    return { text: `Error executing ${toolCall.name}: ${err instanceof Error ? err.message : String(err)}`, failed: true };
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
    profile,
    taintGating,
    governedTools,
    onTurn,
    resume,
  } = opts;

  // Build authority context if engine provided
  const authorityCtx: AuthorityContext | undefined = authorityEngine ? {
    agent,
    engine: authorityEngine,
    auditTrail,
    emergencyController,
    temporaryGrants,
    profile,
    taintGating,
    taint: new Set<string>(resume?.taint ?? []),
    governedTools,
  } : undefined;
  const taint = authorityCtx?.taint ?? new Set<string>(resume?.taint ?? []);

  const agentName = agent.agent.role.name;
  const agentId = agent.id;
  const toolsUsed: string[] = resume ? [...resume.toolsUsed] : [];
  const totalUsage = resume ? { ...resume.tokensUsed } : { input: 0, output: 0 };
  const failedToolCalls: string[] = resume ? [...resume.failedToolCalls] : [];
  let sequence = resume?.sequence ?? 0;

  // Set the task on the agent
  agent.setTask(task);
  agent.activate();

  // A resumed run continues its saved log; a fresh one starts from the
  // system prompt (static half cache-marked, per-task context dynamic).
  let messages: LLMMessage[];
  if (resume) {
    messages = resume.messages;
  } else {
    const systemPrompt = buildSubAgentPromptParts(agent, context);
    agent.addMessage('user', task);
    messages = [
      { role: 'system', content: systemPrompt.static, cache: true },
      ...(systemPrompt.dynamic ? [{ role: 'system', content: systemPrompt.dynamic } satisfies LLMMessage] : []),
      ...agent.getMessages(),
    ];
  }

  // The sub-agent buffer IS durable -- `state()` captures it whole into the
  // checkpoint and `resume.messages` restores it -- so the ledger can be
  // seeded from it and admissions survive a pause.
  const exposure = new ToolExposureLedger();
  exposure.seedFromMessages(resume?.messages, (n) => toolRegistry.has(n));
  let toolSet = getLLMTools(toolRegistry, messages, exposure, tierMapOf(llmManager));
  let tools = toolSet.llm;
  let finalText = '';
  let reachedFinal = false;

  const state = (iteration: number): SubAgentCheckpoint => ({
    messages, toolsUsed: [...toolsUsed], tokensUsed: { ...totalUsage }, sequence, iteration,
    taint: [...taint], failedToolCalls: [...failedToolCalls],
  });
  const finish = (partial: Pick<SubAgentResult, 'success' | 'response' | 'terminationReason'> & Partial<SubAgentResult>): SubAgentResult => ({
    toolsUsed: [...new Set(toolsUsed)],
    tokensUsed: totalUsage,
    messages,
    sequence,
    failedToolCalls: [...failedToolCalls],
    taint: [...taint],
    ...partial,
  });

  // A cancellation is not an agent error: the caller stopped the run and
  // must not record anything for it.
  const fence = () => { try { checkpointExecution(); } catch (err) { throw new SubAgentCanceled(err); } };

  const noteToolCall = (tc: LLMToolCall) => {
    toolsUsed.push(tc.name);
    if (onProgress) {
      onProgress({ type: 'tool_call', agentName, agentId, data: { name: tc.name, arguments: tc.arguments } });
    }
  };

  const record = (tc: LLMToolCall, dispatched: { text: string; failed?: boolean }) => {
    messages.push({ role: 'tool', content: dispatched.text, tool_call_id: tc.id });
    if (dispatched.failed) failedToolCalls.push(tc.id);
    console.log(`[SubAgent:${agentName}] Tool ${tc.name} -> ${dispatched.text.slice(0, 100)}...`);
  };

  /** Dispatch a turn's tool calls in order; a pause returns what was not reached. */
  /** Set when a discover_tools admission widened the exposed set. */
  let exposureWidened = false;

  const dispatchCalls = async (calls: LLMToolCall[], iteration: number): Promise<SubAgentPause | null> => {
    for (let index = 0; index < calls.length; index++) {
      const tc = calls[index]!;
      fence();
      // The escape hatch is synthetic and never in the scoped registry, so
      // it is answered here rather than dispatched. It carries no authority
      // and touches nothing; admission only widens what the next provider
      // call is offered, and the coupling invariant is re-checked then.
      const discovery = interceptDiscovery(tc.name, tc.arguments, {
        all: toolRegistry.list(),
        ledger: exposure,
        exposed: toolSet.exposed,
        filterEnabled: getToolFilterPolicy().enabled,
        // The same emergency predicate `executeTool` applies below. Without
        // it a halted system would still enumerate its catalogue here, which
        // is the one thing this branch skips by sitting before dispatch.
        haltedState: () =>
          (authorityCtx?.emergencyController && !authorityCtx.emergencyController.canExecute()
            ? authorityCtx.emergencyController.getState()
            : null),
        onAdmitted: (admitted) => {
          try {
            authorityCtx?.auditTrail?.log({
              agent_id: agentId,
              agent_name: agentName,
              tool_name: `${DISCOVER_TOOLS}(${admitted.join(',')})`,
              action_category: 'read_data',
              authority_decision: 'allowed',
              executed: true,
            });
          } catch (err) {
            console.warn(`[SubAgent:${agentName}] could not audit a discover_tools admission:`,
              err instanceof Error ? err.message : err);
          }
        },
      });
      if (discovery) {
        if (discovery.grew) exposureWidened = true;
        noteToolCall(tc);
        sequence += 1;
        record(tc, { text: discovery.result });
        continue;
      }
      noteToolCall(tc);
      sequence += 1;
      const dispatched = await executeTool(toolRegistry, tc, sequence, authorityCtx);
      if ('paused' in dispatched) {
        return { ...dispatched.paused, remaining: calls.slice(index + 1), iteration };
      }
      // Whatever the sub-agent actually called stays exposed for the rest of
      // the run -- registered names only, and only while the filter is on.
      if (getToolFilterPolicy().enabled && toolRegistry.has(tc.name)) exposure.add(tc.name);
      record(tc, dispatched);
    }
    return null;
  };

  try {
    let startIteration = resume?.iteration ?? 0;
    if (resume?.pending) {
      // The paused call goes back through the same dispatch, which now
      // answers from the decision that was made; then the rest of its turn.
      const pending = resume.pending;
      if (!governedTools || !authorityCtx) throw new Error('Cannot resume a paused sub-agent without a governed tool dispatch');
      fence();
      let governed: GovernedToolResult;
      try {
        governed = await governedTools({ toolCall: pending.toolCall, sequence: pending.sequence, actionCategory: pending.actionCategory,
          toolCategory: pending.toolCategory, principal: pending.principal, reason: pending.reason });
      } catch (err) {
        throw new GovernedDispatchError(err instanceof Error ? err.message : String(err), err);
      }
      if (governed.kind === 'paused') return finish({ success: true, response: '', terminationReason: 'paused', paused: { ...pending, approval: governed.approval } });
      record(pending.toolCall, governedText(authorityCtx, pending.toolCall, pending.toolCategory, governed));
      const pause = await dispatchCalls(pending.remaining, pending.iteration);
      // A turn is durable only while the run is still alive.
      fence();
      if (pause) return finish({ success: true, response: '', terminationReason: 'paused', paused: pause });
      startIteration = pending.iteration + 1;
      onTurn?.(state(startIteration));
    }

    // Tool execution loop
    for (let iteration = startIteration; iteration < maxIterations; iteration++) {
      fence();
      const llmResponse: LLMResponse = await llmManager.chatTier('medium', 'sub_agent', messages, { tools });
      fence();

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

        const pause = await dispatchCalls(llmResponse.tool_calls, iteration);
        // A turn is durable only while the run is still alive.
        fence();
        if (pause) return finish({ success: true, response: '', terminationReason: 'paused', paused: pause });
        if (exposureWidened) {
          exposureWidened = false;
          toolSet = getLLMTools(toolRegistry, messages, exposure, tierMapOf(llmManager));
          tools = toolSet.llm;
        }
        onTurn?.(state(iteration + 1));
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

    // Add final response to agent's history
    agent.addMessage('assistant', finalText);

    return finish({ success: true, response: finalText, terminationReason: reachedFinal ? 'completed' : 'max_iterations' });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[SubAgent:${agentName}] Error:`, errorMsg);

    return finish({ success: false, response: `Sub-agent error: ${errorMsg}`, terminationReason: 'error',
      ...(err instanceof GovernedDispatchError ? { dispatchError: true } : err instanceof SubAgentCanceled ? { canceled: true } : {}) });
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
