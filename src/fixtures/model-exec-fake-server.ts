/**
 * The listening half of the fake browser used by model-exec-env-probe.ts.
 * The fake's shell wrapper has already dumped its environment; this only
 * answers what launchChrome polls for, so that it returns normally instead of
 * timing out:
 *   --remote-debugging-port=N  -> HTTP 200 on /json/version (Chrome's CDP)
 *
 * Exits on SIGTERM (stopChrome), or after 30s whatever happens, so a failed
 * test cannot leave it running.
 */
setTimeout(() => process.exit(0), 30_000);

const args = process.argv.slice(2);
const cdp = args.find(a => a.startsWith('--remote-debugging-port='));

if (cdp) {
  Bun.serve({
    hostname: '127.0.0.1',
    port: Number(cdp.split('=')[1]),
    fetch: (req) => new URL(req.url).pathname === '/json/version'
      ? Response.json({ Browser: 'fake' })
      : new Response('not found', { status: 404 }),
  });
} else {
  console.error('model-exec-fake-server: no port argument');
  process.exit(2);
}
