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
