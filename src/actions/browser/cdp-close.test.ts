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
 * `close()` clears its pending map without rejecting, and the send timeout only
 * fires for an id still in that map, so reading the code alone says this
 * leaks. It does not, and this pins why: Bun runs a client WebSocket's
 * `onclose` SYNCHRONOUSLY inside `ws.close()` (measured: the handler's log line
 * lands before the line after the call), and that handler rejects every
 * pending call before `close()` reaches its `clear()`. If a Bun upgrade makes
 * the close event asynchronous, the first test here fails, and `close()` has
 * to reject the pending calls itself.
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
});
