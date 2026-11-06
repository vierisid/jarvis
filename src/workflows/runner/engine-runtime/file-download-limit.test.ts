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
const { fileProcessor } = await import(vendored) as { fileProcessor: (p: unknown, v: string) => Promise<unknown> };

test('an oversized download is a refusal, which the file processor fails the step on; another download error gives no file', async () => {
  const tooLarge = new ResponseTooLargeError('HTTP response refused: it is larger than the cap');
  expect(tooLarge).toBeInstanceOf(EgressRefusedError);
  expect(egressRefusalIn({ cause: tooLarge })).toBe(tooLarge);
  // A refusal reaches the step as itself (loopback stands in for any refusal the guard makes).
  await expect(fileProcessor({}, 'http://127.0.0.1:9/big.pdf')).rejects.toBeInstanceOf(EgressRefusedError);
  // Anything else stays upstream's empty file.
  expect(await fileProcessor({}, 'not a url')).toBeNull();
});
