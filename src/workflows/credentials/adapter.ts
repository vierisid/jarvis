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

// Live Jarvis credential sources -- one per backing store -- live in their
// own files (`google-source.ts`, `telegram-source.ts`). They're constructed
// during daemon bootstrap and registered on this resolver. Keep new sources
// in their own file too rather than growing this one.
