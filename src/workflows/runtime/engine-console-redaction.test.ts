import { describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import { installEngineOutputRedaction, redactEngineLogArgs, redactEngineText } from './engine-console-redaction';
import { HttpError } from '../activepieces/packages/pieces/common/src/lib/http/core/http-error';

const SECRETS = ['BODY-SECRET', 'RESP-SECRET', 'HDR-SECRET'];

/** An AxiosError as axios builds one: its config carries the request headers. */
function axiosError(): Error & Record<string, unknown> {
  return Object.assign(new Error('Request failed with status code 401'), {
    name: 'AxiosError', isAxiosError: true, code: 'ERR_BAD_REQUEST',
    config: { headers: { Authorization: 'Bearer HDR-SECRET' }, data: '{"password":"BODY-SECRET"}' },
    response: { status: 401, data: { refresh_token: 'RESP-SECRET' } },
  }) as unknown as Error & Record<string, unknown>;
}

/** What the engine's console wrapper prints and forwards: both the inspected args and their join. */
function printed(args: unknown[]): string {
  const out = redactEngineLogArgs(args);
  return `${out.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' ')}\n${out.join(' ')}`;
}

describe('engine console redaction', () => {
  test('the HttpClient failure log keeps its prefix and status, never the bodies', () => {
    const error = new HttpError({ password: 'BODY-SECRET' }, axiosError() as never);
    // Control: unredacted, the error prints both bodies.
    expect(inspect(error)).toContain('BODY-SECRET');
    expect(String(error)).toContain('RESP-SECRET');
    const text = printed(['[HttpClient#(sanitized error message)] Request failed:', error]);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).toContain('[HttpClient#(sanitized error message)] Request failed: HttpError: request failed (status 401)');
  });

  test('a copy of HttpError from another pieces-common, an AxiosError, and an error rethrown with its message are withheld', () => {
    class HttpErrorCopy extends Error {
      constructor(private readonly requestBody: unknown, private readonly responseBody: unknown) {
        super(JSON.stringify({ response: { status: 500, body: responseBody }, request: { body: requestBody } }));
      }
      errorMessage() { return { request: this.requestBody, response: this.responseBody }; }
      get request() { return { body: this.requestBody }; }
      get response() { return { status: 500, body: this.responseBody }; }
    }
    const rethrown = new Error(new HttpError({ password: 'BODY-SECRET' }, axiosError() as never).message);
    const text = printed([new HttpErrorCopy({ password: 'BODY-SECRET' }, 'RESP-SECRET'), axiosError(), rethrown,
      `step failed: ${rethrown.message}`]);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).toContain('HttpErrorCopy: request failed (status 500)');
    expect(text).toContain('AxiosError: request failed (status 401)');
    expect(text).toContain('step failed: [request and response bodies withheld]');
  });

  test('an error nested in an object, an array, a cause or an AggregateError, and an errorMessage() body, are withheld', () => {
    const error = new HttpError({ password: 'BODY-SECRET' }, axiosError() as never);
    const wrapped = new Error('step failed', { cause: axiosError() });
    const caller = { error, note: 'kept' };
    const text = printed(['x', caller, [error], wrapped, new AggregateError([error], 'many'), error.errorMessage(),
      { deep: { deeper: { request: { body: { password: 'BODY-SECRET' } }, response: { status: 500, body: 'RESP-SECRET' } } } }, caller]);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).toContain('kept');
    expect(text).toContain('step failed');
    // The caller's own objects are not changed.
    expect(caller.error).toBe(error);
  });

  test('serialized requests in text are cut: compact, pretty, escaped, an HttpError as JSON and axios toJSON', () => {
    const error = new HttpError({ password: 'BODY-SECRET' }, axiosError() as never);
    const forms = [
      JSON.stringify(error), JSON.stringify(error.errorMessage(), null, 2), JSON.stringify({ log: error.message }),
      JSON.stringify({ message: 'Request failed', name: 'AxiosError', config: { headers: { Authorization: 'Bearer HDR-SECRET' } } }),
      '{"request":{"body":{"password":"BODY-SECRET"}}}', 'sent {"headers":{"Accept":"*/*","Authorization":"Bearer HDR-SECRET"}}',
    ];
    for (const form of forms) {
      const shown = redactEngineText(form);
      for (const secret of SECRETS) expect(shown).not.toContain(secret);
      expect(shown).toContain('[request and response bodies withheld]');
    }
    expect(redactEngineText('[Progress] Backup failed: socket closed')).toBe('[Progress] Backup failed: socket closed');
  });

  test('an error with no response keeps its code', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { name: 'AxiosError', isAxiosError: true, code: 'ECONNREFUSED',
      config: { headers: { Authorization: 'Bearer HDR-SECRET' } } });
    expect(redactEngineLogArgs([refused])).toEqual(['AxiosError: request failed [ECONNREFUSED]; bodies and headers withheld']);
  });

  test('info, debug, trace, dir, table, assert and direct stream writes are redacted once installed', () => {
    const lines: string[] = [];
    const sink = (...args: unknown[]) => { lines.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' ')); };
    const fake = { info: sink, debug: sink, trace: sink, dir: sink, table: sink, group: sink, groupCollapsed: sink, count: sink, write: sink, timeLog: sink,
      assert: (c: unknown, ...a: unknown[]) => { if (!c) sink(...a); } } as unknown as Console;
    const written: unknown[] = [];
    const stream = { write: (chunk: unknown) => { written.push(chunk); return true; } };
    installEngineOutputRedaction(fake, [stream]);
    installEngineOutputRedaction(fake, [stream]);
    const error = new HttpError({ password: 'BODY-SECRET' }, axiosError() as never);
    for (const name of ['info', 'debug', 'trace', 'dir', 'table', 'group', 'groupCollapsed', 'count', 'timeLog'] as const) (fake[name] as (...a: unknown[]) => void)(name, error);
    (fake as unknown as { write: (...a: unknown[]) => void }).write('write', error.message);
    fake.assert(false, 'assert', { error });
    stream.write(`direct ${error.message}\n`);
    stream.write(new TextEncoder().encode(`bytes ${error.message}`));
    stream.write(new TextEncoder().encode('plain bytes'));
    const text = [...lines, ...written.map((w) => (typeof w === 'string' ? w : new TextDecoder().decode(w as Uint8Array)))].join('\n');
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(lines).toHaveLength(11);
    expect(text).toContain('direct [request and response bodies withheld]');
    expect(text).toContain('plain bytes');
  });

  test('in a Map, a Set, under a symbol key, and in an error of another realm or with a hidden cause', () => {
    const error = new HttpError({ password: 'BODY-SECRET' }, axiosError() as never);
    const sym = Symbol('k');
    const realm = { message: 'from a vm', stack: 'Error: from a vm', cause: error };
    const hiddenCause = new Error('outer');
    Object.defineProperty(hiddenCause, 'cause', { value: error, enumerable: false });
    const text = printed([new Map([['e', error]]), new Set([error]), { [sym]: error }, realm, hiddenCause]);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).toContain('from a vm');
    expect(text).toContain('outer');
  });

  test('a cycle back to a value that was copied never reaches the original', () => {
    const error = new HttpError({ password: 'BODY-SECRET' }, axiosError() as never);
    const ctx: Record<string, unknown> = { name: 'ctx', error };
    ctx.self = ctx;
    const outer: Record<string, unknown> = { error };
    outer.inner = { outer };
    const text = printed([ctx, outer]);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).toContain('[circular value]');
    // A cycle with nothing to hide still prints as itself.
    const plain: Record<string, unknown> = { n: 1 };
    plain.self = plain;
    expect(redactEngineLogArgs([plain])[0]).toBe(plain);
  });

  test('line structure: only the line with the serialized request is cut, later lines and line ends are kept', () => {
    expect(redactEngineText('line1 {"requestBody":1}\nline2 important\n')).toBe('line1 [request and response bodies withheld]\nline2 important\n');
    expect(redactEngineText('a {\n  "response": {\n    "status": 401,\n    "body": "RESP-SECRET"\n  }\n}\nnext\n'))
      .toBe('a [request and response bodies withheld]\nnext\n');
    expect(redactEngineText('requestBody: { password: "BODY-SECRET" },\nok')).toBe('[request and response bodies withheld]\nok');
    expect(redactEngineText('{"headers":{"X-Meta":{"a":1},"Proxy-Authorization":"Basic HDR-SECRET"}}')).not.toContain('HDR-SECRET');
    // Ordinary JSON with a config is not cut.
    expect(redactEngineText('loaded {"name":"x","config":{"retries":3}}')).toBe('loaded {"name":"x","config":{"retries":3}}');
  });

  test('ordinary values print as before: bytes, class instances, cycles, accessors; a revoked proxy is withheld, not thrown', () => {
    const bytes = Buffer.alloc(300);
    expect(redactEngineLogArgs([bytes])[0]).toBe(bytes);
    class Foo { n = 1; self: unknown = null; note = 'x {"requestBody":1}'; }
    const foo = new Foo(); foo.self = foo;
    const shown = redactEngineLogArgs([foo])[0] as Foo;
    expect(shown).toBeInstanceOf(Foo);
    expect(shown.note).toBe('x [request and response bodies withheld]');
    let calls = 0;
    const withGetter = { get secret() { calls++; return 'BODY-SECRET'; }, note: 'x {"requestBody":1}' };
    redactEngineLogArgs([withGetter]);
    expect(calls).toBe(0);
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    expect(redactEngineLogArgs([revoked.proxy])).toEqual(['[unprintable value withheld]']);
    const unanswered = new HttpError({ a: 1 }, { message: 'connect ECONNREFUSED' } as never);
    expect(redactEngineLogArgs([unanswered])).toEqual(['HttpError: request failed (no response); bodies and headers withheld']);
  });

  test('ordinary logs pass through unchanged, and a throwing getter does not throw here', () => {
    const plain = new Error('connection reset');
    const data = { a: 1 };
    expect(redactEngineLogArgs(['[Progress] Backup failed', plain, data, 3, null, undefined])).toEqual(['[Progress] Backup failed', plain, data, 3, null, undefined]);
    const hostile = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); } });
    expect(redactEngineLogArgs([hostile])).toEqual([hostile]);
  });
});
