/**
 * The founder's page has to outlive its own credential.
 *
 * ── The bug this file exists to make impossible ──
 *
 * The dashboard authenticates its data plane with a sidecar ACCESS token in an
 * HttpOnly cookie, and that token lives ten minutes. The /ws socket is
 * authenticated once, at upgrade, and then lives as long as the socket does.
 * For a panel someone opens, uses and closes, those two facts never meet.
 *
 * The trial is the first surface that keeps ONE page open for an hour on
 * purpose. Eleven minutes in, the conversation is still perfect: Jarvis talks,
 * the pebble flies, the memory ticker fills, the proposal card resolves, the
 * clock counts down. All of it is WebSocket. Meanwhile every room underneath
 * has gone blind, because every fetch it makes comes back 401, and the room
 * hooks only assign state `if (resp.ok)` and clear their error either way. So
 * the founder says yes, the objective and three key results really are written
 * to their vault, the room really is opened and really is told to re-fetch,
 * and their screen does not change by one pixel. They conclude it failed. It
 * did not. That is worse than failing loudly, because Jarvis told the truth
 * and they had every reason to think it was lying (D22).
 *
 * So while the conductor is live, the layer renews the page's credential from
 * inside the TTL. `src/trial/session-renew.test.ts` holds the cadence below
 * against the real token lifetime so the two cannot drift apart again.
 */

/**
 * How often the trial's page renews its own credential.
 *
 * Four minutes against a ten-minute token: two renewals can fail outright,
 * silently, and the third still lands with time to spare. That headroom is the
 * point. A cadence anywhere near the TTL would put the founder back in the
 * failure this file exists to prevent, on nothing worse than a slow request.
 */
export const TRIAL_SESSION_RENEW_MS = 4 * 60 * 1000;

/**
 * Ask the daemon for a fresh cookie. Resolves to whether the page is still
 * authenticated.
 *
 * The cookie is HttpOnly, so the browser cannot read it and this is the only
 * way the page can find out. A refusal is a real answer, not an exception: the
 * caller says so on screen rather than letting the rooms quietly stop moving.
 */
export async function renewTrialSession(): Promise<boolean> {
  try {
    const r = await fetch("/api/trial/session/renew", { method: "POST" });
    return r.ok;
  } catch {
    // Offline, or the daemon is restarting. Either way the page is not
    // renewed, and the caller treats that as the founder needing to know.
    return false;
  }
}
