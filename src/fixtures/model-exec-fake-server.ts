/**
 * The listening half of the fake browser and fake sidecar used by
 * model-exec-env-probe.ts. The fake's shell wrapper has already dumped its
 * environment; this only answers what launchChrome and launchSidecar poll for,
 * so that they return normally instead of timing out:
 *   --remote-debugging-port=N  -> HTTP 200 on /json/version (Chrome's CDP)
 *   --port N                   -> "pong" to a JSON-RPC ping (desktop-bridge)
 *
 * Exits on SIGTERM (stopChrome / stopSidecar), on the sidecar's shutdown
 * message, or after 30s whatever happens, so a failed test cannot leave it
 * running.
 */
setTimeout(() => process.exit(0), 30_000);

const args = process.argv.slice(2);
const cdp = args.find(a => a.startsWith('--remote-debugging-port='));
const portIdx = args.indexOf('--port');

if (cdp) {
  Bun.serve({
    hostname: '127.0.0.1',
    port: Number(cdp.split('=')[1]),
    fetch: (req) => new URL(req.url).pathname === '/json/version'
      ? Response.json({ Browser: 'fake' })
      : new Response('not found', { status: 404 }),
  });
} else if (portIdx !== -1) {
  const listen = (hostname: string) => Bun.listen({
    hostname,
    port: Number(args[portIdx + 1]),
    socket: {
      data(socket, chunk) {
        const text = chunk.toString();
        if (text.includes('"shutdown"')) process.exit(0);
        if (text.includes('"ping"')) socket.write('{"jsonrpc":"2.0","result":"pong","id":-1}\n');
      },
    },
  });
  // '::' accepts IPv4 as well on a dual-stack host, whichever of the two
  // 'localhost' resolves to first. A kernel with IPv6 disabled refuses it,
  // and there 'localhost' is 127.0.0.1 anyway.
  try {
    listen('::');
  } catch {
    listen('127.0.0.1');
  }
} else {
  console.error('model-exec-fake-server: no port argument');
  process.exit(2);
}
