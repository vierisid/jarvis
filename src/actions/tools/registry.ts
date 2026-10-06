import type { ContentBlock } from '../../llm/provider.ts';
import { checkpointExecution } from '../execution-scope.ts';
import { ActionOutcomeError } from '../action-outcome.ts';
import { WorkflowCancellationError } from '../../workflows/runtime/cancellation-error.ts';
import { observeToolExecution } from '../progress-context.ts';

export type ToolParameter = {
  type: string;
  description: string;
  required: boolean;
  /**
   * Allowed values for a string parameter. Emitted as JSON-Schema `enum` in
   * the model-facing schema AND enforced in `validateParameters`, so it is a
   * constraint and not just a hint: small and local models routinely invent
   * values when the choices are only described in prose, and an advertised
   * but unchecked enum only moves that failure one layer down, into the
   * sidecar or the provider.
   *
   * Prefer this over listing the options in the description.
   */
  enum?: string[];
};

export type ToolResult = {
  content: ContentBlock[];
};

export function isToolResult(v: unknown): v is ToolResult {
  return v !== null && typeof v === 'object' && 'content' in (v as object) && Array.isArray((v as ToolResult).content);
}

/**
 * Per-call authority resolution for a tool whose effect is decided by what
 * the call will do, not by the tool's name: run_skill replays whatever steps
 * the named skill holds, record_skill installs input hooks.
 *
 *   actionCategory  what this call reaches. The orchestrator gates on the
 *                   stricter of this and the tool's TOOL_ACTION_MAP entry, so
 *                   a gate can raise a call, never lower it below the floor.
 *   intent          card-ready sentence naming what will actually happen,
 *                   with resolved values ("click Send (sends email)").
 *   confirm         'always': the person must confirm this call on a card;
 *                   explicit denials still win. Like 'above_level', a pure
 *                   level shortfall above a permitted floor can ask for approval.
 *                   'above_level': a category the
 *                   agent's level cannot clear becomes an approval card instead
 *                   of a denial, the substitution request_approval makes for a
 *                   declared intent. Absent: the engine's decision stands.
 */
export type ToolGate = {
  actionCategory: import('../../roles/authority').ActionCategory;
  /**
   * What the call acts on, as durable identity: for run_skill the skill's
   * name, version and surface. The workflow effect boundary records it as the
   * effect's target, so an approval reviewed against one version of a skill
   * cannot dispatch another. Plain JSON, no secrets. The boundary owns the
   * target keys its dispatch fence reads and drops any subject key that names
   * one (`tool`, `capability`, `sidecarId`, `selection`, `machineBinding`,
   * `intent`), so a gate cannot retarget a run by naming a key the same way.
   */
  subject?: Record<string, unknown>;
  /**
   * Every category the call reaches when it spans more than one (a skill
   * that clicks controls and sends a message). The call must clear each of
   * them: a config that governs send_message stops such a skill even though
   * control_app is the higher level. Defaults to [actionCategory].
   */
  actionCategories?: import('../../roles/authority').ActionCategory[];
  intent: string;
  confirm?: 'always' | 'above_level';
};

export type ToolDefinition = {
  name: string;
  description: string;
  category: string;
  parameters: Record<string, ToolParameter>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
  /** Trusted adapter declaration, never accepted from workflow/model input. */
  workflowEffect?: {
    category: import('../../roles/authority').ActionCategory;
    target: (params: Record<string, unknown>) => Record<string, unknown>;
  };
  /**
   * Trusted per-call gate, never accepted from model input. Consulted by every
   * authority gate site (orchestrator text and realtime paths, sub-agents)
   * before the engine is asked. Returning null leaves the static mapping in
   * force. Must be cheap and must not act.
   */
  authorityGate?: (params: Record<string, unknown>) => ToolGate | null;
  /**
   * Trusted, never accepted from model input. Applied to a call's arguments
   * before it is gated, so the gate, the approval card and the eventual run
   * all see the same values: pins anything the tool would otherwise resolve
   * later from ambient state (the file tools' relative path, against the
   * site chat's cwd). Must be cheap, must not act, and must return the
   * params unchanged when there is nothing to pin.
   */
  freezeArguments?: (params: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Trusted declaration, never accepted from model input: this tool's FAILURE
   * text can carry content from outside the conversation, so the dispatch frames
   * it as data before the model reads it (#608).
   *
   * Why a declaration and not a name. Framing is normally decided by
   * `UNTRUSTED_TOOL_NAMES` in roles/untrusted.ts, and #595 argued specifically
   * against adding `manage_workflow` to that set: it also drives `outsideReach`,
   * `FRAMED_ACTORS` and the tool filter's I1 union repair, so membership moves
   * three things that have nothing to do with framing an error string. This flag
   * moves exactly one.
   *
   * Why the FAILURE only. A tool whose ordinary RESULT is outside content
   * belongs in the name set, where the filter and the taint predicate can see
   * it. This is for the narrower case: a tool whose success path is its own
   * text, but whose refusals quote stored or remote data --
   * `manage_workflow`'s `run` / `enable` / `publish`, whose readiness and
   * code-step refusals interpolate step names written by the composer LLM or by
   * the versions API.
   *
   * WHERE IT IS HONOURED -- five model boundaries, all of them a point where a
   * failure string is about to become prompt text:
   *
   *   - `agents/orchestrator.ts`, the text dispatch's two failure branches;
   *   - the same file's realtime dispatch;
   *   - the same file's inline approval gate, which frames what
   *     `authority/deferred-executor.ts` hands back;
   *   - `agents/sub-agent-runner.ts`'s own dispatch;
   *   - and that file's `governedText`, for a governed or approved call. Those
   *     last two were defence in depth when #608 wired them, because the only
   *     flagged tool was registered on the primary registry alone. They are
   *     LIVE since #629: `desktop_type`, `desktop_press_keys` and
   *     `desktop_screenshot` declare the flag and are in `BUILTIN_TOOLS`, which
   *     is what `createScopedToolRegistry` builds a sub-agent registry from, so
   *     a sub-agent allowed the `desktop` tools gets all three.
   *
   * WHERE IT DELIBERATELY IS NOT. Everything that writes a row or faces an
   * operator keeps the RAW text: `workflows/runtime/effect-boundary.ts`'s
   * `workflow_effect.error`, `workflows/runner/handler.ts`'s
   * `flow_run.failed_step`, `approval_requests.execution_result` (bounded and
   * defanged by `boundedReceiptText` instead), the dashboard's `[EXECUTED]`
   * notification, the chat-channel relay, the approval execute route's HTTP
   * body, and the HTTP routes' `trapErrors`. A frame carries a per-message
   * nonce (#567), so a stored or broadcast one is a stale boundary and a cut one
   * is an unterminated block.
   *
   * That split is why the frame is drawn at each boundary and never inside the
   * executor that produces the string: `deferred-executor`'s one value feeds a
   * model AND four non-model consumers, so framing it there put a live nonce in
   * all five.
   *
   * Frame where a model reads; never where something writes a row or a person
   * reads.
   *
   * ONE ACCEPTED COST. `execute` below rewraps a plain Error as
   * `Tool '<name>' execution failed: ...` before any dispatch sees it, so that
   * repo-authored prefix ends up INSIDE the block, disclaimed along with the text
   * it precedes. ("A plain Error" is now two carve-outs, not one: an
   * `ActionOutcomeError` and a `WorkflowCancellationError` are both typed
   * verdicts a caller translates, and both pass through untouched -- see
   * `execute`. Neither is the tool's own diagnosis, so neither is the text this
   * paragraph is about.) That is the same trade `manage-workflow.ts` takes for its `note`
   * field, and the alternative -- framing only part of a message -- is the
   * branch-dependent framing #559 warns against. The direction that must never
   * happen is the opposite one, and it cannot: the only text outside the block is
   * what the dispatch itself puts there.
   */
  failureIsOutsideContent?: true;
  /** Capture a read-only check of the UI session/subject a person will review.
   * The returned guard lives only until this approval is resolved; it must
   * never reconnect or select a replacement subject when validation fails. */
  captureApprovalGuard?: (params: Record<string, unknown>) => (() => boolean);
};

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  /** Default working directory for tools like run_command. Set by site builder context. */
  defaultCwd: string | null = null;

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }

    this.validateToolDefinition(tool);
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(category?: string): ToolDefinition[] {
    const allTools = Array.from(this.tools.values());

    if (!category) {
      return allTools;
    }

    return allTools.filter(tool => tool.category === category);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new Error(`Tool '${name}' not found in registry`);
    }

    this.validateParameters(tool, params);

    // Outside the try: a cancellation fence is not a tool failure, and
    // rewrapping it would hide its type from the callers that map it.
    checkpointExecution();

    try {
      return await observeToolExecution(name, () => tool.execute(params));
    } catch (error) {
      if (error instanceof ActionOutcomeError) throw error;
      // #630. The fence above is NOT the only place cancellation is raised, and
      // that was the whole defect: `withExecutionScope` publishes the run's
      // fence into an AsyncLocalStorage scope, and the deep dispatch points a
      // tool reaches through -- `SidecarManager.dispatchRPC`, the channel
      // adapters, the TTS chunk loop, the ws service -- each call
      // `checkpointExecution()` of their own, INSIDE `tool.execute`. So a
      // cancellation acknowledged while a tool was awaiting a remote reply
      // landed in this catch and left as a plain `Error`, and
      // `sandbox-api/server.ts`'s `instanceof WorkflowCancellationError` ->
      // 409 could never fire for it: a deliberate cancel was reported to the
      // engine as a 500 and to the run as a generic tool failure.
      //
      // Carved out for the same reason as `ActionOutcomeError` and not a new
      // one: both are TYPED verdicts about the call that callers above
      // translate, rather than diagnoses from inside the tool that only a
      // human reads. Rewrapping either does not add information -- it removes
      // the only thing a caller can branch on. Nothing else is carved out: a
      // tool's own failure stays wrapped, named and attributed.
      //
      // The message is left alone too. `WorkflowCancellationError`'s text
      // already names the run and says that previously dispatched effects may
      // have completed, which is exactly what a 409 body should say; prefixing
      // it with "Tool 'x' execution failed" would assert a failure where what
      // happened is a stop.
      if (error instanceof WorkflowCancellationError) throw error;
      throw new Error(
        `Tool '${name}' execution failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  clear(): void {
    this.tools.clear();
  }

  getCategories(): string[] {
    const categories = new Set<string>();

    for (const tool of this.tools.values()) {
      categories.add(tool.category);
    }

    return Array.from(categories).sort();
  }

  count(): number {
    return this.tools.size;
  }

  private validateToolDefinition(tool: ToolDefinition): void {
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error('Tool must have a valid name');
    }

    if (!tool.description || typeof tool.description !== 'string') {
      throw new Error(`Tool '${tool.name}' must have a description`);
    }

    if (!tool.category || typeof tool.category !== 'string') {
      throw new Error(`Tool '${tool.name}' must have a category`);
    }

    if (typeof tool.execute !== 'function') {
      throw new Error(`Tool '${tool.name}' must have an execute function`);
    }

    if (typeof tool.parameters !== 'object' || tool.parameters === null) {
      throw new Error(`Tool '${tool.name}' must have a parameters object`);
    }

    // The declared type is `?: true`, and the dispatches compare with `=== true`
    // so a truthy-but-not-true value cannot frame on one branch and not another
    // -- that is the branch-dependent framing #559 warns about. Rejecting the
    // value at registration removes the hazard class instead of relying on six
    // call sites staying strict.
    if (tool.failureIsOutsideContent !== undefined && tool.failureIsOutsideContent !== true) {
      throw new Error(`Tool '${tool.name}' may only set failureIsOutsideContent to true`);
    }

    for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
      if (!paramDef.type || typeof paramDef.type !== 'string') {
        throw new Error(`Parameter '${paramName}' in tool '${tool.name}' must have a type`);
      }

      if (!paramDef.description || typeof paramDef.description !== 'string') {
        throw new Error(`Parameter '${paramName}' in tool '${tool.name}' must have a description`);
      }

      if (typeof paramDef.required !== 'boolean') {
        throw new Error(`Parameter '${paramName}' in tool '${tool.name}' must specify if it's required`);
      }

      // `validateParameters` can only enforce an enum on a string value, so a
      // declared enum anywhere else would advertise a constraint that is
      // never checked. Fail at registration instead of shipping the no-op.
      if (paramDef.enum !== undefined) {
        if (!Array.isArray(paramDef.enum) || paramDef.enum.length === 0) {
          throw new Error(`Parameter '${paramName}' in tool '${tool.name}' has an empty enum`);
        }
        if (paramDef.type.toLowerCase() !== 'string') {
          throw new Error(
            `Parameter '${paramName}' in tool '${tool.name}' declares an enum but is type '${paramDef.type}'; enums are only enforced for strings`
          );
        }
        if (paramDef.enum.some((v) => typeof v !== 'string')) {
          throw new Error(`Parameter '${paramName}' in tool '${tool.name}' has a non-string enum value`);
        }
      }
    }
  }

  private validateParameters(tool: ToolDefinition, params: Record<string, unknown>): void {
    for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
      const value = params[paramName];

      if (paramDef.required && (value === undefined || value === null)) {
        throw new Error(`Required parameter '${paramName}' missing for tool '${tool.name}'`);
      }

      if (value !== undefined && value !== null) {
        const actualType = typeof value;
        const expectedType = paramDef.type.toLowerCase();

        if (expectedType === 'array' && !Array.isArray(value)) {
          throw new Error(
            `Parameter '${paramName}' for tool '${tool.name}' must be an array, got ${actualType}`
          );
        } else if (expectedType === 'object' && (actualType !== 'object' || Array.isArray(value))) {
          throw new Error(
            `Parameter '${paramName}' for tool '${tool.name}' must be an object, got ${actualType}`
          );
        } else if (
          expectedType !== 'array' &&
          expectedType !== 'object' &&
          actualType !== expectedType &&
          !(expectedType === 'number' && actualType === 'bigint')
        ) {
          throw new Error(
            `Parameter '${paramName}' for tool '${tool.name}' must be ${expectedType}, got ${actualType}`
          );
        }

        // An out-of-enum value is rejected here, with the allowed values in
        // the message: the orchestrator turns a throw into the tool result
        // the model reads, so an invented action gets corrected on the next
        // turn instead of reaching the sidecar as an opaque failure.
        //
        // Matched case-insensitively on purpose. Callers that already worked
        // keep working (`parsePostcondition` lowercases its input, and stored
        // workflow steps were written before any enum existed), and the value
        // is passed through unchanged rather than normalised, so this only
        // ever narrows what is rejected -- it never alters what a tool sees.
        if (paramDef.enum && paramDef.enum.length > 0 && typeof value === 'string') {
          const allowed = paramDef.enum;
          if (!allowed.some((v) => v.toLowerCase() === value.toLowerCase())) {
            throw new Error(
              `Parameter '${paramName}' for tool '${tool.name}' must be one of: ${allowed.join(', ')} (got "${value}")`
            );
          }
        }
      }
    }

    const unexpectedParams = Object.keys(params).filter(key => !tool.parameters[key]);
    if (unexpectedParams.length > 0) {
      console.warn(
        `Unexpected parameters for tool '${tool.name}': ${unexpectedParams.join(', ')}`
      );
    }
  }
}
