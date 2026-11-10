import { test, expect, afterEach, describe } from 'bun:test';
import { WebSocketServer } from './websocket.ts';
import { MAX_REQUEST_BODY_BYTES, RequestBodyTooLargeError, limitUndeclaredBody } from '../util/bounded-body.ts';

// The daemon's one request-body limit, for bodies that declare a length and
// for chunked ones alike. Bun's own maxRequestBodySize answers 413 for a
// declared length, but before Bun 1.4 it hands a CHUNKED body to the handler
// in full whatever the limit (measured on 1.3.8: a 1 MiB chunked POST against
// a 1 KiB limit reached the handler as 1,048,576 bytes), so req.json() on an
// authenticated route held whatever a sender streamed. These tests pin that
// the server answers 413 and no handler ever sees more than the limit.

const PORT = 3172;
const LIMIT = 1024;
let server: WebSocketServer | null = null;

afterEach(() => {
  if (server?.isRunning()) server.stop();
  server = null;
});

function start(nativeLimit?: number): { seen: Array<number | string> } {
  const seen: Array<number | string> = [];
  server = new WebSocketServer(PORT);
  server.setInsecureOpenAccess(true);
  server.setMaxRequestBodyBytes(LIMIT, nativeLimit);
  server.setApiRoutes({
    '/api/echo': {
      POST: async (req) => {
        try {
          const text = await req.text();
          seen.push(text.length);
          return Response.json({ len: text.length });
        } catch (err) {
          // What a route handler does with a failed read: a generic error.
          seen.push(String(err));
          return Response.json({ error: String(err) }, { status: 500 });
        }
      },
    },
  });
  server.start();
  return { seen };
}

/** A body sent with Transfer-Encoding: chunked (no content-length). */
function chunked(total: number, chunk = 16 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(c) {
      if (sent >= total) { c.close(); return; }
      const n = Math.min(chunk, total - sent);
      c.enqueue(new Uint8Array(n).fill(97));
      sent += n;
    },
  });
}

const url = `http://127.0.0.1:${PORT}/api/echo`;

test('the daemon limit is Bun\'s documented default, so no request that worked before is refused', () => {
  expect(MAX_REQUEST_BODY_BYTES).toBe(128 * 1024 * 1024);
});

test('the backstop answers 413 itself even where Bun would not (Bun\'s own limit set above it)', async () => {
  // Bun >= 1.4 applies maxRequestBodySize to chunked bodies; set it far above
  // the backstop so this test reaches the backstop on every Bun version.
  const { seen } = start(1 << 30);
  const res = await fetch(url, { method: 'POST', body: chunked(64 * 1024), duplex: 'half', keepalive: false } as RequestInit);
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: 'Request body too large' });
  expect(seen).toHaveLength(1);
  expect(String(seen[0])).toContain('RequestBodyTooLargeError');
});

test('a chunked body over the limit is answered 413 and no handler reads it in full', async () => {
  const { seen } = start();
  // keepalive off: Bun answers 413 but keeps reading the rest of the body
  // off the socket, so a pooled connection would carry it into the next test.
  const res = await fetch(url, { method: 'POST', body: chunked(1024 * 1024), duplex: 'half', keepalive: false } as RequestInit);
  expect(res.status).toBe(413);
  // The handler runs and its read fails, so it never holds 1 MiB: our error
  // on Bun < 1.4, Bun's own maxRequestBodySize error on 1.4.
  expect(seen).toHaveLength(1);
  expect(typeof seen[0]).toBe('string');
});

test('a route that lets the failed read throw still answers 413', async () => {
  server = new WebSocketServer(PORT);
  server.setInsecureOpenAccess(true);
  server.setMaxRequestBodyBytes(LIMIT, 1 << 30);
  server.setApiRoutes({ '/api/echo': { POST: async (req) => Response.json(await req.json()) } });
  server.start();
  const res = await fetch(url, { method: 'POST', body: chunked(64 * 1024), duplex: 'half', keepalive: false } as RequestInit);
  expect(res.status).toBe(413);
});

// The two server tests above pass on Bun >= 1.4 without the backstop (Bun
// enforces the limit itself there), so the backstop is also pinned directly.
describe('limitUndeclaredBody', () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request('http://localhost/x', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

  test('a chunked body past the limit fails its read and is reported exceeded', async () => {
    const limited = limitUndeclaredBody(post(chunked(LIMIT + 1, 100)), LIMIT);
    expect(limited.exceeded()).toBe(false);
    await expect(limited.req.text()).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(limited.exceeded()).toBe(true);
  });

  test('a chunked body at the limit reads whole, with method and headers kept', async () => {
    const original = post(chunked(LIMIT, 100), { 'content-type': 'application/json', 'x-probe': '1' });
    const limited = limitUndeclaredBody(original, LIMIT);
    expect(limited.req).not.toBe(original);
    expect(limited.req.method).toBe('POST');
    expect(limited.req.headers.get('x-probe')).toBe('1');
    expect(limited.req.signal).toBe(original.signal);
    expect((await limited.req.text()).length).toBe(LIMIT);
    expect(limited.exceeded()).toBe(false);
  });

  test('a declared length, and a request without a body, are left to Bun', () => {
    // A server request carries the header the client sent; set it here.
    const declared = post('x'.repeat(LIMIT + 1), { 'content-length': String(LIMIT + 1) });
    expect(limitUndeclaredBody(declared, LIMIT).req).toBe(declared);
    const get = new Request('http://localhost/x');
    expect(limitUndeclaredBody(get, LIMIT).req).toBe(get);
  });
});

test('a chunked body within the limit reaches the handler whole', async () => {
  const { seen } = start();
  const res = await fetch(url, { method: 'POST', body: chunked(LIMIT, 100), duplex: 'half' } as RequestInit);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ len: LIMIT });
  expect(seen).toEqual([LIMIT]);
});

test('a declared body over the limit is answered 413 before any handler runs', async () => {
  const { seen } = start();
  const res = await fetch(url, { method: 'POST', body: 'x'.repeat(LIMIT + 1) });
  expect(res.status).toBe(413);
  expect(seen).toEqual([]);
});

test('a declared body within the limit is untouched', async () => {
  const { seen } = start();
  const res = await fetch(url, { method: 'POST', body: 'x'.repeat(LIMIT), headers: { 'content-type': 'application/json' } });
  expect(res.status).toBe(200);
  expect(seen).toEqual([LIMIT]);
});
