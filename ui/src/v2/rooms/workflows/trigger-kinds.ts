/**
 * Canonical trigger-kind table + transition logic for the workflow
 * editor's top-level trigger picker (Manual / Schedule / Webhook /
 * Event).
 *
 * Lives in its own module so:
 *   - presentation (the buttons in `WorkflowEditor.tsx`) and selection
 *     (the state mutator in `useWorkflowEditor.ts`) read from one source
 *     of truth -- a typo on either side would otherwise desync the two
 *     halves silently.
 *   - the stash / restore semantics are pure functions, testable
 *     without mounting the editor's React tree.
 *
 * A "trigger kind" is the user-facing concept ("what kind of trigger
 * is this"). It maps to a concrete `(pieceName, triggerName?)` pair
 * the engine understands. The mapping is fixed for the four built-in
 * kinds; anything else flowing through the trigger slot (community
 * pieces with their own triggers, imported flows) is detected as
 * `"other"` so the picker stays informational and doesn't clobber the
 * step on a misclick.
 */

import type { FlowStepNode } from "./useWorkflowEditor";

export type TriggerKind = "manual" | "schedule" | "webhook" | "event";

/** Detection includes the "other" sentinel for non-canonical triggers. */
export type DetectedTriggerKind = TriggerKind | "other";

export interface TriggerKindMeta {
  kind: TriggerKind;
  /** Label shown on the picker button. */
  label: string;
  /** Tooltip text describing the kind. */
  description: string;
  /** Canonical pieceName for non-manual kinds; null for manual. */
  pieceName: string | null;
  /** Canonical triggerName when the piece has multiple triggers; null otherwise. */
  triggerName: string | null;
}

/**
 * Single source of truth for the kind <-> (pieceName, triggerName) mapping.
 * Order is presentation order, left to right.
 *
 * Why these specific values:
 *   - manual: type=EMPTY (the legacy "no piece selected" trigger)
 *   - schedule / webhook: built-in primitives the trigger manager
 *     understands as a pieceName (no triggerName -- there's only one
 *     mode per primitive).
 *   - event: the Jarvis-side `@jarvispieces/piece-jarvis-trigger`
 *     piece's `on_event` trigger. Pulls events from the workflow event
 *     bus; the user picks which event type via a dedicated dropdown
 *     (powered by `WORKFLOW_EVENT_TYPES`).
 */
export const TRIGGER_KINDS: ReadonlyArray<TriggerKindMeta> = [
  {
    kind: "manual",
    label: "Manual",
    description: "Run on demand via POST /api/workflows/:id/run",
    pieceName: null,
    triggerName: null,
  },
  {
    kind: "schedule",
    label: "Schedule",
    description: "Fire on a cron expression (e.g. 0 8 * * *)",
    pieceName: "schedule",
    triggerName: null,
  },
  {
    kind: "webhook",
    label: "Webhook",
    description: "Fire on inbound HTTP to /api/webhooks/<flow_id>",
    pieceName: "webhook",
    triggerName: null,
  },
  {
    kind: "event",
    label: "Event",
    description: "Fire on a Jarvis event (clipboard, email, awareness, ...)",
    pieceName: "@jarvispieces/piece-jarvis-trigger",
    triggerName: "on_event",
  },
];

const KIND_BY_PIECE: Map<string, TriggerKind> = new Map(
  TRIGGER_KINDS.flatMap((tk) =>
    tk.pieceName ? [[tk.pieceName, tk.kind] as [string, TriggerKind]] : [],
  ),
);

/**
 * Reverse map: given a step, decide which kind it currently is.
 *
 * Returns `"other"` for any `PIECE_TRIGGER` whose pieceName isn't one
 * of the canonical three. The picker treats `"other"` as a non-clobber
 * state: no button is visually active, and a hint explains that the
 * step is a custom piece trigger. Clicking a button still works (the
 * user is explicitly opting in), but the picker won't silently switch
 * out a community-piece trigger just because the user clicked the
 * panel.
 */
export function detectTriggerKind(step: FlowStepNode): DetectedTriggerKind {
  if (step.type === "EMPTY") return "manual";
  if (step.type !== "PIECE_TRIGGER") return "other";
  const pieceName = step.settings?.pieceName;
  if (typeof pieceName !== "string") return "other";
  return KIND_BY_PIECE.get(pieceName) ?? "other";
}

/**
 * Settings stash, keyed by `TriggerKind`. Lets the user restore prior
 * config when they round-trip through Manual or hop between non-manual
 * kinds.
 *
 * Contract: the key is the `TriggerKind` enum value, NOT the
 * `pieceName` or `triggerName`. The stash semantics survive any future
 * shuffle of the canonical (pieceName, triggerName) pair behind a kind
 * (e.g. if `jarvis-trigger` grew a second trigger and we reshuffled
 * which one backs the `event` kind). Restore always looks up by kind,
 * so the stored settings can't accidentally be applied to a different
 * piece.
 */
export type TriggerKindStash = Record<TriggerKind, FlowStepNode["settings"] | undefined>;

/** Empty stash with all kinds set to `undefined`. */
export function makeEmptyStash(): TriggerKindStash {
  return { manual: undefined, schedule: undefined, webhook: undefined, event: undefined };
}

/**
 * Result of a kind transition: the new (type, settings) the editor
 * should apply, plus the updated stash to persist in the ref.
 */
export interface TransitionResult {
  type: "EMPTY" | "PIECE_TRIGGER";
  settings: FlowStepNode["settings"];
  nextStash: TriggerKindStash;
}

/**
 * Pure transition: compute the next step shape + updated stash when
 * the user picks `nextKind`.
 *
 * Semantics:
 *   1. Snapshot the OUTGOING kind's settings into the stash so future
 *      visits can restore them. Only snapshots when the settings are
 *      non-trivial (a fresh empty `{ input: {} }` doesn't displace a
 *      meaningful prior snapshot for the same kind).
 *   2. If a stash for the INCOMING kind exists, restore it verbatim.
 *      Otherwise initialize the canonical fresh settings for the
 *      incoming kind.
 *
 * This closes the silent-discard hole the prior single-ref design had:
 * `schedule -> webhook` no longer drops the cron; `schedule -> manual
 * -> event` keeps the schedule config recoverable.
 */
export function transitionTriggerKind(
  currentKind: DetectedTriggerKind,
  currentSettings: FlowStepNode["settings"],
  nextKind: TriggerKind,
  stash: TriggerKindStash,
): TransitionResult {
  // 1. Snapshot the outgoing kind, if it's one of the canonical four
  //    and has meaningful content. We deliberately skip `"other"` --
  //    we can't safely restore a community-piece trigger by the
  //    canonical kind set, so no point keeping it under any key.
  const nextStash: TriggerKindStash = { ...stash };
  if (currentKind !== "other" && currentKind !== nextKind && hasMeaningfulSettings(currentSettings)) {
    nextStash[currentKind] = currentSettings ? deepClone(currentSettings) : undefined;
  }

  // 2. Apply the incoming kind.
  if (nextKind === "manual") {
    // Restore stash if present; manual otherwise means empty settings.
    const stashed = nextStash.manual;
    if (stashed) nextStash.manual = undefined;
    return { type: "EMPTY", settings: stashed ? deepClone(stashed) : {}, nextStash };
  }

  const meta = TRIGGER_KINDS.find((tk) => tk.kind === nextKind);
  // Defensive: TRIGGER_KINDS is exhaustive over the union, so meta is
  // always defined. The fallback path keeps the type happy without an
  // assertion.
  if (!meta || !meta.pieceName) {
    return { type: "PIECE_TRIGGER", settings: { input: {} }, nextStash };
  }

  const stashed = nextStash[nextKind];
  if (stashed) {
    nextStash[nextKind] = undefined;
    return { type: "PIECE_TRIGGER", settings: deepClone(stashed), nextStash };
  }

  // Fresh canonical settings for this kind.
  const settings: NonNullable<FlowStepNode["settings"]> = {
    pieceName: meta.pieceName,
    input: {},
  };
  if (meta.triggerName) settings.triggerName = meta.triggerName;
  return { type: "PIECE_TRIGGER", settings, nextStash };
}

/**
 * "Meaningful" means the user has actually configured something: at
 * least one input field is set. The canonical fresh-pick state
 * (`{ pieceName: "schedule", input: {} }`) does NOT count -- it's the
 * default the picker just installed and overwriting a slot with it
 * would displace whatever was actually there.
 *
 * For Manual (no pieceName), settings are always `{}` so this is a
 * no-op; we never store anything under the manual stash key today.
 */
function hasMeaningfulSettings(settings: FlowStepNode["settings"] | undefined): boolean {
  if (!settings) return false;
  if (settings.input && Object.keys(settings.input).length > 0) return true;
  return false;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
