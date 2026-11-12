/**
 * How the HTTP and GraphQL steps say a request failed.
 *
 * Upstream hands the flow `{"response":{"status":404,"body":""},"request":{}}`
 * as the error text, shows a client timeout as a server 500, and, when a step
 * continues past a failure, returns that shape instead of the success one. The
 * vendored pieces call these helpers instead, so a failure reads as a
 * sentence and a continued failure keeps the success fields.
 *
 * The response body is what the server chose to send, so it is redacted with
 * the same rules as the approval card and the receipt (`redactCredentials`)
 * before any of it is shown, and only the first part is kept. It is quoted,
 * so it never reads as Jarvis's own words, and frame delimiters in it are
 * defanged as in every other receipt text (`boundedReceiptText`).
 */
import { STATUS_CODES } from 'node:http';
import { boundedReceiptText } from '../../roles/untrusted';
import { redactCredentials } from './piece-effects';

/** How much of a response body a failure sentence quotes. */
export const FAILURE_BODY_CHARS = 300;

/** What the vendored `HttpError` knows about a failed request. */
export interface HttpFailure {
  /** The server's status, or undefined when no response came back. */
  status?: number;
  hasResponse: boolean;
  /** The transport's error code (`ECONNABORTED`, `ENOTFOUND`, ...), when there was no response. */
  code?: string;
  body?: unknown;
  headers?: unknown;
}

/** A timeout, as axios and Node name one. */
function timedOut(code: string | undefined): boolean {
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT';
}

/**
 * Errors raised before a connection to the server existed: the name did not
 * resolve, or the address refused or could not be routed to. Anything else
 * with no response (a reset, a closed socket, a TLS or redirect failure) may
 * have come after the request was written, so it is not called unreachable.
 */
const NOT_CONNECTED = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

/** The first part of a response body as one redacted line of text, or ''. */
export function bodyExcerpt(body: unknown): string {
  if (body === undefined || body === null || body === '') return '';
  let text: string;
  try {
    const safe = redactCredentials(body);
    text = typeof safe === 'string' ? safe : JSON.stringify(safe) ?? '';
  } catch {
    return '';
  }
  text = text.replace(/\s+/gu, ' ').trim();
  return boundedReceiptText(text.length > FAILURE_BODY_CHARS ? `${text.slice(0, FAILURE_BODY_CHARS)}...` : text, FAILURE_BODY_CHARS + 3);
}

/** The server's own words, quoted, so they are never read as Jarvis's. */
function quoted(text: string): string {
  return `"${text.replaceAll('"', "'")}"`;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname || url; } catch { return 'the server'; }
}

/**
 * One plain sentence for a failed request. `timeoutSeconds` is the step's own
 * timeout; `url` only supplies the host name, never a path, query or login.
 */
export function describeHttpFailure(failure: HttpFailure, request: { url: string; timeoutSeconds?: number }): string {
  if (!failure.hasResponse) {
    if (timedOut(failure.code)) {
      const seconds = request.timeoutSeconds;
      return seconds && seconds > 0
        ? `The request timed out after ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`
        : 'The request timed out.';
    }
    if (failure.code !== undefined && NOT_CONNECTED.has(failure.code)) return `Could not reach ${hostOf(request.url)}.`;
    return `The connection to ${hostOf(request.url)} failed before an answer came back${failure.code ? ` (${failure.code})` : ''}.`;
  }
  const status = failure.status ?? 0;
  const reason = STATUS_CODES[status];
  const head = `The server answered ${status}${reason ? ` ${reason}` : ''}.`;
  const excerpt = bodyExcerpt(failure.body);
  return excerpt ? `${head} It said: ${quoted(excerpt)}` : head;
}

/** A 408, 429, any 5xx, or no response at all: worth sending again. 4xx otherwise is not. */
export function isRetryableFailure(failure: HttpFailure): boolean {
  if (!failure.hasResponse) return true;
  const status = failure.status ?? 0;
  return status >= 500 || status === 408 || status === 429;
}

/** The reply body for the legacy `response.body` key: redacted, and cut to the excerpt when it is long. */
function legacyBody(body: unknown): unknown {
  if (body === undefined || body === null) return body ?? null;
  try {
    const safe = redactCredentials(body);
    const text = typeof safe === 'string' ? safe : JSON.stringify(safe) ?? '';
    return text.length > FAILURE_BODY_CHARS ? bodyExcerpt(body) : safe;
  } catch {
    return '';
  }
}

/**
 * What a step that continues past a failure returns: the success fields
 * (`status`, `headers`, `body`) so `{{step.body}}` still resolves, `ok: false`
 * and the sentence. No response (a timeout, an unreachable host) has no
 * status, so it is null rather than a made-up 500.
 *
 * `response` and `request` keep the old shape (`{{step.response.status}}`) for
 * saved flows that read it: the body there is redacted and bounded.
 */
export function continuedFailure(failure: HttpFailure, message: string): {
  status: number | null; headers: unknown; body: unknown; ok: false; error: string;
  response: { status: number; body: unknown }; request: Record<string, never>;
} {
  return {
    status: failure.hasResponse ? failure.status ?? null : null,
    headers: failure.headers ?? {},
    body: failure.body ?? null,
    ok: false,
    error: message,
    response: { status: failure.status ?? 500, body: legacyBody(failure.body) },
    request: {},
  };
}

/** The failure facts an error carries, or null for an error that is not an HTTP failure. */
export function httpFailureOf(error: unknown): HttpFailure | null {
  if (error === null || typeof error !== 'object') return null;
  const e = error as { hasResponse?: unknown; status?: unknown; code?: unknown; responseBody?: unknown; responseHeaders?: unknown };
  if (typeof e.hasResponse !== 'boolean') return null;
  return {
    hasResponse: e.hasResponse,
    ...(typeof e.status === 'number' ? { status: e.status } : {}),
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
    body: e.responseBody,
    headers: e.responseHeaders,
  };
}

/** The sentence for a GraphQL response whose `errors` array is not empty, or null when it has none. */
export function graphqlErrorMessage(body: unknown): string | null {
  const errors = body !== null && typeof body === 'object' ? (body as { errors?: unknown }).errors : undefined;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0] as unknown;
  const raw = typeof first === 'string' ? first
    : first !== null && typeof first === 'object' && typeof (first as { message?: unknown }).message === 'string' ? (first as { message: string }).message
    : '';
  const text = bodyExcerpt(raw);
  return text ? `The GraphQL server reported an error: ${quoted(text)}` : 'The GraphQL server reported an error.';
}
