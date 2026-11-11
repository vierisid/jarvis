/**
 * What the engine's console may print about a failed HTTP request.
 *
 * Compiled INTO the engine bundle (the patched `worker-socket.ts` calls it), so
 * it imports nothing: see `engine-bundle-purity.test.ts`.
 *
 * THE LEAK. The Activepieces `AxiosHttpClient.sendRequest` (the vendored copy
 * and the one in every published `@activepieces/pieces-common`) logs each
 * failure as
 *
 *     console.error('[HttpClient#(sanitized error message)] Request failed:', httpError)
 *
 * and `HttpError` carries the request body it sent and the response body it got
 * (its message is their JSON, and both are own fields). A request body holds
 * whatever the step sent (a password, a client secret), a response body
 * whatever the server answered (a token). Upstream's engine meant to catch this
 * (`ERROR_MESSAGES_TO_REDACT`), but it looks for `HttpClient#sendRequest`, a
 * prefix the client no longer prints, so the whole error reached engine stderr,
 * which the daemon copies into its log and the per-run log buffer. Pieces also
 * log the errors they catch themselves (`console.error(e)`), and an
 * `AxiosError` carries its request config, headers included.
 *
 * Here: an argument that is such an error is replaced by its status, and text
 * holding an `HttpError` message keeps what precedes it. Duck-typed, because a
 * published piece brings its own copy of the classes.
 */

const HTTP_ERROR_JSON = '{"response":{"status":';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

/** A property read that a hostile getter cannot turn into a throw here. */
function read(value: Record<string, unknown>, key: string): unknown {
  try { return value[key]; } catch { return undefined; }
}

function statusOf(value: Record<string, unknown>): string {
  const response = read(value, 'response');
  const status = object(response) ? read(response, 'status') : read(value, 'status');
  return typeof status === 'number' && Number.isInteger(status) ? ` (status ${status})` : '';
}

const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/u;

/** The class name, or the `name` field of a plain `Error` (axios names its errors so). */
function errorName(value: Record<string, unknown>): string {
  const ctor = read(value, 'constructor');
  const own = object(ctor) ? read(ctor, 'name') : undefined;
  if (typeof own === 'string' && IDENTIFIER.test(own) && own !== 'Error' && own !== 'Object') return own;
  const name = read(value, 'name');
  return typeof name === 'string' && IDENTIFIER.test(name) ? name : 'Error';
}

/** An `HttpError` from any copy of pieces-common, an `AxiosError`, or an error whose message is an `HttpError`'s. */
function isRequestError(value: Record<string, unknown>): boolean {
  if (read(value, 'isAxiosError') === true) return true;
  const name = errorName(value);
  if (name === 'HttpError' || name === 'AxiosError') return true;
  try {
    if (typeof read(value, 'errorMessage') === 'function' && 'request' in value && 'response' in value) return true;
  } catch { /* a proxy whose `has` throws: judged by its message below */ }
  const message = read(value, 'message');
  return typeof message === 'string' && message.includes(HTTP_ERROR_JSON);
}

/** Text with an `HttpError` message cut off where it starts. */
function redactText(text: string): string {
  const at = text.indexOf(HTTP_ERROR_JSON);
  return at < 0 ? text : `${text.slice(0, at)}[request and response bodies withheld]`;
}

/**
 * The console arguments with every failed-request error replaced by its type
 * and status, and every `HttpError` message cut from text. Anything else is
 * passed through unchanged, so ordinary logs read as before.
 */
export function redactEngineLogArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg === 'string') return redactText(arg);
    if (object(arg) && isRequestError(arg)) return `${errorName(arg)}: request failed${statusOf(arg)}; bodies and headers withheld`;
    return arg;
  });
}
