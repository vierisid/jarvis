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
