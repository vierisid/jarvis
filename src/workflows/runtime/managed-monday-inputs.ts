import type { PieceInputSchema, PieceInputField } from "./piece-input";
/** The same managed-only contract drives readiness, the editor and engine validation. */
export function mondayInputSchema(action: string): PieceInputSchema | null {
  const field = (
    name: string,
    label: string,
    required = true,
    type: PieceInputField["type"] = "string",
    description?: string,
  ): PieceInputField => ({
    name,
    label,
    required,
    type,
    sourceType:
      type === "json"
        ? "JSON"
        : type === "long_text"
          ? "LONG_TEXT"
          : "SHORT_TEXT",
    ...(description ? { description } : {}),
  });
  const board = field("board_id", "Board ID");
  const item = field("item_id", "Item ID");
  const columns = (required: boolean) =>
    field(
      "column_values",
      "Column values",
      required,
      "json",
      "JSON object keyed by column IDs. Supports text, long text, numbers, checkbox, date (YYYY-MM-DD) and existing status labels or indices. Empty values preserve existing fields.",
    );
  switch (action) {
    case "monday_create_item":
      return {
        fields: [
          board,
          field("group_id", "Group ID", false),
          field("item_name", "Item name"),
          columns(false),
        ],
      };
    case "monday_get_item_column_values":
      return {
        fields: [
          board,
          item,
          field(
            "column_ids",
            "Column IDs",
            false,
            "json",
            "Optional JSON array of column IDs. Leave empty to read all column text values.",
          ),
        ],
      };
    case "monday_update_item_name":
      return { fields: [board, item, field("name", "New item name")] };
    case "monday_update_column_values_of_item":
      return { fields: [board, item, columns(true)] };
    case "monday_create_update":
      return {
        fields: [
          board,
          item,
          field(
            "body",
            "Update",
            true,
            "long_text",
            "Plain text, posted as your connected user.",
          ),
        ],
      };
    default:
      return null;
  }
}
export function isMondayReference(piece: unknown, auth: unknown): boolean {
  return (
    piece === "@activepieces/piece-monday" &&
    [
      "{{connections.jarvis:monday}}",
      "{{connections['jarvis:monday']}}",
    ].includes(String(auth))
  );
}
/** Upstream's workspace dropdown and dynamic form do not describe the managed adapter. */
export function mondayEngineProps(
  piece: string,
  action: string,
  input: unknown,
): Record<string, any> | null {
  const auth = (input as any)?.auth;
  if (
    piece !== "@activepieces/piece-monday" ||
    auth?.jarvis_managed !== "monday"
  )
    return null;
  const schema = mondayInputSchema(action);
  if (!schema) return null;
  return Object.fromEntries(
    schema.fields.map((f) => [
      f.name,
      { displayName: f.label, type: f.sourceType, required: f.required },
    ]),
  );
}
