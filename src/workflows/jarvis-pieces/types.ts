/**
 * Jarvis-native pieces -- shared types.
 *
 * These pieces live in Jarvis (not in the vendored activepieces tree) and use
 * a minimal local interface rather than the vendored `createPiece` framework.
 * Reasons:
 *   1. Vendored code uses Nx workspace path aliases (`@activepieces/*`) that
 *      we deliberately exclude from the project's tsc. Importing
 *      `createPiece` from the vendored tree would put our pieces in the same
 *      tsc-untyped boat.
 *   2. Until the engine subprocess is wired up, pieces don't actually need
 *      the vendored framework -- they need a typed interface we can call
 *      directly from tests and from a future executor.
 *
 * When engine integration lands, each Jarvis piece is wrapped in upstream's
 * `createPiece({ actions: [createAction(...)] })` by a thin adapter. The
 * adapter is mechanical; the action handlers don't need to change.
 *
 * Naming:
 *   piece.name      = "jarvis-ask" (kebab; matches activepieces convention)
 *   action.name     = "ask"        (verb; the operation)
 *   workflow ref    = "jarvis-ask:ask"
 */

export interface JarvisPieceContext {
  /** Optional logger; default is silent. Pass console.log in dev. */
  log?: (line: string) => void;
  /** Inject services as needed. Each piece declares which subset it requires. */
  services: JarvisPieceServices;
}

/**
 * Service surface available to piece actions. Each piece reads only the
 * services it needs; tests inject stubs. Adding a new service here requires
 * the daemon bootstrap to populate it (or pieces that don't use it work
 * regardless).
 *
 * All services are optional from the type's perspective so individual pieces
 * can construct a minimal context for tests. A piece that needs a service it
 * didn't get throws at execute() time with a clear message.
 */
export interface JarvisPieceServices {
  llm?: PieceLlmClient;
  toolRegistry?: PieceToolRegistry;
  notifier?: PieceNotifier;
  context?: PieceContextProvider;
  agentDelegator?: PieceAgentDelegator;
  eventBus?: PieceEventBus;
  workflowRunner?: PieceWorkflowRunner;
}

/**
 * Subscribe-style event bus exposed to triggers. The daemon's implementation
 * adapts the Jarvis event reactor (M5/M13) to this surface.
 *
 * Event types are free-form strings -- the daemon publishes its catalog
 * (e.g. "awareness.context_changed", "commitment.due", "voice.intent",
 * "tool.executed"). `listEventTypes()` lets the UI render a dropdown.
 */
export interface PieceEventBus {
  subscribe(
    eventType: string,
    handler: (payload: Record<string, unknown>) => void,
  ): () => void;
  listEventTypes(): string[];
}

/** Run a saved workflow by id. The runner enqueues a job and returns the run id.
 * When `callerRunId` is provided, the runner walks the caller's parent-run chain
 * and refuses if the target flow appears anywhere in it (catches both direct
 * self-recursion and deeper cycles). */
export interface PieceWorkflowRunner {
  start(input: PieceWorkflowStartInput, callerRunId?: string): Promise<PieceWorkflowStartResult>;
}

export interface PieceWorkflowStartInput {
  flowId: string;
  payload?: Record<string, unknown>;
}

export interface PieceWorkflowStartResult {
  runId: string;
}

/**
 * Trigger definition. Unlike actions, triggers are not invoked once -- they
 * are subscribed when the parent workflow is enabled and unsubscribed on
 * disable. The trigger fires by calling `onFire(payload)`; the runtime turns
 * each fire into a flow run.
 */
export interface JarvisTrigger<I = unknown> {
  name: string;
  displayName: string;
  description: string;
  inputSchema?: PieceInputSchema;
  parseInput: (raw: unknown) => I;
  /** Called when the parent workflow is enabled. Returns an unsubscribe fn. */
  subscribe: (input: I, ctx: JarvisTriggerContext) => Promise<TriggerSubscription>;
}

export interface JarvisTriggerContext extends JarvisPieceContext {
  /** Called by the trigger to fire a flow run. Payload is forwarded to RUN_FLOW. */
  onFire: (payload: Record<string, unknown>) => Promise<void>;
}

export interface TriggerSubscription {
  unsubscribe: () => Promise<void>;
}

/**
 * Delegate a sub-agent run to M7. The daemon's implementation calls
 * `assignPersistentAgentTask` (or equivalent) and waits for completion.
 *
 * `role` corresponds to M7's specialist role names (researcher, planner, ...).
 * `maxIterations` caps the agent's tool loop.
 */
export interface PieceAgentDelegator {
  delegate(input: PieceAgentDelegateInput): Promise<PieceAgentDelegateResult>;
}

export interface PieceAgentDelegateInput {
  goal: string;
  role?: string;
  maxIterations?: number;
}

export type PieceAgentRunStatus = "completed" | "max_iterations" | "error" | "canceled";

export interface PieceAgentToolCall {
  name: string;
  /** JSON-stringified arguments. Pieces don't introspect them. */
  args?: string;
  /** Stringified result (truncated to a sensible size by the delegator). */
  result?: string;
  error?: string;
}

export interface PieceAgentDelegateResult {
  /** The agent's final message to the user. May be empty if status='error'. */
  finalMessage: string;
  toolCalls: PieceAgentToolCall[];
  status: PieceAgentRunStatus;
  /** Optional error detail when status='error'. */
  error?: string;
}

/**
 * Read-only surface over Jarvis state used by `jarvis-context`. The daemon's
 * implementation reads directly from the vault DB and from the awareness /
 * commitment services. Tests inject stubs.
 *
 * Returned values are POJOs (no class instances) so they survive any future
 * subprocess IPC boundary unchanged.
 */
export interface PieceContextProvider {
  vaultSearch(input: VaultSearchInput): Promise<VaultEntitySnapshot[]>;
  vaultGetEntity(id: string): Promise<VaultEntitySnapshot | null>;
  awarenessRecent(input: AwarenessRecentInput): Promise<AwarenessActivitySnapshot[]>;
  commitmentsList(input: CommitmentsListInput): Promise<CommitmentSnapshot[]>;
}

export type VaultEntityType = "person" | "project" | "tool" | "place" | "concept" | "event";

export interface VaultSearchInput {
  /** Free-text fragment matched against entity name (substring, case-insensitive). */
  query?: string;
  type?: VaultEntityType;
  /** Cap. Default 25. */
  limit?: number;
}

export interface VaultEntitySnapshot {
  id: string;
  type: VaultEntityType;
  name: string;
  properties: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface AwarenessRecentInput {
  /** Cap. Default 25. */
  limit?: number;
  /** Optional epoch-ms cutoff: only items with start_time >= since. */
  since?: number;
}

export interface AwarenessActivitySnapshot {
  id: string;
  appName: string | null;
  windowTitle: string | null;
  url: string | null;
  startTime: number;
  endTime: number | null;
  summary: string | null;
}

export type CommitmentStatus = "pending" | "in_progress" | "completed" | "failed";

export interface CommitmentsListInput {
  status?: CommitmentStatus;
  /** Cap. Default 25. */
  limit?: number;
}

export interface CommitmentSnapshot {
  id: string;
  description: string;
  status: CommitmentStatus;
  dueAt: number | null;
  priority: "low" | "normal" | "high" | "urgent";
  createdAt: number;
}

/**
 * Channel-aware delivery surface used by `jarvis-notify`. The daemon's
 * implementation routes through M8 (telegram/discord/signal), the dashboard
 * broadcaster (WebSocketService), and the voice TTS pipeline (M10).
 *
 * "auto" lets the implementation pick reasonable defaults given the user's
 * configured channels and the current priority.
 */
export interface PieceNotifier {
  notify(input: PieceNotifyInput): Promise<PieceNotifyResult>;
}

export type PieceNotifyChannel = "auto" | "telegram" | "discord" | "voice" | "dashboard" | "desktop";

export type PieceNotifyPriority = "low" | "normal" | "high";

export interface PieceNotifyInput {
  message: string;
  channels?: PieceNotifyChannel[];
  priority?: PieceNotifyPriority;
}

export interface PieceNotifyResult {
  delivered: string[];
  failed: { channel: string; error: string }[];
}

/**
 * Minimal slice of the Jarvis tool registry that pieces use. The daemon's
 * concrete `ToolRegistry` satisfies this shape; tests pass a stub.
 */
export interface PieceToolRegistry {
  has(name: string): boolean;
  /** Throws if the tool is missing or invocation fails. */
  execute(name: string, params: Record<string, unknown>): Promise<unknown>;
  /** Returns metadata for the named tool, or null if absent. */
  describe(name: string): PieceToolDescription | null;
  /** Returns the names of all registered tools (optionally filtered by category). */
  listNames(category?: string): string[];
}

export interface PieceToolDescription {
  name: string;
  description: string;
  category: string;
  parameters: Record<string, { type: string; description: string; required: boolean }>;
}

/** Minimal LLM client surface a piece needs. Concrete impls wrap the daemon's LLMManager. */
export interface PieceLlmClient {
  /**
   * Single round-trip prompt completion. Returns the assistant's text reply.
   * No streaming, no tool calls -- pieces that need richer behavior compose
   * multiple `chat()` calls or use a different service.
   */
  chat(input: PieceLlmInput): Promise<PieceLlmResponse>;
}

export interface PieceLlmInput {
  /** System prompt; placed before the user prompt in the message list. */
  system?: string;
  /** User prompt. Required. */
  prompt: string;
  /** Override the configured model. Format is provider-specific. */
  model?: string;
  /** Sampling temperature; defaults to provider default if omitted. */
  temperature?: number;
}

export interface PieceLlmResponse {
  /** The assistant's text. */
  text: string;
  /** Optional usage stats (tokens). Not all providers populate these. */
  usage?: { promptTokens?: number; completionTokens?: number };
}

/**
 * Type of a single input field on a piece action or trigger. Drives the
 * typed widget the dashboard renders (text input, dropdown, toggle, etc.).
 *
 * Keep this set small and Jarvis-native rather than mirroring activepieces'
 * full Property API -- our UI only needs to discriminate widget kinds, not
 * preserve every upstream affordance.
 */
export type PieceInputType =
  | "string"      // single-line text input
  | "long_text"   // multi-line textarea
  | "number"      // numeric input
  | "boolean"     // toggle / checkbox
  | "enum"        // single-select dropdown
  | "multi_enum"  // multi-select chip list
  | "datetime"    // ISO-8601 date / datetime picker
  | "json";       // raw JSON textarea

export interface PieceInputField {
  /** Stable key used in `settings.input`. Match to `parseInput` field names. */
  name: string;
  /** Display label for the panel. */
  label: string;
  type: PieceInputType;
  required: boolean;
  /** Optional inline help text below the widget. */
  description?: string;
  /** Optional placeholder for text/number widgets. */
  placeholder?: string;
  /** Choices for enum / multi_enum. Order is rendering order. */
  options?: ReadonlyArray<{ value: string; label: string; description?: string }>;
  /** Suggested default. Used by the UI when the field is first revealed. */
  default?: unknown;
}

export interface PieceInputSchema {
  fields: ReadonlyArray<PieceInputField>;
}

/**
 * A single action exported by a piece. `execute` runs the action; `name` is
 * the stable id used in flow definitions; the schema fields are descriptive
 * (consumed by the UI / NL builder).
 *
 * `inputSchema` is optional — pieces that don't declare it fall back to a
 * freeform key/value editor in the dashboard.
 */
export interface JarvisAction<I = unknown, O = unknown> {
  name: string;
  displayName: string;
  description: string;
  inputSchema?: PieceInputSchema;
  /** Returns the validated/normalized input or throws. */
  parseInput: (raw: unknown) => I;
  execute: (input: I, ctx: JarvisPieceContext) => Promise<O>;
}

export interface JarvisPiece {
  name: string;
  displayName: string;
  description: string;
  actions: Record<string, JarvisAction>;
  triggers?: Record<string, JarvisTrigger>;
}

/**
 * In-memory registry of Jarvis-native pieces. Lookup is by piece name +
 * action name. Used by the future engine adapter and by tests.
 */
export class JarvisPieceRegistry {
  private readonly pieces: Map<string, JarvisPiece> = new Map();

  register(piece: JarvisPiece): void {
    if (this.pieces.has(piece.name)) {
      throw new Error(`piece already registered: ${piece.name}`);
    }
    validatePiece(piece);
    this.pieces.set(piece.name, piece);
  }

  get(name: string): JarvisPiece | null {
    return this.pieces.get(name) ?? null;
  }

  list(): JarvisPiece[] {
    return Array.from(this.pieces.values());
  }

  /** Resolve "<piece>:<action>" to its handler. Returns null if either side is missing. */
  resolveAction(reference: string): JarvisAction | null {
    const colon = reference.indexOf(":");
    if (colon < 0) return null;
    const pieceName = reference.slice(0, colon);
    const actionName = reference.slice(colon + 1);
    const piece = this.pieces.get(pieceName);
    if (!piece) return null;
    return piece.actions[actionName] ?? null;
  }

  /** Resolve "<piece>:<trigger>" to its definition. Returns null if either side is missing. */
  resolveTrigger(reference: string): JarvisTrigger | null {
    const colon = reference.indexOf(":");
    if (colon < 0) return null;
    const pieceName = reference.slice(0, colon);
    const triggerName = reference.slice(colon + 1);
    const piece = this.pieces.get(pieceName);
    if (!piece || !piece.triggers) return null;
    return piece.triggers[triggerName] ?? null;
  }
}

/** Convenience: error thrown by `parseInput` impls when input is malformed. */
export class JarvisActionInputError extends Error {
  override readonly name = "JarvisActionInputError";
}

/**
 * Registration-time sanity checks on a piece's schemas. Catches author
 * mistakes that would otherwise produce silently-broken UI (empty enum
 * dropdowns, colliding field keys, etc.).
 */
function validatePiece(piece: JarvisPiece): void {
  for (const [key, action] of Object.entries(piece.actions)) {
    if (action.inputSchema) {
      validateSchema(`${piece.name}:${key}`, action.inputSchema);
    }
  }
  if (piece.triggers) {
    for (const [key, trigger] of Object.entries(piece.triggers)) {
      if (trigger.inputSchema) {
        validateSchema(`${piece.name}:${key}`, trigger.inputSchema);
      }
    }
  }
}

function validateSchema(label: string, schema: PieceInputSchema): void {
  const seen = new Set<string>();
  for (const field of schema.fields) {
    if (seen.has(field.name)) {
      throw new Error(`piece schema ${label}: duplicate field name "${field.name}"`);
    }
    seen.add(field.name);
    if (field.type === "enum" || field.type === "multi_enum") {
      if (!field.options || field.options.length === 0) {
        throw new Error(`piece schema ${label}: field "${field.name}" of type ${field.type} requires options`);
      }
      const values = new Set<string>();
      for (const opt of field.options) {
        if (values.has(opt.value)) {
          throw new Error(
            `piece schema ${label}: field "${field.name}" has duplicate option value "${opt.value}"`,
          );
        }
        values.add(opt.value);
      }
    }
  }
}
