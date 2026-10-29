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

  /**
   * Accepts either a `GoogleAuth` instance or a getter. The daemon passes a
   * getter reading its live `googleAuth` binding so settings hot reload
   * (connecting Google mid-run, rotating the OAuth client) is picked up
   * without re-registering the source; a bare instance is kept for tests
   * and simple embedders.
   */
  constructor(auth: GoogleAuth | (() => GoogleAuth | null)) {
    this.getAuth = typeof auth === "function" ? auth : () => auth;
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
