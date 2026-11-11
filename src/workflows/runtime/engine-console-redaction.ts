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
 * Here: such an error, wherever it sits in what is logged (in an object, an
 * array, a Map or Set, an error's `cause`, an `AggregateError`), is replaced by
 * its status, and a line holding a serialized request keeps what precedes it.
 * Duck-typed, because a published piece brings its own copy of the classes.
 * The patched engine applies it to the console methods that print values
 * (log, warn, error, info, debug, trace, dir, table, assert, group,
 * groupCollapsed, timeLog, count, and Bun's `console.write`) and to
 * `process.stdout`/`stderr.write`; the daemon applies `redactEngineText` again
 * to each chunk of engine output it copies. A logging call never throws
 * because of it: a value that cannot be read is withheld.
 */

/**
 * Where a serialized request or response starts in a line: an `HttpError`
 * message (`{"response":{"status":...`, `{"request":{"body":...`), the JSON of
 * an `HttpError`'s own fields (`"requestBody"`, `"responseBody"`, or the same
 * keys unquoted at the start of a line, as an inspector prints them), an axios
 * error's `toJSON` (from its `"name":"AxiosError"`), or request headers holding
 * a credential. Whitespace and JSON escaping (`\"`) are tolerated.
 */
const SERIALIZED_REQUEST = /(?:\{\s*)?\\?"(?:response\\?"\s*:\s*\{\s*\\?"status|request\\?"\s*:\s*\{\s*\\?"body|requestBody\\?"\s*:|responseBody\\?"\s*:|name\\?"\s*:\s*\\?"AxiosError|headers\\?"\s*:\s*\{[\s\S]{0,500}?\\?"(?:(?:proxy-)?authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token)\\?"\s*:)|^\s*(?:requestBody|responseBody)\s*:/imu;
const WITHHELD = '[request and response bodies withheld]';
/** A line that continues a value cut on an earlier line: indented, or closing it. */
const CONTINUATION = /^(?:\s|[}\]"),]|$)/u;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

/** A property read that a hostile getter cannot turn into a throw here. */
function read(value: Record<string, unknown>, key: string): unknown {
  try { return value[key]; } catch { return undefined; }
}

function has(value: Record<string, unknown>, key: string): boolean {
  try { return key in value; } catch { return false; }
}

/** An error of any realm, by its brand or its shape. */
function isErrorLike(value: Record<string, unknown>): boolean {
  try {
    if (Object.prototype.toString.call(value) === '[object Error]') return true;
  } catch { return false; }
  return typeof read(value, 'message') === 'string' && typeof read(value, 'stack') === 'string';
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
  // pieces-common's HttpError says 500 for a request no server answered.
  const unanswered = status === 500 && has(value, 'responseBody') && read(value, 'responseBody') === undefined;
  return `${errorName(value)}: request failed`
    + (unanswered ? ' (no response)' : typeof status === 'number' && Number.isInteger(status) ? ` (status ${status})` : '')
    + (typeof code === 'string' && ERROR_CODE.test(code) ? ` [${code}]` : '')
    + '; bodies and headers withheld';
}

/**
 * Text with each serialized request cut where it starts, to the end of its
 * line, and the lines after it that continue that value (indented, or closing
 * it) dropped. Other lines, and line ends, are kept. Known false positive,
 * accepted: an engine log line holding such JSON for another reason is cut too.
 */
export function redactEngineText(text: string): string {
  let out = '', pos = 0;
  const scan = new RegExp(SERIALIZED_REQUEST.source, 'gimu');
  for (;;) {
    scan.lastIndex = pos;
    const found = scan.exec(text);
    if (!found) return pos === 0 ? text : out + text.slice(pos);
    const at = found.index;
    out += text.slice(pos, at) + WITHHELD;
    let end = text.indexOf('\n', at);
    while (end >= 0) {
      const next = text.indexOf('\n', end + 1);
      const line = text.slice(end + 1, next < 0 ? text.length : next);
      if (line === '' || !CONTINUATION.test(line)) break;
      end = next;
    }
    if (end < 0) return out;
    pos = end;
  }
}

const MAX_DEPTH = 12;
/** Values a call may walk before what is left is withheld rather than printed unchecked. */
const NODE_BUDGET = 20_000;

type Walk = { seen: WeakMap<object, unknown>; budget: number };

/**
 * A value with every request error in it replaced by its summary and every
 * string cut by `redactEngineText`. A value with nothing to hide is returned
 * as it is, the same object, so an ordinary log prints as before; otherwise a
 * copy with the same prototype is returned and the caller's object is never
 * changed. Accessors are not called. Cycle-safe. Never throws.
 */
function sanitize(value: unknown, depth: number, walk: Walk): unknown {
  if (typeof value === 'string') return redactEngineText(value);
  if (!object(value)) return value;
  try {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    if (isRequestError(value)) return summary(value);
    // Seen before: what it became then; inside itself (a cycle), the object itself.
    if (walk.seen.has(value)) return walk.seen.get(value);
    if (depth >= MAX_DEPTH || --walk.budget < 0) return '[nested value withheld]';
    walk.seen.set(value, value);
    const result = sanitizeFresh(value, depth, walk);
    walk.seen.set(value, result);
    return result;
  } catch {
    return '[unprintable value withheld]';
  }
}

function sanitizeFresh(value: Record<string, unknown>, depth: number, walk: Walk): unknown {
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([k, v]) => [sanitize(k, depth + 1, walk), sanitize(v, depth + 1, walk)] as const);
    return entries.some(([k, v], i) => { const [k0, v0] = [...value.entries()][i]!; return k !== k0 || v !== v0; }) ? new Map(entries) : value;
  }
  if (value instanceof Set) {
    const items = [...value.values()];
    const out = items.map((item) => sanitize(item, depth + 1, walk));
    return out.some((item, i) => item !== items[i]) ? new Set(out) : value;
  }
  if (Array.isArray(value)) {
    const out = value.map((item) => sanitize(item, depth + 1, walk));
    return out.some((item, i) => item !== value[i]) ? out : value;
  }
  const isError = isErrorLike(value);
  const own = [...Object.keys(value), ...Object.getOwnPropertySymbols(value).filter((key) => Object.prototype.propertyIsEnumerable.call(value, key))];
  // An error's message, and the two places an error nests another, even when not enumerable.
  const keys: Array<string | symbol> = isError ? [...new Set<string | symbol>([...own, 'message', 'cause', 'errors'])] : own;
  const out = new Map<string | symbol, unknown>();
  let changed = false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    // Not calling a getter, as the printer does not.
    if (!('value' in descriptor)) { out.set(key, undefined); continue; }
    const next = sanitize(descriptor.value, depth + 1, walk);
    out.set(key, next);
    if (next !== descriptor.value) changed = true;
  }
  if (!changed) return value;
  if (isError) {
    // A plain copy that prints as the error did: its name and message, never the stack (it repeats the message).
    const message = out.get('message');
    const copy = new Error(typeof message === 'string' ? message : '');
    copy.name = errorName(value);
    copy.stack = `${copy.name}: ${copy.message}`;
    for (const [key, item] of out) if (key !== 'message' && item !== undefined) (copy as unknown as Record<string | symbol, unknown>)[key] = item;
    return copy;
  }
  const copy = Object.create(Object.getPrototypeOf(value) as object | null) as Record<string | symbol, unknown>;
  for (const [key, item] of out) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    Object.defineProperty(copy, key, 'value' in descriptor ? { ...descriptor, value: item } : descriptor);
  }
  return copy;
}

/**
 * The console arguments with every failed-request error replaced by its type,
 * status and error code, wherever it sits, and every serialized request cut
 * from text. Anything else is passed through unchanged, so ordinary logs read
 * as before. Never throws.
 */
export function redactEngineLogArgs(args: readonly unknown[]): unknown[] {
  const walk: Walk = { seen: new WeakMap(), budget: NODE_BUDGET };
  return args.map((arg) => sanitize(arg, 0, walk));
}

type Writable = { write: (chunk: unknown, ...rest: unknown[]) => boolean };
const INSTALLED = Symbol.for('jarvis.engineOutputRedaction');
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The console methods the engine's own wrappers (log, warn, error) leave
 * alone, and direct writes to stdout and stderr, made to print what
 * `redactEngineLogArgs` and `redactEngineText` leave. In Bun, `info`, `debug`,
 * `trace`, `dir`, `table`, `assert`, `group`, `timeLog`, `count` and `write`
 * write to the descriptor themselves rather than through `log` or `error`, so
 * each is wrapped. Once per console.
 */
export function installEngineOutputRedaction(
  target: Console = console,
  streams: readonly Writable[] = [process.stdout as unknown as Writable, process.stderr as unknown as Writable],
): void {
  const marked = target as unknown as Record<symbol, boolean>;
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;
  const methods = target as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ['info', 'debug', 'trace', 'dir', 'table', 'group', 'groupCollapsed', 'count', 'write'] as const) {
    const original = methods[name];
    if (typeof original !== 'function') continue;
    methods[name] = function (...raw: unknown[]): unknown { return original.apply(target, redactEngineLogArgs(raw)); };
  }
  const assert = methods.assert;
  if (typeof assert === 'function') {
    methods.assert = function (condition: unknown, ...raw: unknown[]): unknown { return assert.call(target, condition, ...redactEngineLogArgs(raw)); };
  }
  const timeLog = methods.timeLog;
  if (typeof timeLog === 'function') {
    methods.timeLog = function (label: unknown, ...raw: unknown[]): unknown { return timeLog.call(target, ...redactEngineLogArgs([label, ...raw])); };
  }
  for (const stream of streams) {
    const write = stream.write;
    stream.write = function (chunk: unknown, ...rest: unknown[]): boolean {
      if (typeof chunk === 'string') return write.call(stream, redactEngineText(chunk), ...rest);
      if (chunk instanceof Uint8Array) {
        const text = decoder.decode(chunk);
        const shown = redactEngineText(text);
        if (shown !== text) return write.call(stream, encoder.encode(shown), ...rest);
      }
      return write.call(stream, chunk, ...rest);
    };
  }
}
