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
  /**
   * True when the daemon is confirmed gone (or there was none). False means it
   * survived both signals — e.g. `kill` raised EPERM because the daemon belongs
   * to another user. Callers that go on to modify the data dir must not treat a
   * false here as "stopped".
   */
  stopped: boolean;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process EXISTS but isn't ours to signal (a daemon running
    // as another user). Only ESRCH means "no such process". Treating EPERM as
    // dead is what would let the caller clear a live daemon's lockfile.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Poll until `pid` is gone, or the budget runs out. */
async function waitForExit(pid: number, timeoutMs: number, pollIntervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
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
      // SIGKILL returns before the kernel has finished tearing the process
      // down, and a killed-but-unreaped zombie still answers kill(pid, 0).
      // Without this wait the liveness check below loses that race, reports
      // the daemon as alive, and leaves a stale lockfile blocking the next
      // start — the exact case the unconditional release used to cover.
      await waitForExit(pid, 2000);
    }
  } catch {
    // SIGTERM failed. Usually the process was already dead (ESRCH), but it can
    // also mean we're not allowed to signal it (EPERM — a daemon owned by
    // another user). The liveness check below tells the two apart.
  }

  // Only clear the lockfile once the holder is confirmed gone. releaseLock()
  // unlinks the path unconditionally, so calling it while the daemon is still
  // alive deletes a LIVE holder's lock — after which isLocked() reports nothing
  // and a second daemon can start against the same data dir. The stale-lock
  // case this double-tap exists for is unaffected: a dead holder still gets its
  // lockfile cleared.
  const stopped = !isAlive(pid);
  if (stopped) releaseLock();

  return { wasRunning: true, pid, graceful, stopped };
}
