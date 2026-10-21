/**
 * #954: OAuth2 connections pasted in Workflows -> Connections.
 *
 * Upstream Activepieces refreshes an OAuth2 connection in its server
 * (`app-connection-service/oauth2`), not in the engine. Jarvis replaced that
 * server with the `app_connection` table and `CredentialResolver` and never
 * carried the refresh over, so a pasted row worked until its access token
 * expired and then failed with the provider's 401.
 *
 * A pasted row is refreshed here, inside the daemon, when it carries what a
 * refresh needs, in upstream's own stored shape:
 *   refresh_token, client_id, client_secret, token_url (https), and an expiry
 *   (`claimed_at` + `expires_in` in seconds, or `expiry_date` in ms).
 * One that does not is handed out as pasted until its expiry is known to have
 * passed; from then on the engine is told the connection expired (the engine's
 * own `ConnectionExpiredError`), and the run records a typed reason (Q-19),
 * rather than the step failing on the provider's 401.
 *
 * Only rows of the `app_connection` table come here. A `jarvis:*` connection
 * (the Google account Jarvis itself holds, refreshed by `GoogleAuth`, through
 * the control plane on hosted) never does: the resolver hands those to their
 * own source before it reads the table.
 *
 * Secrets never leave through here: no log line, no error message and no
 * thrown error carries a token, a client secret or the token endpoint's body.
 */

import { request as httpsRequest } from "node:https";
import type { AppConnectionType } from "../db/repos/app-connection";
import { getConnectionInProject, replaceRefreshedConnectionValue, sameCredential } from "../db/repos/app-connection";
import { EgressRefusedError, egressRefusalIn, guardedLookup, assertHostAllowed, destinationAllowed, type EgressPolicy } from "../runtime/http-egress";

export const OAUTH2_TYPES: ReadonlySet<AppConnectionType> = new Set(["OAUTH2", "PLATFORM_OAUTH2", "CLOUD_OAUTH2"]);

/**
 * Refresh this long before the recorded expiry. Upstream's own threshold at
 * the pinned commit (d04e6807, `oauth2-util.ts` `isExpired`:
 * `refreshThreshold = 15 * 60`), so a step that starts just before expiry
 * still holds a token for its whole run.
 */
export const REFRESH_AHEAD_MS = 15 * 60_000;
/**
 * Lifetime assumed when a token endpoint answers without `expires_in`.
 * Upstream's default at the same commit (`connection.expires_in ?? 60 * 60`).
 */
const DEFAULT_EXPIRES_IN_S = 60 * 60;
/** Upstream's token request timeout at the same commit (`timeout: 20000`). */
const TOKEN_TIMEOUT_MS = 20_000;
/** A token response is a few hundred bytes; refuse anything absurd rather than buffer it. */
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

/** Why a pasted connection could not be handed out. Typed, for the run's record and Q-19. */
export type ConnectionCredentialCode =
  /** The access token expired and Jarvis cannot refresh it, or the provider refused the refresh. */
  | "CONNECTION_EXPIRED"
  /** The token endpoint could not be reached or failed; the token has expired meanwhile. */
  | "CONNECTION_REFRESH_UNREACHABLE"
  /** A person replaced or removed the connection while Jarvis was refreshing it. */
  | "CONNECTION_CHANGED";

export class ConnectionCredentialError extends Error {
  constructor(readonly code: ConnectionCredentialCode, message: string) {
    super(message);
    this.name = "ConnectionCredentialError";
  }
}

const finiteNumber = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** The largest time a JS Date holds (ECMA-262 21.4.1.1); anything past it is not a date. */
const MAX_DATE_MS = 8.64e15;

/**
 * Below this an `expiry_date` is read as seconds, not ms: 1e11 ms is March
 * 1973, while 1e11 s is far past any token. Google's client libraries write
 * ms; some tools write seconds, which read as ms would date the token in 1970
 * and refuse one that may still work.
 */
const SECONDS_BELOW = 1e11;

/** When the stored access token expires, in ms since the epoch, or null when the row does not say (or says nonsense). */
export function oauth2ExpiresAt(value: Record<string, unknown>): number | null {
  const rawExpiry = finiteNumber(value.expiry_date);
  const expiryDate = rawExpiry !== null && rawExpiry > 0 && rawExpiry < SECONDS_BELOW ? rawExpiry * 1000 : rawExpiry;
  const claimedAt = finiteNumber(value.claimed_at);
  const expiresIn = finiteNumber(value.expires_in);
  const at = expiryDate !== null && expiryDate > 0 ? expiryDate
    : claimedAt !== null && expiresIn !== null ? (claimedAt + expiresIn) * 1000 : null;
  return at !== null && Math.abs(at) <= MAX_DATE_MS ? at : null;
}

interface RefreshGrant {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  tokenUrl: URL;
  /** Upstream's `authorization_method`: client credentials in the body (default) or a Basic header. */
  inHeader: boolean;
}

/**
 * What a refresh needs, or null. Only the authorization-code grant refreshes
 * with a refresh token; a token URL that is not https is refused, because the
 * request carries the client secret and the refresh token.
 */
function refreshGrant(value: Record<string, unknown>): RefreshGrant | null {
  const grantType = value.grant_type ?? "authorization_code";
  if (grantType !== "authorization_code") return null;
  const refreshToken = nonEmpty(value.refresh_token);
  const clientId = nonEmpty(value.client_id);
  const clientSecret = nonEmpty(value.client_secret);
  const rawUrl = nonEmpty(value.token_url);
  if (!refreshToken || !clientId || !clientSecret || !rawUrl) return null;
  let tokenUrl: URL;
  try { tokenUrl = new URL(rawUrl); } catch { return null; }
  if (tokenUrl.protocol !== "https:" || tokenUrl.username || tokenUrl.password) return null;
  return { refreshToken, clientId, clientSecret, tokenUrl, inHeader: value.authorization_method === "HEADER" };
}

/** The OAuth error code a token endpoint answered with (RFC 6749 5.2), only when it is one: never free text. */
function oauthErrorCode(body: Record<string, unknown> | null): string {
  const code = body?.error;
  return typeof code === "string" && /^[a-z_]{1,64}$/u.test(code) ? `, ${code}` : "";
}

/** What the Connections panel may show about a pasted OAuth2 row: no secret, only whether and when. */
export interface PastedOAuth2Status {
  /** Expiry of the stored access token in ms, or null when the row does not say. */
  expiresAt: number | null;
  /**
   * True when the row carries what a refresh needs, so Jarvis refreshes it:
   * before its stated expiry, or on first use when it states none.
   */
  refreshable: boolean;
}

export function pastedOAuth2Status(type: AppConnectionType, value: Record<string, unknown>): PastedOAuth2Status | null {
  if (!OAUTH2_TYPES.has(type)) return null;
  return { expiresAt: oauth2ExpiresAt(value), refreshable: refreshGrant(value) !== null };
}

/**
 * A saved OAuth2 value with `expires_in` and no claim time gets one, as
 * upstream records `claimed_at` when it stores a token. The same access token
 * saved again keeps the claim time it already had, or stays undated when it
 * was stored undated (a row saved before #954), so re-saving the same
 * credential stays the same credential (Q-05 does not count it as replaced).
 */
export function stampOAuth2Claim(
  type: AppConnectionType,
  value: Record<string, unknown>,
  previous: Record<string, unknown> | null | undefined,
  now: number = Date.now(),
): Record<string, unknown> {
  if (!OAUTH2_TYPES.has(type)) return value;
  if (value.claimed_at !== undefined || value.expiry_date !== undefined || finiteNumber(value.expires_in) === null) return value;
  const sameToken = !!previous && previous.access_token === value.access_token;
  if (sameToken && previous!.claimed_at === undefined) return value;
  const kept = sameToken ? finiteNumber(previous!.claimed_at) : null;
  return { ...value, claimed_at: kept ?? Math.round(now / 1000) };
}

/** One POST to a token endpoint. Resolves with the status and parsed JSON body; rejects when nothing usable came back. */
export type TokenTransport = (url: URL, form: URLSearchParams, headers: Record<string, string>) => Promise<{ status: number; body: unknown }>;

export interface GuardedTokenTransportOptions {
  /** Test seams, as `http-egress.ts` offers them. Production passes neither. */
  resolve?: Parameters<typeof guardedLookup>[1];
  allowAddress?: (address: string) => boolean;
  /** Extra trust anchors (tests' self-signed endpoint). */
  ca?: string;
  /** Deadline for the whole exchange, from connect to the last byte. */
  timeoutMs?: number;
}

/**
 * The token POST, through the workflow egress policy (#961): the name is
 * resolved once, every address checked, and the connection made to the
 * checked address. Never a redirect, never a pooled socket, and on Bun 1.4.2
 * never a proxy. (Measured in review: Bun 1.3.8 sends it through an
 * HTTPS_PROXY from the environment as a CONNECT to the checked address, so
 * the destination is still the checked one and TLS is still end to end.)
 * The deadline covers the whole exchange: a socket timeout alone is an idle
 * timer, which an endpoint dripping a byte at a time never trips.
 */
export function guardedTokenTransport(policy: EgressPolicy, options: GuardedTokenTransportOptions = {}): TokenTransport {
  const allowed = options.allowAddress ?? ((address: string) => destinationAllowed(address, policy));
  const lookup = guardedLookup(policy, options.resolve, allowed);
  const timeoutMs = options.timeoutMs ?? TOKEN_TIMEOUT_MS;
  return (url, form, headers) => new Promise((resolveAnswer, rejectAnswer) => {
    if (url.protocol !== "https:") return rejectAnswer(new EgressRefusedError(`token request refused: ${url.protocol} is not https`));
    try { assertHostAllowed(url.hostname, policy, allowed); } catch (error) { return rejectAnswer(error); }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const resolvePromise = (answer: { status: number; body: unknown }) => { clearTimeout(deadline); resolveAnswer(answer); };
    const reject = (error: unknown) => { clearTimeout(deadline); rejectAnswer(error); };
    const payload = form.toString();
    const req = httpsRequest({
      protocol: "https:",
      hostname: url.hostname.replace(/^\[(.*)\]$/u, "$1"),
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(payload)) },
      lookup: lookup as never,
      agent: false,
      timeout: timeoutMs,
      ...(options.ca ? { ca: options.ca } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_TOKEN_RESPONSE_BYTES) { req.destroy(new Error("token response too large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        let body: unknown = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
        resolvePromise({ status: res.statusCode ?? 0, body });
      });
      res.on("error", reject);
    });
    deadline = setTimeout(() => { req.destroy(); reject(new Error("token request timed out")); }, timeoutMs);
    req.on("timeout", () => req.destroy(new Error("token request timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

/** A connection row as the resolver read it. */
export interface StoredOAuth2Connection {
  id: string;
  projectId: string;
  externalId: string;
  type: AppConnectionType;
  value: Record<string, unknown>;
  /** The row's credential_generation when it was read: the identity the run's binding (Q-05) accepted. */
  generation: number;
}

/**
 * Refreshes pasted OAuth2 rows on resolve. One refresh at a time per row: a
 * provider that rotates refresh tokens invalidates the old one on first use,
 * so two concurrent refreshes would leave one holding a dead token. A caller
 * holding the same stored value shares the refresh in flight; one holding a
 * value a person saved since waits for it to settle and refreshes its own.
 *
 * A refresh the provider refused (or the egress rule refused) is remembered
 * against the stored value it was tried with, and not tried again until that
 * value changes: a revoked grant would otherwise be POSTed at every step's
 * fetch. An unreachable endpoint is remembered for REFRESH_AHEAD_MS, and only
 * for a token not known to have expired, which is handed out meanwhile: a
 * black-holed endpoint would otherwise cost every fetch the full deadline. A
 * token known to have expired has nothing to hand out, so its fetches always
 * try again.
 */
export class PastedOAuth2Refresher {
  private readonly inflight = new Map<string, { start: Record<string, unknown>; promise: Promise<Record<string, unknown>> }>();
  private readonly refused = new Map<string, { start: Record<string, unknown>; error: ConnectionCredentialError; until?: number }>();
  private readonly now: () => number;

  constructor(private readonly transport: TokenTransport, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * The value to hand out for this row: as stored while its token is good for
   * longer than REFRESH_AHEAD_MS, refreshed when it is not and the row can be
   * refreshed. A refreshable row that states no expiry (one saved before
   * #954, or pasted without `expires_in`) is refreshed on first use, which
   * dates it. Throws `ConnectionCredentialError` only when the token is known
   * to have expired and no fresh one was obtained; a refresh that fails while
   * the stored token may still work hands that out.
   */
  async fresh(conn: StoredOAuth2Connection): Promise<Record<string, unknown>> {
    if (!OAUTH2_TYPES.has(conn.type)) return conn.value;
    const expiresAt = oauth2ExpiresAt(conn.value);
    const grant = refreshGrant(conn.value);
    if (expiresAt === null && !grant) return conn.value;
    const now = this.now();
    if (expiresAt !== null && now + REFRESH_AHEAD_MS < expiresAt) return conn.value;
    const expired = expiresAt !== null && now >= expiresAt;
    if (!grant) {
      if (!expired) return conn.value;
      throw new ConnectionCredentialError("CONNECTION_EXPIRED",
        `The access token in connection ${conn.externalId} expired at ${new Date(expiresAt!).toISOString()}, and the connection has no `
        + "refresh details (refresh_token, client_id, client_secret and an https token_url), so Jarvis cannot refresh it. "
        + "Paste a new token, or add the refresh details.");
    }
    const key = `${conn.projectId}\u0000${conn.id}`;
    try {
      return await this.shared(key, conn, grant, expired);
    } catch (error) {
      if (!expired && error instanceof ConnectionCredentialError && error.code !== "CONNECTION_CHANGED") {
        // The stored token may still work: hand it out, and try again on the next fetch. As the row
        // holds it now, not the snapshot from before any wait, whose refresh token may be retired.
        const row = getConnectionInProject(conn.projectId, conn.id);
        if (row && row.credentialGeneration === conn.generation) return row.value;
        throw new ConnectionCredentialError("CONNECTION_CHANGED",
          `Connection ${conn.externalId} was replaced or removed while Jarvis refreshed it. Start a new run once the connection is right.`);
      }
      throw error;
    }
  }

  private async shared(key: string, conn: StoredOAuth2Connection, grant: RefreshGrant, expired: boolean): Promise<Record<string, unknown>> {
    for (;;) {
      const entry = this.inflight.get(key);
      if (entry && sameCredential(entry.start, conn.value)) return entry.promise;
      if (entry) {
        // Another value is being refreshed: let it settle, then look again.
        await entry.promise.catch(() => undefined);
        continue;
      }
      // Nothing in flight. Re-read the row right before refreshing: a refresh
      // that finished after the caller read its snapshot (behind any await,
      // or while it waited above) may have rotated the refresh token, and a
      // retired one must never be sent (a reuse-detecting provider revokes
      // the whole grant). Nothing awaits from here to the POST.
      const row = getConnectionInProject(conn.projectId, conn.id);
      // Only the same credential the run was allowed: a person's replacement is another identity (Q-05).
      if (!row || row.credentialGeneration !== conn.generation) {
        throw new ConnectionCredentialError("CONNECTION_CHANGED",
          `Connection ${conn.externalId} was replaced or removed while Jarvis refreshed it. Start a new run once the connection is right.`);
      }
      if (sameCredential(row.value, conn.value)) break;
      conn = { ...conn, value: row.value };
      const expiresAt = oauth2ExpiresAt(row.value);
      const next = refreshGrant(row.value);
      if (expiresAt !== null && this.now() + REFRESH_AHEAD_MS < expiresAt) return row.value;
      if (!next) {
        // Unreachable today (a refresh keeps the grant fields), but never hand out a token known to have expired.
        if (expiresAt === null || this.now() < expiresAt) return row.value;
        throw new ConnectionCredentialError("CONNECTION_EXPIRED",
          `The access token in connection ${conn.externalId} has expired, and the connection has no refresh details, so Jarvis cannot refresh it.`);
      }
      grant = next;
    }
    const refused = this.refused.get(key);
    if (refused && sameCredential(refused.start, conn.value) && (refused.until === undefined || (!expired && this.now() < refused.until))) {
      throw refused.error;
    }
    const promise = this.refresh(conn, grant)
      .then((value) => { this.refused.delete(key); return value; },
        (error: unknown) => {
          if (error instanceof ConnectionCredentialError) {
            // One line, with no secret: which connection, which host, which typed reason.
            console.warn(`[workflow-credentials] refresh of connection ${JSON.stringify(conn.externalId)} at ${grant.tokenUrl.host} failed: ${error.code}`);
            if (error.code === "CONNECTION_EXPIRED") this.refused.set(key, { start: conn.value, error });
            if (error.code === "CONNECTION_REFRESH_UNREACHABLE") this.refused.set(key, { start: conn.value, error, until: this.now() + REFRESH_AHEAD_MS });
            // A row replaced or removed has nothing left to remember a refusal for.
            if (error.code === "CONNECTION_CHANGED") this.refused.delete(key);
          }
          throw error;
        })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, { start: conn.value, promise });
    return promise;
  }

  private async refresh(conn: StoredOAuth2Connection, grant: RefreshGrant): Promise<Record<string, unknown>> {
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: grant.refreshToken });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (grant.inHeader) {
      headers.authorization = `Basic ${Buffer.from(`${grant.clientId}:${grant.clientSecret}`).toString("base64")}`;
    } else {
      form.set("client_id", grant.clientId);
      form.set("client_secret", grant.clientSecret);
    }
    let answer: { status: number; body: unknown };
    try {
      answer = await this.transport(grant.tokenUrl, form, headers);
    } catch (error) {
      if (egressRefusalIn(error)) {
        throw new ConnectionCredentialError("CONNECTION_EXPIRED",
          `Jarvis may not connect to the token endpoint of connection ${conn.externalId} (${grant.tokenUrl.host}): `
          + "this Jarvis's workflows reach only allowed network addresses. Change the connection's token_url, or reconnect.");
      }
      // Measured: on Bun 1.3.8-1.3.10, node:https given a lookup rewrites the
      // request to the resolved IP and never verifies the certificate for the
      // host name (even one listing that IP fails), so every refresh fails
      // here; 1.3.11, 1.3.12 and 1.4.2 verify the host name. Say so rather
      // than blame the network.
      const tls = (error as { code?: unknown })?.code === "ERR_TLS_CERT_ALTNAME_INVALID"
        ? " Its certificate did not verify for that host name; Bun older than 1.3.11 cannot verify it at all, so update Bun if this persists."
        : "";
      throw new ConnectionCredentialError("CONNECTION_REFRESH_UNREACHABLE",
        `Jarvis could not reach the token endpoint of connection ${conn.externalId} (${grant.tokenUrl.host}) to refresh it.${tls}`);
    }
    if (answer.status >= 500 || answer.status === 429 || answer.status === 408) {
      throw new ConnectionCredentialError("CONNECTION_REFRESH_UNREACHABLE",
        `The token endpoint of connection ${conn.externalId} (${grant.tokenUrl.host}) failed with HTTP ${answer.status} while Jarvis refreshed it.`);
    }
    const body = answer.body && typeof answer.body === "object" && !Array.isArray(answer.body) ? answer.body as Record<string, unknown> : null;
    const accessToken = body ? nonEmpty(body.access_token) : null;
    if (answer.status < 200 || answer.status >= 300 || !body || !accessToken) {
      throw new ConnectionCredentialError("CONNECTION_EXPIRED",
        `The provider refused to refresh connection ${conn.externalId} (HTTP ${answer.status}${oauthErrorCode(body)}). `
        + "Reconnect it: paste a new token with its refresh details.");
    }
    // A lifetime of zero or less would make every fetch refresh again: treat it as absent, as upstream treats a missing one.
    const lifetime = finiteNumber(body.expires_in);
    const next: Record<string, unknown> = { ...conn.value, access_token: accessToken, claimed_at: Math.round(this.now() / 1000),
      expires_in: lifetime !== null && lifetime > 0 ? lifetime : DEFAULT_EXPIRES_IN_S };
    // The expiry now lives in claimed_at + expires_in; a stale absolute one would win over it.
    delete next.expiry_date;
    // A provider that rotates refresh tokens sends the new one; one that does not, sends none.
    const rotated = nonEmpty(body.refresh_token);
    if (rotated) next.refresh_token = rotated;
    if (nonEmpty(body.token_type)) next.token_type = body.token_type;
    if (nonEmpty(body.scope)) next.scope = body.scope;
    let saved: ReturnType<typeof replaceRefreshedConnectionValue>;
    try {
      saved = replaceRefreshedConnectionValue(conn.projectId, conn.id, conn.value, next);
    } catch (error) {
      // The provider may already have retired the stored refresh token. Say so, without any secret.
      console.warn(`[workflow-credentials] refreshed connection ${JSON.stringify(conn.externalId)} but could not store it (${(error as Error).name}); `
        + "if the provider rotates refresh tokens, it may need reconnecting");
      throw error;
    }
    if (saved !== "stored") {
      throw new ConnectionCredentialError("CONNECTION_CHANGED",
        `Connection ${conn.externalId} was replaced or removed while Jarvis refreshed it. Start a new run once the connection is right.`
        + (saved === "kept-rotation" ? " Its rotated refresh token was kept in the saved connection." : ""));
    }
    return next;
  }
}
