import type { FlowStepNode } from "./useWorkflowEditor";
import { manualTriggerFields } from "./trigger-kinds";
import { manualRunInput } from "../../../brief/host/InputDialog";

/**
 * Ask for a manual trigger's declared input fields before a legacy Run.
 *
 * `/api/workflows/:id/run` runs the PUBLISHED version, else the latest draft,
 * so the fields come from that version as the server holds it, not from an
 * editor's draft or unsaved edits: a draft that adds a field must not be asked
 * for while the published version runs without it, and the reverse.
 *
 * Returns `{}` when that version declares no fields (or cannot be read: the run
 * then starts as it did before fields existed), `{ payload }` with the values
 * entered, and `null` when the person cancelled, so nothing may start.
 */
export async function askManualRunPayload(flowId: string): Promise<{ payload?: Record<string, unknown> } | null> {
  let trigger: FlowStepNode | undefined;
  try {
    const res = await fetch(`/api/workflows/${encodeURIComponent(flowId)}`);
    if (res.ok) {
      const body = (await res.json()) as { published?: { trigger?: FlowStepNode } | null; latestDraft?: { trigger?: FlowStepNode } | null };
      trigger = (body.published ?? body.latestDraft)?.trigger;
    }
  } catch { /* Without the trigger the run starts as before. */ }
  const fields = manualTriggerFields(trigger);
  if (!fields.length) return {};
  const entered = await manualRunInput(undefined, fields);
  return entered === null ? null : { payload: entered };
}
