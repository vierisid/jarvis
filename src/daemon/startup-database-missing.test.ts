import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from './index.ts';

// A real start against a data folder that was used before but lost its
// database: the process must refuse, say why and what to run, and create nothing.
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jarvis-start-')); mkdirSync(join(root, 'home')); mkdirSync(join(root, 'data')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function start(extra: string[] = []) {
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'run', join(import.meta.dir, '../../bin/jarvis.ts'), 'start', '--no-open', '--port', '39517', ...extra], {
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), JARVIS_HOME: join(root, 'data'), JARVIS_SECRETS_DIR: join(root, 'data') },
    stdout: 'pipe', stderr: 'pipe', timeout: 20_000, killSignal: 'SIGKILL',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { text: out + err, code };
}

for (const state of ['missing', 'empty'] as const) {
  test(`${state} database next to saved state: refuses, names the restore command, creates nothing`, async () => {
    writeFileSync(join(root, 'data', 'workspace-id'), 'abcdefghijklmnopqrstu\n');
    if (state === 'empty') writeFileSync(join(root, 'data', 'jarvis.db'), '');
    const { text, code } = await start();
    expect(code).toBe(1);
    expect(text).toContain(`database file is ${state}`);
    expect(text).toContain('jarvis restore');
    expect(text).toContain('--new-database');
    expect(text).not.toContain('Fatal error during startup');
    if (state === 'missing') expect(existsSync(join(root, 'data', 'jarvis.db'))).toBe(false);
    else expect(Bun.file(join(root, 'data', 'jarvis.db')).size).toBe(0);
  }, 30_000);
}

test('--new-database reaches the daemon as an explicit request', () => {
  expect(parseArgs(['--new-database']).allowNewDatabase).toBe(true);
  expect(parseArgs([]).allowNewDatabase).toBeUndefined();
});
