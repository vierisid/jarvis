import type { PieceInputSchema } from "./piece-input";
/** The managed account uses an explicit project ID; manual OAuth keeps the upstream project dropdown. */
export function gitlabInputSchema(action: string): PieceInputSchema | null {
  if (action !== "create_issue") return null;
  return {
    fields: [
      {
        name: "projectId",
        label: "Project ID",
        type: "string",
        sourceType: "SHORT_TEXT",
        required: true,
        description:
          "Copy the numeric Project ID from your GitLab.com project, or use a workflow variable.",
      },
      {
        name: "title",
        label: "Issue title",
        type: "string",
        sourceType: "SHORT_TEXT",
        required: true,
      },
      {
        name: "description",
        label: "Issue description",
        type: "string",
        sourceType: "LONG_TEXT",
        required: false,
        description:
          "Markdown, up to 10,000 characters. GitLab slash commands are not supported.",
      },
    ],
  };
}
export function isGitLabReference(piece: unknown, auth: unknown) {
  return (
    piece === "@activepieces/piece-gitlab" &&
    [
      "{{connections.jarvis:gitlab}}",
      "{{connections['jarvis:gitlab']}}",
    ].includes(String(auth))
  );
}
export function gitlabEngineProps(
  piece: string,
  action: string,
  input: unknown,
): Record<string, any> | null {
  if (
    piece !== "@activepieces/piece-gitlab" ||
    (input as any)?.auth?.jarvis_managed !== "gitlab"
  )
    return null;
  const schema = gitlabInputSchema(action);
  return schema
    ? Object.fromEntries(
        schema.fields.map((f) => [
          f.name,
          { displayName: f.label, type: f.sourceType, required: f.required },
        ]),
      )
    : null;
}
