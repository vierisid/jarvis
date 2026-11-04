import type { PieceInputSchema, PieceInputField } from "./piece-input";
/** One managed-only contract shared by editor, readiness and engine validation. */
export function pipedriveInputSchema(action: string): PieceInputSchema | null {
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
    sourceType:
      type === "json"
        ? "JSON"
        : type === "number"
          ? "NUMBER"
          : type === "boolean"
            ? "CHECKBOX"
            : "SHORT_TEXT",
    description,
  });
  const choice = (
    name: string,
    label: string,
    values: string[],
  ): PieceInputField => ({
    ...field(name, label),
    type: "enum",
    sourceType: "STATIC_DROPDOWN",
    options: values.map((value) => ({ label: value, value })),
  });
  const person = action.endsWith("person") || action === "search-persons";
  const id = field(
    person ? "personId" : "dealId",
    person ? "Person ID" : "Deal ID",
    true,
    "string",
    "Use the numeric ID from a previous step or a Pipedrive record URL.",
  );
  if (action === "get-person" || action === "get-deal") return { fields: [id] };
  if (action === "search-persons" || action === "search-deals")
    return {
      fields: [
        field(
          "term",
          "Search term",
          true,
          "string",
          "At least two characters, or one for an exact match.",
        ),
        field(
          "fields",
          "Search fields",
          false,
          "json",
          person
            ? 'Optional JSON array: ["name"], ["email"] or ["phone"]. Empty searches names, email and phone.'
            : 'Optional JSON array: ["title"]. Empty searches titles.',
        ),
        field("exactMatch", "Exact match", false, "boolean"),
        field("organizationId", "Organization ID"),
        ...(!person
          ? [
              field("personId", "Person ID"),
              choice("status", "Status", ["open", "won", "lost"]),
            ]
          : []),
        field(
          "limit",
          "Results per page",
          false,
          "number",
          "1-100; defaults to 50.",
        ),
        field(
          "cursor",
          "Next page cursor",
          false,
          "string",
          "Use next_cursor from the previous search. Leave empty for the first page.",
        ),
      ],
    };
  if (
    !["create-person", "update-person", "create-deal", "update-deal"].includes(
      action,
    )
  )
    return null;
  const create = action.startsWith("create-");
  return {
    fields: [
      ...(!create ? [id] : []),
      ...(person
        ? [
            field("name", "Name", create),
            field(
              "email",
              "Email addresses",
              false,
              "json",
              'JSON array, for example ["person@example.com"]. Replaces existing addresses when updating; empty preserves them.',
            ),
            field(
              "phone",
              "Phone numbers",
              false,
              "json",
              "JSON array of phone numbers. Replaces existing numbers when updating; empty preserves them.",
            ),
            field("organizationId", "Organization ID"),
          ]
        : [
            field("title", "Deal title", create),
            field("dealValue", "Value", false, "number"),
            field(
              "dealValueCurrency",
              "Currency",
              false,
              "string",
              "Three-letter currency code, such as EUR or USD.",
            ),
            field("personId", "Person ID"),
            field("organizationId", "Organization ID"),
            field(
              "pipelineId",
              "Pipeline ID",
              false,
              "string",
              "Optional. Pipedrive uses its default pipeline for a new deal.",
            ),
            field(
              "stageId",
              "Stage ID",
              false,
              "string",
              "Optional. Use a stage in the selected pipeline.",
            ),
            choice("status", "Status", ["open", "won", "lost"]),
            field(
              "expectedCloseDate",
              "Expected close date",
              false,
              "string",
              "YYYY-MM-DD. Empty fields preserve existing values.",
            ),
            field(
              "probability",
              "Probability (%)",
              false,
              "number",
              "0-100. Requires deal probability to be enabled in Pipedrive.",
            ),
          ]),
    ],
  };
}
export function isPipedriveReference(piece: unknown, auth: unknown) {
  return (
    piece === "@activepieces/piece-pipedrive" &&
    [
      "{{connections.jarvis:pipedrive}}",
      "{{connections['jarvis:pipedrive']}}",
    ].includes(String(auth))
  );
}
export function pipedriveEngineProps(
  piece: string,
  action: string,
  input: unknown,
): Record<string, any> | null {
  if (
    piece !== "@activepieces/piece-pipedrive" ||
    (input as any)?.auth?.jarvis_managed !== "pipedrive"
  )
    return null;
  const schema = pipedriveInputSchema(action);
  return schema
    ? Object.fromEntries(
        schema.fields.map((f) => [
          f.name,
          {
            displayName: f.label,
            type: f.sourceType,
            required: f.required,
            ...(f.options
              ? { options: { disabled: false, options: f.options } }
              : {}),
          },
        ]),
      )
    : null;
}
