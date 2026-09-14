/**
 * First-run state for the sidecar's ambient UI.
 *
 * The very first time a sidecar ever connects to a brain, the only thing the
 * user sees is the pebble — which reads as "nothing happened". The brain opens
 * the dashboard once alongside it so the product introduces itself.
 *
 * "First time ever" is scoped to the BRAIN, not the machine: the flag lives in
 * the brain's settings table, so re-issuing an enrollment token or installing
 * the sidecar on a second PC is not a first run. That is deliberately different
 * from the sidecar-local "Open dashboard at startup" preference, which fires on
 * every launch of one machine's sidecar.
 */

import { getSetting, setSetting } from '../vault/settings.ts';

/** Settings key holding "the first-run dashboard has been shown on this brain". */
export const DASHBOARD_INTRO_KEY = 'sidecar.dashboard_intro_shown';

/** Settings key counting attempts to show it, successful or not. */
export const DASHBOARD_INTRO_ATTEMPTS_KEY = 'sidecar.dashboard_intro_attempts';

/** Attempts (one per connect) before the brain stops trying to show the intro. */
export const MAX_DASHBOARD_INTRO_ATTEMPTS = 3;

// Set while one attempt is between begin and finish, so two sidecars connecting
// at once cannot both open it. In memory on purpose: a daemon that dies
// mid-attempt must not leave it set, and the attempt it already counted keeps
// retries bounded anyway.
let introInFlight = false;

/**
 * Starts an attempt to show the first-run dashboard. Returns false, reserving
 * nothing, when it has already been shown on this brain, when every attempt is
 * used up, or while another attempt is in flight.
 *
 * The intro is marked shown only once the spawn succeeds (finishDashboardIntro).
 * It used to be claimed before the spawn, so any spawn that failed burned it for
 * good: the Linux sidecar crashing as the window opened, a Windows webview that
 * never got created. The attempt is counted here, before the spawn, so a sidecar
 * that can never open a window (a headless box with the capability) costs a few
 * connects rather than one failed spawn on every connect forever.
 *
 * Synchronous with no `await`, so Bun's single-threaded loop cannot interleave
 * two begins.
 */
export function beginDashboardIntro(): boolean {
  if (introInFlight) return false;
  if (getSetting(DASHBOARD_INTRO_KEY) !== null) return false;
  const attempts = Number.parseInt(getSetting(DASHBOARD_INTRO_ATTEMPTS_KEY) ?? '0', 10) || 0;
  if (attempts >= MAX_DASHBOARD_INTRO_ATTEMPTS) return false;
  setSetting(DASHBOARD_INTRO_ATTEMPTS_KEY, String(attempts + 1));
  introInFlight = true;
  return true;
}

/**
 * Ends the attempt begun by beginDashboardIntro. `shown` is true when the
 * dashboard is up on the sidecar, whether this spawn opened it or it was
 * already open; only then is the intro marked shown for good.
 */
export function finishDashboardIntro(shown: boolean): void {
  introInFlight = false;
  if (shown) setSetting(DASHBOARD_INTRO_KEY, '1');
}

/** How the first-run dashboard's `panel.spawn` RPC settled. */
export type DashboardSpawnSettled = { ok: true; result: unknown } | { ok: false; error: unknown };

/**
 * - opened: the sidecar created the window.
 * - already-open: the 'tray:chat' id was taken (the user clicked the tray, or
 *   the sidecar's own open-at-startup preference got there first). The sidecar
 *   waits for a same-id window still being created and reports one that failed
 *   as a failure, so this is a dashboard that is up.
 * - detached: no answer within the RPC's initial timeout (30s). The sidecar
 *   answers within about 25s (up to 10s minting the panel's token, at most 5s
 *   waiting out a same-id window, then at most 10s waiting on its own), so a
 *   spawn still running past that most likely opened late; retrying would open
 *   the dashboard a second time.
 * - failed: anything else. The brain tries again on a later connect.
 */
export type DashboardSpawnOutcome = 'opened' | 'already-open' | 'detached' | 'failed';

/** Classifies a settled first-run dashboard spawn. Only 'failed' is not shown. */
export function dashboardSpawnOutcome(settled: DashboardSpawnSettled): DashboardSpawnOutcome {
  if (!settled.ok) {
    const msg = settled.error instanceof Error ? settled.error.message : String(settled.error);
    return msg.includes('panel already exists') ? 'already-open' : 'failed';
  }
  return settled.result === 'detached' ? 'detached' : 'opened';
}
