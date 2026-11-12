/**
 * The one length cap on a workflow name wherever a caller writes one: the
 * dashboard's routes (`validDisplayName` in ./routes.ts) and the assistant's
 * `manage_workflow` (create, compose, continue_setup and update). The two
 * drifted once: the routes allowed 512 while the assistant's update allowed 200
 * and its create and compose had no cap.
 *
 * `manage_workflow` also holds step names and display names to it, on the
 * graph a compose saves and on what an update writes (`stepNameRefusal` in
 * src/actions/tools/workflow-draft-update.ts). The dashboard's version routes
 * do not check step names.
 *
 * A write cap, not the prompt budget: `FLOW_NAME_MAX_CHARS` in
 * manage-workflow.ts truncates what the model reads back, and covers rows
 * written before any cap existed.
 */
export const WORKFLOW_NAME_MAX_CHARS = 512;

/** Why `name` is refused, or null when it fits. `what` names the field. */
export function nameLengthRefusal(name: string, what: string): string | null {
  return name.length > WORKFLOW_NAME_MAX_CHARS
    ? `${what} is ${name.length} characters; the limit is ${WORKFLOW_NAME_MAX_CHARS}`
    : null;
}
