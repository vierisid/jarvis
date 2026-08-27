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

/**
 * One-shot claim of the "first sidecar ever connected to this brain" moment.
 * Returns true exactly once per brain, and false forever after.
 *
 * The flag is claimed BEFORE the caller dispatches anything: if the spawn then
 * fails, we do not want an unclaimed flag re-firing the attempt on every single
 * subsequent connect. A one-time intro that occasionally misses is far better
 * than one that retries forever.
 *
 * The read and the write are synchronous with no `await` between them, so two
 * sidecars connecting in the same tick cannot both win the claim on Bun's
 * single-threaded event loop.
 */
export function claimDashboardIntro(): boolean {
  if (getSetting(DASHBOARD_INTRO_KEY) !== null) return false;
  setSetting(DASHBOARD_INTRO_KEY, '1');
  return true;
}
