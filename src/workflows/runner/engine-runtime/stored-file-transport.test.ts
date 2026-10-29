/**
 * The vendored file processor sends the engine token only to an exact
 * /v1/step-files/<id> path joined onto the engine's own internal API URL.
 * Any other flow-chosen value goes through the egress guard with no token.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';

// The engine's workspace packages are not resolvable from the repo root; the
// processor only needs these few helpers.
mock.module('@activepieces/pieces-framework', () => ({
  ApFile: class { constructor(public filename: string, public data: Buffer, public extension?: string) {} },
}));
mock.module('@activepieces/shared', () => ({
  isNil: (v: unknown) => v === null || v === undefined,
  isString: (v: unknown) => typeof v === 'string',
  isBase64: () => false,
}));
// A non-literal specifier keeps tsc out of the vendored tree, which it does not type-check.
const vendored = '../../activepieces/packages/server/engine/src/lib/variables/processors/file';
const { fileProcessor } = await import(vendored) as { fileProcessor: unknown };

const seen: Array<{ path: string; auth: string | null }> = [];
let server: ReturnType<typeof Bun.serve>;
let ctx: { apiUrl: string; engineToken: string };
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
    seen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization') });
    return new Response('%PDF-1.4 fixture', { headers: { 'content-disposition': 'attachment; filename="invoice.pdf"' } });
  } });
  ctx = { apiUrl: `http://127.0.0.1:${server.port}/api/`, engineToken: 'engine-secret' };
});
afterAll(() => server.stop(true));

const run = (value: string, ...context: [typeof ctx?]) =>
  (fileProcessor as (p: unknown, v: string, c?: typeof ctx) => Promise<unknown>)({}, value, ...(context.length ? context : [ctx]));

test('an exact stored-file path is fetched from the internal API with the engine token', async () => {
  seen.length = 0;
  const file = await run('/v1/step-files/abc_D-1') as { filename: string; data: Buffer };
  expect(file.filename).toBe('invoice.pdf');
  expect(file.data.toString()).toContain('%PDF-');
  expect(seen).toEqual([{ path: '/api/v1/step-files/abc_D-1', auth: 'Bearer engine-secret' }]);
});

test('path tricks, encodings and absolute URLs never receive the engine token', async () => {
  seen.length = 0;
  const values = [
    '/v1/step-files/abc\n', '/v1/step-files/../x', '/v1/step-files/a%2F..', '/v1/step-files/abc?x=1',
    '/v1/step-files/abc#x', '//127.0.0.1:' + server.port + '/v1/step-files/abc', '\\v1/step-files/abc',
    ' /v1/step-files/abc', '/v1/step-files/', `http://127.0.0.1:${server.port}/api/v1/step-files/abc`,
  ];
  for (const value of values) {
    // Each falls to the guarded download: relative values fail to parse and
    // the loopback URL is refused by the egress policy. None reaches the server.
    await run(value).catch(() => null);
  }
  expect(seen).toEqual([]);
});

test('a stored-file path without the workflow context is not fetched', async () => {
  seen.length = 0;
  expect(await run('/v1/step-files/abc', undefined)).toBeNull();
  expect(seen).toEqual([]);
});
