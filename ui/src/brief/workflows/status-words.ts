/**
 * One vocabulary for a workflow's state, used by the All workflows list and the
 * workflow page. The server keeps three separate facts (ENABLED/DISABLED,
 * published or not, readiness). A founder sees one: the workflow is On (it runs
 * on its trigger) or Off, plus at most one note. Server semantics are unchanged.
 */
export interface WorkflowStatusFacts {
  activation: "ENABLED" | "DISABLED";
  /** True when the version being shown is a draft that is not what runs now. */
  draftChangesNotLive: boolean;
  readiness: "ready" | "blocked" | "unknown";
}
export interface WorkflowStatusWords {
  /** The switch word. */
  state: "On" | "Off";
  /** Secondary note, or null when there is nothing to add. */
  note: "Needs setup" | "Draft changes not live yet" | "Setup status unknown" | null;
  /** One line for a header or subtitle: state plus note. */
  line: string;
}
export const WORKFLOW_SAVE_ACTION = "Save and turn on";
export function workflowStatusWords(f: WorkflowStatusFacts): WorkflowStatusWords {
  const state = f.activation === "ENABLED" ? "On" : "Off";
  const note = f.readiness === "blocked" ? "Needs setup"
    : f.readiness === "unknown" ? "Setup status unknown"
    : f.draftChangesNotLive && state === "On" ? "Draft changes not live yet"
    : null;
  return { state, note, line: note ? `${state} · ${note}` : state };
}
