import type { PieceInputSchema, PieceInputField } from "./piece-input";
/** One managed contract for the editor, readiness and engine. Manual accounts keep upstream props. */
export function wrikeInputSchema(action: string): PieceInputSchema | null {
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
      type === "boolean"
        ? "CHECKBOX"
        : type === "number"
          ? "NUMBER"
          : type === "long_text"
            ? "LONG_TEXT"
            : "SHORT_TEXT",
    ...(description ? { description } : {}),
  });
  const choice = (
    name: string,
    label: string,
    values: string[],
    required = false,
  ): PieceInputField => ({
    ...field(name, label, required),
    type: "enum",
    sourceType: "STATIC_DROPDOWN",
    options: values.map((value) => ({ value, label: value })),
  });
  const status = choice("status", "Status", [
    "Active",
    "Completed",
    "Deferred",
    "Cancelled",
  ]);
  const importance = choice("importance", "Importance", [
    "Low",
    "Normal",
    "High",
  ]);
  const folder = (required: boolean) =>
    field(
      "folderId",
      "Folder ID",
      required,
      "string",
      "Wrike API folder or project ID, or a workflow variable. This is not the numeric ID in the browser URL.",
    );
  if (action === "find_task")
    return {
      fields: [
        field(
          "taskId",
          "Task ID",
          false,
          "string",
          "Read one task by its API ID. Leave search filters empty when using this field.",
        ),
        folder(false),
        field("title", "Title contains"),
        status,
        importance,
        field(
          "pageSize",
          "Page size",
          false,
          "number",
          "1 to 100; defaults to 100.",
        ),
        field(
          "nextPageToken",
          "Next page token",
          false,
          "string",
          "Use nextPageToken from the preceding page with the same search filters.",
        ),
      ],
    };
  if (action === "create_task" || action === "update_task")
    return {
      fields: [
        action === "create_task"
          ? folder(true)
          : field("taskId", "Task ID", true),
        field("title", "Title", action === "create_task"),
        field(
          "description",
          "Description",
          false,
          "long_text",
          "Empty fields preserve existing values. Assignees, scheduling and custom fields are not supported by this connection yet.",
        ),
        status,
        importance,
      ],
    };
  if (action === "add_comment")
    return {
      fields: [
        {
          ...field(
            "plainText",
            "Treat comment as plain text",
            false,
            "boolean",
            "Turn off to send Wrike-supported HTML markup.",
          ),
          default: true,
        },
        choice("entityType", "Comment on", ["tasks", "folders"], true),
        field("entityId", "Task or folder ID", true),
        field(
          "text",
          "Comment",
          true,
          "long_text",
          "Posted by your connected user. People following the task or folder may be notified.",
        ),
      ],
    };
  return null;
}
export function isWrikeReference(piece: unknown, auth: unknown): boolean {
  return (
    piece === "@activepieces/piece-wrike" &&
    [
      "{{connections.jarvis:wrike}}",
      "{{connections['jarvis:wrike']}}",
    ].includes(String(auth))
  );
}
export function wrikeEngineProps(
  piece: string,
  action: string,
  input: unknown,
): Record<string, any> | null {
  if (
    piece !== "@activepieces/piece-wrike" ||
    (input as any)?.auth?.jarvis_managed !== "wrike"
  )
    return null;
  const schema = wrikeInputSchema(action);
  return schema
    ? Object.fromEntries(
        schema.fields.map((f) => [
          f.name,
          {
            displayName: f.label,
            type: f.sourceType,
            required: f.required,
            ...(f.options ? { options: { options: f.options } } : {}),
          },
        ]),
      )
    : null;
}
