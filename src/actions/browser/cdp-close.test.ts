/**
 * A closed CDP client fails the calls it was carrying (#875 review).
 *
 * The controller's snapshot lock is held across CDP calls (a snapshot, a type,
 * a click's mouse events), and its holder releases it in a `finally`. If a
 * call in flight when the client is closed -- a reconnect in `ensureConnected`
 * closes it while other callers may be mid-call -- never settled, that
 * `finally` would never run and every later snapshot and element action would
 * refuse as busy until the daemon restarted.
 *
 * `close()` rejects the pending calls itself. It cannot lean on the socket's
 * close event: Bun 1.3 runs `onclose` synchronously inside `ws.close()`, but
 * Bun 1.4 (CI) runs it later, after `close()` has cleared its pending map.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { CDPClient } from './cdp.ts';

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

/** A CDP endpoint that never answers. */
function endpoint(): string {
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      message() {},
    },
  });
  return `ws://127.0.0.1:${server.port}/`;
}

describe('CDPClient.close', () => {
  test('rejects a call that was still waiting for its answer', async () => {
    const cdp = new CDPClient();
    await cdp.connect(endpoint());
    const hung = cdp.send('Never.answered');
    const outcome = hung.then(() => 'resolved', (err: Error) => err.message);

    await cdp.close();

    // Well inside the 30-second send timeout, which is not what settles it.
    const settled = await Promise.race([outcome, Bun.sleep(1000).then(() => 'still pending')]);
    expect(settled).toBe('CDP connection closed');
  });

  test('rejects a waiting call even when the close event arrives late or never', async () => {
    const cdp = new CDPClient();
    await cdp.connect(endpoint());
    // Stand in for a runtime that delivers onclose after close() returns.
    (cdp as unknown as { ws: { onclose: unknown } }).ws.onclose = null;
    const hung = cdp.send('Never.answered');
    const outcome = hung.then(() => 'resolved', (err: Error) => err.message);

    await cdp.close();

    const settled = await Promise.race([outcome, Bun.sleep(1000).then(() => 'still pending')]);
    expect(settled).toBe('CDP connection closed');
  });
});
