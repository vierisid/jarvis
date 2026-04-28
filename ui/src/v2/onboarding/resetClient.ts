/**
 * Onboarding reset client (Phase A — reset gate).
 *
 * Single shared helper for firing `POST /api/onboarding/reset`,
 * clearing the localStorage caches the daemon tells us to clear, then
 * reloading the page so the OnboardingGate (when it lands) re-evaluates
 * its initial state cleanly.
 *
 * Three call sites all funnel through here:
 *   1. URL query trigger     — `?onboarding=reset[&scope=...]`
 *   2. Settings → General    — debug section dropdown
 *   3. Voice room action     — "replay onboarding" / "reset onboarding"
 *
 * See `docs/ONBOARDING_PLAN.md` § "Test reset (developer flag)" for the
 * gate semantics.
 */

export type OnboardingResetScope = "all" | "setup" | "profile" | "tutorial";

export interface OnboardingResetResponse {
  ok: boolean;
  scope: OnboardingResetScope;
  cleared: string[];
  client_cache_keys: string[];
  message: string;
}

/**
 * Fire the reset, clear the caches the daemon names, and (by default)
 * reload the page. Pass `reload: false` if the caller wants to chain
 * additional UI work first (e.g. show a toast then navigate manually).
 */
export async function resetOnboarding(
  scope: OnboardingResetScope = "all",
  opts: { reload?: boolean } = {},
): Promise<OnboardingResetResponse> {
  const reload = opts.reload ?? true;

  const resp = await fetch("/api/onboarding/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => `HTTP ${resp.status}`);
    throw new Error(`Onboarding reset failed: ${text}`);
  }
  const data = (await resp.json()) as OnboardingResetResponse;

  // Wipe the client-side caches the daemon told us about. These survive
  // a config reset on their own (they're in localStorage, not
  // ~/.jarvis/), so we have to clear them explicitly to truly reproduce
  // a fresh-install experience.
  if (typeof window !== "undefined") {
    for (const key of data.client_cache_keys ?? []) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* quota / SecurityError — best-effort */
      }
    }
  }

  // Phase E — broadcast to peer tabs so any other open dashboard tab
  // immediately re-fetches its onboarding status and exits the live
  // shell back to the appropriate phase. Best-effort: if BroadcastChannel
  // isn't available (older Safari), peers stay until their next refresh.
  if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    try {
      const ch = new BroadcastChannel("v2-onboarding-status");
      ch.postMessage({ type: "reset", scope });
      ch.close();
    } catch {
      /* best-effort; the local reload below still fires */
    }
  }

  if (reload && typeof window !== "undefined") {
    // Strip any ?onboarding=... params so the next mount doesn't
    // re-fire the URL trigger after we reload.
    const url = new URL(window.location.href);
    url.searchParams.delete("onboarding");
    url.searchParams.delete("scope");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    window.location.reload();
  }

  return data;
}

/**
 * Mount-time URL trigger. Reads `?onboarding=reset[&scope=...]`, fires
 * the reset, and reloads. No-op if the param is absent. Safe to call
 * unconditionally inside an effect — handles its own SSR guard.
 */
export async function maybeRunUrlReset(): Promise<void> {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const trigger = params.get("onboarding");
  if (trigger !== "reset") return;
  const scopeRaw = params.get("scope");
  const scope: OnboardingResetScope =
    scopeRaw === "setup" ||
    scopeRaw === "profile" ||
    scopeRaw === "tutorial" ||
    scopeRaw === "all"
      ? scopeRaw
      : "all";
  try {
    await resetOnboarding(scope);
  } catch (err) {
    console.error("[Onboarding] URL reset failed:", err);
    // Even on failure, strip the param so we don't loop on every reload.
    const url = new URL(window.location.href);
    url.searchParams.delete("onboarding");
    url.searchParams.delete("scope");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
}
