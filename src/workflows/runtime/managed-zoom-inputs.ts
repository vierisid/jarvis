import type { PieceInputSchema, PieceInputField } from "./piece-input";
import { MANAGED_ZOOM_ACTIONS } from "./managed-zoom";
/** The editor, readiness check and engine share this managed-only contract. */
export function zoomInputSchema(action: string): PieceInputSchema | null {
  if (!(MANAGED_ZOOM_ACTIONS as readonly string[]).includes(action))
    return null;
  const create = action === "zoom_create_meeting",
    update = action.startsWith("zoom_update_");
  const field = (
    name: string,
    label: string,
    required = false,
    type: PieceInputField["type"] = "string",
    description?: string,
  ): PieceInputField => ({
    name,
    label,
    required,
    type,
    sourceType: type === "number" ? "NUMBER" : "SHORT_TEXT",
    description,
  });
  return {
    fields: [
      ...(!create
        ? [
            field(
              "meeting_id",
              "Meeting ID",
              true,
              "string",
              "Use the numeric ID from Zoom or a previous workflow step. Only your scheduled, non-recurring meetings are supported.",
            ),
          ]
        : []),
      ...(create || update
        ? [
            field("topic", "Topic", create),
            field(
              "start_time",
              "Start time (UTC)",
              create,
              "string",
              "Use a future date and time ending in Z, for example 2030-06-01T14:00:00Z.",
            ),
            field(
              "duration",
              "Duration (minutes)",
              false,
              "number",
              "1–1440. New meetings default to 30 minutes. Empty fields preserve existing values when updating.",
            ),
            field(
              "agenda",
              "Agenda",
              false,
              "string",
              "Optional, up to 2,000 characters. Empty preserves the current agenda.",
            ),
          ]
        : []),
    ],
  };
}
export function isZoomReference(piece: unknown, auth: unknown) {
  return (
    piece === "@activepieces/piece-zoom" &&
    ["{{connections.jarvis:zoom}}", "{{connections['jarvis:zoom']}}"].includes(
      String(auth),
    )
  );
}
export function zoomEngineProps(
  piece: string,
  action: string,
  input: unknown,
): Record<string, any> | null {
  if (
    piece !== "@activepieces/piece-zoom" ||
    (input as any)?.auth?.jarvis_managed !== "zoom"
  )
    return null;
  const schema = zoomInputSchema(action);
  return schema
    ? Object.fromEntries(
        schema.fields.map((f) => [
          f.name,
          { displayName: f.label, type: f.sourceType, required: f.required },
        ]),
      )
    : null;
}
