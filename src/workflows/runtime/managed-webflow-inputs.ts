import type { PieceInputSchema, PieceInputField } from "./piece-input";
/** One managed-only contract for readiness, editor and engine. The legacy dynamic form calls v1. */
export function webflowInputSchema(action: string): PieceInputSchema | null {
  if (
    ![
      "create_collection_item",
      "update_collection_item",
      "get_collection_item",
      "find_collection_item",
    ].includes(action)
  )
    return null;
  const field = (
    name: string,
    label: string,
    required = true,
    type: PieceInputField["type"] = "string",
  ): PieceInputField => ({
    name,
    label,
    required,
    type,
    sourceType:
      type === "json" ? "JSON" : type === "number" ? "NUMBER" : "SHORT_TEXT",
  });
  const fields = [
    field("site_id", "Site"),
    field("collection_id", "Collection"),
  ];
  if (["get_collection_item", "update_collection_item"].includes(action))
    fields.push(field("collection_item_id", "Item ID"));
  if (["create_collection_item", "update_collection_item"].includes(action))
    fields.push({
      ...field("collection_fields", "Collection fields", true, "json"),
      description:
        "Fields keyed by slug. Writes always stay in draft. Media and reference fields are not supported.",
    });
  if (action === "find_collection_item")
    fields.push(
      {
        ...field("field_name", "Text field slug"),
        description: "For example name or slug. Matches the exact text value.",
      },
      field("field_value", "Exact text value"),
      {
        ...field("max_results", "Maximum results", false, "number"),
        description:
          "1 to 100, default 20. Searches up to 1,000 items; incomplete searches fail explicitly.",
      },
    );
  return { fields };
}
export function isWebflowReference(piece: unknown, auth: unknown): boolean {
  return (
    piece === "@activepieces/piece-webflow" &&
    [
      "{{connections.jarvis:webflow}}",
      "{{connections['jarvis:webflow']}}",
    ].includes(String(auth))
  );
}
export function webflowEngineProps(
  piece: string,
  action: string,
  input: unknown,
): Record<string, any> | null {
  if (
    piece !== "@activepieces/piece-webflow" ||
    (input as any)?.auth?.jarvis_managed !== "webflow"
  )
    return null;
  const schema = webflowInputSchema(action);
  return schema
    ? Object.fromEntries(
        schema.fields.map((f) => [
          f.name,
          { displayName: f.label, type: f.sourceType, required: f.required },
        ]),
      )
    : null;
}
