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
/** What awaitCaptureTool needs of a spawned tool: Bun.spawn with stderr piped. */
type CaptureProcess = { readonly exited: Promise<number>; readonly exitCode: number | null; readonly signalCode: string | null; readonly stderr: ReadableStream<Uint8Array>; kill(signal?: NodeJS.Signals | number): void };

/**
 * How long a capture tool may run before it is stopped (#802). The tools used
 * to run with no bound at all, and a capture tool hangs exactly when the
 * display server does -- a wedged X server, a WindowServer that never
 * answers -- which is when nothing else will end it either.
 *
 * Measured, on a 3440x1440 display: scrot 112-217 ms (median 113, n=30);
 * the win32 PowerShell one-liner 331-343 ms warm and 1.5 s cold (n=10, run
 * through WSL interop, which adds to it). 30 s is twenty times the slowest
 * of those, and the bound desktop.ps1's own capture-screen already runs
 * under (native-exec.ts), so the two Windows capture paths agree. The capture
 * is awaited rather than run synchronously, so the bound costs only the
 * one call that hit it, never the daemon's event loop.
 */
export const CAPTURE_TIMEOUT_MS = 30_000;
let captureTimeoutMs = CAPTURE_TIMEOUT_MS;

/** @internal Test only: shorten the bound (null restores it). */
export function __setCaptureTimeoutForTests(ms: number | null): void {
  captureTimeoutMs = ms ?? CAPTURE_TIMEOUT_MS;
}

/** A capture tool that ran past CAPTURE_TIMEOUT_MS and was killed. */
export class CaptureTimeoutError extends Error {}

/**
 * Wait for a capture tool the caller just spawned (stdout ignored, stderr
 * piped), and throw if it fails. Past the bound it is killed with SIGKILL,
 * not SIGTERM: a tool that ignores SIGTERM outlived a SIGTERM timeout
 * indefinitely when this was measured (Bun 1.3.8), and a hung tool is not
 * one to trust to exit politely.
 *
 * Takes the process rather than spawning it, so each spawn stays at its own
 * call site, where src/spawn-env-guard.test.ts can see what it runs.
 *
 * `extraMs` lengthens the bound for one call whose own work grows with its
 * input, past what any capture takes: `xdotool type` (#895) spends a measured
 * 12.8 ms per character, so a flat bound would stop a long text part-typed.
 */
export async function awaitCaptureTool(proc: CaptureProcess, what: string, extraMs = 0): Promise<void> {
  await settleCaptureTool(proc, what, null, extraMs);
}

/**
 * The same, for a tool whose stdout is the answer (stdout piped): the window
 * lookups xdotool and xprop run before a window capture, and hang on a wedged
 * X server exactly as the capture would (#802 review).
 */
export async function awaitCaptureToolOutput(proc: CaptureProcess & { readonly stdout: ReadableStream<Uint8Array> }, what: string): Promise<string> {
  return settleCaptureTool(proc, what, proc.stdout, 0);
}

/** How long a killed tool gets to be reaped before it is given up on regardless. */
const KILL_GRACE_MS = 1000;

async function settleCaptureTool(proc: CaptureProcess, what: string, stdoutStream: ReadableStream<Uint8Array> | null, extraMs: number): Promise<string> {
  const bound = captureTimeoutMs + extraMs;
  let timedOut = false;
  let killed!: () => void;
  const wasKilled = new Promise<void>((resolve) => { killed = resolve; });
  const timer = setTimeout(() => {
    // A tool that exited (or crashed) just as the bound passed is not a timeout.
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    timedOut = true;
    try { proc.kill('SIGKILL'); } catch {}
    killed();
  }, bound);
  // Both read alongside the run, so a chatty tool cannot fill a pipe and
  // stall. On success stderr is left unread: nothing needs it.
  const stderr = new Response(proc.stderr).text().catch(() => '');
  const stdout = stdoutStream ? new Response(stdoutStream).text().catch(() => '') : Promise.resolve('');
  let code: number | null = null;
  try {
    // Past the kill, only a short grace: a process in uninterruptible sleep
    // (a hung driver call, a dead network mount) is not reaped by SIGKILL
    // until the kernel lets go, and the caller must not wait for that.
    code = await Promise.race([proc.exited, wasKilled.then(() => Bun.sleep(KILL_GRACE_MS)).then(() => null)]);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) throw new CaptureTimeoutError(`${what} did not finish within ${bound / 1000}s and was stopped`);
  // Bounded: a descendant still holding a pipe must not hold this too.
  const drained = <T>(p: Promise<T>, fallback: T): Promise<T> => Promise.race([p, Bun.sleep(250).then(() => fallback)]);
  if (code !== 0) {
    const text = (await drained(stderr, '')).trim();
    throw new Error(`${what} exited with code ${code}${text ? `: ${text.slice(0, 500)}` : ''}`);
  }
  // Not a fallback for stdout: a missing answer must not read as an empty one.
  const out = await drained<string | null>(stdout, null);
  if (out === null) throw new CaptureTimeoutError(`${what} exited but its output never closed`);
  return out;
}

function captureDir(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-capture-'));
  return { dir, file: join(dir, 'capture.png') };
}

/**
 * Run `write(path)` with a fresh private path, and return what it wrote
 * there. (The synchronous twin went with the synchronous native seam, #893.)
 */
export async function captureViaPrivateFileAsync(write: (path: string) => Promise<unknown>): Promise<Buffer> {
  const { dir, file } = captureDir();
  try {
    await write(file);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
