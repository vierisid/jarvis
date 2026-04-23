/**
 * Shared daemon lifecycle helpers used by `jarvis update` and
 * `jarvis uninstall`. Both need the same SIGTERM → poll → SIGKILL dance,
 * and both need to release the lockfile afterward.
 */

import { isLocked, releaseLock } from '../daemon/pid.ts';

export interface StopOptions {
  /** How long to wait for graceful exit before SIGKILL. Default 5s. */
  timeoutMs?: number;
  /** Poll interval for checking liveness. Default 500ms. */
  pollIntervalMs?: number;
  /** Invoked once when SIGTERM is sent. */
  onStart?: (pid: number) => void;
  /** Invoked when graceful shutdown times out and SIGKILL is sent. */
  onForce?: (pid: number) => void;
}

export interface StopResult {
  /** True if there was a running daemon when the call started. */
  wasRunning: boolean;
  /** The PID of the daemon we stopped, if any. */
  pid: number | null;
  /** True if the daemon exited via SIGTERM; false if we had to SIGKILL. */
  graceful: boolean;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the running daemon, if any. Sends SIGTERM, polls for exit, escalates
 * to SIGKILL on timeout. Releases the lockfile on return regardless of path
 * (the daemon normally releases it on SIGTERM, but we double-tap in case of
 * a crashed daemon that never cleared its lock).
 */
export async function stopDaemonGracefully(options: StopOptions = {}): Promise<StopResult> {
  const pid = isLocked();
  if (!pid) {
    return { wasRunning: false, pid: null, graceful: true };
  }

  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const attempts = Math.max(1, Math.floor(timeoutMs / pollIntervalMs));

  options.onStart?.(pid);

  let graceful = true;

  try {
    process.kill(pid, 'SIGTERM');

    let alive = true;
    for (let i = 0; i < attempts; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      if (!isAlive(pid)) {
        alive = false;
        break;
      }
    }

    if (alive) {
      graceful = false;
      options.onForce?.(pid);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone between our last check and the kill attempt.
      }
    }
  } catch {
    // SIGTERM failed — process was likely already dead. Fall through to
    // releaseLock() so a stale lockfile doesn't block the next start.
  }

  releaseLock();
  return { wasRunning: true, pid, graceful };
}
