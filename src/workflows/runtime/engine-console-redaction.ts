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
 * Here: such an error, at any depth of what is logged, is replaced by its
 * status, and text holding a serialized request keeps what precedes it.
 * Duck-typed, because a published piece brings its own copy of the classes.
 * The patched engine applies it to every console method that prints and to
 * direct `process.stdout`/`stderr` writes, and the daemon applies
 * `redactEngineText` again to each chunk of engine output it copies.
 */

/**
 * Where a serialized request or response starts in text: an `HttpError`
 * message (`{"response":{"status":...`, `{"request":{"body":...`), the JSON of
 * an `HttpError`'s own fields (`"requestBody"`, `"responseBody"`), an axios
 * error's `toJSON` (`"config":{`), or request headers holding a credential.
 * Whitespace and JSON escaping (`\"`) are tolerated. The text is cut there.
 */
const SERIALIZED_REQUEST = /(?:\{\s*)?\\?"(?:response\\?"\s*:\s*\{\s*\\?"status|request\\?"\s*:\s*\{\s*\\?"body|requestBody\\?"\s*:|responseBody\\?"\s*:|config\\?"\s*:\s*\{|headers\\?"\s*:\s*\{[^}]{0,500}?\\?"(?:authorization|cookie|x-api-key)\\?"\s*:)/iu;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

/** A property read that a hostile getter cannot turn into a throw here. */
function read(value: Record<string, unknown>, key: string): unknown {
  try { return value[key]; } catch { return undefined; }
}

function has(value: Record<string, unknown>, key: string): boolean {
  try { return key in value; } catch { return false; }
}

const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/u;
/** A Node or axios error code (`ECONNREFUSED`, `ERR_BAD_REQUEST`): kept, it names no data. */
const ERROR_CODE = /^(?:E[A-Z0-9_]{1,40}|ERR_[A-Z0-9_]{1,40})$/u;

/** The class name, or the `name` field of a plain `Error` (axios names its errors so). */
function errorName(value: Record<string, unknown>): string {
  const ctor = read(value, 'constructor');
  const own = object(ctor) ? read(ctor, 'name') : undefined;
  if (typeof own === 'string' && IDENTIFIER.test(own) && own !== 'Error' && own !== 'Object') return own;
  const name = read(value, 'name');
  return typeof name === 'string' && IDENTIFIER.test(name) ? name : 'Error';
}

/**
 * An `HttpError` from any copy of pieces-common, an `AxiosError`, an error
 * whose message is a serialized request, or the `{ response: { status },
 * request }` body an `HttpError.errorMessage()` returns.
 */
function isRequestError(value: Record<string, unknown>): boolean {
  if (read(value, 'isAxiosError') === true) return true;
  const name = errorName(value);
  if (name === 'HttpError' || name === 'AxiosError') return true;
  if (has(value, 'request') && has(value, 'response')) {
    if (typeof read(value, 'errorMessage') === 'function') return true;
    const response = read(value, 'response');
    if (object(response) && has(response, 'status')) return true;
  }
  if (has(value, 'requestBody') || has(value, 'responseBody')) return true;
  const message = read(value, 'message');
  return typeof message === 'string' && SERIALIZED_REQUEST.test(message);
}

function summary(value: Record<string, unknown>): string {
  const response = read(value, 'response');
  const status = object(response) ? read(response, 'status') : read(value, 'status');
  const code = read(value, 'code');
  return `${errorName(value)}: request failed`
    + (typeof status === 'number' && Number.isInteger(status) ? ` (status ${status})` : '')
    + (typeof code === 'string' && ERROR_CODE.test(code) ? ` [${code}]` : '')
    + '; bodies and headers withheld';
}

/**
 * Text with a serialized request or response cut off where it starts. Known
 * false positive, accepted: any engine log line holding such JSON is cut too.
 */
export function redactEngineText(text: string): string {
  const at = text.search(SERIALIZED_REQUEST);
  return at < 0 ? text : `${text.slice(0, at)}[request and response bodies withheld]`;
}

const MAX_DEPTH = 8;
const MAX_KEYS = 200;

/**
 * A value with every request error at any depth (in an object, an array, an
 * error's `cause`, an `AggregateError`'s `errors`) replaced by its summary and
 * every string cut by `redactEngineText`. A value with nothing to hide is
 * returned as it is, the same object, so an ordinary log prints as before;
 * otherwise a copy is returned and the caller's object is never changed.
 * Cycle-safe; past `MAX_DEPTH` or `MAX_KEYS` an object that cannot be checked
 * whole is withheld rather than printed unchecked.
 */
function sanitize(value: unknown, depth: number, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return redactEngineText(value);
  if (!object(value)) return value;
  if (isRequestError(value)) return summary(value);
  // Seen before: what it became then; inside itself (a cycle), a marker.
  if (seen.has(value)) return seen.get(value);
  if (depth >= MAX_DEPTH) return '[nested value withheld]';
  seen.set(value, '[circular]');
  const result = sanitizeFresh(value, depth, seen);
  seen.set(value, result);
  return result;
}

function sanitizeFresh(value: Record<string, unknown>, depth: number, seen: WeakMap<object, unknown>): unknown {
  if (Array.isArray(value)) {
    if (value.length > MAX_KEYS) return '[large array withheld]';
    const out = value.map((item) => sanitize(item, depth + 1, seen));
    return out.some((item, i) => item !== value[i]) ? out : value;
  }
  let keys: string[];
  try { keys = Object.keys(value); } catch { return '[unreadable value withheld]'; }
  if (keys.length > MAX_KEYS) return '[large object withheld]';
  const isError = value instanceof Error;
  // An error's own fields, plus the two places an error nests another.
  const fields = isError ? [...new Set([...keys, 'message', 'cause', 'errors'])] : keys;
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const key of fields) {
    if (!has(value, key)) continue;
    const item = read(value, key);
    const next = sanitize(item, depth + 1, seen);
    out[key] = next;
    if (next !== item) changed = true;
  }
  if (!changed) return value;
  if (isError) {
    // A plain copy that prints as the error did: its name and message, never the stack (it repeats the message).
    const copy = new Error(typeof out.message === 'string' ? out.message : '');
    copy.name = errorName(value);
    copy.stack = `${copy.name}: ${copy.message}`;
    for (const [key, item] of Object.entries(out)) if (key !== 'message' && item !== undefined) (copy as unknown as Record<string, unknown>)[key] = item;
    return copy;
  }
  return out;
}

/**
 * The console arguments with every failed-request error replaced by its type,
 * status and error code, at any depth, and every serialized request cut from
 * text. Anything else is passed through unchanged, so ordinary logs read as before.
 */
export function redactEngineLogArgs(args: readonly unknown[]): unknown[] {
  const seen = new WeakMap<object, unknown>();
  return args.map((arg) => sanitize(arg, 0, seen));
}

type Writable = { write: (chunk: unknown, ...rest: unknown[]) => boolean };
const INSTALLED = Symbol.for('jarvis.engineOutputRedaction');

/**
 * The console methods the engine's own wrappers (log, warn, error) leave
 * alone, and direct writes to stdout and stderr, made to print what
 * `redactEngineLogArgs` and `redactEngineText` leave. In Bun, `info`, `debug`,
 * `trace`, `dir`, `table` and `assert` write to the descriptor themselves
 * rather than through `log` or `error`, so each is wrapped. Once per console.
 */
export function installEngineOutputRedaction(
  target: Console = console,
  streams: readonly Writable[] = [process.stdout as unknown as Writable, process.stderr as unknown as Writable],
): void {
  const marked = target as unknown as Record<symbol, boolean>;
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;
  const methods = target as unknown as Record<string, (...args: unknown[]) => void>;
  for (const name of ['info', 'debug', 'trace', 'dir', 'table'] as const) {
    const original = methods[name];
    if (typeof original !== 'function') continue;
    methods[name] = function (...raw: unknown[]): void { original.apply(target, redactEngineLogArgs(raw)); };
  }
  const assert = methods.assert;
  if (typeof assert === 'function') {
    methods.assert = function (condition: unknown, ...raw: unknown[]): void { assert.call(target, condition, ...redactEngineLogArgs(raw)); };
  }
  for (const stream of streams) {
    const write = stream.write;
    stream.write = function (chunk: unknown, ...rest: unknown[]): boolean {
      if (typeof chunk === 'string') return write.call(stream, redactEngineText(chunk), ...rest);
      if (chunk instanceof Uint8Array) {
        const text = new TextDecoder().decode(chunk);
        const shown = redactEngineText(text);
        if (shown !== text) return write.call(stream, shown, ...rest);
      }
      return write.call(stream, chunk, ...rest);
    };
  }
}
