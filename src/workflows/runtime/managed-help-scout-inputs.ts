import type { PieceInputSchema, PieceInputField } from "./piece-input";
/** Shared managed-only editor, readiness and engine contract; manual accounts keep upstream fields. */
export function helpScoutInputSchema(action: string): PieceInputSchema | null {
  const field = (
    name: string,
    label: string,
    required = false,
    description?: string,
  ): PieceInputField => ({
    name,
    label,
    required,
    type: "string",
    sourceType: name === "text" ? "LONG_TEXT" : "SHORT_TEXT",
    description,
  });
  if (action === "find_customer")
    return {
      fields: [
        field(
          "email",
          "Customer email",
          true,
          "Exact email match. Duplicate matches stop the workflow.",
        ),
      ],
    };
  if (action === "find_conversation")
    return {
      fields: [
        field(
          "conversationId",
          "Conversation ID",
          false,
          "Use a Help Scout conversation ID or a workflow variable. Alternatively, fill both fields below.",
        ),
        field(
          "mailboxId",
          "Inbox ID",
          false,
          "Required with Conversation number when no Conversation ID is supplied.",
        ),
        field(
          "number",
          "Conversation number",
          false,
          "The displayed conversation number, together with its Inbox ID. Searches include closed conversations.",
        ),
      ],
    };
  if (action === "add_note")
    return {
      fields: [
        field("conversationId", "Conversation ID", true),
        field(
          "text",
          "Internal note",
          true,
          "Plain text, up to 10,000 characters. Added as the connected user; visible to teammates, not sent as a customer reply.",
        ),
      ],
    };
  return null;
}
export function isHelpScoutReference(piece: unknown, auth: unknown) {
  return (
    piece === "@activepieces/piece-help-scout" &&
    [
      "{{connections.jarvis:help-scout}}",
      "{{connections['jarvis:help-scout']}}",
    ].includes(String(auth))
  );
}
export function helpScoutEngineProps(
  piece: string,
  action: string,
  input: unknown,
): Record<string, any> | null {
  if (
    piece !== "@activepieces/piece-help-scout" ||
    (input as any)?.auth?.jarvis_managed !== "help-scout"
  )
    return null;
  const schema = helpScoutInputSchema(action);
  return schema
    ? Object.fromEntries(
        schema.fields.map((f) => [
          f.name,
          { displayName: f.label, type: f.sourceType, required: f.required },
        ]),
      )
    : null;
}
