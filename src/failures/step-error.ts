/**
 * What a failed step's own error text says, read without the wrappers the
 * runtime puts around it, and the two kinds of failure whose outcome that text
 * already settles: a server that answered with an error status, and a called
 * workflow whose own run ended Failed.
 *
 * Pure text reading, no I/O. Callers decide which step may be read this way.
 */
import { STATUS_CODES } from 'node:http';

/** A daemon refusal: `<who>: daemon responded 409: {"error":"..."}`, the body cut at 500 characters. */
const DAEMON_RESPONSE = /(?:^|:\s)daemon responded \d{3}:\s*([\s\S]+)$/;
/** An action outcome printed as `<status> <CODE>: <message>`. */
const OUTCOME_LINE = /^(?:blocked|error|unknown) [A-Z][A-Z0-9_]{2,}:\s*([\s\S]+)$/;
const JSON_ERROR_FIELD = /"(?:error|message)"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/** The plain sentence inside a JSON reply, also when the reply was cut short. */
function sentenceIn(body: string): string {
  const text = body.trim();
  if (!text.startsWith('{')) return text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown; outcome?: { message?: unknown } };
    for (const value of [parsed.error, parsed.message, parsed.outcome?.message]) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return text;
  } catch {
    const said = JSON_ERROR_FIELD.exec(text)?.[1];
    if (said === undefined) return text;
    try { return (JSON.parse(`"${said}"`) as string).trim() || text; } catch { return said.trim() || text; }
  }
}

/**
 * The step's error text with the runtime's wrappers removed: "Governed piece
 * ... was not authorized: daemon responded 409: {json}" reads as the sentence
 * inside the JSON, and "blocked HUMAN_INPUT_REJECTED: Human request rejected"
 * as "Human request rejected". Text with no wrapper comes back unchanged.
 */
export function plainStepMessage(message: string): string {
  let text = message.trim();
  for (let i = 0; i < 3; i++) {
    const inner = DAEMON_RESPONSE.exec(text)?.[1] ?? OUTCOME_LINE.exec(text)?.[1];
    if (inner === undefined) break;
    const next = sentenceIn(inner);
    if (!next || next === text) break;
    text = next;
  }
  return text;
}

/** The server's error status when a request step's error text says the server answered 4xx, else null. */
export function serverRefusalStatus(message: string | undefined): number | null {
  if (!message) return null;
  // Today's wording, then the shape upstream raised before it: {"response":{"status":404,...}}.
  const said = /The server answered (\d{3})\b/.exec(message)?.[1] ?? /"response"\s*:\s*\{\s*"status"\s*:\s*(\d{3})\b/.exec(message)?.[1];
  const status = said ? Number(said) : 0;
  return status >= 400 && status < 500 ? status : null;
}

/** "404 Not Found", or "404" for a status with no standard name. */
export function statusLabel(status: number): string {
  const reason = STATUS_CODES[status];
  return reason ? `${status} ${reason}` : String(status);
}

/**
 * Whether a call step's error says the workflow it called ended Failed, and
 * that workflow's name when the text has it. A timeout, an unusable result or
 * a child that never reported back is not this: those leave the outcome open.
 */
export function calledWorkflowFailure(message: string | undefined): { child?: string } | null {
  if (!message) return null;
  const named = /The workflow "([^"]{1,200})" failed\. Open its latest run/.exec(message);
  if (named) return { child: named[1]! };
  return /Reusable child did not succeed: failed\b/.test(message) ? {} : null;
}
