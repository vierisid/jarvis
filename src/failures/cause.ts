/**
 * The reason a step failed, as one plain line a person can read. A failed
 * step's recorded message is the engine's whole error report: the piece's own
 * message followed by a stack trace with server file paths, sometimes wrapped
 * in JSON, and always ending with the retry guidance. Only the piece's own
 * message is the cause. The report stays in the server log.
 */
import { redactSecrets } from '../util/redact';
import { boundedReceiptText } from '../roles/untrusted';
import { WORKFLOW_RETRY_GUIDANCE } from '../workflows/queue/retry-policy';

export const CAUSE_MAX = 240;

/** A file path of a server, an engine cache or a package, with its position in the file. */
const PATH = /(?:[A-Za-z]:\\|file:\/\/|(?<![\w.)\]:/])\/)(?:[\w@.~+-]+[\\/])+[\w@.~+-]*(?::\d+){0,2}/g;
const STACK_LINE = /^\s*at\s/;
const ERROR_NAME = /^(?:[A-Z][A-Za-z]*)?(?:Error|Exception)(?:\s*\[[^\]]*\])?:\s*/;
/** The executor's own wrapper around a step's error report. */
const EXECUTOR_PREFIX = /^engine executor: run \S+ ended [A-Z_]+ at step "[^"]*":?\s*/;
const INTERNAL_PREFIX = /^internal error:\s*/i;

/** The first text in a JSON error body: a field-by-field `errors` map, or a `message` / `error` string. */
function fromJson(line: string): string | null {
  if (!line.startsWith('{') && !line.startsWith('[')) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as Record<string, unknown>;
  const text = (value: unknown): string | null => typeof value === 'string' ? value
    : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').join(' ') || null : null;
  const errors = body.errors;
  if (errors && typeof errors === 'object') {
    const parts = Object.entries(errors as Record<string, unknown>).map(([field, value]) => {
      const said = text(value);
      return said ? `${field.replace(/_/g, ' ')}: ${said}` : null;
    }).filter((p): p is string => p !== null);
    if (parts.length) return parts.join('; ');
  }
  return text(body.message) ?? text(body.error);
}

/**
 * The step's own error message: first line, with no stack frame, server or
 * engine path, error class name or retry guidance, credentials redacted, frame
 * delimiters defanged and bounded. Null when nothing readable is left.
 */
export function failureCause(message: unknown, max = CAUSE_MAX): string | null {
  const text = typeof message === 'string' ? message : message === undefined || message === null ? '' : safeJson(message);
  const rest = text.replaceAll(WORKFLOW_RETRY_GUIDANCE, '').replace(EXECUTOR_PREFIX, '').trim();
  // A whole JSON report (the engine pretty-prints one) reads as its message, not as its first line.
  const lines = (fromJson(rest) ?? rest).split(/\r?\n/);
  for (const raw of lines) {
    let line = raw.trim();
    if (!line || STACK_LINE.test(line)) continue;
    line = line.replace(INTERNAL_PREFIX, '');
    line = fromJson(line) ?? line;
    line = redactSecrets(line).replace(ERROR_NAME, '').replace(PATH, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
    line = line.replace(/^[\s:;,(]+|[\s:;,(]+$/g, '');
    if (!/[A-Za-z0-9]/.test(line)) continue;
    // The message can carry text from outside Jarvis (a piece's error, a server's reply):
    // a frame delimiter in it is defanged, as every other receipt text is.
    return boundedReceiptText(line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line, max);
  }
  return null;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}

/** The cause as a sentence: first letter capitalised, one closing full stop. */
export function causeSentence(cause: string): string {
  const text = cause.charAt(0).toUpperCase() + cause.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
