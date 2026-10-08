/**
 * The local clipboard tools, get_clipboard and set_clipboard.
 *
 * Under WSL they reach the Windows clipboard through powershell.exe and
 * clip.exe, which used to be found on PATH (#896): WSL's PATH puts the user's
 * own bin dirs and third-party Windows dirs ahead of System32, so whichever
 * came first read the clipboard or was handed what was written to it. They
 * now run from the Windows directory by absolute path.
 *
 * POSIX-only: the fakes are `#!/bin/sh` scripts. isWSL() is stubbed, and the
 * Windows directory is a fake one (__setWindowsDirForTests), so nothing here
 * touches a real clipboard.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WSLBridge, __setWindowsDirForTests } from '../terminal/wsl-bridge.ts';
import { getClipboardTool, setClipboardTool } from './builtin.ts';
import { __setCaptureTimeoutForTests } from '../app-control/capture-file.ts';

const IS_POSIX = process.platform !== 'win32';

const root = mkdtempSync(join(tmpdir(), 'jarvis-clipboard-'));
const winDir = join(root, 'Windows');
const logDir = join(root, 'log');

function fake(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

mkdirSync(logDir);
// Get-Clipboard as Windows PowerShell prints it: CRLF line ends.
fake(join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  `for a in "$@"; do printf '%s\\0' "$a" >> "${logDir}/powershell.argv"; done\nprintf 'copied line 1\\r\\ncopied line 2\\r\\n'`);
fake(join(winDir, 'System32', 'clip.exe'), `cat > "${logDir}/clip.input"`);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!IS_POSIX)('clipboard tools under WSL (#896)', () => {
  let spy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    rmSync(join(logDir, 'powershell.argv'), { force: true });
    rmSync(join(logDir, 'clip.input'), { force: true });
    spy = spyOn(WSLBridge, 'isWSL').mockReturnValue(true);
    __setWindowsDirForTests(winDir);
  });

  afterEach(() => {
    spy?.mockRestore();
    __setWindowsDirForTests(null);
  });

  test.skipIf(process.platform !== 'linux')('get_clipboard reads through System32 powershell.exe', async () => {
    expect(await getClipboardTool.execute({})).toBe('copied line 1\ncopied line 2');
    expect(readFileSync(join(logDir, 'powershell.argv'), 'utf-8').split('\0').slice(0, -1))
      .toEqual(['-NoProfile', '-Command', 'Get-Clipboard']);
  });

  test.skipIf(process.platform !== 'linux')('set_clipboard writes through System32 clip.exe', async () => {
    const content = 'to the clipboard\nwith a second line';
    expect(await setClipboardTool.execute({ content })).toBe('Clipboard updated.');
    expect(existsSync(join(logDir, 'clip.input'))).toBe(true);
    expect(readFileSync(join(logDir, 'clip.input'), 'utf-8')).toBe(content);
  });
});

/** The tool's reply, or 'still running' past the deadline (never `await expect().rejects` on a maybe-hung call). */
function settle(p: Promise<unknown>, deadlineMs: number): Promise<string> {
  return Promise.race([p.then(String, (e: Error) => `threw: ${e.message}`), Bun.sleep(deadlineMs).then(() => 'still running')]);
}

const SLEEP = Bun.which('sleep') ?? '/bin/sleep';

/**
 * #894: the clipboard tools ran through execSync with no timeout, so one that
 * hung -- `xclip -o` waiting on a selection owner that stopped answering --
 * held the event loop for as long as it hung. Under WSL they reach
 * powershell.exe and clip.exe by absolute path, so this runs in-process with
 * hanging fakes in a fake Windows directory.
 */
describe.skipIf(process.platform !== 'linux')('clipboard tools are bounded and awaited (#894)', () => {
  const hungWin = join(root, 'hung-Windows');
  let spy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    fake(join(hungWin, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), `exec '${SLEEP}' 10`);
    fake(join(hungWin, 'System32', 'clip.exe'), `exec '${SLEEP}' 10`);
    spy = spyOn(WSLBridge, 'isWSL').mockReturnValue(true);
    __setWindowsDirForTests(hungWin);
    __setCaptureTimeoutForTests(1000);
  });

  afterEach(() => {
    spy?.mockRestore();
    __setWindowsDirForTests(null);
    __setCaptureTimeoutForTests(null);
  });

  test('a read that hangs is stopped at the bound, and the event loop turns meanwhile', async () => {
    let ticks = 0;
    const interval = setInterval(() => { ticks++; }, 20);
    try {
      const started = performance.now();
      const read = Promise.resolve().then(() => getClipboardTool.execute({}));
      await Bun.sleep(600);
      const ticksWhileHung = ticks;
      expect(await settle(read, 6000)).toBe('Error reading clipboard: Get-Clipboard did not finish within 1s and was stopped');
      expect(performance.now() - started).toBeLessThan(4000);
      // ~30 were due in those 600 ms; execSync allowed none until it returned.
      // 8 leaves room for a loaded machine.
      expect(ticksWhileHung).toBeGreaterThanOrEqual(8);
    } finally {
      clearInterval(interval);
    }
  }, 15_000);

  test('a write that hangs is stopped at the bound', async () => {
    expect(await settle(setClipboardTool.execute({ content: 'x' }), 6000))
      .toBe('Error writing clipboard: clip.exe did not finish within 1s and was stopped');
  }, 15_000);
});

/**
 * The X clipboard path, in a child whose PATH holds only fake xclip and xsel:
 * an env-less spawn resolves against the PATH the process started with, so
 * an in-process PATH swap would not reach it.
 */
describe.skipIf(process.platform !== 'linux')('X clipboard fallback and its bound (#894)', () => {
  const BUILTIN_TS = new URL('./builtin.ts', import.meta.url).href;
  const WSL_TS = new URL('../terminal/wsl-bridge.ts', import.meta.url).href;
  const CAPTURE_TS = new URL('../app-control/capture-file.ts', import.meta.url).href;

  async function readIn(binDir: string, write?: string): Promise<string> {
    const code = `
      import { WSLBridge } from ${JSON.stringify(WSL_TS)};
      import { __setCaptureTimeoutForTests } from ${JSON.stringify(CAPTURE_TS)};
      WSLBridge.isWSL = () => false;
      __setCaptureTimeoutForTests(500);
      const { getClipboardTool, setClipboardTool } = await import(${JSON.stringify(BUILTIN_TS)});
      const write = ${JSON.stringify(write ?? null)};
      console.log('RESULT:' + JSON.stringify(write === null ? await getClipboardTool.execute({}) : await setClipboardTool.execute({ content: write })));
      process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, '--eval', code], {
      env: { PATH: binDir, HOME: binDir }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      .finally(() => clearTimeout(killer));
    const line = out.split('\n').find((l) => l.startsWith('RESULT:'));
    if (!line) throw new Error(`no result from the child:\n${out}\n${err}`);
    return JSON.parse(line.slice('RESULT:'.length)) as string;
  }

  function bin(xclip: string): string {
    const d = mkdtempSync(join(root, 'xbin-'));
    fake(join(d, 'xclip'), xclip);
    fake(join(d, 'xsel'), `: > '${d}/xsel.ran'\nprintf 'from xsel'`);
    return d;
  }

  test('an xclip that fails falls back to xsel, as before', async () => {
    const d = bin("echo 'Error: target STRING not available' >&2; exit 1");
    expect(await readIn(d)).toBe('from xsel');
  }, 40_000);

  test('an xclip that hangs is stopped at the bound, and xsel, which waits on the same owner, is not tried', async () => {
    const d = bin(`exec '${SLEEP}' 10`);
    expect(await readIn(d)).toBe('Error reading clipboard: xclip did not finish within 0.5s and was stopped');
    expect(existsSync(join(d, 'xsel.ran'))).toBe(false);
  }, 40_000);

  test('writing: an xclip that hangs is stopped and xsel is not tried; one that fails falls back', async () => {
    const hung = bin(`exec '${SLEEP}' 10`);
    expect(await readIn(hung, 'x')).toBe('Error writing clipboard: xclip did not finish within 0.5s and was stopped');
    expect(existsSync(join(hung, 'xsel.ran'))).toBe(false);
    const failing = bin('exit 1');
    expect(await readIn(failing, 'x')).toBe('Clipboard updated.');
    expect(existsSync(join(failing, 'xsel.ran'))).toBe(true);
  }, 40_000);

  test('writing: xclip leaving a child that owns the selection, and holds stderr, still returns at once', async () => {
    // What real xclip does (#893 review): it forks a child that stays to
    // serve the selection, and exits. Only the exit is awaited on success.
    const d = bin(`cat > /dev/null; ('${SLEEP}' 6 >&2) & exit 0`);
    const started = performance.now();
    expect(await readIn(d, 'x')).toBe('Clipboard updated.');
    expect(performance.now() - started).toBeLessThan(2500);
  }, 40_000);
});
