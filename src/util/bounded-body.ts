/**
 * Read a request body as UTF-8 text, refusing it once more than `maxBytes`
 * have arrived.
 *
 * `req.text()` buffers the whole body before a caller can look at its size.
 * The declared `content-length` check does not help with a chunked body,
 * which declares none, and Bun's own `maxRequestBodySize` does not stop one
 * either on the Bun versions this package supports. Measured with
 * `maxRequestBodySize: 1024` and a 1 MiB chunked POST: Bun 1.3.8, 1.3.11 and
 * 1.3.13 hand the handler all 1,048,576 bytes; Bun 1.4.2 answers 413. So a
 * public route that reads with `req.text()` holds whatever a sender streams
 * at it, up to memory, before its own cap runs.
 *
 * This reads chunk by chunk and cancels the stream at the first chunk that
 * takes the total past the cap, so at most one chunk beyond the cap is ever
 * held. The cap is in BYTES, the same unit as `content-length`, which is
 * checked first so an honest oversized request is refused without a read.
 *
 * Decoding matches `req.text()`: UTF-8, with ill-formed sequences replaced
 * rather than refused.
 */
export type BoundedText =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' | 'unreadable' };

export async function readBoundedText(req: Request, maxBytes: number): Promise<BoundedText> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large' };
  if (!req.body) return { ok: true, text: '' };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = req.body.getReader();
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks)) };
}

/**
 * The daemon's request-body limit: Bun's documented `maxRequestBodySize`
 * default, set explicitly so a chunked body is held to the same number.
 */
export const MAX_REQUEST_BODY_BYTES = 128 * 1024 * 1024;

/**
 * Hold a body that declares no length to `maxBytes`, the server-wide backstop
 * for what `maxRequestBodySize` misses on Bun < 1.4 (see the top of this file).
 * A body with a `content-length` is Bun's to refuse and is returned as is, as
 * is a GET or HEAD (a Request cannot be rebuilt with a body for those, and no
 * route reads one). Otherwise the returned request streams the same bytes and
 * fails its read once more than `maxBytes` arrive; `exceeded()` then says so,
 * so the server can answer 413 whatever the handler made of the failed read.
 * The rebuilt request is a copy: server calls keyed on the native request
 * (server.timeout, server.requestIP) must still be given the original.
 */
export function limitUndeclaredBody(req: Request, maxBytes: number): { req: Request; exceeded: () => boolean } {
  let over = false;
  const exceeded = () => over;
  const method = req.method.toUpperCase();
  if (!req.body || req.headers.has('content-length') || method === 'GET' || method === 'HEAD') return { req, exceeded };
  let size = 0;
  const counted = req.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        over = true;
        controller.error(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return { req: new Request(req, { body: counted, duplex: 'half' } as RequestInit), exceeded };
}

export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body is larger than ${maxBytes} bytes`);
    this.name = 'RequestBodyTooLargeError';
  }
}
