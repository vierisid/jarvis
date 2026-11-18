import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const LIFECYCLE_TS = join(ROOT, 'src', 'cli', 'lifecycle.ts');
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

const scratch: string[] = [HOME];

afterAll(() => {
  try { holder?.kill('SIGKILL'); } catch { /* gone */ }
  for (const dir of scratch) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-first-run-'));
  scratch.push(dir);
  return dir;
}

/** A database file with something in it: what the daemon leaves after its first boot. */
function existingDb(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'SQLite format 3\0');
}

/**
 * firstRunHintFor in its own process, so HOME and JARVIS_HOME are exactly what
 * a `jarvis start` with that environment would see.
 */
async function hintFor(env: Record<string, string>, dataDir?: string): Promise<string | null> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'JARVIS_HOME') base[k] = v;
  const code = `const { firstRunHintFor } = await import(${JSON.stringify(LIFECYCLE_TS)});`
    + `const lines = await firstRunHintFor({ dataDir: ${JSON.stringify(dataDir)}, openUrl: 'http://localhost:3142' });`
    + `console.log(JSON.stringify(lines));`;
  const proc = Bun.spawn(['bun', '-e', code], { env: { ...base, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exit !== 0) throw new Error(err);
  const lines = JSON.parse(out.trim().split('\n').pop()!) as string[] | null;
  return lines ? lines.join('\n') : null;
}

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

  test('prints on a fresh data dir from --data-dir, naming the config file the daemon reads', async () => {
    const home = tempHome();
    const hint = await hintFor({ HOME: home }, join(home, 'data'));
    expect(hint).toContain('First-run detected');
    expect(hint).toContain(`in ${join(home, '.jarvis', 'config.yaml')}, open`);
  });

  test('prints on a fresh JARVIS_HOME', async () => {
    const home = tempHome();
    expect(await hintFor({ HOME: home, JARVIS_HOME: join(home, 'data') })).toContain('First-run detected');
  });

  test('does not print once the default data dir has a database', async () => {
    const home = tempHome();
    existingDb(join(home, '.jarvis', 'jarvis.db'));
    expect(await hintFor({ HOME: home })).toBeNull();
  });

  test('does not print when the JARVIS_HOME data dir has a database', async () => {
    const home = tempHome();
    existingDb(join(home, 'data', 'jarvis.db'));
    expect(await hintFor({ HOME: home, JARVIS_HOME: join(home, 'data') }, join(home, 'data'))).toBeNull();
  });

  test('Docker: HOME and JARVIS_HOME both the volume, --data-dir the volume, with a database, prints nothing', async () => {
    const volume = tempHome();
    existingDb(join(volume, 'jarvis.db'));
    expect(await hintFor({ HOME: volume, JARVIS_HOME: volume }, volume)).toBeNull();
    // The same volume before its first boot does get the hint.
    const fresh = tempHome();
    expect(await hintFor({ HOME: fresh, JARVIS_HOME: fresh }, fresh)).toContain(`in ${join(fresh, '.jarvis', 'config.yaml')}, open`);
  });

  test('does not print for an install whose database is gone but other state remains', async () => {
    const home = tempHome();
    mkdirSync(join(home, 'data'), { recursive: true });
    writeFileSync(join(home, 'data', 'workspace-id'), 'ws_1');
    expect(await hintFor({ HOME: home, JARVIS_HOME: join(home, 'data') })).toBeNull();
  });
});
