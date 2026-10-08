import { modelExecEnv } from '../../util/model-exec-env.ts';

/**
 * Minimal exec used by the Windows/macOS fallback controllers. Injectable so
 * tests can capture the exact command lines and payloads without spawning
 * real processes.
 */
export type NativeExecResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

/**
 * Asynchronous (#893). It was spawnSync, so a script that hit the bound below
 * held the daemon's event loop for the whole 30 s -- every WS client, every
 * channel and every other agent stalled behind one hung osascript or
 * desktop.ps1, not just the caller.
 */
export type NativeExec = (cmd: string[], input: string) => Promise<NativeExecResult>;

/**
 * How long one fallback script or tool may run (screencapture, osascript,
 * desktop.ps1), killed with SIGKILL past it (#802): a child that ignores
 * SIGTERM outlived a SIGTERM timeout indefinitely when that was measured (Bun
 * 1.3.8, 500 ms bound: SIGTERM never returned, SIGKILL at 501 ms). On Windows
 * the signal is moot, the process is terminated either way. The 30 s is #892's
 * figure: about twenty times the slowest capture measured (the win32
 * PowerShell one-liner, 1.5 s cold), and capture-file.ts's CAPTURE_TIMEOUT_MS.
 *
 * Since #893 the wait is awaited, so hitting the bound costs the one call that
 * hit it, never the event loop.
 */
export const NATIVE_EXEC_TIMEOUT_MS = 30_000;
let nativeExecTimeoutMs = NATIVE_EXEC_TIMEOUT_MS;

/** @internal Test only: shorten the bound (null restores it). */
export function __setNativeExecTimeoutForTests(ms: number | null): void {
  nativeExecTimeoutMs = ms ?? NATIVE_EXEC_TIMEOUT_MS;
}

/** Base64 screenshots can be several MB; this is spawnSync's old maxBuffer. */
export const NATIVE_EXEC_MAX_OUTPUT = 64 * 1024 * 1024;
let nativeExecMaxOutput = NATIVE_EXEC_MAX_OUTPUT;

/** @internal Test only: lower the output cap (null restores it). */
export function __setNativeExecMaxOutputForTests(bytes: number | null): void {
  nativeExecMaxOutput = bytes ?? NATIVE_EXEC_MAX_OUTPUT;
}

/** After a SIGKILL, how long the child gets to be reaped before it is given up on. */
const KILL_GRACE_MS = 1000;
/** After exit, how long the pipes get to close (a descendant may hold them). */
const DRAIN_MS = 1000;

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Read a pipe to the end, refusing more than `limit` bytes. What has arrived
 * so far is kept in `chunks`, so a caller that stops waiting can still use it.
 */
async function readCapped(stream: ReadableStream<Uint8Array>, limit: number, onOverflow: () => void, chunks: Uint8Array[] = []): Promise<string> {
  const reader = stream.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        onOverflow();
        throw codedError(`output passed ${limit} bytes`, 'ENOBUFS');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export const defaultExec: NativeExec = async (cmd, input) => {
  let proc: ReturnType<typeof Bun.spawn<Buffer, 'pipe', 'pipe'>>;
  try {
    proc = Bun.spawn(cmd, {
      // Always a stdin (an empty one closes it), so scripts reading
      // [Console]::In never hang waiting for input.
      stdin: Buffer.from(input, 'utf-8'),
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      // The desktop session without the daemon's secrets (#514). This seam
      // runs the Windows `launch-app` script, whose Start-Process hands its env
      // to a model-chosen executable, and macOS `open -a <model app>`
      // (LaunchServices gives the app launchd's env, but `open` itself gets
      // this one). The other scripts only need the session. See
      // util/model-exec-env.ts.
      env: modelExecEnv(),
    });
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error: error instanceof Error ? error : new Error(String(error)) };
  }

  const bound = nativeExecTimeoutMs;
  let failure: Error | undefined;
  const kill = () => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } };
  let stopped!: () => void;
  const wasStopped = new Promise<void>((resolve) => { stopped = resolve; });
  const timer = setTimeout(() => {
    // One that exited just as the bound passed is not a timeout.
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    failure ??= codedError(`did not finish within ${bound / 1000}s`, 'ETIMEDOUT');
    kill();
    stopped();
  }, bound);
  const overflow = () => {
    failure ??= codedError(`output passed ${nativeExecMaxOutput} bytes`, 'ENOBUFS');
    kill();
    stopped();
  };
  // Both read alongside the run, so a chatty script cannot fill a pipe and stall.
  // A stdout that could not be read is no answer, never an empty one.
  const stdout = readCapped(proc.stdout, nativeExecMaxOutput, overflow).catch(() => undefined);
  // stderr keeps what arrived even if a descendant holds the pipe open past
  // the drain (#893 review): the error text is usually written before that.
  const stderrChunks: Uint8Array[] = [];
  const stderr = readCapped(proc.stderr, nativeExecMaxOutput, overflow, stderrChunks).catch(() => null);

  let status: number | null = null;
  try {
    // Past a kill, only a short grace: a process in uninterruptible sleep is
    // not reaped until the kernel lets go, and the caller must not wait for it.
    status = await Promise.race([proc.exited, wasStopped.then(() => Bun.sleep(KILL_GRACE_MS)).then(() => null)]);
  } finally {
    clearTimeout(timer);
  }
  if (failure) return { status: null, stdout: '', stderr: '', error: failure };
  // Killed by a signal (not by the bound): no exit status, as spawnSync
  // reported it, rather than Bun's 128 + signal.
  if (proc.signalCode !== null) status = null;

  const drained = <T>(p: Promise<T>, fallback: T): Promise<T> => Promise.race([p, Bun.sleep(DRAIN_MS).then(() => fallback)]);
  const [out, errRead] = await Promise.all([drained<string | undefined>(stdout, undefined), drained<string | null>(stderr, null)]);
  const err = errRead ?? Buffer.concat(stderrChunks).toString('utf-8');
  if (failure) return { status: null, stdout: '', stderr: '', error: failure };
  // A failed run is reported as its exit and stderr; its stdout is not the
  // answer anyway.
  if (out === undefined && status !== 0) return { status, stdout: '', stderr: err };
  // A missing answer must not read as an empty one. The status rides along:
  // the script may well have done its work.
  if (out === undefined) return { status, stdout: '', stderr: err, error: codedError('its output never closed or could not be read', 'EPIPE') };
  return { status, stdout: out, stderr: err };
};

/**
 * Run a command and return stdout, throwing on spawn failure or non-zero
 * exit. Fallback scripts report errors on stderr with a non-zero exit code —
 * they must surface as thrown errors, never as silent no-ops, because the
 * agent plans its next step based on action outcomes.
 */
export async function runNative(exec: NativeExec, cmd: string[], input: string, what: string): Promise<string> {
  const result = await exec(cmd, input);
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      throw new Error(`${what} did not finish within ${nativeExecTimeoutMs / 1000}s and was stopped`);
    }
    if (code === 'ENOBUFS') {
      throw new Error(`${what} was stopped: ${result.error.message}`);
    }
    if (code === 'EPIPE') {
      // Nothing was stopped: it exited, and whether it did its work is unknown.
      const exited = result.status === null ? 'exited' : `exited with code ${result.status}`;
      throw new Error(`${what} ${exited} but ${result.error.message}`);
    }
    throw new Error(`${what} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const exitInfo = result.status === null ? 'was killed (timeout?)' : `exited with code ${result.status}`;
    throw new Error(`${what} ${exitInfo}${stderr ? `: ${stderr}` : ''}`);
  }
  return result.stdout;
}
