/**
 * A copy of a draft's unsaved edits, kept in the browser tab so a reload or a lost session does not lose them.
 * The copy is tied to the draft revision it was made from: a draft that changed since is not overwritten by it.
 */
import type { FlowStepNode, NodePosition, OrphanStep } from "./useWorkflowEditor";

const VERSION = 1;
/** Beyond this the copy is skipped: the edits are still on screen, only the reload safety is lost. */
const MAX_CHARS = 1_500_000;

export interface KeptEdits {
  base: string | null;
  savedAt: number;
  displayName: string | null;
  trigger: FlowStepNode;
  orphans: OrphanStep[];
  positions: Record<string, NodePosition>;
}

export function serializeEdits(edits: Omit<KeptEdits, "savedAt"> & { displayName: string | null }): string | null {
  const text = JSON.stringify({ v: VERSION, ...edits, savedAt: Date.now() });
  return text.length <= MAX_CHARS ? text : null;
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The stored edits when they were made from `revision`; otherwise null. Never throws. */
export function keptEdits(stored: string | null, revision: string | null | undefined): KeptEdits | null {
  if (!stored || !revision) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!object(parsed) || parsed.v !== VERSION || parsed.base !== revision) return null;
    const trigger = parsed.trigger;
    if (!object(trigger) || trigger.name !== "trigger" || typeof trigger.type !== "string") return null;
    const orphans = Array.isArray(parsed.orphans) ? (parsed.orphans as unknown[]).filter((o): o is OrphanStep => object(o) && object(o.node) && typeof o.x === "number" && typeof o.y === "number") : [];
    return {
      base: revision,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
      displayName: typeof parsed.displayName === "string" ? parsed.displayName : null,
      trigger: trigger as unknown as FlowStepNode,
      orphans,
      positions: object(parsed.positions) ? (parsed.positions as Record<string, NodePosition>) : {},
    };
  } catch {
    return null;
  }
}
