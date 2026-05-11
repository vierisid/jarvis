/**
 * Coverage for `JarvisGoogleConnectionSource`. The refresh-token dance
 * itself lives in `GoogleAuth.refreshAccessToken` (and is hit through
 * `getAccessToken` when the token's within 5min of expiry); this file's
 * scope is the source's contract: it MUST call `getAccessToken` (not
 * `getTokens().access_token` directly), so an expired token triggers a
 * refresh on every piece-side credential resolution.
 *
 * Regression target: a previous iteration of this source read
 * `this.googleAuth.getTokens()?.access_token` directly, which served stale
 * tokens to pieces. The current implementation calls `getAccessToken()`
 * first, which auto-refreshes; this test asserts that contract.
 */

import { describe, expect, test } from "bun:test";
import { JarvisGoogleConnectionSource, JARVIS_GOOGLE_PREFIX } from "./google-source";
import type { GoogleAuth } from "../../integrations/google-auth";

interface FakeAuthState {
  authed: boolean;
  /** What getAccessToken() returns -- can be different from getTokens().access_token to model post-refresh state. */
  freshAccessToken: string;
  /** The cached token blob seen by getTokens() -- updated by the test to simulate refresh. */
  tokens: {
    access_token: string;
    refresh_token: string;
    token_type?: string;
    expiry_date?: number;
  } | null;
}

function makeFakeAuth(state: FakeAuthState): GoogleAuth {
  // The source only calls these three methods on GoogleAuth. Cast through
  // unknown so the test doesn't have to mock the full surface.
  const stub = {
    isAuthenticated: () => state.authed,
    async getAccessToken() {
      if (!state.authed) throw new Error("not authed");
      // Simulate the refresh flow updating the cached token to match the
      // fresh value -- real `getAccessToken` does this internally before
      // returning when the cached one is within 5min of expiry.
      if (state.tokens) state.tokens.access_token = state.freshAccessToken;
      return state.freshAccessToken;
    },
    getTokens: () => (state.tokens ? { ...state.tokens } : null),
  };
  return stub as unknown as GoogleAuth;
}

describe("JarvisGoogleConnectionSource", () => {
  test("returns null when GoogleAuth is unauthenticated", async () => {
    const auth = makeFakeAuth({
      authed: false,
      freshAccessToken: "x",
      tokens: null,
    });
    const src = new JarvisGoogleConnectionSource(auth);
    expect(await src.resolve(JARVIS_GOOGLE_PREFIX)).toBeNull();
  });

  test("canResolve matches jarvis:google + jarvis:google:<sub>", () => {
    const src = new JarvisGoogleConnectionSource(makeFakeAuth({ authed: false, freshAccessToken: "x", tokens: null }));
    expect(src.canResolve("jarvis:google")).toBe(true);
    expect(src.canResolve("jarvis:google:gmail")).toBe(true);
    expect(src.canResolve("jarvis:telegram")).toBe(false);
  });

  test("calls getAccessToken so an expired cache surfaces the refreshed token", async () => {
    // Cached token is "stale-token"; the (simulated) refresh returns "new-token".
    // The source must surface the refreshed value, not the stale cached one.
    const state: FakeAuthState = {
      authed: true,
      freshAccessToken: "new-token-after-refresh",
      tokens: {
        access_token: "stale-token",
        refresh_token: "rt-abc",
        token_type: "Bearer",
        expiry_date: Date.now() - 1, // expired
      },
    };
    const src = new JarvisGoogleConnectionSource(makeFakeAuth(state));
    const resolved = await src.resolve(JARVIS_GOOGLE_PREFIX);
    expect(resolved?.type).toBe("OAUTH2");
    const value = resolved?.value as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expiry_date?: number;
    };
    // CRITICAL: the source called getAccessToken (which would have
    // refreshed) instead of reading the cached access_token directly.
    expect(value.access_token).toBe("new-token-after-refresh");
    expect(value.refresh_token).toBe("rt-abc");
    expect(value.token_type).toBe("Bearer");
  });

  test("surfaces refresh_token + token_type even when expiry_date is missing", async () => {
    const state: FakeAuthState = {
      authed: true,
      freshAccessToken: "live",
      tokens: { access_token: "live", refresh_token: "rt" },
    };
    const src = new JarvisGoogleConnectionSource(makeFakeAuth(state));
    const resolved = await src.resolve(JARVIS_GOOGLE_PREFIX);
    const value = resolved?.value as { token_type?: string; expiry_date?: number };
    // token_type defaults to "Bearer" per the source's normalization.
    expect(value.token_type).toBe("Bearer");
    expect(value.expiry_date).toBeUndefined();
  });

  test("handles getTokens returning null (refresh succeeded but cache wasn't repopulated)", async () => {
    // Defensive: if for some reason getTokens() yields null but
    // getAccessToken returned a value, we still surface the access token
    // (refresh_token falls back to "").
    const state: FakeAuthState = {
      authed: true,
      freshAccessToken: "only-access-token",
      tokens: null,
    };
    const src = new JarvisGoogleConnectionSource(makeFakeAuth(state));
    const resolved = await src.resolve(JARVIS_GOOGLE_PREFIX);
    const value = resolved?.value as { access_token: string; refresh_token: string };
    expect(value.access_token).toBe("only-access-token");
    expect(value.refresh_token).toBe("");
  });
});
