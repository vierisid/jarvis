/**
 * Where a local capture tool writes its image before the daemon reads it back
 * (#746).
 *
 * The capture tools (screencapture, import, scrot, PowerShell's
 * System.Drawing) only write to a path, so the image has to go through a file.
 * That path used to be guessable -- `/tmp/jarvis-screen-${Date.now()}.png` and
 * the like -- so a process that could write to the temp directory could
 * pre-create a symlink there (the capture tool, running as the daemon, then
 * writes through it) or plant the file the daemon reads back and hands to its
 * PNG decoder and the model.
 *
 * Now every capture gets its own directory from mkdtemp: a random name,
 * created atomically, mode 0700. Nothing else can predict the path, create
 * anything inside it, or swap the file between the write and the read. The
 * directory is removed whatever happens, including when the tool fails.
 *
 * The 0700 is POSIX's. On Windows the mode is ignored and the directory takes
 * %TEMP%'s ACL, which is per user by default; the random name still keeps
 * anyone from predicting or pre-creating the path.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function captureDir(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-capture-'));
  return { dir, file: join(dir, 'capture.png') };
}

/** Run `write(path)` with a fresh private path, and return what it wrote there. */
export function captureViaPrivateFile(write: (path: string) => void): Buffer {
  const { dir, file } = captureDir();
  try {
    write(file);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The same, for a capture tool that is awaited. */
export async function captureViaPrivateFileAsync(write: (path: string) => Promise<unknown>): Promise<Buffer> {
  const { dir, file } = captureDir();
  try {
    await write(file);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
