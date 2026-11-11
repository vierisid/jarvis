/**
 * Server readiness issues (`{ node, path, code, message }`) in words a person can act on.
 * The server owns the wording of each message; this names the step by its title instead of
 * its internal id, and turns the dangling-reference refusal into the thing that happened.
 */

export interface ReadinessIssueLike { node?: unknown; path?: unknown; code?: unknown; message?: unknown }

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The step titles the editor knows, by internal name. */
export type StepNamer = (name: string) => string | undefined;

export function issueLine(issue: ReadinessIssueLike, nameOf: StepNamer): string {
  const node = text(issue.node);
  const step = node ? nameOf(node) : undefined;
  const who = step ? `"${step}"` : node && node !== "trigger" ? `Step ${node}` : node ? "The trigger" : "This workflow";
  const message = text(issue.message);
  const ref = /^Reference "([^"]+)" is missing/.exec(message)?.[1];
  if (text(issue.code) === "REFERENCE_SCOPE" && ref) {
    const target = nameOf(ref);
    return target
      ? `${who} uses the result of "${target}", which does not run before it.`
      : `${who} uses the result of a step that was deleted or does not run before it (${ref}). Choose another step's result or remove it.`;
  }
  return message ? `${who}: ${message}` : `${who} is not ready.`;
}

/** Up to `max` distinct lines for an `issues` array; empty when there are none. */
export function issueLines(issues: unknown, nameOf: StepNamer, max = 4): string[] {
  if (!Array.isArray(issues)) return [];
  const lines = [...new Set(issues.filter((i): i is ReadinessIssueLike => typeof i === "object" && i !== null).map((i) => issueLine(i, nameOf)))];
  return lines.length > max ? [...lines.slice(0, max), `And ${lines.length - max} more.`] : lines;
}

/** A refused request's body as one message: its issues, else its own sentence, else nothing. */
export function refusalMessage(body: unknown, nameOf: StepNamer): string | null {
  if (typeof body !== "object" || body === null) return null;
  const lines = issueLines((body as { issues?: unknown }).issues, nameOf);
  if (lines.length) return lines.join(" ");
  const sentence = text((body as { error?: unknown }).error);
  return sentence && !/^[A-Za-z_]+$/.test(sentence) ? sentence : null;
}
