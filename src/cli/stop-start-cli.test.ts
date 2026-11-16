import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The real CLI, in a throwaway HOME, against a listener that has nothing to do
 * with Jarvis. Nothing here may signal that listener: it is killed only by the
 * test that started it.
 */
const BIN = join(import.meta.dir, '..', '..', 'bin', 'jarvis.ts');
const HOME = mkdtempSync(join(tmpdir(), 'jarvis-cli-e2e-'));
const children: Array<ReturnType<typeof Bun.spawn>> = [];
let heldPort: number | null = null;

async function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    env: { ...process.env, HOME, JARVIS_HOME: join(HOME, '.jarvis'), JARVIS_PORT: '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out + err };
}

async function unrelatedListener(): Promise<{ pid: number; port: number }> {
  const child = Bun.spawn(
    ['bun', '-e', 'const s = Bun.serve({ port: 0, fetch: () => new Response("x") }); console.log(s.port); setInterval(() => {}, 1000);'],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  children.push(child);
  const { value } = await child.stdout.getReader().read();
  const port = Number.parseInt(new TextDecoder().decode(value).trim(), 10);
  heldPort = port;
  return { pid: child.pid, port };
}

afterAll(async () => {
  // Nothing here should have started a daemon. If a regression did, its lock
  // is in this HOME and `stop` signals only that lock's holder. The port is
  // pinned to one of our own listeners (never this install's, so never
  // signalled): a bare `stop` would fall back to 3142 and clear any daemon
  // run from this checkout -- the developer's own -- since its command line is
  // this bin/jarvis.ts.
  if (existsSync(join(HOME, '.jarvis', 'jarvis.pid')) && heldPort !== null) {
    await cli(['stop'], { JARVIS_PORT: String(heldPort) }).catch(() => {});
  }
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('jarvis stop with no daemon running', () => {
  test('does not kill an unrelated program on the port, and says what holds it', async () => {
    const { pid, port } = await unrelatedListener();

    const { code, out } = await cli(['stop'], { JARVIS_PORT: String(port) });

    expect(code).toBe(0);
    expect(out).toContain('JARVIS is not running');
    expect(out).toContain(`PID ${pid}`);
    expect(out).toContain('left running');
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect((await fetch(`http://127.0.0.1:${port}/`)).ok).toBe(true);
  });
});

describe('jarvis start', () => {
  test('-d on a busy port fails at once, naming the port, and starts nothing', async () => {
    const { port } = await unrelatedListener();

    const started = Date.now();
    const { code, out } = await cli(['start', '-d', '--no-open', '--port', String(port)]);

    expect(code).not.toBe(0);
    expect(out).toContain(`Port ${port} is already in use`);
    expect(out).not.toContain('daemon started');
    expect(Date.now() - started).toBeLessThan(8000);
    expect((await cli(['status'])).out).not.toContain('(PID');
  }, 20_000);

  test('--port without a value is an error, not the default port', async () => {
    for (const args of [['start', '--port'], ['start', '--port', '--no-open'], ['start', '--port=abc']]) {
      const { code, out } = await cli(args);
      expect(code).toBe(1);
      expect(out).toContain('--port requires a number');
    }
  });
});
