/**
 * #954: what the Connections panel says about a pasted OAuth2 connection.
 *
 * Jarvis refreshes a pasted OAuth2 token only when the value carries what a
 * refresh needs (refresh_token, client_id, client_secret, an https token_url)
 * (refreshing before the stated expiry, or on first use when none is stated).
 * Anything less is an access token that stops working when it expires, and
 * the panel says so instead of implying otherwise.
 */
import type { AppConnectionType, ConnectionMeta } from "./useConnections";

const OAUTH2_TYPES: ReadonlySet<AppConnectionType> = new Set(["OAUTH2", "PLATFORM_OAUTH2", "CLOUD_OAUTH2"]);

export function isOAuth2Type(type: AppConnectionType): boolean {
  return OAUTH2_TYPES.has(type);
}

/** The value placeholder for an OAuth2 connection: the fields a refresh needs, in upstream's stored shape. */
export const OAUTH2_VALUE_PLACEHOLDER =
  '{"access_token": "...", "expires_in": 3599, "refresh_token": "...", "client_id": "...", "client_secret": "...", "token_url": "https://..."}';

export const OAUTH2_VALUE_HELP =
  "Jarvis refreshes this token only when the value includes refresh_token, client_id, client_secret and an https token_url; "
  + "with expires_in it refreshes shortly before expiry, without it on first use. "
  + "With an access token alone, the connection stops working when that token expires (about an hour for Google and Microsoft), "
  + "and steps using it fail until you paste a new one.";

const text = (value: unknown): boolean => typeof value === "string" && value.length > 0;
/** Parsed as the daemon parses it, so HTTPS:// counts as https. */
const isHttps = (url: string): boolean => { try { return new URL(url).protocol === "https:"; } catch { return false; } };

/**
 * A warning for a value about to be saved, or null when Jarvis will refresh
 * it. Mirrors the daemon's rule (credentials/pasted-oauth2.ts); the daemon's
 * own answer, shown on the saved row, is the one that counts.
 */
export function pastedOAuth2Warning(type: AppConnectionType, value: Record<string, unknown>): string | null {
  if (!isOAuth2Type(type)) return null;
  if (value.grant_type !== undefined && value.grant_type !== "authorization_code") {
    return `Jarvis refreshes only the authorization_code grant, not ${String(value.grant_type)}. This token stops working when it expires; paste a new one then.`;
  }
  const missing = ["refresh_token", "client_id", "client_secret", "token_url"].filter((key) => !text(value[key]));
  if (text(value.token_url) && !isHttps(String(value.token_url))) missing.push("an https token_url");
  if (!missing.length) return null;
  return `Jarvis will not refresh this token (no ${missing.join(", ")}). It stops working when it expires; paste a new one then.`;
}

/** The chip a saved OAuth2 row shows: whether Jarvis refreshes it, and when its token expires. */
export function oauth2RowLabel(connection: Pick<ConnectionMeta, "type" | "oauth2">, now: number = Date.now()):
  { tone: "ok" | "warn"; label: string; title: string } | null {
  if (!isOAuth2Type(connection.type) || !connection.oauth2) return null;
  const { expiresAt, refreshable } = connection.oauth2;
  const when = expiresAt === null ? null : new Date(expiresAt).toLocaleString();
  if (refreshable) {
    return { tone: "ok", label: "Refreshed by Jarvis", title: `Jarvis refreshes this token before it expires${when ? ` (now ${when})` : ""}.` };
  }
  if (expiresAt === null) {
    return { tone: "warn", label: "Not refreshed", title: "No refresh details and no expiry were saved: Jarvis cannot refresh this token, and steps fail once it expires." };
  }
  if (expiresAt <= now) {
    return { tone: "warn", label: "Expired", title: `This token expired ${when} and Jarvis cannot refresh it. Paste a new token, or add the refresh details.` };
  }
  return { tone: "warn", label: `Not refreshed; expires ${when}`, title: "Jarvis cannot refresh this token: add refresh_token, client_id, client_secret and an https token_url." };
}
