/**
 * Q-19: what a failed send says about whether the message arrived. Read from
 * the error's type and typed fields only (its name, runtime code, HTTP status,
 * retry-after and the unsent remainder of a chunked message), never from its
 * wording.
 *
 * - `not_sent`: the request never left Jarvis, never reached the service, or
 *   the service answered that it refused it. Nothing arrived.
 * - `may_have_arrived`: the service may have taken the message before the
 *   failure: a timeout, a dropped connection, a server or gateway error, part
 *   of a long message already sent, or an error with no typed shape at all.
 *   Sending it again could send it twice, so Jarvis never does that on its own.
 */

export type SendFailure = 'not_sent' | 'may_have_arrived';

/** A send Jarvis refused before anything left it: no adapter, no connection, no recipient. */
export class NotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotSentError';
  }
}

/** No transport confirmed the message, and at least one may have taken it. */
export class DeliveryUnconfirmedError extends Error {
  constructor(public readonly channels: string[], message = `Not confirmed by ${channels.join(', ')}`) {
    super(message);
    this.name = 'DeliveryUnconfirmedError';
  }
}

/** Runtime codes (Node, Bun and undici spellings) for a connection that was never made. */
const NEVER_CONNECTED = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ConnectionRefused', 'FailedToOpenSocket', 'UND_ERR_CONNECT_TIMEOUT',
]);

function field(err: unknown, name: string): unknown {
  return err && typeof err === 'object' ? (err as Record<string, unknown>)[name] : undefined;
}

function runtimeCode(err: unknown): string | null {
  const code = field(err, 'code') ?? field(field(err, 'cause'), 'code');
  return typeof code === 'string' ? code : null;
}

/** An HTTP status the service answered with, when the error carries one. */
function httpStatus(err: unknown): number | null {
  const status = field(err, 'status');
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

/** Whether part of a chunked message was already sent before this error. */
export function partlySent(err: unknown): boolean {
  const remaining = field(err, 'remainingText');
  return typeof remaining === 'string' && remaining.length > 0;
}

/** The failed request alone, apart from any earlier chunks of the same message. */
function requestFailure(err: unknown): SendFailure {
  if (err instanceof NotSentError) return 'not_sent';
  // The service named a wait: it did not take this request.
  if (typeof field(err, 'retryAfterMs') === 'number') return 'not_sent';
  const code = runtimeCode(err);
  if (code && NEVER_CONNECTED.has(code)) return 'not_sent';
  const status = httpStatus(err);
  // A 4xx is the service refusing the request. A 5xx can follow work it did.
  if (status !== null && status >= 400 && status < 500) return 'not_sent';
  return 'may_have_arrived';
}

/** Whether the request that failed may itself have been taken. Never retry one that may. */
export function requestMayHaveArrived(err: unknown): boolean {
  return requestFailure(err) === 'may_have_arrived';
}

/** The message as a whole: any part of it already sent means it may have arrived. */
export function sendFailure(err: unknown): SendFailure {
  return partlySent(err) ? 'may_have_arrived' : requestFailure(err);
}

export function sendMayHaveArrived(err: unknown): boolean {
  return sendFailure(err) === 'may_have_arrived';
}

/**
 * Whether trying the failed request again is both safe and useful: it was not
 * taken, and the failure can pass (a rate limit, a connection never made). A
 * refused request (any other 4xx) would only fail again. Earlier chunks of the
 * same message do not matter here: a retry resumes from `remainingText`.
 */
export function sendRetryable(err: unknown): boolean {
  if (requestFailure(err) !== 'not_sent' || err instanceof NotSentError) return false;
  if (typeof field(err, 'retryAfterMs') === 'number' || httpStatus(err) === 429) return true;
  const code = runtimeCode(err);
  return code !== null && NEVER_CONNECTED.has(code);
}
