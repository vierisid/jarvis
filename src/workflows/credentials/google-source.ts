/**
 * `JarvisGoogleConnectionSource` -- bridges Jarvis's existing Google OAuth
 * file (`~/.jarvis/google-tokens.json`) into the workflow runtime's
 * `CredentialResolver`. When a piece asks for `jarvis:google` (or any
 * `jarvis:google:*` sub-id), the source returns the live access token
 * (refreshed on demand by `GoogleAuth.getAccessToken`) so users who already
 * authenticated Jarvis with Google see a "Jarvis Google" connection in the
 * workflow piece picker without re-authenticating per piece.
 *
 * The piece sees an `OAUTH2`-shaped value:
 *   { access_token, refresh_token: "", token_type, expiry_date? }
 *
 * The refresh token never leaves the daemon, as the engine's credential route
 * states. The engine asks for the connection at every step and gets an access
 * token refreshed here, so a piece has nothing to refresh, and a long-lived
 * grant to the whole Google account never reaches sandboxed piece code. Inside
 * the daemon it still identifies the grant (`identity`, Q-05).
 */

import type { GoogleAuth } from "../../integrations/google-auth";
import type {
  JarvisConnectionSource,
  ManagedPieceDetails,
  ResolvedConnection,
} from "./adapter";
import { credentialFingerprint } from "./adapter";
import { googleSendRefusal, type GoogleSendState } from "../../integrations/google-scopes";
import { GOVERNED_PIECE_ADAPTERS } from "../runtime/piece-effects";

const GMAIL_PIECE = "@activepieces/piece-gmail";
/** Gmail actions that send mail, as the governed adapter categorises them: they need gmail.send. */
const GMAIL_SEND_ACTIONS: ReadonlySet<string> = new Set(
  GOVERNED_PIECE_ADAPTERS.find((adapter) => adapter.pieceName === GMAIL_PIECE)?.categories.send_email ?? [],
);

export const JARVIS_GOOGLE_PREFIX = "jarvis:google";

/** The Google pieces that use Jarvis's own Google grant. */
export const JARVIS_GOOGLE_PIECES: readonly string[] = [
  "@activepieces/piece-gmail",
  "@activepieces/piece-google-calendar",
  "@activepieces/piece-google-drive",
  "@activepieces/piece-google-sheets",
];

/**
 * Names and API hosts of those pieces. The hosts are each piece's custom API
 * call base URL in the installed piece bundles (gmail.googleapis.com/gmail/v1,
 * www.googleapis.com/calendar/v3 and /drive/v3, sheets.googleapis.com/v4).
 */
export const JARVIS_GOOGLE_PIECE_DETAILS: Readonly<Record<string, ManagedPieceDetails>> = {
  "@activepieces/piece-gmail": { displayName: "Gmail", apiHosts: ["gmail.googleapis.com"] },
  "@activepieces/piece-google-calendar": { displayName: "Google Calendar", apiHosts: ["www.googleapis.com"] },
  "@activepieces/piece-google-drive": { displayName: "Google Drive", apiHosts: ["www.googleapis.com"] },
  "@activepieces/piece-google-sheets": { displayName: "Google Sheets", apiHosts: ["sheets.googleapis.com"] },
};

export class JarvisGoogleConnectionSource implements JarvisConnectionSource {
  readonly id = "google";
  readonly pieceNames = JARVIS_GOOGLE_PIECES;
  readonly pieceDetails = JARVIS_GOOGLE_PIECE_DETAILS;

  private readonly getAuth: () => GoogleAuth | null;
  private readonly sendState: () => GoogleSendState;

  /**
   * Accepts either a `GoogleAuth` instance or a getter. The daemon passes a
   * getter reading its live `googleAuth` binding so settings hot reload
   * (connecting Google mid-run, rotating the OAuth client) is picked up
   * without re-registering the source; a bare instance is kept for tests
   * and simple embedders.
   */
  constructor(
    auth: GoogleAuth | (() => GoogleAuth | null),
    /**
     * #957: whether the connection may send mail now. Defaults to read-only,
     * so an embedder that does not say gets the shipped default.
     */
    sendState: () => GoogleSendState = () => ({ canSend: false, reason: "not_granted" }),
  ) {
    this.getAuth = typeof auth === "function" ? auth : () => auth;
    this.sendState = sendState;
  }

  /** The account's address, by grant: reconnecting (perhaps to another account) asks again. */
  private account: { grant: string; email: string } | null = null;

  /**
   * #957: the connected account's address, for an email send's card, or null
   * when it cannot be read just now. gmail.readonly reads the profile, so no
   * scope is added for it.
   */
  async accountLabel(fetchImpl: typeof fetch = fetch): Promise<string | null> {
    const grant = this.identity(JARVIS_GOOGLE_PREFIX);
    if (!grant) return null;
    if (this.account?.grant === grant) return this.account.email;
    const profile = await this.gmailGet("users/me/profile", fetchImpl) as { emailAddress?: unknown } | null;
    const email = profile?.emailAddress;
    if (typeof email !== "string" || email.length > 320 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/u.test(email)) return null;
    this.account = { grant, email };
    return email;
  }

  /**
   * #957: the subject of the message a reply or forward answers, for its
   * card, or null when it cannot be read.
   */
  async messageSubject(id: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) return null;
    const data = await this.gmailGet(`users/me/messages/${id}?format=metadata&metadataHeaders=Subject`, fetchImpl) as
      { payload?: { headers?: unknown } } | null;
    const headers = data?.payload?.headers;
    if (!Array.isArray(headers)) return null;
    for (const header of headers) {
      if (header && typeof header === "object" && typeof header.name === "string" && header.name.toLowerCase() === "subject"
        && typeof header.value === "string") return header.value.slice(0, 1000);
    }
    return null;
  }

  /** One read of the Gmail API with this grant; null on any failure. Errors never leave it (they can carry tokens). */
  private async gmailGet(path: string, fetchImpl: typeof fetch): Promise<unknown> {
    try {
      const resolved = await this.resolve(JARVIS_GOOGLE_PREFIX);
      const token = resolved?.value.access_token;
      if (typeof token !== "string" || !token) return null;
      const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/${path}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000), redirect: "error",
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  /** A Gmail send needs the gmail.send grant (and, hosted, the system config's leave). */
  actionRefusal(pieceName: string, actionName: string): string | null {
    if (pieceName !== GMAIL_PIECE || !GMAIL_SEND_ACTIONS.has(actionName)) return null;
    return googleSendRefusal(this.sendState());
  }

  canResolve(externalId: string): boolean {
    return externalId === JARVIS_GOOGLE_PREFIX || externalId.startsWith(`${JARVIS_GOOGLE_PREFIX}:`);
  }

  /**
   * The grant this source would hand out: a fingerprint of the refresh token,
   * so reconnecting Google (possibly to another account) changes it. Null while
   * not connected or while Google has revoked the grant.
   */
  identity(_externalId: string): string | null {
    const auth = this.getAuth();
    if (!auth || !auth.isAuthenticated() || auth.reconnectRequired?.()) return null;
    const token = auth.getTokens()?.refresh_token;
    return token ? credentialFingerprint(token) : null;
  }

  async resolve(_externalId: string): Promise<ResolvedConnection | null> {
    const auth = this.getAuth();
    // A revoked grant is not a credential to hand out, even while its last
    // access token has not expired yet.
    if (!auth || !auth.isAuthenticated() || auth.reconnectRequired?.()) {
      // Not configured or not yet authenticated -- piece will see
      // "connection not found". Surface as null (vs throw) so other
      // sources / repo lookups can still run.
      return null;
    }
    // Trigger refresh-if-expired before reading the snapshot so the
    // returned access_token + expiry_date are consistent.
    const accessToken = await auth.getAccessToken();
    const tokens = auth.getTokens();
    return {
      type: "OAUTH2",
      value: {
        access_token: accessToken,
        refresh_token: "",
        token_type: tokens?.token_type ?? "Bearer",
        ...(tokens?.expiry_date ? { expiry_date: tokens.expiry_date } : {}),
      },
    };
  }
}
