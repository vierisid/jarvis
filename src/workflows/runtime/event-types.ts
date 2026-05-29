/**
 * Canonical event-type taxonomy for the workflow event bus.
 *
 * `on_event` triggers subscribe to one of these strings. Daemon services
 * (awareness, observers, commitments, channels, etc.) publish onto the bus
 * using the same strings. Keeping the catalog centralized here prevents drift
 * between subscribers and publishers and lets the composer's planner surface
 * the taxonomy to the LLM.
 *
 * Naming convention: `<source>.<verb_phrase>` in snake_case. Sources match
 * the daemon module (awareness, commitment, observer, channel, tool, voice).
 *
 * Adding a new event type:
 *   1. Add to `WORKFLOW_EVENT_TYPES` below with a one-line description.
 *   2. Wire a publisher at the source (call `eventBus.publish(type, payload)`).
 *   3. The composer's catalog auto-surfaces it; no other UI changes needed.
 */

export interface WorkflowEventTypeMeta {
  type: string;
  description: string;
  /** Example payload shape, used in the composer prompt to help the LLM filter. */
  payloadExample?: Record<string, unknown>;
}

export const WORKFLOW_EVENT_TYPES: ReadonlyArray<WorkflowEventTypeMeta> = [
  // ── observer.* ── unified stream from ObserverManager ───────────────────
  {
    type: "observer.clipboard_changed",
    description:
      "User copied something. The clipboard text is at `payload.content` (reference as {{trigger.payload.content}}); also `payload.length`. There is NO type/kind field -- detect what it is by inspecting `payload.content` itself (e.g. regex-match against ^https?:// to decide it's a URL). Do not test for a `contentType`.",
    payloadExample: { content: "https://example.com", length: 19 },
  },
  {
    type: "observer.file_changed",
    description:
      "A watched file or directory changed. The path is at `payload.path` ({{trigger.payload.path}}); the kind of change is at `payload.eventType` (created / modified / deleted). Also `payload.filename`, `payload.basePath`.",
    payloadExample: { path: "/home/me/notes.txt", eventType: "modified", filename: "notes.txt", basePath: "/home/me" },
  },
  {
    type: "observer.email_received",
    description:
      "New Gmail message arrived (requires Google auth). The available content is `payload.snippet` ({{trigger.payload.snippet}}, a short preview) -- there is NO full email body, so feed `payload.snippet` into any classification/summary prompt. Other fields: `payload.from`, `payload.to`, `payload.subject`, `payload.date`, `payload.labels`, `payload.id`, `payload.threadId`.",
    payloadExample: {
      id: "msg_abc",
      from: "alice@example.com",
      to: "me@example.com",
      subject: "Re: launch",
      date: "2026-05-26T09:00:00Z",
      snippet: "Hey, can you review the deck before our 2pm? It's blocking the release...",
      labels: ["INBOX", "IMPORTANT"],
    },
  },
  {
    type: "observer.calendar_event_starting",
    description: "A Google Calendar event is about to start. Title at `payload.summary` ({{trigger.payload.summary}}); start time at `payload.start`.",
    payloadExample: { summary: "Standup", start: "2026-05-07T15:00:00Z" },
  },
  {
    type: "observer.process_started",
    description: "A new process appeared in the process list. Pid at `payload.pid`; name at `payload.name` ({{trigger.payload.name}}).",
    payloadExample: { pid: 1234, name: "node" },
  },
  {
    type: "observer.process_stopped",
    description: "A previously-running process exited. Pid at `payload.pid`; name at `payload.name` ({{trigger.payload.name}}).",
    payloadExample: { pid: 1234, name: "node" },
  },
  {
    type: "observer.notification_received",
    description:
      "A D-Bus / native desktop notification was shown. Source app at `payload.app` ({{trigger.payload.app}}); also `payload.title`, `payload.body`, `payload.urgency`.",
    payloadExample: { app: "Slack", title: "Alice", body: "Message from Alice", urgency: "normal" },
  },

  // ── commitment.* ── heartbeat sweep over the vault commitments table ─
  {
    type: "commitment.due_soon",
    description:
      "A commitment is about to come due (typically within the next 30 min). Text at `payload.what` ({{trigger.payload.what}}); id at `payload.id`; due ms at `payload.when_due`.",
    payloadExample: { id: "c_abc", what: "Follow up with vendor", when_due: 1710000000000 },
  },
  {
    type: "commitment.overdue",
    description:
      "A commitment passed its due time without being completed. Text at `payload.what` ({{trigger.payload.what}}); id at `payload.id`; due ms at `payload.when_due`.",
    payloadExample: { id: "c_abc", what: "Follow up with vendor", when_due: 1710000000000 },
  },

  // ── awareness.* ── from the awareness service (M13) ─────────────────────
  {
    type: "awareness.context_changed",
    description:
      "User switched between meaningful contexts (project / app / task). Active app at `payload.app` ({{trigger.payload.app}}); project at `payload.project`.",
    payloadExample: { app: "VS Code", project: "jarvis" },
  },
  {
    type: "awareness.error_detected",
    description:
      "User is hitting an error pattern detected by the awareness service. Error text at `payload.excerpt` ({{trigger.payload.excerpt}}); originating app at `payload.app`.",
    payloadExample: { app: "Terminal", excerpt: "fatal: not a git repository" },
  },
  {
    type: "awareness.stuck_detected",
    description:
      "User has been on the same window for too long with little change. App at `payload.app`; window title at `payload.windowTitle` ({{trigger.payload.windowTitle}}); duration ms at `payload.durationMs`.",
    payloadExample: { app: "VS Code", windowTitle: "config.ts", durationMs: 600000 },
  },
  {
    type: "awareness.struggle_detected",
    description:
      "User is undoing repeatedly or otherwise showing struggle signals. App at `payload.app`; specific signal name at `payload.signal` ({{trigger.payload.signal}}).",
    payloadExample: { app: "VS Code", signal: "repeated_undo" },
  },
  {
    type: "awareness.session_started",
    description: "A new awareness session began (focus on a project or task). Session id at `payload.sessionId`; topic at `payload.topic` (may be null at start).",
    payloadExample: { sessionId: "sess_abc", topic: null },
  },
  {
    type: "awareness.session_ended",
    description:
      "An awareness session ended. Inferred topic at `payload.topic` ({{trigger.payload.topic}}); duration ms at `payload.durationMs`; session id at `payload.sessionId`.",
    payloadExample: { sessionId: "sess_abc", topic: "jarvis workflows", durationMs: 1800000 },
  },
  {
    type: "awareness.suggestion_ready",
    description:
      "Awareness intelligence produced a proactive suggestion for the user. Title at `payload.title` ({{trigger.payload.title}}); body at `payload.body`.",
    payloadExample: { title: "Stuck on this error?", body: "Try X." },
  },
];

/**
 * Map from raw ObserverEvent.type to canonical workflow event type. Anything
 * not listed here gets a fallback `observer.<rawType>` at the publisher.
 *
 * Keep these aligned with WORKFLOW_EVENT_TYPES so the composer's catalog and
 * the actual runtime publishers agree.
 */
export const OBSERVER_EVENT_TYPE_MAP: Readonly<Record<string, string>> = {
  clipboard: "observer.clipboard_changed",
  file_change: "observer.file_changed",
  email: "observer.email_received",
  calendar: "observer.calendar_event_starting",
  process_started: "observer.process_started",
  process_stopped: "observer.process_stopped",
  notification: "observer.notification_received",
};

/**
 * Map from raw AwarenessEvent.type to canonical workflow event type. The
 * awareness service emits typed events through its eventCallback; we
 * republish onto the bus using these names. Same fallback rule as the
 * observer map applies (`awareness.<rawType>` for unmapped entries).
 */
export const AWARENESS_EVENT_TYPE_MAP: Readonly<Record<string, string>> = {
  context_changed: "awareness.context_changed",
  error_detected: "awareness.error_detected",
  stuck_detected: "awareness.stuck_detected",
  struggle_detected: "awareness.struggle_detected",
  session_started: "awareness.session_started",
  session_ended: "awareness.session_ended",
  suggestion_ready: "awareness.suggestion_ready",
};

/** O(1) check that a string is a known workflow event type. */
export function isWorkflowEventType(s: string): boolean {
  if (!_indexBuilt) buildIndex();
  return _index.has(s);
}

/** Get metadata for a known type (or null if not in the catalog). */
export function getWorkflowEventTypeMeta(s: string): WorkflowEventTypeMeta | null {
  if (!_indexBuilt) buildIndex();
  return _index.get(s) ?? null;
}

let _index: Map<string, WorkflowEventTypeMeta> = new Map();
let _indexBuilt = false;
function buildIndex(): void {
  _index = new Map(WORKFLOW_EVENT_TYPES.map((m) => [m.type, m]));
  _indexBuilt = true;
}
