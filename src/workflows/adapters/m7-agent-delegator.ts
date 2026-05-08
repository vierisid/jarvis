/**
 * `M7AgentDelegator` -- backs `jarvis-agent.delegate` with the full M7 sub-agent
 * loop. Spawns a sub-agent under the daemon's primary agent, runs it through
 * `runSubAgent` (LLM + tool-call loop, authority-gated), and returns the final
 * message + tool-call trace + termination reason.
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
 * Authority: sub-agents are denied actions that would require user approval
 * (per `runSubAgent`'s policy). A workflow step that needs a destructive
 * action should expose it via a separate piece (e.g., `jarvis-tool` or
 * `jarvis-notify` + waitpoint), not piggy-back on the sub-agent.
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
import {
  createScopedToolRegistry,
  runSubAgent as defaultRunSubAgent,
  type RunSubAgentOptions,
  type SubAgentResult,
} from "../../agents/sub-agent-runner";

/**
 * Indirection so tests can replace the runner without monkey-patching the
 * imported binding (ESM bindings are read-only). Production passes nothing
 * and gets the real `runSubAgent`.
 */
export type RunSubAgentFn = (opts: RunSubAgentOptions) => Promise<SubAgentResult>;

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
}

const DEFAULT_ROLE_ID = "workflow-default";
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_TRACE_RESULT_MAX_CHARS = 1000;

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
  }

  async delegate(input: PieceAgentDelegateInput): Promise<PieceAgentDelegateResult> {
    const roleId = input.role ?? this.defaultRoleId;
    const role = this.specialists.get(roleId);
    if (!role) {
      const available = Array.from(this.specialists.keys()).join(", ") || "<none>";
      return {
        finalMessage: "",
        toolCalls: [],
        status: "error",
        error: `unknown role "${roleId}"; available: ${available}`,
      };
    }

    const parent = this.orchestrator.getPrimary();
    if (!parent) {
      return {
        finalMessage: "",
        toolCalls: [],
        status: "error",
        error:
          "no primary agent registered; the daemon's agent-service hasn't initialized -- workflows can't delegate yet",
      };
    }

    let childId: string | null = null;
    try {
      const child = this.orchestrator.spawnSubAgent(parent.id, role);
      childId = child.id;
      const scopedRegistry = createScopedToolRegistry(child.agent.authority.allowed_tools);

      const result: SubAgentResult = await this.runSubAgentFn({
        agent: child,
        task: input.goal,
        context: "",
        llmManager: this.llmManager,
        toolRegistry: scopedRegistry,
        maxIterations: input.maxIterations ?? this.defaultMaxIterations,
        ...(this.authorityEngine ? { authorityEngine: this.authorityEngine } : {}),
        ...(this.auditTrail ? { auditTrail: this.auditTrail } : {}),
        ...(this.emergencyController ? { emergencyController: this.emergencyController } : {}),
        ...(this.temporaryGrants ? { temporaryGrants: this.temporaryGrants } : {}),
      });

      // Walk the runSubAgent-supplied message log (NOT child.getMessages(),
      // which only carries user/assistant turns). The local log has every
      // assistant tool_calls block + matching tool result.
      const toolCalls = extractToolCallsTrace(result.messages, this.traceResultMaxChars);

      if (result.terminationReason === "error") {
        return {
          finalMessage: "",
          toolCalls,
          status: "error",
          error: result.response,
        };
      }
      return {
        finalMessage: result.response,
        toolCalls,
        status: result.terminationReason,
      };
    } catch (e) {
      // spawnSubAgent or runSubAgent threw an unhandled exception. Surface
      // as a clean error rather than letting the engine see a 500.
      const msg = e instanceof Error ? e.message : String(e);
      return {
        finalMessage: "",
        toolCalls: [],
        status: "error",
        error: `delegate failed: ${msg}`,
      };
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
 * (mid-loop crash) come through with no `result`.
 */
export function extractToolCallsTrace(
  messages: LLMMessage[],
  maxResultChars: number,
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
        // The sub-agent runner formats authority denials + tool errors as
        // `[AUTHORITY DENIED]` / `Error executing X:` strings inside the
        // result. Surface them as `error` so the workflow step can branch on
        // it. Heuristic match -- the runner is the only source of these
        // prefixes.
        if (result.startsWith("[AUTHORITY DENIED]") || result.startsWith("Error executing ")) {
          entry.error = result;
        }
      }
      trace.push(entry);
    }
  }
  return trace;
}
