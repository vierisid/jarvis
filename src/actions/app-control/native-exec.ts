import { spawnSync } from 'node:child_process';
import { modelExecEnv } from '../../util/model-exec-env.ts';

/**
 * Minimal synchronous exec used by the Windows/macOS fallback controllers.
 * Injectable so tests can capture the exact command lines and payloads
 * without spawning real processes.
 */
export type NativeExecResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type NativeExec = (cmd: string[], input: string) => NativeExecResult;

/**
 * How long one fallback script or tool may run (screencapture, osascript,
 * desktop.ps1), killed with SIGKILL past it (#802). The 30 s was always
 * here, but with spawnSync's default SIGTERM it did not bound everything:
 * a child that ignores SIGTERM ran on past it indefinitely, holding the
 * daemon's thread the whole time (measured, Bun 1.3.8, with a 500 ms
 * timeout: SIGTERM never returned; SIGKILL returned at 501 ms). On Windows
 * the signal is moot, the process is terminated either way.
 *
 * This is still synchronous, so a call that hits it holds the event loop for
 * the full 30 s; making the seam async is a larger change than the bound.
 */
export const NATIVE_EXEC_TIMEOUT_MS = 30_000;
let nativeExecTimeoutMs = NATIVE_EXEC_TIMEOUT_MS;

/** @internal Test only: shorten the bound (null restores it). */
export function __setNativeExecTimeoutForTests(ms: number | null): void {
  nativeExecTimeoutMs = ms ?? NATIVE_EXEC_TIMEOUT_MS;
}

export const defaultExec: NativeExec = (cmd, input) => {
  const [file, ...args] = cmd;
  const result = spawnSync(file!, args, {
    encoding: 'utf-8',
    // Always pipe stdin (empty string closes it) so scripts reading
    // [Console]::In never hang waiting for input.
    input,
    timeout: nativeExecTimeoutMs,
    killSignal: 'SIGKILL',
    // Base64 screenshots can be several MB.
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    // The desktop session without the daemon's secrets (#514). This seam runs
    // the Windows `launch-app` script, whose Start-Process hands its env to a
    // model-chosen executable, and macOS `open -a <model app>` (LaunchServices
    // gives the app launchd's env, but `open` itself gets this one). The
    // other scripts only need the session. See util/model-exec-env.ts.
    env: modelExecEnv(),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
};

/**
 * Run a command and return stdout, throwing on spawn failure or non-zero
 * exit. Fallback scripts report errors on stderr with a non-zero exit code —
 * they must surface as thrown errors, never as silent no-ops, because the
 * agent plans its next step based on action outcomes.
 */
export function runNative(exec: NativeExec, cmd: string[], input: string, what: string): string {
  const result = exec(cmd, input);
  if (result.error) {
    // A timeout comes back as an ETIMEDOUT error (Bun 1.3.8), not a status,
    // and is not a failure to start.
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`${what} did not finish within ${nativeExecTimeoutMs / 1000}s and was stopped`);
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
