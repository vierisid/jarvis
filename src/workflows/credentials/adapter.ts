/**
 * Credential adapter (Phase 2 step 15).
 *
 * Pieces ask the engine for credentials by `connectionId`/`externalId`. This
 * resolver decides where to fetch them from:
 *
 *   1. If the externalId starts with `jarvis:`, dispatch to a registered
 *      `JarvisConnectionSource` that pulls live from Jarvis' existing stores
 *      (Google OAuth file, Telegram/Discord bot token in config, etc.). This
 *      means a user who already wired Gmail into Jarvis sees a "Jarvis Gmail"
 *      connection in the workflow builder without re-authenticating.
 *
 *   2. Otherwise, fall back to the `app_connection` repository -- the
 *      activepieces-native flow where the user adds a new connection per
 *      piece via OAuth/secret entry.
 *
 * The adapter does not import Jarvis modules directly; sources are injected so
 * this file stays testable in isolation. The wiring (which Source for what
 * config/store) lives in the daemon bootstrap.
 */

import type { AppConnectionType } from "../db/repos/app-connection";
import { getConnectionByExternalId } from "../db/repos/app-connection";

/** Prefix that marks a connection as "managed by Jarvis itself". */
export const JARVIS_PREFIX = "jarvis:";

/** Resolved connection value handed to the piece at execution time. */
export interface ResolvedConnection {
  type: AppConnectionType;
  value: Record<string, unknown>;
}

/**
 * A source of Jarvis-managed credentials. One per backing store (Google file,
 * channel config, etc.). Sources only handle externalIds with the JARVIS_PREFIX.
 */
export interface JarvisConnectionSource {
  /** Lower-cased externalId suffix this source claims, e.g. "google", "telegram". */
  readonly id: string;
  /** True if this source can resolve `externalId`. */
  canResolve(externalId: string): boolean;
  /**
   * Resolve to a connection value. Returns null if the source is configured
   * but the credential is not available (e.g. not yet authenticated). Throws
   * if the source itself errors (network failure refreshing token, etc.).
   */
  resolve(externalId: string): Promise<ResolvedConnection | null>;
}

export interface ResolveInput {
  projectId: string;
  pieceName: string;
  externalId: string;
}

/** Composite resolver: Jarvis sources first, then the workflow DB. */
export class CredentialResolver {
  private sources: JarvisConnectionSource[] = [];

  register(source: JarvisConnectionSource): void {
    this.sources.push(source);
  }

  unregister(id: string): void {
    this.sources = this.sources.filter((s) => s.id !== id);
  }

  list(): readonly JarvisConnectionSource[] {
    return this.sources;
  }

  async resolve(input: ResolveInput): Promise<ResolvedConnection | null> {
    if (input.externalId.startsWith(JARVIS_PREFIX)) {
      for (const source of this.sources) {
        if (source.canResolve(input.externalId)) {
          return source.resolve(input.externalId);
        }
      }
      return null;
    }
    const conn = getConnectionByExternalId(input.projectId, input.pieceName, input.externalId);
    if (!conn) return null;
    return { type: conn.type, value: conn.value };
  }
}

// ---------- Built-in Jarvis sources ----------

/** Snapshot of a live Google token. `expiryDate` is epoch ms (matches GoogleAuth.tokens.expiry_date). */
export interface JarvisGoogleTokenSnapshot {
  accessToken: string;
  expiryDate: number;
}

/**
 * Google OAuth source. Reads the live access token (with expiry) from Jarvis'
 * GoogleAuth, which handles refresh internally. Returns an OAUTH2-shaped value
 * compatible with activepieces' OAuth2 connection type.
 *
 * Accepts externalIds: jarvis:google, jarvis:gmail, jarvis:google-calendar,
 * jarvis:google-drive. All map to the same underlying token because the
 * Jarvis Google integration uses one OAuth client across services.
 *
 * Important contract: `refresh_token` is intentionally empty in the resolved
 * value. Jarvis owns the refresh token and refreshes proactively before
 * handing out an access token. If we surfaced the refresh token, pieces could
 * try to refresh independently and race with Jarvis. The empty value signals
 * to the engine that this token is non-refreshable from its side -- when it
 * expires, the piece must call us back for a fresh one.
 */
export class JarvisGoogleSource implements JarvisConnectionSource {
  readonly id = "google";
  static readonly EXTERNAL_IDS = new Set([
    `${JARVIS_PREFIX}google`,
    `${JARVIS_PREFIX}gmail`,
    `${JARVIS_PREFIX}google-calendar`,
    `${JARVIS_PREFIX}google-drive`,
  ]);

  constructor(
    private readonly getToken: () => Promise<JarvisGoogleTokenSnapshot | null>,
    private readonly nowMs: () => number = Date.now,
  ) {}

  canResolve(externalId: string): boolean {
    return JarvisGoogleSource.EXTERNAL_IDS.has(externalId);
  }

  async resolve(_externalId: string): Promise<ResolvedConnection | null> {
    const snap = await this.getToken();
    if (!snap) return null;
    const nowMs = this.nowMs();
    const nowSec = Math.floor(nowMs / 1000);
    const expiresIn = Math.max(0, Math.floor((snap.expiryDate - nowMs) / 1000));
    return {
      type: "OAUTH2",
      value: {
        access_token: snap.accessToken,
        token_type: "Bearer",
        refresh_token: "",
        expires_in: expiresIn,
        claimed_at: nowSec,
        scope: "",
        token_url: "https://oauth2.googleapis.com/token",
        client_id: "",
        data: {},
      },
    };
  }
}

/** Telegram bot token source -- reads the bot token from Jarvis' channel config. */
export class JarvisTelegramSource implements JarvisConnectionSource {
  readonly id = "telegram";
  static readonly EXTERNAL_ID = `${JARVIS_PREFIX}telegram`;

  constructor(private readonly getBotToken: () => string | null) {}

  canResolve(externalId: string): boolean {
    return externalId === JarvisTelegramSource.EXTERNAL_ID;
  }

  async resolve(_externalId: string): Promise<ResolvedConnection | null> {
    const token = this.getBotToken();
    if (!token) return null;
    return { type: "SECRET_TEXT", value: { secret_text: token } };
  }
}

/** Discord bot token source -- mirrors Telegram. */
export class JarvisDiscordSource implements JarvisConnectionSource {
  readonly id = "discord";
  static readonly EXTERNAL_ID = `${JARVIS_PREFIX}discord`;

  constructor(private readonly getBotToken: () => string | null) {}

  canResolve(externalId: string): boolean {
    return externalId === JarvisDiscordSource.EXTERNAL_ID;
  }

  async resolve(_externalId: string): Promise<ResolvedConnection | null> {
    const token = this.getBotToken();
    if (!token) return null;
    return { type: "SECRET_TEXT", value: { secret_text: token } };
  }
}
