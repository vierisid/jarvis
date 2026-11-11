import { describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import { redactEngineLogArgs } from './engine-console-redaction';
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

  test('ordinary logs pass through unchanged, and a throwing getter does not throw here', () => {
    const plain = new Error('connection reset');
    const data = { a: 1 };
    expect(redactEngineLogArgs(['[Progress] Backup failed', plain, data, 3, null, undefined])).toEqual(['[Progress] Backup failed', plain, data, 3, null, undefined]);
    const hostile = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); } });
    expect(redactEngineLogArgs([hostile])).toEqual([hostile]);
  });
});
