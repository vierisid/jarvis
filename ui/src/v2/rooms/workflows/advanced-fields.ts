/**
 * Fields a step's config panel keeps under "Advanced" instead of the first
 * thing a person sees. Keyed by `<pieceName>:<actionName>` (a trigger has no
 * action name, so its key ends with the colon). Everything else keeps the
 * schema's own order, so the common fields come first.
 */

import type { PieceInputField } from "./useWorkflowEditor";

const ADVANCED_FIELDS: Record<string, readonly string[]> = {
  // The message and channels are what a person edits. The meeting guard and the
  // notification identity are for meeting briefs and once-only delivery.
  "@jarvispieces/piece-jarvis-notify:notify": ["meetingGuard", "idempotencyKey"],
  // The schedule editor covers time and zone; only the daylight-saving policy is left.
  "schedule:": ["dst_policy"],
};

export function splitAdvancedFields(
  pieceName: string | undefined,
  subName: string | undefined,
  fields: PieceInputField[],
): { primary: PieceInputField[]; advanced: PieceInputField[] } {
  const names = ADVANCED_FIELDS[`${pieceName ?? ""}:${subName ?? ""}`];
  if (!names) return { primary: fields, advanced: [] };
  return {
    primary: fields.filter((f) => !names.includes(f.name)),
    advanced: fields.filter((f) => names.includes(f.name)),
  };
}
