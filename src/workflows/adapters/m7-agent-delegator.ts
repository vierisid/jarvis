/**
 * `M7AgentDelegator` -- backs `jarvis-agent.delegate` with the full M7 sub-agent
 * loop. Spawns a sub-agent under the daemon's primary agent, runs it through
 * `runSubAgent` (LLM + tool-call loop, authority-gated), and returns the final
 * message + tool-call trace + termination reason + declared outcome.
 *
 * Lifecycle per call:
 *   1. Look up the requested role in the specialist registry. Fall back to
 *      `defaultRoleId` (defaults to `"workflow-default"`) when the piece
 *      didn't supply one. Unknown role -> `status: "error"`.
 *   2. Resolve the parent agent. Today that's `orchestrator.getPrimary()` --
 *      the chat primary, whose authority caps cascade to the spawned child.
 *      No primary -> `status: "error"` (the daemon's agent-service hasn't
 *      booted; workflows shouldn't run before that).
 *   3. `orchestrator.spawnSubAgent(parent.id, role)` -- gives us a child
 *      AgentInstance with reduced authority.
 *   4. `createScopedToolRegistry(child.allowed_tools)` -- only the role's
 *      categories are callable.
 *   5. `runSubAgent(...)` with the goal as the task. Authority engine,
 *      audit trail, and emergency controller all flow in if configured.
 *   6. Walk the agent's message log to extract `{name, args, result, error}`
 *      tuples for each tool call (zip assistant `tool_calls` with subsequent
 *      `tool` messages by `tool_call_id`).
 *   7. `orchestrator.terminateAgent(child.id)` in `finally` so a thrown
 *      exception still cleans up the hierarchy.
 *
 * Concurrency: each `delegate()` call spawns + terminates its own sub-agent;
 * multiple workflow steps can call this in parallel without sharing state.
 *
 * Authority: a governed tool call inside the sub-agent is handed to the
 * continuation's dispatch, which runs it through the workflow effect
 * boundary. When that parks the run on an approval, the conversation is
 * checkpointed and the step returns `approval_required`; the engine runs the
 * step again after the decision and the conversation resumes where it
 * stopped. Without a continuation (no workflow around the call) governed
 * calls are denied outright, as before.
 */

import type {
  PieceAgentDelegateInput,
  PieceAgentDelegateResult,
  PieceAgentDelegator,
  PieceAgentToolCall,
} from "../jarvis-pieces/types";
import type { LLMManager } from "../../llm/manager";
import type { LLMMessage } from "../../llm/provider";
import type { AgentOrchestrator } from "../../agents/orchestrator";
import type { AuthorityEngine } from "../../authority/engine";
import type { AuditTrail } from "../../authority/audit";
import type { EmergencyController } from "../../authority/emergency";
import type { ActionCategory } from "../../roles/authority";
import type { RoleDefinition } from "../../roles/types";
import type { ToolRegistry } from "../../actions/tools/registry";
import type { ActionOutcome } from "../../actions/action-outcome";
import type { DelegationCheckpoint } from "../db/repos/delegation";
import {
  createScopedToolRegistry,
  runSubAgent as defaultRunSubAgent,
  type GovernedToolCall,
  type GovernedToolResult,
  type RunSubAgentOptions,
  type SubAgentResult,
  type SubAgentResume,
} from "../../agents/sub-agent-runner";

/**
 * Indirection so tests can replace the runner without monkey-patching the
 * imported binding (ESM bindings are read-only). Production passes nothing
 * and gets the real `runSubAgent`.
 */
export type RunSubAgentFn = (opts: RunSubAgentOptions) => Promise<SubAgentResult>;

/**
 * What a workflow step supplies so a delegation can pause on an approval and
 * continue later: where its checkpoint lives, what it is bound to, and how a
 * governed tool call reaches the effect boundary.
 */
export interface DelegationContinuation {
  identity: {
    id: string;
    runId: string;
    stepName: string;
    executionPath: Array<[string, number]>;
    versionDigest: string;
  };
  load(): DelegationCheckpoint | null;
  save(checkpoint: DelegationCheckpoint): void;
  /** Runs, pauses or reports the decision for a governed tool call. */
  dispatch(registry: ToolRegistry, call: GovernedToolCall): Promise<GovernedToolResult>;
}

export interface M7AgentDelegatorOptions {
  orchestrator: AgentOrchestrator;
  llmManager: LLMManager;
  /** Map<roleId, RoleDefinition>. The daemon's specialist registry. */
  specialists: Map<string, RoleDefinition>;
  /**
   * Role used when the piece didn't specify one. Default `"workflow-default"`,
   * which ships in `roles/specialists/workflow-default.yaml`. Falling back is
   * preferable to erroring -- most flows won't pin a role.
   */
  defaultRoleId?: string;
  /** Default `maxIterations` when the piece doesn't supply one. Default 50. */
  defaultMaxIterations?: number;
  /** Authority components -- forwarded into runSubAgent's gate. */
  authorityEngine?: AuthorityEngine;
  auditTrail?: AuditTrail;
  emergencyController?: EmergencyController;
  /** Per-agent temporary grants. Workflow sub-agents inherit none by default. */
  temporaryGrants?: Map<string, ActionCategory[]>;
  /**
   * Cap on individual tool result length surfaced in the trace. Long results
   * still flow through `runSubAgent` -> the LLM (truncated by its internal
   * cap), but the trace returned to the workflow step shouldn't bloat the
   * step output. Default 1000 chars per call.
   */
  traceResultMaxChars?: number;
  /** Test seam. Production omits this and gets the real `runSubAgent`. */
  runSubAgentFn?: RunSubAgentFn;
  /** Test seam. Production omits this and gets the builtin tools for the role's categories. */
  scopedRegistry?: (allowedCategories: string[]) => ToolRegistry;
}

const DEFAULT_ROLE_ID = "workflow-default";
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_TRACE_RESULT_MAX_CHARS = 1000;

const errorResult = (error: string, toolCalls: PieceAgentToolCall[] = []): PieceAgentDelegateResult =>
  ({ finalMessage: "", toolCalls, status: "error", error });

/**
 * The declared business outcome of a finished delegation. The conversation
 * ending is not it: only the required tools completing is. Without declared
 * tools, `succeeded` says no more than that the agent finished cleanly.
 */
export function delegationOutcome(
  result: Pick<PieceAgentDelegateResult, "status" | "toolCalls" | "error">,
  requiredTools: string[] = [],
): ActionOutcome {
  if (result.status === "error") {
    return { status: "error", code: "AGENT_ERROR", effect: "may_have_occurred",
      message: result.error ?? "The delegated agent failed" };
  }
  if (result.status === "max_iterations") {
    return { status: "error", code: "AGENT_INCOMPLETE", effect: "may_have_occurred",
      message: "The delegated agent reached its iteration limit before finishing" };
  }
  if (result.status === "canceled") {
    return { status: "error", code: "AGENT_CANCELED", effect: "may_have_occurred",
      message: "The delegated agent was canceled before finishing" };
  }
  if (result.status === "approval_required") {
    return { status: "blocked", code: "APPROVAL_PENDING", effect: "not_started",
      message: "A governed tool call is waiting for approval" };
  }
  const unmet = requiredTools.filter(name =>
    !result.toolCalls.some(call => call.name === name && call.result !== undefined && call.error === undefined));
  if (unmet.length > 0) {
    return { status: "error", code: "REQUIRED_TOOL_NOT_COMPLETED", effect: "may_have_occurred",
      message: `The delegated agent finished without completing: ${unmet.join(", ")}` };
  }
  return { status: "succeeded" };
}

export class M7AgentDelegator implements PieceAgentDelegator {
  private readonly orchestrator: AgentOrchestrator;
  private readonly llmManager: LLMManager;
  private readonly specialists: Map<string, RoleDefinition>;
  private readonly defaultRoleId: string;
  private readonly defaultMaxIterations: number;
  private readonly authorityEngine?: AuthorityEngine;
  private readonly auditTrail?: AuditTrail;
  private readonly emergencyController?: EmergencyController;
  private readonly temporaryGrants?: Map<string, ActionCategory[]>;
  private readonly traceResultMaxChars: number;
  private readonly runSubAgentFn: RunSubAgentFn;
  private readonly scopedRegistry: (allowedCategories: string[]) => ToolRegistry;

  constructor(opts: M7AgentDelegatorOptions) {
    this.orchestrator = opts.orchestrator;
    this.llmManager = opts.llmManager;
    this.specialists = opts.specialists;
    this.defaultRoleId = opts.defaultRoleId ?? DEFAULT_ROLE_ID;
    this.defaultMaxIterations = opts.defaultMaxIterations ?? DEFAULT_MAX_ITERATIONS;
    if (opts.authorityEngine) this.authorityEngine = opts.authorityEngine;
    if (opts.auditTrail) this.auditTrail = opts.auditTrail;
    if (opts.emergencyController) this.emergencyController = opts.emergencyController;
    if (opts.temporaryGrants) this.temporaryGrants = opts.temporaryGrants;
    this.traceResultMaxChars = opts.traceResultMaxChars ?? DEFAULT_TRACE_RESULT_MAX_CHARS;
    this.runSubAgentFn = opts.runSubAgentFn ?? defaultRunSubAgent;
    this.scopedRegistry = opts.scopedRegistry ?? createScopedToolRegistry;
  }

  async delegate(input: PieceAgentDelegateInput, continuation?: DelegationContinuation): Promise<PieceAgentDelegateResult> {
    const roleId = input.role ?? this.defaultRoleId;
    const role = this.specialists.get(roleId);
    if (!role) {
      const available = Array.from(this.specialists.keys()).join(", ") || "<none>";
      return errorResult(`unknown role "${roleId}"; available: ${available}`);
    }

    const parent = this.orchestrator.getPrimary();
    if (!parent) {
      return errorResult(
        "no primary agent registered; the daemon's agent-service hasn't initialized -- workflows can't delegate yet",
      );
    }

    // A step the engine runs again answers from its record: the finished
    // result, or a refusal when what the checkpoint was bound to has changed.
    const checkpoint = continuation?.load() ?? null;
    if (checkpoint?.status === "completed" && checkpoint.result) {
      // The declaration is not part of the record's identity, so it is applied as asked now.
      return { ...checkpoint.result, outcome: delegationOutcome(checkpoint.result, input.requiredTools) };
    }
    if (checkpoint && continuation) {
      if (checkpoint.versionDigest !== continuation.identity.versionDigest) {
        return errorResult("Workflow version changed while the delegation was paused; start a new run");
      }
      if (checkpoint.roleId !== roleId || checkpoint.goal !== input.goal) {
        return errorResult("Delegation input changed while it was paused; start a new run");
      }
    }
    const resume: SubAgentResume | undefined = checkpoint && checkpoint.status !== "completed"
      ? { messages: checkpoint.messages, toolsUsed: checkpoint.toolsUsed, tokensUsed: checkpoint.tokensUsed,
          sequence: checkpoint.sequence, iteration: checkpoint.iteration, taint: checkpoint.taint,
          failedToolCalls: checkpoint.failedToolCalls, ...(checkpoint.pending ? { pending: checkpoint.pending } : {}) }
      : undefined;

    let childId: string | null = null;
    try {
      const child = this.orchestrator.spawnSubAgent(parent.id, role);
      childId = child.id;
      const registry = this.scopedRegistry(child.agent.authority.allowed_tools);
      const base = { ...(continuation?.identity ?? {}), roleId, goal: input.goal } as Omit<DelegationCheckpoint,
        "status" | "messages" | "toolsUsed" | "tokensUsed" | "sequence" | "iteration" | "taint" | "failedToolCalls" | "updatedAt">;

      const result: SubAgentResult = await this.runSubAgentFn({
        agent: child,
        task: input.goal,
        context: "",
        llmManager: this.llmManager,
        toolRegistry: registry,
        // Clamped as well as validated at the route: this adapter is also
        // reachable without it, and 200 is the primary loop's own ceiling.
        maxIterations: Math.min(input.maxIterations ?? this.defaultMaxIterations, 200),
        ...(this.authorityEngine ? { authorityEngine: this.authorityEngine } : {}),
        ...(this.auditTrail ? { auditTrail: this.auditTrail } : {}),
        ...(this.emergencyController ? { emergencyController: this.emergencyController } : {}),
        ...(this.temporaryGrants ? { temporaryGrants: this.temporaryGrants } : {}),
        ...(continuation ? {
          governedTools: call => continuation.dispatch(registry, call),
          // After every completed turn the conversation is durable, so a run
          // that dies mid-conversation continues from here, not from scratch.
          onTurn: state => continuation.save({ ...base, ...state, status: "running", updatedAt: Date.now() }),
        } : {}),
        ...(resume ? { resume } : {}),
      });

      // Walk the runSubAgent-supplied message log (NOT child.getMessages(),
      // which only carries user/assistant turns). The local log has every
      // assistant tool_calls block + matching tool result.
      const toolCalls = extractToolCallsTrace(result.messages, this.traceResultMaxChars, new Set(result.failedToolCalls ?? []));
      const now = Date.now();
      const stateOf = (iteration: number) => ({ messages: result.messages, toolsUsed: result.toolsUsed, tokensUsed: result.tokensUsed,
        sequence: result.sequence ?? result.paused?.sequence ?? 0, iteration, taint: result.taint ?? [],
        failedToolCalls: result.failedToolCalls ?? [] });

      if (result.terminationReason === "paused") {
        // The dispatch only exists with a continuation, so a pause always has somewhere to go.
        if (!continuation || !result.paused) throw new Error("paused without a continuation");
        continuation.save({ ...base, ...stateOf(result.paused.iteration), status: "paused", pending: result.paused, updatedAt: now });
        return { finalMessage: "", toolCalls, status: "approval_required", approval: result.paused.approval };
      }

      if (result.terminationReason === "error" && result.dispatchError) {
        // The boundary refused or failed the call (emergency, changed version,
        // an uncertain earlier attempt). That is this run's answer, not the
        // delegation's: the checkpoint keeps its state so a later run can
        // resume once the condition clears.
        return errorResult(result.response, toolCalls);
      }

      const finished: PieceAgentDelegateResult = result.terminationReason === "error"
        ? errorResult(result.response, toolCalls)
        : { finalMessage: result.response, toolCalls,
            status: result.terminationReason === "max_iterations" ? "max_iterations" : "completed" };
      finished.outcome = delegationOutcome(finished, input.requiredTools);
      // The log is dropped once the result exists; the trace is in the step output.
      continuation?.save({ ...base, ...stateOf(0), messages: [], status: "completed", result: finished, updatedAt: now });
      return finished;
    } catch (e) {
      // spawnSubAgent or runSubAgent threw an unhandled exception. Surface
      // as a clean error rather than letting the engine see a 500.
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`delegate failed: ${msg}`);
    } finally {
      // Always clean up. terminateAgent recursively removes children, so even
      // if runSubAgent itself spawned grand-children (it doesn't today), they
      // get torn down too.
      if (childId !== null) {
        try {
          this.orchestrator.terminateAgent(childId);
        } catch {
          // Ignore cleanup errors -- the orchestrator will surface them via
          // its own logging; we don't want to mask the original return.
        }
      }
    }
  }
}

/**
 * Walk the message log of a finished sub-agent and produce the
 * `PieceAgentToolCall[]` trace surfaced in the workflow step output.
 *
 * Strategy: every `assistant` message carrying `tool_calls` is followed by
 * one or more `tool` messages whose `tool_call_id` matches an entry in that
 * tool_calls array. Zip them by id. Tool calls whose response never landed
 * (mid-loop crash, or a pause) come through with no `result`.
 */
export function extractToolCallsTrace(
  messages: LLMMessage[],
  maxResultChars: number,
  /** Tool call ids the runner reported as failed, denied or refused. */
  failed: ReadonlySet<string> = new Set(),
): PieceAgentToolCall[] {
  const responseById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "tool" && typeof msg.tool_call_id === "string" && typeof msg.content === "string") {
      responseById.set(msg.tool_call_id, msg.content);
    }
  }
  const trace: PieceAgentToolCall[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    for (const call of msg.tool_calls) {
      const entry: PieceAgentToolCall = { name: call.name };
      // Stringify args defensively -- sub-agents shouldn't see the raw object
      // round-trip in step output, just a stable JSON blob.
      try {
        entry.args = JSON.stringify(call.arguments);
      } catch {
        entry.args = "<unserializable>";
      }
      const result = responseById.get(call.id);
      if (typeof result === "string") {
        // The LLM-side already truncates long tool results to ~6KB inside
        // `runSubAgent`; we apply a tighter cap here so a row of 50 tool
        // calls with multi-KB results doesn't bloat the workflow step.
        entry.result =
          result.length > maxResultChars
            ? result.slice(0, maxResultChars) + `... (truncated, was ${result.length} chars)`
            : result;
        // The runner says which calls failed, were denied or refused. The
        // prefix match remains for logs recorded before it did.
        if (failed.has(call.id) || result.startsWith("[AUTHORITY DENIED]") || result.startsWith("[APPROVAL DENIED]") || result.startsWith("Error executing ")) {
          entry.error = result;
        }
      }
      trace.push(entry);
    }
  }
  return trace;
}
