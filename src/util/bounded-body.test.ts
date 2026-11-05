import { describe, expect, test } from 'bun:test';
import { readBoundedText } from './bounded-body.ts';

/** A chunked body of `total` bytes in 64 KiB chunks that counts what was pulled. */
function countingStream(total: number, chunk = 65_536): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) { controller.close(); return; }
      const n = Math.min(chunk, total - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(0x61));
    },
  }, { highWaterMark: 0 });
  return { stream, pulled: () => sent };
}

describe('readBoundedText', () => {
  test('stops reading a chunked body at the first chunk past the cap', async () => {
    const body = countingStream(64 * 1024 * 1024);
    const req = new Request('http://x/', { method: 'POST', body: body.stream });
    expect(req.headers.get('content-length')).toBeNull();
    const read = await readBoundedText(req, 1_000_000);
    expect(read).toEqual({ ok: false, reason: 'too_large' });
    // At most one chunk beyond the cap, plus whatever the stream queued ahead.
    expect(body.pulled()).toBeLessThan(1_000_000 + 4 * 65_536);
  });

  test('refuses on the declared length without reading', async () => {
    const body = countingStream(10);
    const req = new Request('http://x/', { method: 'POST', body: body.stream, headers: { 'content-length': '2000000' } });
    expect(await readBoundedText(req, 1_000_000)).toEqual({ ok: false, reason: 'too_large' });
    expect(body.pulled()).toBe(0);
  });

  test('counts bytes, not UTF-16 code units, and decodes like req.text()', async () => {
    const cjk = '漢'.repeat(400); // 400 code units, 1200 UTF-8 bytes
    expect(await readBoundedText(new Request('http://x/', { method: 'POST', body: cjk }), 1000))
      .toEqual({ ok: false, reason: 'too_large' });
    const ok = await readBoundedText(new Request('http://x/', { method: 'POST', body: cjk }), 1200);
    expect(ok).toEqual({ ok: true, text: cjk });
    const bad = new Uint8Array([0x7b, 0xff, 0x7d]);
    const viaText = await new Request('http://x/', { method: 'POST', body: bad }).text();
    expect(await readBoundedText(new Request('http://x/', { method: 'POST', body: bad }), 10)).toEqual({ ok: true, text: viaText });
  });

  test('an absent body reads as empty text', async () => {
    expect(await readBoundedText(new Request('http://x/', { method: 'POST' }), 10)).toEqual({ ok: true, text: '' });
  });
});
