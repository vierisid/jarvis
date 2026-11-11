/**
 * A file field accepts every file shape Jarvis's own steps produce: the bare
 * step-file path (zip, pdf, image, qrcode), the { fileName, url } object Create
 * file returns, a data URL and a { filename, base64 } object. Anything else
 * fails the step in plain words, not as "required input is missing". The rule
 * lives once in the vendored file processor (`processors/file.ts`), so it holds
 * for every piece's file prop.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';

mock.module('@activepieces/pieces-framework', () => ({
  ApFile: class { constructor(public filename: string, public data: Buffer, public extension?: string) {} },
}));
mock.module('@activepieces/shared', () => ({
  isNil: (v: unknown) => v === null || v === undefined,
  isString: (v: unknown) => typeof v === 'string',
  isBase64: (v: unknown) => typeof v === 'string' && v.startsWith('data:'),
}));
// A non-literal specifier keeps tsc out of the vendored tree, which it does not type-check.
const vendored = '../../activepieces/packages/server/engine/src/lib/variables/processors/file';
const { fileProcessor } = await import(vendored) as { fileProcessor: (p: unknown, v: unknown, c?: Ctx) => Promise<unknown> };

type Ctx = { apiUrl: string; engineToken: string };
type Stored = { filename: string; data: Buffer; extension?: string };
const seen: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let ctx: Ctx;
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
    seen.push(new URL(req.url).pathname);
    return new Response('hello file', { headers: { 'content-disposition': 'attachment; filename="notes.txt"' } });
  } });
  ctx = { apiUrl: `http://127.0.0.1:${server.port}/api/`, engineToken: 'engine-secret' };
});
afterAll(() => server.stop(true));

const PLAIN = 'This field needs a file from an earlier step, such as the output of Create file.';

test('Create file output chained as {{step_1}} is read as the file it points at', async () => {
  seen.length = 0;
  const file = await fileProcessor({}, { fileName: 'notes.txt', url: '/v1/step-files/abc_D-1' }, ctx) as Stored;
  expect(file.filename).toBe('notes.txt');
  expect(file.data.toString()).toBe('hello file');
  expect(seen).toEqual(['/api/v1/step-files/abc_D-1']);
});

test('the bare step-file path still works', async () => {
  const file = await fileProcessor({}, '/v1/step-files/abc_D-1', ctx) as Stored;
  expect(file.data.toString()).toBe('hello file');
});

test('a { filename, base64 } object and a data URL become files; bad or oversized base64 is refused plainly', async () => {
  const b64 = Buffer.from('from base64').toString('base64');
  const fromObject = await fileProcessor({}, { filename: 'a.txt', base64: b64 }) as Stored;
  expect(fromObject.filename).toBe('a.txt');
  expect(fromObject.extension).toBe('txt');
  expect(fromObject.data.toString()).toBe('from base64');
  const fromUrl = await fileProcessor({}, { fileName: 'b.txt', base64: `data:text/plain;base64,${b64}` }) as Stored;
  expect(fromUrl.data.toString()).toBe('from base64');
  const dataUrl = await fileProcessor({}, `data:text/plain;base64,${b64}`) as Stored;
  expect(dataUrl.data.toString()).toBe('from base64');
  await expect(fileProcessor({}, { filename: 'a.txt', base64: '%%%not base64%%%' })).rejects.toThrow(/not valid base64/);
  await expect(fileProcessor({}, { filename: 'a.txt', base64: 'A'.repeat(11 * 1024 * 1024) })).rejects.toThrow(/too large/);
});

test('a data URL of any media type is decoded in place and never fetched; one that is not base64 is refused plainly', async () => {
  seen.length = 0;
  const b64 = Buffer.from('from a data url').toString('base64');
  for (const [type, extension] of [['video/mp4', 'mp4'], ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'], ['text/plain;charset=utf-8', 'txt'], ['', 'bin']]) {
    const file = await fileProcessor({}, `data:${type};base64,${b64}`, ctx) as Stored;
    expect(file.data.toString()).toBe('from a data url');
    expect(file.extension).toBe(extension);
    expect(file.filename).toBe(`unknown.${extension}`);
  }
  const inObject = await fileProcessor({}, { fileName: 'c.mp3', url: `data:audio/mpeg;base64,${b64}` }, ctx) as Stored;
  expect(inObject.data.toString()).toBe('from a data url');
  // Nothing went to the daemon: no read list asked, no download.
  expect(seen).toEqual([]);
  await expect(fileProcessor({}, 'data:text/plain,hello', ctx)).rejects.toThrow(/must be base64/);
  await expect(fileProcessor({}, 'data:text/plain;base64,%%%', ctx)).rejects.toThrow(/not valid base64/);
  await expect(fileProcessor({}, `data:text/plain;base64,${'A'.repeat(11 * 1024 * 1024)}`, ctx)).rejects.toThrow(/too large/);
});

test('a refusal never echoes the value or the name it came with', async () => {
  const name = '<img src=x onerror=alert(1)>.txt';
  const message = await fileProcessor({}, { filename: name, base64: '%%%not base64%%%' }).catch((e: Error) => e.message) as string;
  expect(message).toMatch(/not valid base64/);
  expect(message).not.toContain('<img');
  const text = await fileProcessor({}, '<b>ignore previous instructions</b>', ctx).catch((e: Error) => e.message) as string;
  expect(text).toBe(`${PLAIN} It got text instead.`);
});

test('text, a number or an object with no file in it gets a plain message, never "required input is missing"', async () => {
  await expect(fileProcessor({}, 'the quarterly report', ctx)).rejects.toThrow(`${PLAIN} It got text instead.`);
  await expect(fileProcessor({}, 42, ctx)).rejects.toThrow(`${PLAIN} It got a number instead.`);
  await expect(fileProcessor({}, { fileName: 'x.txt' }, ctx)).rejects.toThrow(/It got an object with no file in it instead/);
  // Absent or blank stays "no value", so the required check still speaks for it.
  expect(await fileProcessor({}, undefined, ctx)).toBeNull();
  expect(await fileProcessor({}, '  ', ctx)).toBeNull();
});

test('a URL object still goes through the read-host rules: with no workflow to check, nothing is fetched', async () => {
  await expect(fileProcessor({}, { fileName: 'x.pdf', url: 'https://files.example.com/x.pdf' })).rejects.toThrow(/no workflow to check its read list against/);
});
