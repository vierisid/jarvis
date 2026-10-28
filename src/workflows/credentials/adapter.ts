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

import { createHash } from "node:crypto";
import type { AppConnectionStatus, AppConnectionType } from "../db/repos/app-connection";
import { getConnectionByExternalId, getUniqueConnectionByExternalId } from "../db/repos/app-connection";
import type { EgressPolicy } from "../runtime/http-egress";
import { guardedTokenTransport, PastedOAuth2Refresher, type TokenTransport } from "./pasted-oauth2";

/** Prefix that marks a connection as "managed by Jarvis itself". */
export const JARVIS_PREFIX = "jarvis:";

/** Resolved connection value handed to the piece at execution time. */
export interface ResolvedConnection {
  type: AppConnectionType;
  value: Record<string, unknown>;
  /** Native identity/status; managed sources may omit these. */
  pieceName?: string;
  status?: AppConnectionStatus;
  /** Set only for a row of the `app_connection` table: which row, so `fresh` can refresh it. */
  stored?: { id: string; projectId: string; externalId: string; generation: number };
}

/**
 * A source of Jarvis-managed credentials. One per backing store (Google file,
 * channel config, etc.). Sources only handle externalIds with the JARVIS_PREFIX.
 */
export interface JarvisConnectionSource {
  /** Lower-cased externalId suffix this source claims, e.g. "google", "telegram". */
  readonly id: string;
  /**
   * The pieces whose steps may use this source's credential, by full piece
   * name. Only a step of one of these pieces may name the connection, and only
   * as its `auth`: readiness refuses any other reference, and so does the
   * engine's credential route for the run's own graph. Without this a CODE or
   * HTTP step could read the token and use it outside the governed pieces.
   */
  readonly pieceNames: readonly string[];
  /**
   * What people call each of `pieceNames` (readiness messages name the piece
   * that way), and the hosts its own API lives on. A custom API call step of
   * one of these pieces sends the credential to the URL it is given, so with
   * this source's connection it may only reach these hosts. A piece without
   * hosts here may use a custom API call only with a path under its base URL.
   */
  readonly pieceDetails?: Readonly<Record<string, ManagedPieceDetails>>;
  /** True if this source can resolve `externalId`. */
  canResolve(externalId: string): boolean;
  /**
   * Resolve to a connection value. Returns null if the source is configured
   * but the credential is not available (e.g. not yet authenticated). Throws
   * if the source itself errors (network failure refreshing token, etc.).
   */
  resolve(externalId: string): Promise<ResolvedConnection | null>;
  /**
   * Q-05: a fingerprint of the credential this source would hand out for
   * `externalId` right now, or null when it would hand out none (not
   * connected, revoked, reconnect required). Synchronous and secret-free, so
   * readiness can compare it with the identity a workflow was enabled against.
   * A source without it is one fixed identity.
   */
  identity?(externalId: string): string | null;
}

export interface ManagedPieceDetails {
  /** When present, only these qualified actions may use this managed grant. Triggers are refused. */
  actions?: readonly string[];
  displayName: string;
  /** Host names (with a port only when not the default) its custom API call may reach. */
  apiHosts: readonly string[];
}

/** The registered source that owns a `jarvis:` external id, if any. */
export function managedSourceFor(sources: readonly JarvisConnectionSource[] | undefined, externalId: string): JarvisConnectionSource | undefined {
  return sources?.find(candidate => candidate.canResolve(externalId));
}

/** "A, B or C" from display names, falling back to the piece name. */
function pieceList(source: JarvisConnectionSource): string {
  const names = source.pieceNames.map(name => source.pieceDetails?.[name]?.displayName ?? name);
  if (names.length <= 1) return names[0] ?? 'no';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether a custom API call URL can only reach `hosts`. The vendored action
 * (pieces-common createCustomApiCallAction) sends a value that starts with
 * `http://` or `https://` as it is and joins anything else under the piece's
 * base URL, so a path is always safe. A templated URL is judged by its text
 * before the first `{{`: it must already fix an https host from the list, or
 * already rule out that the evaluated value starts with `http://`/`https://`.
 */
export function customApiUrlStaysOnHosts(url: string, hosts: readonly string[]): boolean {
  const cut = url.indexOf('{{');
  const literal = cut < 0 ? url : url.slice(0, cut);
  if (/^https?:\/\//.test(literal)) {
    // With an expression, the host must end before it does.
    const authority = cut < 0 ? url : /^https:\/\/[^/?#\\]*[/?#\\]/.exec(literal)?.[0];
    if (!authority || !authority.startsWith('https://')) return false;
    try { return hosts.includes(new URL(authority).host); } catch { return false; }
  }
  return cut < 0 || !('http://'.startsWith(literal) || 'https://'.startsWith(literal));
}

/**
 * Why a step may not name a managed connection, or null when it may: it must
 * be a step of one of the source's pieces, naming it as that step's `auth`,
 * and a custom API call step must stay on the piece's own API hosts.
 * `settings` is the step's settings, when the caller has them.
 */
export function managedConnectionMisuse(source: JarvisConnectionSource, pieceName: string, path: string, settings?: unknown): string | null {
  if (!source.pieceNames.includes(pieceName)) {
    return `Managed connection jarvis:${source.id} can only be used by ${pieceList(source)} steps`;
  }
  if (path !== 'settings.input.auth') return `Managed connection jarvis:${source.id} can only be a step's auth`;
  // Judged only with the step's settings: a caller without them (prepared
  // qualification) is told about the piece alone, and readiness and the run's
  // scope check, which always pass them, refuse any other action or a trigger.
  // A trigger step is refused by its triggerName whatever actionName it also
  // carries: the trigger hook runs the piece's own trigger code, not the
  // fixed-endpoint dispatch the allowed actions go through.
  const allowed = source.pieceDetails?.[pieceName]?.actions;
  if (allowed && settings !== undefined && (!record(settings) || settings.triggerName !== undefined || typeof settings.actionName !== 'string' || !allowed.includes(settings.actionName))) return `This ${source.pieceDetails?.[pieceName]?.displayName ?? pieceName} connection does not support this action or trigger yet`;
  if (record(settings) && settings.actionName === 'custom_api_call') {
    const details = source.pieceDetails?.[pieceName];
    const hosts = details?.apiHosts ?? [];
    const url = record(settings.input) && record(settings.input.url) ? settings.input.url.url : undefined;
    if (typeof url !== 'string' || !customApiUrlStaysOnHosts(url, hosts)) {
      return `A custom API call with managed connection jarvis:${source.id} must use a path under the ${details?.displayName ?? pieceName} API`
        + (hosts.length ? ` or an https URL on ${hosts.join(', ')}` : '');
    }
  }
  return null;
}

/** A credential fingerprint for binding pins: never the credential itself. */
export function credentialFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 32);
}

export interface ResolveInput {
  projectId: string;
  /** Omitted by the normal engine request: require a unique project match. */
  pieceName?: string;
  externalId: string;
}

export interface CredentialResolverOptions {
  /**
   * Where a pasted OAuth2 row's token refresh may connect (#954, #961). The
   * daemon passes the install's policy; anything else gets the hosted rule.
   */
  egressPolicy?: EgressPolicy;
  /** Test seam: the token POST itself. */
  tokenTransport?: TokenTransport;
  /** Test seam: the clock the refresher reads. */
  now?: () => number;
}

/** Composite resolver: Jarvis sources first, then the workflow DB. */
export class CredentialResolver {
  private sources: JarvisConnectionSource[] = [];
  private readonly oauth2: PastedOAuth2Refresher;

  constructor(opts: CredentialResolverOptions = {}) {
    this.oauth2 = new PastedOAuth2Refresher(opts.tokenTransport ?? guardedTokenTransport(opts.egressPolicy ?? "public-only"),
      opts.now ? { now: opts.now } : {});
  }

  register(source: JarvisConnectionSource): void {
    this.sources.push(source);
  }

  unregister(id: string): void {
    this.sources = this.sources.filter((s) => s.id !== id);
  }

  list(): readonly JarvisConnectionSource[] {
    return this.sources;
  }

  /**
   * Returns null when nothing owns `externalId`. Throws `AmbiguousConnectionError`
   * when a piece-less lookup finds more than one row for the id in the project:
   * an uncertain identity must fail the step, not pick a credential. Callers
   * map it to a distinct status (the engine endpoint answers 409).
   */
  async resolve(input: ResolveInput): Promise<ResolvedConnection | null> {
    if (input.externalId.startsWith(JARVIS_PREFIX)) {
      for (const source of this.sources) {
        if (source.canResolve(input.externalId)) {
          return source.resolve(input.externalId);
        }
      }
      return null;
    }
    const conn = input.pieceName === undefined
      ? getUniqueConnectionByExternalId(input.projectId, input.externalId)
      : getConnectionByExternalId(input.projectId, input.pieceName, input.externalId);
    if (!conn) return null;
    return { type: conn.type, value: conn.value, pieceName: conn.pieceName, status: conn.status,
      stored: { id: conn.id, projectId: conn.projectId, externalId: conn.externalId, generation: conn.credentialGeneration } };
  }

  /**
   * The credential to hand out for what `resolve` found: a stored OAuth2 row
   * whose token is about to expire is refreshed first (#954). Call it only
   * after the run's binding check passed, so a connection a run may not use is
   * never refreshed on its behalf. Throws `ConnectionCredentialError` when the
   * token has expired and no fresh one could be had. A Jarvis-managed
   * connection is returned unchanged: its own source refreshes it.
   */
  async fresh(resolved: ResolvedConnection): Promise<ResolvedConnection> {
    if (!resolved.stored) return resolved;
    const value = await this.oauth2.fresh({ ...resolved.stored, type: resolved.type, value: resolved.value });
    return value === resolved.value ? resolved : { ...resolved, value };
  }
}

// Live Jarvis credential sources -- one per backing store -- live in their
// own files (`google-source.ts`, `telegram-source.ts`). They're constructed
// during daemon bootstrap and registered on this resolver. Keep new sources
// in their own file too rather than growing this one.
