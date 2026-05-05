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
 * A single action exported by a piece. `execute` runs the action; `name` is
 * the stable id used in flow definitions; the schema fields are descriptive
 * (consumed by the UI / NL builder).
 */
export interface JarvisAction<I = unknown, O = unknown> {
  name: string;
  displayName: string;
  description: string;
  /** Returns the validated/normalized input or throws. */
  parseInput: (raw: unknown) => I;
  execute: (input: I, ctx: JarvisPieceContext) => Promise<O>;
}

export interface JarvisPiece {
  name: string;
  displayName: string;
  description: string;
  actions: Record<string, JarvisAction>;
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
}

/** Convenience: error thrown by `parseInput` impls when input is malformed. */
export class JarvisActionInputError extends Error {
  override readonly name = "JarvisActionInputError";
}
