/**
 * NL workflow composer. Builds a draft flow from a plain-English description
 * by prompting the configured Jarvis LLM with the piece catalog + a schema
 * the response must conform to.
 *
 * The composer never edits live state on its own; it returns a parsed +
 * validated trigger tree that the caller (the manage_workflow tool) writes
 * via the existing flow / flow_version repos.
 */

import type {
  PieceInputField,
  PieceInputSchema,
} from "../../workflows/runtime/piece-input.ts";
import type { PieceLookup } from "../../workflows/runtime/piece-catalog.ts";

/**
 * Minimal LLM-client shape the composer needs. Single-shot
 * prompt -> `{ text }`. The daemon supplies an instance backed by
 * `LLMManager`; tests inject a stub. Kept inline (instead of importing the
 * legacy `PieceLlmClient` type) so the composer doesn't depend on the
 * deleted jarvis-pieces tree.
 */
export interface ComposerLlmClient {
  chat(input: { prompt: string; system?: string }): Promise<{ text: string }>;
}
import type { FlowTriggerNode } from "../../workflows/db/repos/flow-version.ts";
import { WORKFLOW_EVENT_TYPES } from "../../workflows/runtime/event-types.ts";

export interface ComposedFlow {
  displayName: string;
  trigger: FlowTriggerNode;
}

/**
 * Composer-side step shape. Identical to `FlowTriggerNode` (the persistence
 * shape) but with the type union narrowed to the values the composer
 * understands today. Kept as a separate name so call sites that work strictly
 * with composer output get tighter type narrowing in switches.
 */
export interface ComposedStep extends FlowTriggerNode {
  type: "EMPTY" | "PIECE_TRIGGER" | "PIECE" | "LOOP_ON_ITEMS" | "ROUTER";
  nextAction?: ComposedStep;
  firstLoopAction?: ComposedStep;
  children?: Array<ComposedStep | null>;
}

/** Activepieces' step-name regex. Identifier-style. */
const STEP_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface ComposeRequest {
  /** Display name for the new flow. */
  name: string;
  /** Plain-English description from the user. */
  description: string;
}

export interface ComposeOk {
  ok: true;
  flow: ComposedFlow;
  /** The raw LLM reply, kept for debugging / logging. */
  rawResponse: string;
}

export interface ComposeFail {
  ok: false;
  /** One or more reasons the compose attempt failed. */
  errors: string[];
  /** The raw LLM reply (if any) so the assistant can iterate. */
  rawResponse: string | null;
}

export type ComposeResult = ComposeOk | ComposeFail;

/**
 * Minimal specialist-role shape the composer needs to (a) list valid roles in
 * the prompt and (b) validate a `delegate` step's `role` against reality. The
 * daemon maps its richer `RoleDefinition` down to this; tests can pass literals.
 */
export interface ComposerSpecialistRole {
  /** Canonical role id — the value a delegate step's `input.role` must equal. */
  id: string;
  /** Human label, used only for the prompt listing. */
  name?: string;
  /** Short description, used only for the prompt listing. */
  description?: string;
}

/** Canonical short name of the sub-agent delegation piece. */
const AGENT_PIECE_SHORT = "jarvis-agent";
/** The delegate action on the agent piece, whose `role` we constrain. */
const DELEGATE_ACTION = "delegate";
/** Canonical short name of the generic tool-invocation piece. */
const TOOL_PIECE_SHORT = "jarvis-tool";
/** The invoke action on the tool piece, whose `params` we validate. */
const INVOKE_ACTION = "invoke";
/**
 * Router condition operators whose `secondValue` is a regex pattern. The engine
 * compiles these with JavaScript `RegExp`, so we validate them the same way --
 * catching unsupported syntax (e.g. inline flags `(?i)`) at compose time
 * instead of letting the run hang to a timeout on `InvalidRegexError`.
 */
const REGEX_CONDITION_OPERATORS = new Set(["TEXT_MATCHES_REGEX", "TEXT_DOES_NOT_MATCH_REGEX"]);

/**
 * Internal pieces that exist only for engine smoke-tests / plumbing checks and
 * must never appear in a real composed flow. They're hidden from the prompt
 * catalog AND rejected in validation -- the LLM was picking `jarvis-test:echo`
 * as a no-op fallback step, but echo's `value` is JSON-typed so a placeholder
 * like "ignored" fails with "Expected JSON" and the run dies. A fallback that
 * should do nothing is better expressed as an empty branch (null child).
 */
const COMPOSER_EXCLUDED_PIECES = new Set(["jarvis-test", "jarvis-validate"]);

/** True if `pieceFullName` is an internal piece the composer must not use. */
function isComposerExcludedPiece(pieceFullName: string): boolean {
  for (const short of COMPOSER_EXCLUDED_PIECES) {
    if (pieceFullName === short || pieceFullName.endsWith(`/piece-${short}`)) return true;
  }
  return false;
}

/** One parameter of a Jarvis tool, as surfaced to the composer. */
export interface ComposerToolParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

/**
 * A Jarvis tool's invocation contract: its name plus the parameters it accepts.
 * The composer lists these so the LLM wires `jarvis-tool { toolName, params }`
 * with the params a tool actually needs, and validates that the required ones
 * are present -- otherwise the model guesses (e.g. `{ query }` for a tool that
 * needs `{ action }`) and the step 500s at runtime.
 */
export interface ComposerToolSpec {
  name: string;
  description?: string;
  params: ComposerToolParam[];
}

export interface ComposeDeps {
  llm: ComposerLlmClient;
  pieceRegistry: PieceLookup;
  /**
   * Optional list of registered Jarvis tool names. When present, surfaced in
   * the planner prompt so the LLM can wire `jarvis-tool { toolName: '...' }`
   * for asks like "send a Gmail" without us having to declare every external
   * service as a piece.
   */
  toolNames?: string[];
  /**
   * Optional richer tool listing: each tool plus its parameter schema. When
   * present this supersedes `toolNames` in the prompt (the LLM sees which
   * params each tool requires) and enables compile-time validation of a
   * `jarvis-tool:invoke` step's `params`. Falls back to `toolNames` (names
   * only) when absent.
   */
  tools?: ComposerToolSpec[];
  /**
   * Optional set of specialist sub-agent roles. When present the composer
   * (a) lists the valid role ids in the prompt so the LLM picks a real one for
   * a `jarvis-agent:delegate` step, and (b) rejects any `delegate` step whose
   * `role` isn't in this set — feeding the mismatch back into the retry loop.
   * Without this the LLM would guess names like "researcher" that don't exist
   * (the real id is "research-analyst"), producing a flow that errors on every
   * run.
   */
  specialistRoles?: ComposerSpecialistRole[];
  /**
   * Cap on the LLM attempts inside one compose call. Each failed parse or
   * validation feeds back into the next attempt so the model can self-correct
   * without round-tripping through the calling agent. Default 4. Tests can
   * lower this to 1 to assert single-shot behavior; production should leave
   * it at the default to absorb weak-model noise.
   */
  maxAttempts?: number;
}

/**
 * Build + validate a draft flow from a description.
 *
 * Architecturally this is a small sub-agent loop: a single LLM client
 * runs up to `maxAttempts` rounds with the SAME big system prompt
 * (piece catalog, tool listing, format rules) and a USER prompt that
 * starts as the original request and becomes a feedback patch on
 * subsequent rounds. The calling agent (manage_workflow) sees only
 * the final outcome -- success or the last failure -- so it doesn't
 * pay context for the back-and-forth.
 *
 * Why a loop rather than returning each error to the caller:
 *   - Small / locally-hosted LLMs (Qwen3, DeepSeek-R1) often need 2-3
 *     tries to produce valid JSON. The main agent doesn't have the
 *     catalog in its context, so it can't usefully refine the request;
 *     looping HERE with the catalog already in scope is cheaper and
 *     produces better results.
 *   - The intermediate noise ("parse error", "step references unknown
 *     piece") stays inside this function; the main agent's
 *     conversation history doesn't fill with retry artifacts.
 *
 * Why not always loop indefinitely:
 *   - A genuinely impossible request (e.g., "send a fax") would burn
 *     attempts without converging. Cap is cheap insurance.
 *   - Latency: each attempt is a full LLM round-trip (1-10s on local
 *     models). Hard cap keeps the user-visible delay bounded.
 */
export async function composeFlow(
  deps: ComposeDeps,
  req: ComposeRequest,
): Promise<ComposeResult> {
  if (!req.name.trim()) return { ok: false, errors: ["name is required"], rawResponse: null };
  if (!req.description.trim()) return { ok: false, errors: ["description is required"], rawResponse: null };

  const catalogText = renderCatalog(deps.pieceRegistry);
  const toolsText = renderTools(deps.tools, deps.toolNames);
  const rolesText = renderSpecialistRoles(deps.specialistRoles);
  const system = buildSystemPrompt(catalogText, toolsText, rolesText);
  // Lookup of tool name -> spec for delegate/invoke param validation. Null when
  // the caller only gave names (or nothing) -- without schemas we can't tell a
  // missing-required-param from an intentionally-empty one, so we skip the check.
  const toolSpecs =
    deps.tools && deps.tools.length > 0
      ? new Map(deps.tools.map((t) => [t.name, t] as const))
      : null;
  // Set of valid role ids for delegate-step validation. Null when the caller
  // didn't supply roles -- in that case we can't tell a typo from a real id,
  // so we skip the check rather than reject everything.
  const validRoleIds =
    deps.specialistRoles && deps.specialistRoles.length > 0
      ? new Set(deps.specialistRoles.map((r) => r.id))
      : null;

  // Initial prompt: the user's description verbatim. Retry prompts
  // replace this with a feedback patch derived from the previous
  // failure (see below).
  let prompt = `User description: ${req.description.trim()}\n\nReturn ONLY the JSON object. No prose, no markdown fences.`;
  const maxAttempts = deps.maxAttempts ?? 4;
  let lastRaw: string | null = null;
  let lastErrors: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: string;
    try {
      const reply = await deps.llm.chat({ system, prompt });
      raw = reply.text.trim();
      lastRaw = raw;
    } catch (e) {
      // LLM call failure (network, provider unavailable) -- retrying
      // won't help. Bail out immediately rather than burning attempts.
      return {
        ok: false,
        errors: [`LLM call failed: ${(e as Error).message}`],
        rawResponse: lastRaw,
      };
    }

    let parsed: unknown;
    let parseError: string | null = null;
    try {
      parsed = JSON.parse(stripJsonFence(raw));
    } catch (e) {
      const len = raw.length;
      const tail = raw.slice(Math.max(0, len - 80));
      parseError =
        `${(e as Error).message} (rawResponse: ${len} chars, ends "..${tail.replace(/\n/g, "\\n")}")`;
    }

    if (parseError) {
      lastErrors = [`response was not valid JSON: ${parseError}`];
      if (attempt >= maxAttempts) break;
      // Feedback prompt: tell the model what was wrong and ask for a
      // clean JSON object. Keep it short -- system prompt still
      // carries the catalog + format rules.
      prompt =
        `Your previous reply could not be parsed as JSON. Error: ${parseError}\n\n` +
        `Return ONLY a single valid JSON object now. No prose, no markdown fences, no <think> blocks. ` +
        `Use the schema and rules from the system prompt.`;
      logAttempt(attempt, "parse-error", parseError);
      continue;
    }

    const validation = validateComposedFlow(parsed, deps.pieceRegistry, req.name, validRoleIds, toolSpecs);
    if (validation.ok) {
      if (attempt > 1) logAttempt(attempt, "success-after-retry", null);
      return { ok: true, flow: validation.flow, rawResponse: raw };
    }

    lastErrors = validation.errors;
    if (attempt >= maxAttempts) break;
    // Validation feedback: enumerate the specific failures so the
    // model can target them. Keep wording mechanical -- chatty
    // critique tends to make weak models over-correct elsewhere.
    prompt =
      `Your previous JSON failed validation:\n` +
      validation.errors.map((e) => `  - ${e}`).join("\n") +
      `\n\nReturn a new JSON object that fixes ALL of these issues. ` +
      `Keep the parts that were correct. Output ONLY the JSON, no prose.`;
    logAttempt(attempt, "validation-error", validation.errors.join("; "));
  }

  logAttempt(maxAttempts, "exhausted", lastErrors.join("; "));
  return { ok: false, errors: lastErrors, rawResponse: lastRaw };
}

/**
 * Single-line telemetry for the compose loop. Stays under console.log
 * (not a dedicated logger) so test runs don't spam unless explicitly
 * inspected. Daemon operators see this in stdout when a compose
 * struggles, which is enough signal to know whether the model needs
 * tuning vs the user's request is genuinely impossible.
 */
function logAttempt(attempt: number, status: string, detail: string | null): void {
  const tail = detail ? ` (${detail.length > 120 ? detail.slice(0, 117) + "..." : detail})` : "";
  console.log(`[compose] attempt ${attempt} ${status}${tail}`);
}

/* ---------------------------------------------------------- system prompt */

function buildSystemPrompt(catalog: string, toolsText: string, rolesText: string): string {
  return [
    "You are the Jarvis workflow composer. Convert the user's description into a workflow definition.",
    "",
    "Output a single JSON object with this exact shape:",
    '{ "displayName": "<short title>",',
    '  "trigger": { ',
    '    "name": "trigger",',
    '    "type": "EMPTY" | "PIECE_TRIGGER",',
    '    "displayName": "<optional>",',
    '    "settings": { "pieceName": "...", "triggerName": "...", "input": { ... } },',
    '    "nextAction": { "name": "step_1", "type": "PIECE", "settings": { "pieceName": "...", "actionName": "...", "input": { ... } }, "nextAction": { ... } }',
    "  } }",
    "",
    "Rules:",
    "  - The first node is named 'trigger'. Action steps are named 'step_1', 'step_2', etc.",
    "  - Step names MUST match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (identifier-style; no spaces or dashes).",
    "  - Use type='EMPTY' for manual / on-demand flows. Use type='PIECE_TRIGGER' for scheduled, webhook, or event-driven.",
    "  - For schedule triggers: pieceName='schedule', input.cron_expression='<5-field cron>' (e.g. '0 8 * * *' for 8am daily).",
    "  - For webhook triggers: pieceName='webhook', input.secret optional.",
    "  - For event triggers: pieceName='jarvis-trigger', triggerName='on_event', input.eventType='<event type>'.",
    "  - For action steps, type MUST be 'PIECE' and settings MUST include pieceName + actionName.",
    "  - To iterate over a list, emit a LOOP_ON_ITEMS step:",
    '      { "name": "loop_1", "type": "LOOP_ON_ITEMS", "settings": { "items": "{{step_1.list}}" }, "firstLoopAction": { ...body chain... }, "nextAction": { ...post-loop... } }',
    "    Inside the body, reference {{loop_1.item}} and {{loop_1.index}}.",
    "  - To branch on a condition, emit a ROUTER step:",
    '      { "name": "router_1", "type": "ROUTER",',
    '        "settings": { "executionType": "EXECUTE_FIRST_MATCH",',
    '          "branches": [',
    '            { "branchName": "high", "branchType": "CONDITION", "conditions": [[{ "firstValue": "{{step_1.score}}", "operator": "NUMBER_IS_GREATER_THAN", "secondValue": "0.7" }]] },',
    '            { "branchName": "fallback", "branchType": "FALLBACK" }',
    '          ] },',
    '        "children": [ { ...subgraph for high... }, { ...subgraph for fallback... } ] }',
    "    Conditions are 2D: outer array = OR, inner = AND. Operators include TEXT_CONTAINS, TEXT_EXACTLY_MATCHES, TEXT_MATCHES_REGEX, TEXT_DOES_NOT_MATCH_REGEX, NUMBER_IS_GREATER_THAN, NUMBER_IS_LESS_THAN, NUMBER_IS_EQUAL_TO, BOOLEAN_IS_TRUE, BOOLEAN_IS_FALSE, EXISTS, DOES_NOT_EXIST, LIST_IS_EMPTY, LIST_IS_NOT_EMPTY, LIST_CONTAINS.",
    "    For regex operators: secondValue is a JavaScript RegExp pattern (no slashes, no flags suffix). JS RegExp does NOT support inline",
    "    flags -- '(?i)', '(?m)', '(?s)' are INVALID and throw at runtime. For case-insensitivity use character classes instead, e.g.",
    "    '[Nn]o documents found' rather than '(?i)no documents found'. Prefer TEXT_CONTAINS over regex when a plain substring will do.",
    "    Match the operator to the UPSTREAM STEP'S ACTUAL OUTPUT SHAPE (from its `output` sample in the catalog):",
    "      * If the value is a LIST/array, use LIST_IS_EMPTY / LIST_IS_NOT_EMPTY to test 'did it return anything' -- never a regex.",
    "      * If the value is a STRING, use TEXT_CONTAINS / TEXT_EXACTLY_MATCHES against the actual wording.",
    "      * If the value is a NUMBER, use the NUMBER_* operators; for presence use EXISTS / DOES_NOT_EXIST.",
    "    NEVER hand-write a regex that assumes a shape the output doesn't have. In particular, do NOT test a STRING output against an",
    "    empty-array pattern like '^\\s*\\[\\s*\\]\\s*$' -- a human-readable string (e.g. 'No documents found.') will never match it, so",
    "    the branch evaluates backwards. To check whether a search/list returned results, prefer a step whose output is a real list and",
    "    use LIST_IS_NOT_EMPTY; if you only have a string, test its actual empty-wording with TEXT_CONTAINS.",
    "  - Use {{trigger.field}} and {{step_N.field}} templates to wire data between steps.",
    "  - For jarvis-trigger:on_event, the trigger output is an event envelope shaped",
    "    { id, eventType, payload, timestamp } -- the actual event data lives under `payload`.",
    "    Reference payload fields as {{trigger.payload.<field>}}, NOT {{trigger.<field>}}.",
    "    Example: clipboard text is {{trigger.payload.content}}; an email's subject is {{trigger.payload.subject}}.",
    "  - Field names in `{{step.field}}` MUST exist on that step's declared `output` (see each action / trigger in the catalog).",
    "    Do not guess fields from the user's wording -- for example, a piece whose output is `{ result: ... }` is referenced as",
    "    `{{step.result}}`, NOT `{{step.content}}` just because the user said 'content'. If a piece has no declared output, the",
    "    safe choice is `{{step}}` (the whole output) and let downstream steps drill in.",
    "  - Every required input field MUST be present.",
    "  - The composed flow is created DISABLED. Do NOT claim the flow is running; the user reviews and publishes it explicitly.",
    "  - When the user asks for an integration that isn't a registered piece (Gmail, Slack, ...), use the `jarvis-tool` piece with `toolName` set to a registered Jarvis tool. Available tools are listed below.",
    rolesText
      ? "  - To hand a goal to a sub-agent, use the `jarvis-agent` piece's `delegate` action. Its optional `input.role` MUST be one of the specialist role ids listed below VERBATIM (e.g. `research-analyst`, not `researcher`). If none fits, OMIT `role` and the default agent handles it."
      : "  - To hand a goal to a sub-agent, use the `jarvis-agent` piece's `delegate` action with `input.goal`. Omit `input.role` to use the default agent.",
    "  - Output ONLY the JSON. No markdown. No explanation.",
    "",
    "Available pieces:",
    catalog,
    toolsText ? "" : "",
    toolsText,
    rolesText ? "" : "",
    rolesText,
  ].filter((s) => s !== "").join("\n");
}

/**
 * Render the Jarvis tool listing for the prompt. Prefers the richer `tools`
 * (name + params, with required ones flagged) so the LLM wires correct
 * `params`; falls back to a bare name list when only names are available.
 */
function renderTools(
  tools: ComposerToolSpec[] | undefined,
  toolNames: string[] | undefined,
): string {
  if (tools && tools.length > 0) {
    const header =
      "Available Jarvis tools (call via `jarvis-tool { toolName, params: { ... } }`; include EVERY param marked REQUIRED):";
    const lines = [header];
    for (const t of tools) {
      lines.push(`  - ${t.name}${t.description ? `: ${firstLine(t.description)}` : ""}`);
      for (const p of t.params) {
        const req = p.required ? ", REQUIRED" : "";
        const desc = p.description ? ` -- ${firstLine(p.description)}` : "";
        lines.push(`      param ${p.name} (${p.type}${req})${desc}`);
      }
    }
    return lines.join("\n");
  }
  if (toolNames && toolNames.length > 0) {
    return [
      "Available Jarvis tools (call via `jarvis-tool { toolName, params }`):",
      ...toolNames.map((n) => `  - ${n}`),
    ].join("\n");
  }
  return "";
}

/**
 * List the valid specialist role ids for a `jarvis-agent:delegate` step. The
 * id is what `input.role` must equal verbatim; the name/description are hints
 * so the LLM maps the user's intent ("research AI news") to the right id
 * ("research-analyst") instead of inventing one.
 */
function renderSpecialistRoles(roles: ComposerSpecialistRole[] | undefined): string {
  if (!roles || roles.length === 0) return "";
  return [
    "Available specialist sub-agent roles (for `jarvis-agent:delegate` -> `input.role`; use the id verbatim):",
    ...roles.map((r) => {
      const desc = r.description ? `: ${firstLine(r.description)}` : "";
      const label = r.name && r.name !== r.id ? ` (${r.name})` : "";
      return `  - ${r.id}${label}${desc}`;
    }),
  ].join("\n");
}

/** First non-empty trimmed line of a (possibly multi-line) string. */
function firstLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t) return t.length > 100 ? t.slice(0, 97) + "..." : t;
  }
  return "";
}

function renderCatalog(registry: PieceLookup): string {
  const lines: string[] = [];
  for (const piece of registry.list()) {
    // Internal test/plumbing pieces are never valid in a real flow -- don't
    // even show them to the model.
    if (isComposerExcludedPiece(piece.name)) continue;
    lines.push(`- ${piece.name} (${piece.displayName}): ${piece.description}`);
    for (const trigger of Object.values(piece.triggers ?? {})) {
      lines.push(`    trigger ${trigger.name}: ${trigger.description}`);
      lines.push(...renderSchemaLines(trigger.inputSchema, 6));
      // Triggers carry the upstream-native `sampleData`; some pieces
      // also set `outputSample` (Jarvis extension). Either is a valid
      // hint -- prefer sampleData when present.
      lines.push(...renderOutputLines((trigger as { sampleData?: unknown; outputSample?: unknown }).sampleData ?? (trigger as { outputSample?: unknown }).outputSample, 6));
      // Dynamic-output triggers: emit a per-value sample block so the
      // model sees the EXACT envelope it should wire from for each
      // configured input value (rather than mentally splicing the
      // generic `sampleData` envelope with a separate payload-example
      // catalog). This is the future-proof channel -- adding a new
      // event type to `WORKFLOW_EVENT_TYPES` lights up here too.
      const dyn = (trigger as {
        dynamicSampleData?: { propName: string; samples: Record<string, unknown> };
      }).dynamicSampleData;
      if (dyn && Object.keys(dyn.samples).length > 0) {
        lines.push(`      output samples by ${dyn.propName} (the trigger's actual output for each value):`);
        for (const [value, sample] of Object.entries(dyn.samples)) {
          lines.push(`        ${value}: ${JSON.stringify(sample)}`);
        }
      }
    }
    for (const action of Object.values(piece.actions)) {
      lines.push(`    action  ${action.name}: ${action.description}`);
      lines.push(...renderSchemaLines(action.inputSchema, 6));
      lines.push(...renderOutputLines((action as { outputSample?: unknown }).outputSample, 6));
    }
  }
  // Surface the schedule and webhook primitives the trigger manager understands
  // even though they aren't in the piece catalog today.
  lines.push("");
  lines.push("Built-in trigger primitives (no piece registration needed):");
  lines.push("- schedule: settings={pieceName:'schedule', input:{cron_expression:'0 8 * * *'}} fires on cron.");
  lines.push("- webhook:  settings={pieceName:'webhook',  input:{secret:'<optional HMAC secret>'}} fires on HTTP POST to /api/webhooks/<flow_id>.");

  // Workflow event-type catalog (used by jarvis-trigger:on_event flows).
  lines.push("");
  lines.push("Available event types for jarvis-trigger:on_event (settings.input.eventType):");
  lines.push("  Each event's payload fields below are accessed from downstream steps via {{trigger.payload.<field>}} (the trigger wraps the payload in an envelope -- see the wiring rules above).");
  for (const meta of WORKFLOW_EVENT_TYPES) {
    lines.push(`- ${meta.type}: ${meta.description}`);
    if (meta.payloadExample) {
      lines.push(`    payload example: ${JSON.stringify(meta.payloadExample)}`);
    }
  }
  return lines.join("\n");
}

function renderSchemaLines(schema: PieceInputSchema | undefined, indent: number): string[] {
  if (!schema) return [];
  const pad = " ".repeat(indent);
  return schema.fields.map((f) => `${pad}- input.${f.name}: ${formatField(f)}`);
}

/**
 * Render an action / trigger output sample so the LLM can wire
 * `{{step.field}}` references against real field names instead of
 * guessing from the user's wording. Two patterns emitted:
 *
 *   - Object sample (most actions): emit `output: { field1: <example>, ... }`.
 *     The example values are short representative literals (numbers
 *     keep their value, strings get quoted, nested objects collapse to
 *     `{...}`, arrays to `[...]`) so the prompt stays compact even for
 *     wide outputs.
 *   - Array sample (list-returning pieces): emit `output: [{ field1, ... }]`
 *     surfacing the first element's keys so the model knows how to
 *     drill in after a LOOP_ON_ITEMS.
 *
 * No output is emitted when the piece didn't declare one (undefined),
 * keeping the prompt small for pieces still picker-blind.
 */
function renderOutputLines(sample: unknown, indent: number): string[] {
  if (sample === undefined || sample === null) return [];
  const pad = " ".repeat(indent);
  if (Array.isArray(sample)) {
    if (sample.length === 0) return [`${pad}- output: []`];
    const first = sample[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      return [`${pad}- output: [${renderObjectInline(first as Record<string, unknown>)}, ...] (array)`];
    }
    return [`${pad}- output: [${formatScalar(first)}, ...] (array)`];
  }
  if (typeof sample === "object") {
    return [`${pad}- output: ${renderObjectInline(sample as Record<string, unknown>)}`];
  }
  // Primitive output (rare but valid) -- show the value.
  return [`${pad}- output: ${formatScalar(sample)}`];
}

function renderObjectInline(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj).map(([k, v]) => `${k}: ${formatScalar(v)}`);
  return `{ ${entries.join(", ")} }`;
}

function formatScalar(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    // Keep examples short -- long string literals just bloat the prompt.
    const trimmed = v.length > 40 ? v.slice(0, 37) + "..." : v;
    return JSON.stringify(trimmed);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.length === 0 ? "[]" : "[...]";
  if (typeof v === "object") return "{...}";
  return JSON.stringify(v);
}

function formatField(f: PieceInputField): string {
  const parts: string[] = [`${f.type}${f.required ? ", REQUIRED" : ""}`];
  if (f.options && f.options.length > 0) {
    parts.push(`options=${f.options.map((o) => o.value).join("|")}`);
  }
  if (f.type === "flow_ref") {
    // The composer has no way to know which workflows exist on the
    // user's machine -- any flow id the LLM invents will fail at
    // run time. Tell it to emit an empty string for this field so
    // the user picks the target via the editor's flow picker after
    // the flow is composed.
    parts.push('emit an empty string ""; user picks the target workflow via the editor');
  }
  if (f.description) parts.push(f.description);
  return `${parts.join("; ")}`;
}

/* ------------------------------------------------------------- validation */

interface ValidationOk { ok: true; flow: ComposedFlow }
interface ValidationFail { ok: false; errors: string[] }

function validateComposedFlow(
  raw: unknown,
  registry: PieceLookup,
  fallbackName: string,
  validRoleIds: Set<string> | null,
  toolSpecs: Map<string, ComposerToolSpec> | null,
): ValidationOk | ValidationFail {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: ["expected an object at the top level"] };
  }
  const root = raw as Record<string, unknown>;
  const displayName = typeof root.displayName === "string" && root.displayName.trim() ? root.displayName.trim() : fallbackName;
  const triggerRaw = root.trigger;
  if (typeof triggerRaw !== "object" || triggerRaw === null) {
    return { ok: false, errors: ["missing or invalid 'trigger' object"] };
  }
  const errors: string[] = [];
  const knownNames = new Set<string>();
  const trigger = validateStep(triggerRaw as Record<string, unknown>, errors, knownNames, true, registry, validRoleIds, toolSpecs);
  if (!trigger) return { ok: false, errors };

  // Walk subsequent actions.
  let cursor: Record<string, unknown> | null = (triggerRaw as Record<string, unknown>).nextAction
    ? ((triggerRaw as Record<string, unknown>).nextAction as Record<string, unknown>)
    : null;
  let last: ComposedStep = trigger;
  let depth = 0;
  while (cursor) {
    if (++depth > 100) {
      errors.push("flow exceeds 100 steps");
      break;
    }
    const step = validateStep(cursor, errors, knownNames, false, registry, validRoleIds, toolSpecs);
    if (!step) break;
    last.nextAction = step;
    last = step;
    cursor = cursor.nextAction ? (cursor.nextAction as Record<string, unknown>) : null;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, flow: { displayName, trigger } };
}

function validateStep(
  raw: Record<string, unknown>,
  errors: string[],
  knownNames: Set<string>,
  isTrigger: boolean,
  registry: PieceLookup,
  validRoleIds: Set<string> | null,
  toolSpecs: Map<string, ComposerToolSpec> | null,
): ComposedStep | null {
  const name = typeof raw.name === "string" ? raw.name : null;
  if (!name) {
    errors.push(isTrigger ? "trigger missing name" : "action step missing name");
    return null;
  }
  if (!STEP_NAME_REGEX.test(name)) {
    errors.push(
      `step name "${name}" must match identifier pattern /^[a-zA-Z_][a-zA-Z0-9_]*$/ (no spaces, dashes, etc.)`,
    );
    return null;
  }
  if (knownNames.has(name)) {
    errors.push(`duplicate step name: ${name}`);
    return null;
  }
  knownNames.add(name);

  const type = raw.type;
  if (isTrigger) {
    if (type !== "EMPTY" && type !== "PIECE_TRIGGER") {
      errors.push(`trigger.type must be EMPTY or PIECE_TRIGGER (got ${String(type)})`);
      return null;
    }
  } else if (type !== "PIECE" && type !== "LOOP_ON_ITEMS" && type !== "ROUTER") {
    errors.push(`action step "${name}" type must be PIECE | LOOP_ON_ITEMS | ROUTER (got ${String(type)})`);
    return null;
  }

  const step: ComposedStep = {
    name,
    type: type as ComposedStep["type"],
  };
  if (typeof raw.displayName === "string") step.displayName = raw.displayName;

  const settingsRaw = raw.settings;
  if (settingsRaw !== undefined) {
    if (typeof settingsRaw !== "object" || settingsRaw === null || Array.isArray(settingsRaw)) {
      errors.push(`step "${name}" settings must be an object`);
      return null;
    }
    step.settings = settingsRaw as ComposedStep["settings"];
  }

  if (type === "EMPTY") return step; // manual trigger is always valid

  // LOOP_ON_ITEMS: validate items expression + recurse into firstLoopAction.
  if (type === "LOOP_ON_ITEMS") {
    const settings = step.settings as { items?: unknown } | undefined;
    if (!settings || typeof settings.items !== "string" || settings.items.length === 0) {
      errors.push(`loop "${name}" missing settings.items`);
    }
    const inner = (raw.firstLoopAction as Record<string, unknown> | undefined) ?? null;
    // Build AND attach the loop body. Validating it without attaching (the old
    // bug) left every composed loop with no firstLoopAction -- the engine ran
    // an empty loop and the editor showed the flow "stopping" at the loop node.
    if (inner) {
      const body = buildInnerChain(inner, errors, knownNames, registry, validRoleIds, toolSpecs);
      if (body) step.firstLoopAction = body;
    }
    return step;
  }

  // ROUTER: validate branches + recurse into each child subgraph.
  if (type === "ROUTER") {
    const settings = step.settings as
      | { branches?: Array<Record<string, unknown>>; executionType?: unknown }
      | undefined;
    if (!settings || !Array.isArray(settings.branches) || settings.branches.length === 0) {
      errors.push(`router "${name}" missing settings.branches`);
      return step;
    }
    const childCount = Array.isArray(raw.children) ? (raw.children as unknown[]).length : 0;
    if (childCount !== settings.branches.length) {
      errors.push(`router "${name}" children count (${childCount}) does not match branches count (${settings.branches.length})`);
    }
    // Compile every regex condition exactly as the engine will (JS RegExp), so
    // an unsupported pattern (e.g. an inline `(?i)` flag) fails validation here
    // and feeds the retry loop, rather than throwing InvalidRegexError mid-run
    // and hanging the flow until the executor timeout.
    validateRouterRegexes(name, settings.branches, errors);
    // Build AND attach each branch subgraph, preserving index alignment with
    // `branches` (a null entry = an empty branch). Same bug as loops: the old
    // code validated children but never attached them, so every composed
    // router persisted with no children and the branches did nothing.
    if (Array.isArray(raw.children)) {
      step.children = (raw.children as Array<unknown>).map((child) =>
        child && typeof child === "object"
          ? buildInnerChain(child as Record<string, unknown>, errors, knownNames, registry, validRoleIds, toolSpecs)
          : null,
      );
    }
    return step;
  }

  const settings = step.settings ?? {};
  const pieceName = typeof settings.pieceName === "string" ? settings.pieceName : null;
  if (!pieceName) {
    errors.push(`step "${name}" missing settings.pieceName`);
    return step;
  }

  // Schedule + webhook are runtime primitives, not registered pieces.
  if (isTrigger && (pieceName === "schedule" || pieceName === "webhook")) {
    return step;
  }

  // Resolve short names to canonical npm names. The system prompt
  // tells the LLM to use forms like `jarvis-trigger` and `jarvis-tool`
  // (because that's the short identity humans use), but the catalog
  // is keyed by the full npm package name like
  // `@jarvispieces/piece-jarvis-trigger`. Without this resolution the
  // composer would lose every Jarvis-piece flow on a validation error
  // even though the LLM picked the right piece.
  //
  // Resolution: try the exact name first; on miss walk the catalog
  // for any piece whose name ends with `/piece-<short>` or is exactly
  // `<short>`. Ambiguity (multiple matches) keeps the original miss
  // semantic -- safer than silently picking one.
  let piece = registry.get(pieceName);
  if (!piece) {
    const matches = registry
      .list()
      .filter((p) => p.name === pieceName || p.name.endsWith(`/piece-${pieceName}`));
    if (matches.length === 1) {
      piece = matches[0]!;
      // Persist the canonical name so the engine sees it at runtime.
      if (step.settings) step.settings = { ...step.settings, pieceName: piece.name };
    }
  }
  if (!piece) {
    errors.push(`step "${name}" references unknown piece "${pieceName}"`);
    return step;
  }

  // Reject internal test/plumbing pieces even if the model named one directly
  // (they're hidden from the catalog, but a model can still hallucinate them).
  if (isComposerExcludedPiece(piece.name)) {
    errors.push(
      `step "${name}" uses internal piece "${pieceName}", which isn't available for workflows. ` +
        `For a branch that should do nothing, leave it empty (a null child) instead of adding a step.`,
    );
    return step;
  }

  const subKey = isTrigger ? "triggerName" : "actionName";
  const subName = typeof settings[subKey] === "string" ? (settings[subKey] as string) : null;
  if (!subName) {
    errors.push(`step "${name}" missing settings.${subKey}`);
    return step;
  }

  const sub = isTrigger
    ? piece.triggers?.[subName]
    : piece.actions[subName];
  if (!sub) {
    errors.push(`step "${name}" references unknown ${isTrigger ? "trigger" : "action"} ${pieceName}:${subName}`);
    return step;
  }

  // Required-field check.
  const input = (settings.input ?? {}) as Record<string, unknown>;
  const schema = (sub as { inputSchema?: PieceInputSchema }).inputSchema;
  if (schema) {
    for (const field of schema.fields) {
      if (!field.required) continue;
      // `flow_ref` is required at run time but cannot be filled at
      // compose time: the LLM has no list of valid flow ids on the
      // user's machine. The editor's flow picker fills it after the
      // flow is composed. Exempt from this check so the LLM doesn't
      // hallucinate an id just to satisfy validation.
      if (field.type === "flow_ref") continue;
      const v = input[field.name];
      const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
      if (empty) {
        errors.push(`step "${name}" (${pieceName}:${subName}) missing required input "${field.name}"`);
      }
    }
  }

  // Delegate-role check: a `jarvis-agent:delegate` step's optional `role` must
  // name a specialist that actually exists. The LLM otherwise invents plausible
  // ids ("researcher") that have no role file, so the flow errors on every run.
  // Only enforced when the caller supplied the valid set; skipped for templated
  // values ({{...}}) since those resolve at runtime. `piece` is canonical here
  // (short names were rewritten above), so match on either form.
  if (
    !isTrigger &&
    subName === DELEGATE_ACTION &&
    validRoleIds &&
    (piece.name === AGENT_PIECE_SHORT || piece.name.endsWith(`/piece-${AGENT_PIECE_SHORT}`))
  ) {
    const role = input.role;
    if (typeof role === "string" && role.trim() && !role.includes("{{")) {
      if (!validRoleIds.has(role.trim())) {
        const valid = Array.from(validRoleIds).sort().join(", ");
        errors.push(
          `step "${name}" delegates to unknown specialist role "${role}". ` +
            `Use one of these ids verbatim (or omit role for the default agent): ${valid}`,
        );
      }
    }
  }

  // Invoke-params check: a `jarvis-tool:invoke` step names a tool in
  // `input.toolName` and passes `input.params`. Multi-action tools require an
  // `action` param (and others); the LLM otherwise guesses params like
  // `{ query }` and the step 500s with "Required parameter 'X' missing". When
  // the caller supplied tool schemas, enforce the tool's REQUIRED params so the
  // miss is caught here and fed back into the retry loop.
  if (
    !isTrigger &&
    subName === INVOKE_ACTION &&
    toolSpecs &&
    (piece.name === TOOL_PIECE_SHORT || piece.name.endsWith(`/piece-${TOOL_PIECE_SHORT}`))
  ) {
    const toolName = typeof input.toolName === "string" ? input.toolName.trim() : "";
    if (toolName) {
      const spec = toolSpecs.get(toolName);
      if (!spec) {
        const known = Array.from(toolSpecs.keys()).sort().join(", ");
        errors.push(
          `step "${name}" invokes unknown tool "${toolName}". Valid toolName values: ${known}`,
        );
      } else {
        const params =
          input.params && typeof input.params === "object" && !Array.isArray(input.params)
            ? (input.params as Record<string, unknown>)
            : {};
        const missing = spec.params
          .filter((p) => p.required)
          .map((p) => p.name)
          .filter((pn) => {
            const v = params[pn];
            // Present-but-templated ({{...}}) counts as present.
            return v === undefined || v === null || v === "";
          });
        if (missing.length > 0) {
          const reqList = spec.params
            .filter((p) => p.required)
            .map((p) => p.name)
            .join(", ");
          errors.push(
            `step "${name}" invokes tool "${toolName}" but is missing required param(s): ${missing.join(", ")}. ` +
              `${toolName} requires: ${reqList || "(none)"}. Put them in settings.input.params.`,
          );
        }
      }
    }
  }
  return step;
}

/**
 * Compile every regex-operator condition in a router's branches with JS
 * `RegExp` (the same engine the runtime uses) and report any that don't
 * compile. Catches the common LLM mistake of inline flags like `(?i)`, which
 * JS RegExp rejects -- left unchecked it throws InvalidRegexError mid-run and
 * the flow hangs until the executor timeout. Patterns containing `{{...}}` are
 * skipped (they resolve at runtime and aren't a static pattern).
 */
function validateRouterRegexes(
  routerName: string,
  branches: Array<Record<string, unknown>>,
  errors: string[],
): void {
  for (const branch of branches) {
    const conditions = (branch as { conditions?: unknown }).conditions;
    if (!Array.isArray(conditions)) continue;
    const branchName = typeof branch.branchName === "string" ? branch.branchName : "?";
    // `conditions` is 2D (OR of ANDs); tolerate a flat 1D array defensively.
    const groups = conditions.every((g) => Array.isArray(g)) ? conditions : [conditions];
    for (const group of groups as unknown[][]) {
      for (const cond of group) {
        if (!cond || typeof cond !== "object") continue;
        const c = cond as { operator?: unknown; secondValue?: unknown };
        if (typeof c.operator !== "string" || !REGEX_CONDITION_OPERATORS.has(c.operator)) continue;
        if (typeof c.secondValue !== "string" || c.secondValue.includes("{{")) continue;
        try {
          new RegExp(c.secondValue);
        } catch (e) {
          errors.push(
            `router "${routerName}" branch "${branchName}" has an invalid regex for ${c.operator}: ` +
              `"${c.secondValue}" -- ${(e as Error).message}. The engine uses JavaScript RegExp, which does NOT support ` +
              `inline flags like (?i); use character classes (e.g. [Nn]o) or switch to TEXT_CONTAINS.`,
          );
        }
      }
    }
  }
}

/**
 * Validate AND build an inner chain reachable from a LOOP body or a ROUTER
 * branch, returning its head step with the `nextAction` chain wired up (or
 * null if the head step was invalid). Same logic as the top-level walk but
 * without the trigger-specific checks. Errors are appended to the shared list.
 *
 * Returning the built subtree (rather than validating as a side effect and
 * discarding it) is what lets the caller attach `firstLoopAction` / `children`
 * so loop bodies and router branches actually persist.
 */
function buildInnerChain(
  head: Record<string, unknown>,
  errors: string[],
  knownNames: Set<string>,
  registry: PieceLookup,
  validRoleIds: Set<string> | null,
  toolSpecs: Map<string, ComposerToolSpec> | null,
): ComposedStep | null {
  let cursor: Record<string, unknown> | null = head;
  let first: ComposedStep | null = null;
  let last: ComposedStep | null = null;
  let depth = 0;
  while (cursor) {
    if (++depth > 100) {
      errors.push("inner subgraph exceeds 100 steps");
      break;
    }
    const step = validateStep(cursor, errors, knownNames, false, registry, validRoleIds, toolSpecs);
    if (!step) break;
    if (!first) first = step;
    if (last) last.nextAction = step;
    last = step;
    cursor = cursor.nextAction ? (cursor.nextAction as Record<string, unknown>) : null;
  }
  return first;
}

/**
 * Best-effort cleanup of an LLM reply before JSON.parse:
 *
 *   1. Strip <think>...</think> blocks. Reasoning models (Qwen3, DeepSeek-R1,
 *      o1-style) emit a long chain-of-thought before the answer. If the
 *      closing tag is missing (response truncated mid-thought), drop
 *      everything from `<think>` onward.
 *   2. Strip surrounding markdown code fences when the whole reply is
 *      wrapped in ```json ... ```.
 *   3. Last-resort extract: find the first `{` and the last `}` and
 *      return the slice between them. Catches replies that have prose
 *      before/after the JSON without a fence.
 */
function stripJsonFence(text: string): string {
  let s = text.trim();
  // Reasoning-block strip. We try the well-formed pair first; if the
  // closing tag is missing the response truncated mid-thought and the
  // JSON never started -- drop everything we got so JSON.parse errors
  // with "Unexpected end of input" instead of a confusing "Unexpected
  // token <".
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (s.startsWith("<think>") && !s.includes("</think>")) {
    s = "";
  }
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(s);
  if (fence && typeof fence[1] === "string") s = fence[1].trim();
  // Last-resort: extract the outermost {...} block. Only kicks in when
  // s isn't already a JSON object (cheap startsWith check).
  if (!s.startsWith("{")) {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
  }
  return s;
}
