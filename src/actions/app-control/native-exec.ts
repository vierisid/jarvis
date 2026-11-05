import { modelExecEnv } from '../../util/model-exec-env.ts';
import { codedError, readCapped } from './read-capped.ts';

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
export type NativeExec = (cmd: string[], input: string, opts?: NativeExecOptions) => Promise<NativeExecResult>;

/**
 * `extraMs` lengthens the bound below for one call whose work grows with its
 * input, past what any script takes: typing a text (#903, typing-allowance.ts).
 */
export type NativeExecOptions = { readonly extraMs?: number };

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

export const defaultExec: NativeExec = async (cmd, input, opts) => {
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

  return settleNativeExec(proc, opts);
};

/** What settleNativeExec needs of a spawned script: Bun.spawn with stdout and stderr piped. */
export type NativeProcess = {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal?: NodeJS.Signals | number): void;
};

/**
 * Wait for a script defaultExec just spawned, under the bound and the output
 * cap. Separate from the spawn so tests can hand it stand-in processes and fix
 * the order of exit, overflow and bound themselves; the spawn stays in
 * defaultExec, where src/spawn-env-guard.test.ts can see it.
 *
 * @internal Exported for tests; callers use defaultExec.
 */
export async function settleNativeExec(proc: NativeProcess, opts?: NativeExecOptions): Promise<NativeExecResult> {
  const bound = nativeExecTimeoutMs + (opts?.extraMs ?? 0);
  let failure: Error | undefined;
  // Whether the cap was passed on stdout, the answer: that is never whole, so
  // it is refused however the script then exits.
  let stdoutOverflowed = false;
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
  const stdout = readCapped(proc.stdout, nativeExecMaxOutput, () => { stdoutOverflowed = true; overflow(); }).catch(() => undefined);
  // stderr keeps what arrived even if a descendant holds the pipe open past
  // the drain (#893 review): the error text is usually written before that.
  // Past the cap it stops a running script; once the script has exited, a
  // leftover child flooding stderr does not turn its exit into a failure
  // (#904 review).
  const stderrChunks: Uint8Array[] = [];
  const stderr = readCapped(proc.stderr, nativeExecMaxOutput, () => {
    if (proc.exitCode === null && proc.signalCode === null) overflow();
  }, stderrChunks).catch(() => null);

  let status: number | null = null;
  try {
    // Past a kill, only a short grace: a process in uninterruptible sleep is
    // not reaped until the kernel lets go, and the caller must not wait for it.
    status = await Promise.race([proc.exited, wasStopped.then(() => Bun.sleep(KILL_GRACE_MS)).then(() => null)]);
  } finally {
    clearTimeout(timer);
  }
  // A stderr flood that came while the script still ran, where the kill did
  // not land and the script then exited by itself (a status, no signal), is
  // reported as that exit, as capture-file.ts reports it (#1159): a script
  // that exited 0 did its work, and calling it stopped would invite a retry
  // that does it twice (a second typing of the same text). stdout is still
  // read to the end below and must be whole.
  const ownExit = status !== null && proc.signalCode === null;
  const floodOnly = (failure as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS' && !stdoutOverflowed && ownExit;
  if (failure && !floodOnly) return { status: null, stdout: '', stderr: '', error: failure };
  // Killed by a signal (not by the bound): no exit status, as spawnSync
  // reported it, rather than Bun's 128 + signal.
  if (proc.signalCode !== null) status = null;

  const drained = <T>(p: Promise<T>, fallback: T): Promise<T> => Promise.race([p, Bun.sleep(DRAIN_MS).then(() => fallback)]);
  const [out, errRead] = await Promise.all([drained<string | undefined>(stdout, undefined), drained<string | null>(stderr, null)]);
  // What arrived before a cap or an unclosed pipe: only its head is decoded
  // (#1159 security review). A flood the run survived can have kept up to the
  // output cap, and the error carries 500 characters of it.
  const err = errRead ?? headText(stderrChunks, STDERR_HEAD_BYTES);
  // The answer can pass the cap while it is drained, after the script exited
  // (overflow() then sets the failure, if a stderr flood had not already).
  if (stdoutOverflowed) return { status: null, stdout: '', stderr: '', error: failure };
  // A failed run is reported as its exit and stderr; its stdout is not the
  // answer anyway.
  if (out === undefined && status !== 0) return { status, stdout: '', stderr: err };
  // A missing answer must not read as an empty one. The status rides along:
  // the script may well have done its work.
  if (out === undefined) return { status, stdout: '', stderr: err, error: codedError('its output never closed or could not be read', 'EPIPE') };
  return { status, stdout: out, stderr: err };
}

/** How much of the stderr kept past a cap or a held pipe is decoded: well past what the error carries. */
const STDERR_HEAD_BYTES = 64 * 1024;

/** The first `limit` bytes of `chunks` as text, without joining the rest. */
function headText(chunks: readonly Uint8Array[], limit: number): string {
  const head: Uint8Array[] = [];
  let size = 0;
  for (const chunk of chunks) {
    if (size >= limit) break;
    const part = chunk.byteLength > limit - size ? chunk.subarray(0, limit - size) : chunk;
    head.push(part);
    size += part.byteLength;
  }
  return Buffer.concat(head).toString('utf-8');
}

/** How much of a failed script's stderr its error carries: capture-file.ts's figure. */
export const NATIVE_EXEC_STDERR_REPORT_CHARS = 500;

/**
 * Run a command and return stdout, throwing on spawn failure or non-zero
 * exit. Fallback scripts report errors on stderr with a non-zero exit code —
 * they must surface as thrown errors, never as silent no-ops, because the
 * agent plans its next step based on action outcomes.
 */
export async function runNative(exec: NativeExec, cmd: string[], input: string, what: string, extraMs = 0): Promise<string> {
  const result = await exec(cmd, input, extraMs ? { extraMs } : undefined);
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      throw new Error(`${what} did not finish within ${(nativeExecTimeoutMs + extraMs) / 1000}s and was stopped`);
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
    // Bounded like capture-file.ts's report (#1159 review): stderr is kept up
    // to the output cap, and a flood the run survived must not land whole in
    // the tool result and the log. The reason is written first.
    const stderr = result.stderr.trim().slice(0, NATIVE_EXEC_STDERR_REPORT_CHARS);
    const exitInfo = result.status === null ? 'was killed (timeout?)' : `exited with code ${result.status}`;
    throw new Error(`${what} ${exitInfo}${stderr ? `: ${stderr}` : ''}`);
  }
  return result.stdout;
}
