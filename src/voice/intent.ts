/**
 * Voice Intent — the schema produced by the voice intent classifier.
 *
 * Mirrors `design_handoff_jarvis_redesign/VOICE_SCHEMA.md`. The classifier
 * runs on every final STT transcript and routes downstream by `confidence`:
 *
 *   confidence ≥ 0.85 → act per impact routing (forward to chat agent)
 *   confidence 0.6–0.85 → emit `clarifier_request` ThreadItem
 *   confidence < 0.6   → emit `repeat_back_request` ThreadItem
 *
 * Read-only intents (`verb: "ask"`, `impact: "read"`) skip the gate above
 * 0.85 even when the intent is uncertain, since the worst case is just
 * answering a slightly different question.
 *
 * The UI mirrors this type in `ui/src/v2/voice/types.ts` — keep them in sync.
 */

export type Verb =
  | "ask" // read-only Q&A
  | "show" // navigate to a Room or open a card
  | "run" // execute a workflow / tool
  | "create" // new object
  | "update" // edit object
  | "delete" // destructive
  | "grant" // authority change
  | "revoke" // authority change
  | "pause" // daemon control
  | "resume"
  | "unknown"; // classifier couldn't decide

export type ObjectRefType =
  | "workflow"
  | "memory"
  | "tool"
  | "agent"
  | "authority"
  | "log"
  | "goal"      // Phase 6.7.B — Goals Room
  | "calendar"  // Phase 6.7.A — Calendar Room
  | "task"       // Phase 6.7.C — Tasks Room
  | "content"    // Phase 6.7.D — Content Pipeline Room (was "site")
  | "workspace"  // Phase 6.7.E — Workspaces Room (dev projects)
  | "settings"   // Phase 6.7.F — Settings Room
  | "file"
  | "url"
  | "thread"; // home / "back to thread" target — closes any open Room

export type ObjectRef = {
  type: ObjectRefType;
  id?: string;
  /** Fuzzy lookup string when no id is known. */
  query?: string;
};

export type Impact = "read" | "write" | "destructive" | "external";

export type Intent = {
  id: string;
  utterance: string;
  verb: Verb;
  object: ObjectRef | null;
  args: Record<string, unknown>;
  impact: Impact;
  /** 0..1 — classifier confidence in this whole interpretation. */
  confidence: number;
  /** Optional alternative interpretations for clarifier UI. */
  alternatives?: Array<Pick<Intent, "verb" | "object" | "args" | "impact"> & { label: string }>;
  /**
   * Phase 6.3.5 — when the user is asking the UI of a specific Room to do
   * something (switch tabs, open a dialog, fill a form, toggle a filter),
   * the classifier returns a structured action here instead of routing the
   * utterance to the chat agent. The daemon broadcasts this directly to
   * the dashboard via a `room_action` notification; the UI's action bus
   * dispatches to whichever Room is currently registered.
   *
   * Always read-only impact (it's a UI command, not a daemon action) — the
   * daemon doesn't gate this through the soft-approval pipeline.
   */
  room_action?: RoomAction;

  /**
   * Phase 6.3.5b — voice approve/cancel for pending confirmations.
   * Set when the utterance is a short affirmative ("approve", "yes", "do
   * it", "go ahead") or negative ("cancel", "no", "deny", "never mind").
   * The daemon decides whether to act based on whether a pending approval
   * / clarifier / repeat-back exists; if not, the intent falls through to
   * the normal chat path (so "yes" still works as a conversational reply).
   */
  confirmation_response?: 'approve' | 'cancel';
};

export type RoomAction = {
  /** Which Room the action targets. The UI bus rejects mismatches. */
  room: RoomKey;
  /** Per-Room action name. Documented in the classifier prompt. */
  action: string;
  /** Optional structured args (e.g. `{ specialist, task, context }` for spawn). */
  args?: Record<string, unknown>;
};

/**
 * Confidence band that controls routing. Read-only intents bypass the
 * clarifier band — getting a slightly-wrong answer to a question is far
 * less costly than misfiring a write/destructive action.
 */
export function routeByConfidence(intent: Intent): "act" | "clarify" | "repeat-back" {
  if (intent.impact === "read" && intent.confidence >= 0.6) return "act";
  if (intent.confidence >= 0.85) return "act";
  if (intent.confidence >= 0.6) return "clarify";
  return "repeat-back";
}

/**
 * Map a voice intent's object reference to a dashboard Room key, when the
 * intent is a `show`/`open` navigation request. Returns null when the
 * object type doesn't correspond to a Room (e.g. file, url) or when the
 * intent isn't a navigation verb at all.
 *
 * Used by `handleVoiceSession` to intercept "open workflows" / "show me
 * authority" / etc. before they reach the chat agent — the LLM has no
 * concept of Rooms, so forwarding such intents would just produce
 * "I'm not sure what room you mean".
 */
export type RoomKey =
  | "workflows"
  | "memory"
  | "tools"
  | "agents"
  | "authority"
  | "logs"
  | "calendar"
  | "goals"
  | "tasks"
  | "content"
  | "workspaces"
  | "settings";

export function intentToRoomKey(intent: Intent): RoomKey | null {
  if (intent.verb !== "show") return null;
  const t = intent.object?.type;
  if (!t) return null;
  switch (t) {
    case "workflow":
      return "workflows";
    case "memory":
      return "memory";
    case "tool":
      return "tools";
    case "agent":
      return "agents";
    case "authority":
      return "authority";
    case "log":
      return "logs";
    case "goal":
      return "goals";
    case "calendar":
      return "calendar";
    case "task":
      return "tasks";
    case "content":
      return "content";
    case "workspace":
      return "workspaces";
    case "settings":
      return "settings";
    case "file":
    case "url":
    case "thread":
    default:
      return null;
  }
}

/**
 * Detects "back to thread" / "close the room" / "return to the home view"
 * navigation intents. The classifier emits these as `verb: show, object:
 * { type: "thread" }` per the prompt.
 */
export function intentIsBackToThread(intent: Intent): boolean {
  return intent.verb === "show" && intent.object?.type === "thread";
}
