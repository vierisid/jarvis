import { describe, expect, test } from "bun:test";
import { oauth2RowLabel, pastedOAuth2Warning } from "./connection-oauth";

const FULL = { access_token: "a", expires_in: 3599, refresh_token: "r", client_id: "c", client_secret: "s", token_url: "https://t.example/token" };
const NOW = Date.UTC(2026, 9, 21, 12);

describe("#954 pasted OAuth2 labels", () => {
  test("a value with everything a refresh needs gets no warning", () => {
    expect(pastedOAuth2Warning("OAUTH2", FULL)).toBeNull();
    expect(pastedOAuth2Warning("SECRET_TEXT", {})).toBeNull();
    // The daemon parses the URL, so an upper-case scheme is https too.
    expect(pastedOAuth2Warning("OAUTH2", { ...FULL, token_url: "HTTPS://t.example/token" })).toBeNull();
  });

  test("an access token alone says it will not be refreshed, and what is missing", () => {
    expect(pastedOAuth2Warning("OAUTH2", { access_token: "a" })).toBe(
      "Jarvis will not refresh this token (no refresh_token, client_id, client_secret, token_url). "
      + "It stops working when it expires; paste a new one then.");
    expect(pastedOAuth2Warning("CLOUD_OAUTH2", { ...FULL, token_url: "http://t.example/token" })).toContain("an https token_url");
    // The daemon refreshes only the authorization_code grant.
    expect(pastedOAuth2Warning("OAUTH2", { ...FULL, grant_type: "client_credentials" })).toContain("only the authorization_code grant");
  });

  test("a value with refresh details but no expires_in is refreshed on first use, so it gets no warning", () => {
    expect(pastedOAuth2Warning("OAUTH2", { ...FULL, expires_in: undefined })).toBeNull();
  });

  test("a saved row says whether Jarvis refreshes it and whether it has expired", () => {
    expect(oauth2RowLabel({ type: "OAUTH2", oauth2: { expiresAt: NOW + 1, refreshable: true } }, NOW)).toMatchObject({ tone: "ok", label: "Refreshed by Jarvis" });
    expect(oauth2RowLabel({ type: "OAUTH2", oauth2: { expiresAt: NOW - 1, refreshable: false } }, NOW)).toMatchObject({ tone: "warn", label: "Expired" });
    expect(oauth2RowLabel({ type: "OAUTH2", oauth2: { expiresAt: NOW + 60_000, refreshable: false } }, NOW)!.label).toMatch(/^Not refreshed; expires /);
    expect(oauth2RowLabel({ type: "OAUTH2", oauth2: { expiresAt: null, refreshable: false } }, NOW)).toMatchObject({ tone: "warn", label: "Not refreshed" });
    expect(oauth2RowLabel({ type: "SECRET_TEXT" }, NOW)).toBeNull();
  });
});
