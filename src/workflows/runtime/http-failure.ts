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
 * defanged as in every other receipt text (`boundedReceiptText`). A web page
 * is not quoted as markup: the failure names the page's title, or the text a
 * reader would see, never tags, scripts or styles.
 */
import { STATUS_CODES } from 'node:http';
import { boundedReceiptText } from '../../roles/untrusted';
import { withoutCardInvisibles } from '../../util/card-text';
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

/** Whether a response body is a web page (an error page from a server or a proxy), not JSON or plain text. */
function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 2000);
  return /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/iu.test(head)
    || (/<html[\s>]/iu.test(head) && /<\/(?:html|body|head|title)>/iu.test(text));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * How much of a web page is read for its title or its visible text. Both are
 * at the start of a page, and a body can be megabytes the server chose, so
 * the scan is bounded rather than every pattern below having to be linear.
 */
const HTML_SCAN_CHARS = 64 * 1024;

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/giu, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

/**
 * The words between `<title ...>` and `</title>`, or undefined. Found with
 * one forward search for each end rather than one lazy pattern, which went
 * quadratic on a page of unclosed `<title` tags.
 */
function pageTitle(html: string): string | undefined {
  const open = /<title\b/iu.exec(html);
  if (!open) return undefined;
  const start = html.indexOf('>', open.index);
  if (start < 0) return undefined;
  const close = /<\/title\s*>/giu;
  close.lastIndex = start + 1;
  const end = close.exec(html);
  return end ? html.slice(start + 1, end.index) : undefined;
}

/**
 * Markup as the words a reader would see: tags out, entities decoded, and
 * the invisible and control characters a card drops (bidi overrides, zero
 * widths) dropped too, since an entity can spell one the raw page did not.
 * Every pattern here consumes what it scans, so the cost is linear.
 */
function pageWords(markup: string): string {
  // Collapsed and trimmed before `bodyExcerpt` redacts it: a reply that is
  // one form pair once the tags are gone is redacted only as a whole line.
  return withoutCardInvisibles(decodeEntities(markup.replace(/<[^>]*>?/gu, ' '))).replace(/\s+/gu, ' ').trim();
}

/** Tags, scripts, styles, comments and the head out; what is left is what a reader would see. */
function visibleText(html: string): string {
  return pageWords(html
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)/giu, ' ')
    // `</head>` may be left out, so the body's own tag also ends the head.
    .replace(/<head\b[\s\S]*?(?:<\/head\s*>|(?=<body[\s>/])|$)/giu, ' '));
}

/**
 * What a web page body says in words: `titled "..."` when it has a title,
 * else the text a reader would see, else nothing. Redacted (the whole body,
 * so no credential is cut in two by the scan bound) before it is read, and
 * redacted, defanged and cut again like any other excerpt after. Null when
 * the body is not a web page.
 */
function htmlSummary(body: unknown): { titled?: string; said?: string } | null {
  if (typeof body !== 'string' || !looksLikeHtml(body)) return null;
  let safe: string;
  try { const redacted = redactCredentials(body); safe = typeof redacted === 'string' ? redacted : body; } catch { return {}; }
  safe = safe.slice(0, HTML_SCAN_CHARS);
  const title = pageTitle(safe);
  const titled = title === undefined ? '' : bodyExcerpt(pageWords(title));
  if (titled) return { titled };
  const said = bodyExcerpt(visibleText(safe));
  return said ? { said } : {};
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
  const page = htmlSummary(failure.body);
  if (page) {
    if (page.titled) return `${head} It sent a web page titled ${quoted(page.titled)}.`;
    return page.said ? `${head} It sent a web page that said: ${quoted(page.said)}` : `${head} It sent a web page.`;
  }
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
