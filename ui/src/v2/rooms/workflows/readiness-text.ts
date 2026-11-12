/**
 * Server readiness issues (`{ node, path, code, message }`) in words a person can act on.
 * The server owns the wording of each message; this names the step by its title instead of
 * its internal id, and turns the dangling-reference refusal into the thing that happened.
 */
import { forCard } from "../../../../../src/util/card-text";

export interface ReadinessIssueLike { node?: unknown; path?: unknown; code?: unknown; message?: unknown }

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * A step title, branch name or step id as it appears inside quotes in a confirm or an issue line.
 * These are text people and the model wrote. `forCard` drops invisible and control characters and
 * collapses line breaks, so a name cannot add a line to a confirm (whose first line is its title)
 * or reorder what it reads; a `"` becomes `'` so a name cannot close its own quotes; each is capped.
 * The same rule as the workflow and connection names in `flow-dependents.ts` (#1373).
 */
export const NAME_MAX = 80;
export function cardName(value: unknown): string {
  return forCard(value, NAME_MAX).replace(/"/g, "'");
}

/** The step titles the editor knows, by internal name. */
export type StepNamer = (name: string) => string | undefined;

/** Issues about the workflow as a whole: the message is the sentence, with no step in front of it. */
const WORKFLOW_WIDE = new Set(["NO_STEPS", "VERSION"]);

export function issueLine(issue: ReadinessIssueLike, nameOf: StepNamer): string {
  const node = text(issue.node);
  const step = node ? nameOf(node) : undefined;
  const who = step ? `"${cardName(step)}"` : node && node !== "trigger" ? `Step ${cardName(node)}` : node ? "The trigger" : "This workflow";
  const message = forCard(issue.message);
  const code = text(issue.code);
  const ref = /^Reference "([^"]+)" is missing/.exec(message)?.[1];
  if (code === "REFERENCE_SCOPE" && ref) {
    const target = nameOf(ref);
    return target
      ? `${who} uses the result of "${cardName(target)}", which does not run before it.`
      : `${who} uses the result of a step that was deleted or does not run before it (${cardName(ref)}). Choose another step's result or remove it.`;
  }
  if (WORKFLOW_WIDE.has(code) && message) return message;
  return message ? `${who}: ${message}` : `${who} is not ready.`;
}

/** Up to `max` distinct lines for an `issues` array; empty when there are none. */
export function issueLines(issues: unknown, nameOf: StepNamer, max = 4): string[] {
  if (!Array.isArray(issues)) return [];
  const lines = [...new Set(issues.filter((i): i is ReadinessIssueLike => typeof i === "object" && i !== null).map((i) => issueLine(i, nameOf)))];
  return lines.length > max ? [...lines.slice(0, max), `And ${lines.length - max} more.`] : lines;
}

/**
 * A refused request's body as one message: its issues, else its own sentence, else nothing.
 * `status`, when known, keeps a server failure (5xx) from showing its internal error text: only a
 * refusal (4xx) is worded from the body.
 */
export function refusalMessage(body: unknown, nameOf: StepNamer, status?: number): string | null {
  if (typeof body !== "object" || body === null) return null;
  if (status !== undefined && (status < 400 || status >= 500)) return null;
  const lines = issueLines((body as { issues?: unknown }).issues, nameOf);
  if (lines.length) return lines.join(" ");
  const sentence = forCard((body as { error?: unknown }).error);
  return sentence && !/^[A-Za-z_]+$/.test(sentence) ? sentence : null;
}
