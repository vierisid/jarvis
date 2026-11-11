/** What the confirm for a destructive edit says: the steps that go with it and the steps it leaves broken. */
import { stepsInside, stepsOnChain, stepsReadingResultOf } from "./tree";
import type { FlowStepNode } from "./useWorkflowEditor";

const label = (step: FlowStepNode): string => `"${step.displayName ?? step.name}" (${step.name})`;

function list(steps: FlowStepNode[], max = 5): string {
  const shown = steps.slice(0, max).map(label).join(", ");
  return steps.length > max ? `${shown} and ${steps.length - max} more` : shown;
}

function consequences(roots: FlowStepNode[], removed: FlowStepNode[], results: FlowStepNode[], inside: FlowStepNode[]): string[] {
  // Anything that reads a removed step's result is left without it.
  const readers = new Map<string, FlowStepNode>();
  for (const step of results) for (const reader of stepsReadingResultOf(roots, step.name, removed)) readers.set(reader.name, reader);
  const lines: string[] = [];
  if (inside.length) lines.push(`This also removes the steps inside it: ${list(inside)}.`);
  if (readers.size) lines.push(`These steps use its result and would be left pointing at nothing: ${list([...readers.values()])}. Change them before you publish.`);
  return lines;
}

/** The confirm text for deleting `step`, naming what else goes and what it breaks. */
export function deleteStepPrompt(roots: FlowStepNode[], step: FlowStepNode): string {
  const inside = stepsInside(step);
  const lines = consequences(roots, [step, ...inside], [step, ...inside], inside);
  return [`Delete step "${step.displayName ?? step.name}"?`, ...lines, ...(lines.length ? ["You can Undo until you save."] : [])].join("\n");
}

/** The confirm text for removing a router branch, whose steps are deleted with it. */
export function removeBranchPrompt(roots: FlowStepNode[], branchName: string, head: FlowStepNode | null | undefined): string {
  const removed = stepsOnChain(head);
  const lines = removed.length ? [`This deletes the steps in it: ${list(removed)}.`] : [];
  const readers = new Map<string, FlowStepNode>();
  for (const step of removed) for (const reader of stepsReadingResultOf(roots, step.name, removed)) readers.set(reader.name, reader);
  if (readers.size) lines.push(`These steps use their results and would be left pointing at nothing: ${list([...readers.values()])}.`);
  return [`Remove branch "${branchName}"?`, ...lines, ...(lines.length ? ["You can Undo until you save."] : [])].join("\n");
}
