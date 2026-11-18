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
  test("Q-05: a revoked grant is handed out to no one, and reconnecting changes its identity", async () => {
    const state: FakeAuthState = { authed: true, freshAccessToken: "fresh", tokens: { access_token: "fresh", refresh_token: "grant-one" } };
    let revoked: string | null = null;
    const auth = { ...(makeFakeAuth(state) as object), reconnectRequired: () => revoked } as unknown as GoogleAuth;
    const src = new JarvisGoogleConnectionSource(auth);
    const first = src.identity(JARVIS_GOOGLE_PREFIX);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toContain("grant-one");
    state.tokens!.refresh_token = "grant-two";
    expect(src.identity(JARVIS_GOOGLE_PREFIX)).not.toBe(first);
    revoked = "Google revoked access";
    expect(src.identity(JARVIS_GOOGLE_PREFIX)).toBeNull();
    expect(await src.resolve(JARVIS_GOOGLE_PREFIX)).toBeNull();
  });

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
    // The long-lived grant stays in the daemon; the engine asks again per step.
    expect(value.refresh_token).toBe("");
    expect(JSON.stringify(resolved)).not.toContain("rt-abc");
    expect(value.token_type).toBe("Bearer");
  });

  test("keeps token_type and hands out no refresh_token when expiry_date is missing", async () => {
    const state: FakeAuthState = {
      authed: true,
      freshAccessToken: "live",
      tokens: { access_token: "live", refresh_token: "rt" },
    };
    const src = new JarvisGoogleConnectionSource(makeFakeAuth(state));
    const resolved = await src.resolve(JARVIS_GOOGLE_PREFIX);
    const value = resolved?.value as { refresh_token?: string; token_type?: string; expiry_date?: number };
    // token_type defaults to "Bearer" per the source's normalization.
    expect(value.token_type).toBe("Bearer");
    expect(value.refresh_token).toBe("");
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

describe("#957: sending with Jarvis's Google connection", () => {
  const { managedConnectionMisuse } = require("./adapter") as typeof import("./adapter");
  const GMAIL = "@activepieces/piece-gmail";
  const auth = () => makeFakeAuth({ authed: true, freshAccessToken: "tok", tokens: { access_token: "tok", refresh_token: "grant" } });
  const step = (actionName: string) => ({ pieceName: GMAIL, actionName, input: { auth: "{{connections.jarvis:google}}" } });

  test("a read-only connection refuses every Gmail send, before it runs, and nothing else", () => {
    const src = new JarvisGoogleConnectionSource(auth());
    for (const action of ["send_email", "reply_to_email", "gmail_reply_to_thread", "gmail_forward_message", "gmail_send_draft", "request_approval_in_mail"]) {
      expect(managedConnectionMisuse(src, GMAIL, "settings.input.auth", step(action))).toMatch(/connected read-only/);
    }
    expect(managedConnectionMisuse(src, GMAIL, "settings.input.auth", step("gmail_search_mail"))).toBeNull();
    expect(managedConnectionMisuse(src, GMAIL, "settings.input.auth", step("gmail_create_draft"))).toBeNull();
    expect(src.actionRefusal("@activepieces/piece-google-calendar", "send_email")).toBeNull();
  });

  test("a connection allowed to send lets the send through to its approval card; the state is read live", () => {
    let canSend = true;
    const src = new JarvisGoogleConnectionSource(auth(), () => canSend ? { canSend: true } : { canSend: false, reason: "not_enabled_hosted" });
    expect(managedConnectionMisuse(src, GMAIL, "settings.input.auth", step("send_email"))).toBeNull();
    canSend = false;
    expect(managedConnectionMisuse(src, GMAIL, "settings.input.auth", step("send_email"))).toMatch(/not turned on for this instance/);
  });

  test("the card's account and replied-to subject are read with the grant, the account once per grant", async () => {
    const state: FakeAuthState = { authed: true, freshAccessToken: "tok", tokens: { access_token: "tok", refresh_token: "grant-one" } };
    const src = new JarvisGoogleConnectionSource(makeFakeAuth(state));
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      urls.push(url);
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      if (url.endsWith("/users/me/profile")) return Response.json({ emailAddress: "owner@example.test" });
      return Response.json({ payload: { headers: [{ name: "From", value: "x" }, { name: "Subject", value: "Q3 invoice" }] } });
    }) as unknown as typeof fetch;
    expect(await src.accountLabel(fetchImpl)).toBe("owner@example.test");
    expect(await src.accountLabel(fetchImpl)).toBe("owner@example.test");
    expect(urls.filter((u) => u.endsWith("/profile"))).toHaveLength(1);
    state.tokens!.refresh_token = "grant-two";
    await src.accountLabel(fetchImpl);
    expect(urls.filter((u) => u.endsWith("/profile"))).toHaveLength(2);
    expect(await src.messageSubject("18c0ffee", fetchImpl)).toBe("Q3 invoice");
    expect(await src.messageSubject("../users/x", fetchImpl)).toBeNull();
    const failing = (async () => { throw new Error("token tok leaked"); }) as unknown as typeof fetch;
    expect(await src.messageSubject("18c0ffee", failing)).toBeNull();
  });
});
