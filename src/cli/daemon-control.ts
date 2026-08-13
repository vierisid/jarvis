/**
 * Shared daemon lifecycle helpers used by `jarvis update` and
 * `jarvis uninstall`. Both need the same SIGTERM → poll → SIGKILL dance,
 * and both need to release the lockfile afterward.
 */

import { isLocked, releaseLockIfUnheld, isProcessAlive, waitForProcessExit } from '../daemon/pid.ts';

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
  /**
   * True when NO daemon holds the lock any more. False means one still does —
   * either the daemon survived both signals (`kill` raised EPERM because it
   * belongs to another user) or a service manager already relaunched it under a
   * new pid. Callers that go on to modify the data dir must not treat a false
   * here as "stopped".
   */
  stopped: boolean;
}

/**
 * Stop the running daemon, if any. Sends SIGTERM, polls for exit, escalates
 * to SIGKILL on timeout. Clears the lockfile once the holder is confirmed gone
 * — including for a crashed daemon that never cleared its own lock — but
 * leaves it in place if the daemon survived, since releaseLock() would
 * otherwise unlink a live holder's lock. See `StopResult.stopped`.
 */
export async function stopDaemonGracefully(options: StopOptions = {}): Promise<StopResult> {
  const pid = isLocked();
  if (!pid) {
    return { wasRunning: false, pid: null, graceful: true, stopped: true };
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
      if (!isProcessAlive(pid)) {
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
      // SIGKILL returns before the kernel has finished tearing the process
      // down, and a killed-but-unreaped zombie still answers kill(pid, 0).
      // Without this wait the liveness check below loses that race, reports
      // the daemon as alive, and leaves a stale lockfile blocking the next
      // start — the exact case the unconditional release used to cover.
      await waitForProcessExit(pid, 2000);
    }
  } catch {
    // SIGTERM failed. Usually the process was already dead (ESRCH), but it can
    // also mean we're not allowed to signal it (EPERM — a daemon owned by
    // another user). The liveness check below tells the two apart.
  }

  // Ask the LOCK, not the pid we signalled — and let the release itself make
  // that decision atomically. `isLocked() === null` was still wrong twice over:
  // it reports "free" for a lock whose pid is momentarily unreadable, and it
  // leaves a window between the check and the unlink for a supervisor-spawned
  // replacement to acquire. See releaseLockIfUnheld.
  const stopped = releaseLockIfUnheld();

  // A daemon that outlived both signals did not exit gracefully — it did not
  // exit at all. Without this, an EPERM stop short-circuits to the catch above
  // with `graceful` still at its initial true, reporting a clean shutdown that
  // never happened.
  return { wasRunning: true, pid, graceful: graceful && stopped, stopped };
}
