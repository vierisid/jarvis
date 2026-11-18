import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstRunHint } from './lifecycle.ts';

/**
 * The real CLI in a throwaway HOME with no config.yaml, against a data folder
 * whose lock another process already holds (#1451). The refused start must say
 * so and must not print the first-run hint.
 */
const ROOT = join(import.meta.dir, '..', '..');
const BIN = join(ROOT, 'bin', 'jarvis.ts');
const PID_TS = join(ROOT, 'src', 'daemon', 'pid.ts');
const HOME = mkdtempSync(join(tmpdir(), 'jarvis-first-run-'));
const DATA = join(HOME, 'data');
mkdirSync(DATA, { recursive: true });
const env = { ...process.env, HOME, JARVIS_HOME: DATA, JARVIS_PORT: '' };
let holder: ReturnType<typeof Bun.spawn> | null = null;

async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', BIN, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out + err };
}

afterAll(() => {
  try { holder?.kill('SIGKILL'); } catch { /* gone */ }
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('first-run hint', () => {
  test('names the config file in full, with or without a dashboard URL', () => {
    const withUrl = firstRunHint('/data/.jarvis/config.yaml', 'http://localhost:3142').join('\n');
    expect(withUrl).toContain('in /data/.jarvis/config.yaml, open http://localhost:3142');
    expect(withUrl).not.toContain('~/.jarvis');
    const noUrl = firstRunHint('/data/.jarvis/config.yaml', null).join('\n');
    expect(noUrl).toContain('in /data/.jarvis/config.yaml, reach the socket');
  });

  test('is not printed when the start is refused because another instance holds the lock', async () => {
    const h = Bun.spawn(
      ['bun', '-e', `const { tryAcquireLock } = await import(${JSON.stringify(PID_TS)}); const r = tryAcquireLock(process.pid); console.log(r.ok ? 'locked' : 'failed'); setInterval(() => {}, 1000);`],
      { env, stdout: 'pipe', stderr: 'inherit' },
    );
    holder = h;
    const { value } = await h.stdout.getReader().read();
    expect(new TextDecoder().decode(value).trim()).toBe('locked');

    for (const args of [['start', '--no-open', '--data-dir', DATA], ['start', '-d', '--no-open', '--data-dir', DATA]]) {
      const { code, out } = await cli(args);
      expect(code).toBe(1);
      expect(out).toContain('JARVIS is already running');
      expect(out).not.toContain('First-run detected');
    }
  }, 30_000);
});
