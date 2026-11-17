import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireLockAt } from './pid.ts';

// Real `jarvis start` runs: the two avoidable startup failures now say what is wrong.
let root: string; let holder: Server | null = null; let lock: { release: () => void } | null = null;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jarvis-start-')); mkdirSync(join(root, 'home')); mkdirSync(join(root, 'data')); });
afterEach(() => { lock?.release(); lock = null; holder?.close(); holder = null; chmodSync(join(root, 'data'), 0o755); rmSync(root, { recursive: true, force: true }); });

async function start(port: number, opts: { detach?: boolean; env?: Record<string, string> } = {}) {
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'run', join(import.meta.dir, '../../bin/jarvis.ts'), 'start', ...(opts.detach ? ['-d'] : []), '--no-open', '--port', String(port)], {
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), JARVIS_HOME: join(root, 'data'), JARVIS_SECRETS_DIR: join(root, 'data'), ...opts.env },
    stdout: 'pipe', stderr: 'pipe', timeout: 25_000, killSignal: 'SIGKILL',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { text: out + err, code, seconds: (Date.now() - started) / 1000 };
}

test('a busy port is named at once, with how to choose another, and no stack', async () => {
  const port = await new Promise<number>((resolve) => {
    holder = createServer();
    holder.listen({ port: 0, host: '0.0.0.0' }, () => resolve((holder!.address() as { port: number }).port));
  });
  const { text, code, seconds } = await start(port);
  expect(code).toBe(1);
  expect(text).toContain(`Port ${port} is already in use`);
  expect(text).toContain('jarvis start --port');
  expect(text).not.toContain('EADDRINUSE');
  expect(text).not.toContain('Fatal error during startup');
  expect(seconds).toBeLessThan(8);
}, 30_000);

test.skipIf(process.getuid?.() === 0)('an unwritable data folder is not reported as "already running"', async () => {
  chmodSync(join(root, 'data'), 0o555);
  const { text, code } = await start(39518);
  expect(code).toBe(1);
  expect(text).toContain('cannot write to its data folder');
  expect(text).not.toContain('already running');
}, 30_000);

// Another JARVIS holds this data folder. Inside a container `jarvis stop`
// cannot reach it (it is most likely another container on the same volume), so
// both start paths name the folder and point at the container instead.
for (const detach of [false, true]) {
  const mode = detach ? 'start -d' : 'start';

  test(`${mode} in a container names the data folder and says to stop the other container`, async () => {
    lock = acquireLockAt(join(root, 'data', 'jarvis.pid'), process.pid);
    expect(lock).not.toBeNull();
    const { text, code } = await start(39519, { detach, env: { JARVIS_INSTALL_METHOD: 'docker' } });
    expect(code).toBe(1);
    expect(text).toContain(`Another JARVIS is already using the data folder ${join(root, 'data')}`);
    expect(text).toContain('docker stop <name>');
    expect(text).not.toContain('jarvis stop');
  }, 30_000);

  // /.dockerenv makes every run count as Docker, so this one only means something outside a container.
  test.skipIf(existsSync('/.dockerenv'))(`${mode} outside a container keeps "jarvis stop" and names the data folder`, async () => {
    lock = acquireLockAt(join(root, 'data', 'jarvis.pid'), process.pid);
    expect(lock).not.toBeNull();
    const { text, code } = await start(39519, { detach });
    expect(code).toBe(1);
    expect(text).toContain(`on the data folder ${join(root, 'data')}`);
    expect(text).toContain('Stop it first with: jarvis stop');
    expect(text).not.toContain('docker stop');
  }, 30_000);
}
