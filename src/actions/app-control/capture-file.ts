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
import { NATIVE_EXEC_MAX_OUTPUT } from './native-exec.ts';
import { codedError, readCapped } from './read-capped.ts';
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

/**
 * The most a capture or lookup tool may print on either pipe before it is
 * killed (#904). Both pipes were read in full with no cap, and the lookups
 * (xprop, xdotool, wmctrl) and clipboard reads all come through here. This is
 * native-exec.ts's cap, so the two seams that run desktop tools agree. What
 * the lookups print is far below it: measured with xprop 1.2.8 against a
 * window carrying a seven-size _NET_WM_ICON (16 to 256 px), `xprop -id` printed
 * 31 KB (it draws icons up to some size as text and leaves larger ones out),
 * and the three properties linux.ts asks for printed 89 bytes.
 */
export const CAPTURE_MAX_OUTPUT = NATIVE_EXEC_MAX_OUTPUT;
let captureMaxOutput = CAPTURE_MAX_OUTPUT;

/** @internal Test only: lower the output cap (null restores it). */
export function __setCaptureMaxOutputForTests(bytes: number | null): void {
  captureMaxOutput = bytes ?? CAPTURE_MAX_OUTPUT;
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
  // Whichever stopped the tool first, the bound or the cap; the other then
  // leaves it alone, so a late overflow is never reported as a hang.
  let stoppedBy: 'timeout' | 'overflow' | null = null;
  let killed!: () => void;
  const wasKilled = new Promise<void>((resolve) => { killed = resolve; });
  const stop = (why: 'timeout' | 'overflow') => {
    // Only what stopped a running tool: one that had already exited, and a
    // leftover child then flooding a pipe, keeps its own exit as its report.
    if (stoppedBy !== null || proc.exitCode !== null || proc.signalCode !== null) return;
    stoppedBy = why;
    try { proc.kill('SIGKILL'); } catch {}
    killed();
  };
  // A tool that exited (or crashed) just as the bound passed is not a timeout.
  const timer = setTimeout(() => stop('timeout'), bound);
  // Past the cap on either pipe, killed like a hung tool (#904): what it
  // printed is not read any further, and is never returned.
  let stdoutOverflowed = false;
  // Both read alongside the run, so a chatty tool cannot fill a pipe and
  // stall. On success stderr is left unread: nothing needs it.
  // stderr keeps what has arrived (#902): a tool's error is written before it
  // exits, and a descendant still holding the pipe must not cost the reason.
  const stderrChunks: Uint8Array[] = [];
  const stderr = readCapped(proc.stderr, captureMaxOutput, () => stop('overflow'), stderrChunks).catch(() => null);
  // A stdout that could not be read is no answer, never an empty one.
  const stdout = stdoutStream
    ? readCapped(stdoutStream, captureMaxOutput, () => { stdoutOverflowed = true; stop('overflow'); }).catch(() => null)
    : Promise.resolve('');
  let code: number | null = null;
  try {
    // Past the kill, only a short grace: a process in uninterruptible sleep
    // (a hung driver call, a dead network mount) is not reaped by SIGKILL
    // until the kernel lets go, and the caller must not wait for that.
    code = await Promise.race([proc.exited, wasKilled.then(() => Bun.sleep(KILL_GRACE_MS)).then(() => null)]);
  } finally {
    clearTimeout(timer);
  }
  const tooMuch = () => codedError(`${what} was stopped: output passed ${captureMaxOutput} bytes`, 'ENOBUFS');
  if (stoppedBy === 'timeout') throw new CaptureTimeoutError(`${what} did not finish within ${bound / 1000}s and was stopped`);
  // A tool that exited 0 succeeded whatever a descendant still writes to its
  // stderr afterwards; only its answer, stdout, has to be whole. One that
  // exited on its own with a failure (no signal: the kill did not land, it was
  // already on its way out) is reported for that failure, not the flood.
  const ownExit = code !== null && proc.signalCode === null;
  if (stoppedBy === 'overflow' && (stdoutOverflowed || !ownExit)) throw tooMuch();
  // Bounded: a descendant still holding a pipe must not hold this too.
  const drained = <T>(p: Promise<T>, fallback: T): Promise<T> => Promise.race([p, Bun.sleep(250).then(() => fallback)]);
  if (code !== 0) {
    const text = ((await drained<string | null>(stderr, null)) ?? Buffer.concat(stderrChunks).toString('utf-8')).trim();
    throw new Error(`${what} exited with code ${code}${text ? `: ${text.slice(0, 500)}` : ''}`);
  }
  // Not a fallback for stdout: a missing answer must not read as an empty one.
  const out = await drained<string | null>(stdout, null);
  // A tool can print past the cap and exit before the reader gets there.
  if (stdoutOverflowed) throw tooMuch();
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
