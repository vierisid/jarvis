import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Real `jarvis start` runs: the two avoidable startup failures now say what is wrong.
let root: string; let holder: Server | null = null;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jarvis-start-')); mkdirSync(join(root, 'home')); mkdirSync(join(root, 'data')); });
afterEach(() => { holder?.close(); holder = null; chmodSync(join(root, 'data'), 0o755); rmSync(root, { recursive: true, force: true }); });

async function start(port: number) {
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'run', join(import.meta.dir, '../../bin/jarvis.ts'), 'start', '--no-open', '--port', String(port)], {
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), JARVIS_HOME: join(root, 'data'), JARVIS_SECRETS_DIR: join(root, 'data') },
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
