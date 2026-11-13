/**
 * What an HTTP or GraphQL step says to the person who must approve it, and the
 * requests refused before anyone is asked.
 *
 * Daemon only (the engine bundle never imports this). The words name the
 * method, the host and the path (owner, #1343), never the query, the fragment
 * or userinfo, which carry credentials and customers' data far more often.
 * The path is read from the URL `redactHttpInput` already redacted (#1318), so
 * a webhook's secret segment is `[redacted]` here too, and a segment shaped
 * like a token is masked the same way (`maskedSegment`).
 */

import { isIP } from 'node:net';
import { destinationAllowed, type EgressPolicy } from './http-egress';
import { GRAPHQL_PIECE, HTTP_PIECE, REDACTED, httpRequestHost, httpRequestIsRead } from './piece-effects';

/** True for the action of the HTTP and GraphQL pieces that makes a request. */
export function makesNetworkRequest(piece: string, action: string): boolean {
  return action === 'send_request' && (piece === HTTP_PIECE || piece === GRAPHQL_PIECE);
}

/**
 * The longest card sentence (#1343). The chat card must fit one message of
 * `CHANNEL_CARD_APPROVABLE_MAX_CHARS` (1000) with its Action, Agent, Reason
 * and reply lines, so the sentence keeps the 600 a start card's input keeps
 * (`AGENT_TASK_MAX_CHARS`). A longer one is refused, never cut.
 */
export const HTTP_CARD_SENTENCE_MAX_CHARS = 600;

const UNKNOWN_ADDRESS = 'a web address set when the step runs';
const UNKNOWN_PART = '[set when the step runs]';
/** The note `bound()` appends to a string it cut. */
const CUT_NOTE = /\.\.\. \[\d+ more characters\]$/u;

/**
 * A path segment shown as a token would be on a header (#1318's Bearer shape,
 * `SCHEMED_CREDENTIAL` in piece-effects.ts), narrowed for paths: 20 or more
 * token characters with a digit or mixed case. The Bearer test's other two
 * signals are dropped here because ordinary paths carry them
 * (`customer-subscriptions`, `v1`); a long id such as a UUID is masked too,
 * which costs the card nothing it needs to decide on, and the dashboard's
 * arguments keep the (redacted) URL whole.
 */
function maskedSegment(segment: string): string {
  if (!/^[A-Za-z0-9._~+=:-]{20,}$/u.test(segment)) return segment;
  return /\d/u.test(segment) && /[A-Za-z]/u.test(segment) || /[a-z]/u.test(segment) && /[A-Z]/u.test(segment) ? REDACTED : segment;
}

/**
 * One path segment for the card: percent-decoded only when what it decodes to
 * is all characters a path may hold unencoded (RFC 3986 unreserved and
 * sub-delims, `:`, `@`, and the brackets of `[redacted]`): no slash,
 * backslash, `?`, `#`, `%`, space, quote, angle bracket, brace, backtick or
 * anything outside ASCII. Otherwise it is shown as the URL spells it, which
 * WHATWG parsing has already percent-encoded to printable ASCII. A
 * `{{...}}` the engine has not resolved is named as set when the step runs.
 */
const SAFE_DECODED = /^[A-Za-z0-9\-._~!$&()*+,;=:@[\]]*$/u;
function shownSegment(raw: string): string {
  let decoded: string | null = null;
  try { decoded = decodeURIComponent(raw); } catch { decoded = null; }
  if (decoded !== null && /\{\{[^]*?\}\}/u.test(decoded)) {
    // Around the unresolved parts, what the step spelled, encoded where it is not plain.
    return decoded.split(/\{\{[^]*?\}\}/u).map((part) => part.replace(/[^\x21-\x7e]|[/\\?#%]/gu, (c) => encodeURIComponent(c)))
      .join(UNKNOWN_PART);
  }
  const shown = decoded !== null && SAFE_DECODED.test(decoded) ? decoded : raw;
  return shown === REDACTED ? shown : maskedSegment(shown);
}

/** `host/path` as the card names it, or null when the URL does not say for certain (cut, not http(s), not a URL). */
function shownAddress(url: unknown): string | null {
  const host = httpRequestHost(url);
  // A host the engine has not resolved is unknown whole, as an unparsable URL is.
  if (host === null || host.includes('{')) return null;
  const pathname = new URL((url as string).trim()).pathname;
  const path = pathname === '/' ? '' : pathname.split('/').map(shownSegment).join('/');
  return `${host.includes(':') ? `[${host}]` : host}${path}`;
}

/** The card sentence: what the request will do, in words. */
export function httpApprovalIntent(piece: string, input: Record<string, unknown>): string {
  const where = shownAddress(input.url) ?? UNKNOWN_ADDRESS;
  if (piece === GRAPHQL_PIECE) return `Jarvis wants to send a GraphQL request to ${where}`;
  if (httpRequestIsRead(input)) return `Jarvis wants to read ${where}`;
  const method = typeof input.method === 'string' && /^[A-Za-z]{1,16}$/u.test(input.method) ? `${input.method.toUpperCase()} ` : '';
  return `Jarvis wants to send a ${method}request to ${where}`;
}

/**
 * Why the card could not show the request as it will run, or null (#1040's
 * house rule: a value the card would cut is refused, not approved unseen).
 * A URL the engine's bound cut, or a sentence past
 * `HTTP_CARD_SENTENCE_MAX_CHARS`, cannot be shown whole.
 */
export function httpCardRefusal(piece: string, input: Record<string, unknown>): string | null {
  if (typeof input.url === 'string' && CUT_NOTE.test(input.url)) {
    return 'The request\'s web address is too long for the approval card to show whole. Use a shorter address, or move values from the path into the body.';
  }
  const sentence = httpApprovalIntent(piece, input);
  return sentence.length > HTTP_CARD_SENTENCE_MAX_CHARS
    ? `The approval card would describe this request in ${sentence.length} characters; it describes one in at most ${HTTP_CARD_SENTENCE_MAX_CHARS}, so that it can show all of it. Use a shorter path, or move values from the path into the body.`
    : null;
}

/**
 * Why the request asks, as the card says it (the engine's own wording names a
 * category, not the request). `unlistedRead` is true when an HTTP read asks
 * only because its host is not on the flow's read list. A read whose host is
 * listed and still asks (reads governed by the owner's settings) gets no
 * sentence here: the engine's own reason is the true one.
 */
export function httpApprovalReason(piece: string, input: Record<string, unknown>, unlistedRead: boolean): string | undefined {
  if (unlistedRead) return 'This site is not on the workflow\'s list of sites it may read without asking.';
  if (piece === HTTP_PIECE && httpRequestIsRead(input)) return undefined;
  return 'Sending a request to another server needs your approval.';
}

export const LOCAL_ADDRESS_REFUSAL = 'Jarvis does not send requests to addresses on this computer or local network.';

/**
 * The refusal for a request the egress guard would refuse as soon as it ran: a
 * URL whose host is `localhost` or an address outside the policy (loopback,
 * link-local, this machine's own, and private ranges on a hosted install).
 * Asked before a card is raised, so nobody approves what cannot run. A name
 * that resolves to such an address is still refused by the guard at connect
 * time, after the lookup this check cannot make.
 */
export function localAddressRefusal(input: Record<string, unknown>, policy: EgressPolicy): string | null {
  return localHostRefusal(httpRequestHost(input.url), policy);
}

/** As `localAddressRefusal`, for a host in `readHostKey` form (a read-list entry). */
export function localHostRefusal(host: string | null, policy: EgressPolicy): string | null {
  if (host === null) return null;
  if (host === 'localhost' || host.endsWith('.localhost')) return LOCAL_ADDRESS_REFUSAL;
  return isIP(host) !== 0 && !destinationAllowed(host, policy) ? LOCAL_ADDRESS_REFUSAL : null;
}
