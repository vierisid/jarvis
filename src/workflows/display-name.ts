/**
 * The one rule for a workflow's name (a flow version's `displayName`), shared
 * by every writer: the HTTP routes, the `manage_workflow` and
 * `workflow_draft_update` model tools, and the Brief All workflows list that
 * reads names already stored.
 *
 * A name is trimmed, and a name with no visible character is refused like an
 * empty one: only whitespace, control, zero-width or bidi format characters
 * (U+200B, U+202E, U+FEFF) or lone surrogates. Such a name renders as a blank
 * row, and the All workflows page used to fail to load while one existed.
 *
 * Pure (no imports), so the UI can import it too. The character rule (one line,
 * no controls, well formed) is the vault's `NOT_ONE_LINE`, applied by
 * `validDisplayName` in `api/routes.ts` and by `storedDisplayName` in
 * `db/repos/flow-version.ts`; that last one also maps a blank name to
 * `UNTITLED_WORKFLOW_NAME`, so no writer stores a blank row.
 *
 * The cap is one number for every writer: the routes, `manage_workflow`'s
 * create, compose, continue_setup and update, and the chat draft-update tool.
 * They drifted once: the routes allowed 512 while the assistant's update
 * allowed 200 and its create and compose had no cap. `manage_workflow` also
 * holds step names and display names to it (`stepNameRefusal` in
 * src/actions/tools/workflow-draft-update.ts); the dashboard's version routes
 * do not check step names.
 *
 * A write cap, not the prompt budget: `FLOW_NAME_MAX_CHARS` in
 * manage-workflow.ts truncates what the model reads back, and covers rows
 * written before any cap existed.
 */
export const FLOW_DISPLAY_NAME_MAX_CHARS = 512;

/** Shown, and stored when a blank stored name is carried into a new write. */
export const UNTITLED_WORKFLOW_NAME = "Untitled workflow";

const NO_VISIBLE_CHARACTER = /^[\s\p{Cc}\p{Cf}\p{Cs}\p{Z}]*$/u;

/** True when a person would see nothing: empty, or only invisible characters. */
export function isBlankWorkflowName(name: string): boolean {
  return NO_VISIBLE_CHARACTER.test(name);
}

export type WorkflowNameCheck =
  | { ok: true; name: string }
  | { ok: false; problem: "blank" }
  | { ok: false; problem: "too_long"; length: number; max: number };

/** The trimmed name, or why it is refused. Callers word their own message. */
export function workflowNameProblem(raw: unknown, max = FLOW_DISPLAY_NAME_MAX_CHARS): WorkflowNameCheck {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (isBlankWorkflowName(name)) return { ok: false, problem: "blank" };
  if (name.length > max) return { ok: false, problem: "too_long", length: name.length, max };
  return { ok: true, name };
}

/** The plain refusal for a name over the cap. `what` names the field. */
export function nameTooLongMessage(what: string, length: number, max = FLOW_DISPLAY_NAME_MAX_CHARS): string {
  return `${what} is ${length} characters; the limit is ${max}`;
}

/** A stored name as a person should see it. */
export function displayWorkflowName(stored: string | null | undefined): string {
  return typeof stored === "string" && !isBlankWorkflowName(stored) ? stored : UNTITLED_WORKFLOW_NAME;
}
