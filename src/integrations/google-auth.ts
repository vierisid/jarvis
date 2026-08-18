/**
 * Google OAuth2 Authentication
 *
 * Manages OAuth2 tokens for Google APIs (Gmail, Calendar).
 * Uses raw fetch() — no googleapis package needed.
 * Tokens stored at ~/.jarvis/google-tokens.json
 */

import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { secureParentDirectory, secureWriteFile } from '../util/fs-secure.ts';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * Where the tokens live. Exported so a caller that needs to notice this file
 * changing (settings-reload's per-section diff) cannot drift from the path this
 * class actually reads.
 */
export function googleTokensPath(): string {
  return path.join(os.homedir(), '.jarvis', 'google-tokens.json');
}

export interface ManagedRefresh {
  access_token: string;
  expires_in?: number;
  /** Passed through if the control plane ever reports a rotated token. */
  refresh_token?: string;
}

/**
 * A refresh that will not succeed by waiting: the grant is gone (revoked, or
 * expired — Google revokes Gmail-scoped tokens on a password change and expires
 * them after 7 days while an app is in Testing). The user must connect again,
 * and callers must not treat it as a transient failure to retry forever.
 */
export class GoogleReconnectRequired extends Error {}

export type GoogleTokens = {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type: string;
};

export class GoogleAuth {
  private clientId: string;
  private clientSecret: string;
  private tokens: GoogleTokens | null = null;
  private tokensPath: string;
  private redirectUri: string;

  /**
   * HOSTED: refresh through the control plane instead of calling Google here.
   *
   * Set when the system config carries `google.refresh_url`. The instance keeps
   * its refresh token; the control plane holds the client secret and applies it.
   * That is what lets a managed config carry no Google credentials at all — this
   * daemon runs as the tenant's own user, so a secret it could use would be a
   * secret the tenant could read.
   */
  private refreshVia: ((refreshToken: string) => Promise<ManagedRefresh>) | null;

  /**
   * Where a "this grant is gone" verdict is remembered, beside the tokens it is
   * about.
   *
   * PERSISTED, because the alternative is a lie with a timer on it: a revoked
   * grant leaves the tokens file exactly where it was, so after every restart the
   * settings tab would show a green "connected" chip over an integration where
   * every sync fails, until something happened to attempt a refresh — up to an
   * hour, since refreshes only run on the expiry clock.
   *
   * Keyed by a hash of the refresh token it applies to — never the token — so it
   * self-clears the moment a new one is delivered, with no cross-module reset for
   * anyone to forget to call. Beside the tokens file rather than at a fixed path
   * so that redirecting one in a test redirects both.
   */
  private get reconnectPath(): string {
    return `${this.tokensPath}.reconnect`;
  }

  constructor(
    clientId: string,
    clientSecret: string,
    opts?: {
      tokensPath?: string;
      redirectUri?: string;
      refreshVia?: (refreshToken: string) => Promise<ManagedRefresh>;
    }
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshVia = opts?.refreshVia ?? null;
    this.tokensPath = opts?.tokensPath ?? path.join(os.homedir(), '.jarvis', 'google-tokens.json');
    this.redirectUri = opts?.redirectUri ?? 'http://localhost:3142/api/auth/google/callback';
    this.loadTokens();
  }

  /**
   * A HOSTED instance's auth: no client credentials at all, refreshing through
   * the control plane.
   *
   * A named constructor because the empty strings are a lie the type system would
   * otherwise carry around — the credential arguments are meaningless on this
   * path, and confining them to one line here is what lets every reader of
   * `clientId` treat "empty" as "there is no such thing here".
   */
  static managed(
    refreshVia: (refreshToken: string) => Promise<ManagedRefresh>,
    opts: { tokensPath?: string } = {},
  ): GoogleAuth {
    return new GoogleAuth('', '', { ...opts, refreshVia });
  }

  /**
   * Load saved tokens from disk.
   */
  loadTokens(): GoogleTokens | null {
    try {
      if (!existsSync(this.tokensPath)) return null;
      const text = readFileSync(this.tokensPath, 'utf-8');
      const data = JSON.parse(text);
      if (data.access_token && data.refresh_token) {
        this.tokens = data as GoogleTokens;
        return this.tokens;
      }
    } catch {
      // No tokens file or invalid
    }
    return null;
  }

  /**
   * Drop the in-memory tokens and re-read from disk. loadTokens() alone
   * keeps stale in-memory tokens when the file is gone — this null-first
   * reset is what makes a dashboard "disconnect" (which unlinks the tokens
   * file) actually deactivate a running instance without a restart.
   * Returns whether tokens now exist.
   */
  reloadTokensFromDisk(): boolean {
    this.tokens = null;
    return this.loadTokens() !== null;
  }

  /**
   * Save tokens to disk.
   */
  async saveTokens(tokens: GoogleTokens): Promise<void> {
    this.tokens = tokens;
    await secureParentDirectory(this.tokensPath);
    await secureWriteFile(this.tokensPath, JSON.stringify(tokens, null, 2), 0o600, 'GoogleAuth');
  }

  /**
   * Check if we have valid tokens.
   */
  isAuthenticated(): boolean {
    return this.tokens !== null && !!this.tokens.refresh_token;
  }

  /**
   * Snapshot of the current token set, or `null` if not authenticated.
   * Returned by value (caller can't mutate the internal cache). Used by
   * `JarvisGoogleConnectionSource` to surface the full OAuth2-shaped value
   * (access_token + refresh_token + expiry_date) to pieces.
   */
  getTokens(): GoogleTokens | null {
    return this.tokens ? { ...this.tokens } : null;
  }

  /**
   * Get a valid access token. Auto-refreshes if expired.
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      throw new Error('Not authenticated. Run: bun run src/scripts/google-setup.ts');
    }

    // Check if token is expired (with 5 min buffer)
    if (this.tokens.expiry_date && Date.now() > this.tokens.expiry_date - 5 * 60_000) {
      await this.refreshAccessToken();
    }

    return this.tokens.access_token;
  }

  /**
   * Generate OAuth2 consent URL.
   */
  getAuthUrl(
    scopes: string[],
    opts: { state?: string; codeChallenge?: string } = {},
  ): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });
    if (opts.state) params.set('state', opts.state);
    if (opts.codeChallenge) {
      params.set('code_challenge', opts.codeChallenge);
      params.set('code_challenge_method', 'S256');
    }
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens.
   */
  async exchangeCode(code: string, opts: { codeVerifier?: string } = {}): Promise<GoogleTokens> {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });
    if (opts.codeVerifier) body.set('code_verifier', opts.codeVerifier);
    const resp = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Token exchange failed: ${err}`);
    }

    const data = await resp.json() as any;

    const tokens: GoogleTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
      token_type: data.token_type ?? 'Bearer',
    };

    await this.saveTokens(tokens);
    return tokens;
  }

  /**
   * Refresh the access token using the refresh token.
   */
  /** In-flight refresh, so concurrent callers share one round trip. */
  private refreshing: Promise<void> | null = null;

  private refreshAccessToken(): Promise<void> {
    // SINGLE-FLIGHT. Six independent callers can ask for a token at once (both
    // observers' initial polls, both watch registrations, the suggestion engine,
    // the workflow credential source) and they all cross the 5-minute expiry
    // buffer together — most visibly right after a restart or a restore, when
    // the tokens on disk are already old. Without this they each refresh: for a
    // self-hosted instance that was merely wasteful, but a managed one now meets
    // the control plane's minimum-interval limiter and all but one get a 429
    // they report as a failed sync.
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * The reason this instance must connect Google again, or null.
   *
   * Tokens on disk are NOT proof of a live grant, which is the whole point:
   * reported by /api/auth/google/status so the settings tab offers Connect
   * instead of a green chip over an integration that cannot work.
   */
  reconnectRequired(): string | null {
    const token = this.tokens?.refresh_token;
    if (!token) return null;
    try {
      const saved = JSON.parse(readFileSync(this.reconnectPath, 'utf-8')) as {
        tokenHash?: unknown;
        message?: unknown;
      };
      if (typeof saved.tokenHash !== 'string' || typeof saved.message !== 'string') return null;
      // A DIFFERENT token means a reconnect already happened, and the verdict on
      // the old grant says nothing about the new one.
      return saved.tokenHash === sha256(token) ? saved.message : null;
    } catch {
      return null;
    }
  }

  private async markReconnectRequired(refreshToken: string, message: string): Promise<void> {
    try {
      await secureParentDirectory(this.reconnectPath);
      await secureWriteFile(
        this.reconnectPath,
        JSON.stringify({ tokenHash: sha256(refreshToken), message: clampReason(message) }),
        0o600,
        'GoogleAuth',
      );
    } catch (err) {
      // Losing this only costs a stale "connected" chip until the next attempt;
      // it must never turn a refresh failure into an unhandled one.
      console.warn(
        '[GoogleAuth] could not record the reconnect state:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  private clearReconnect(): void {
    try {
      rmSync(this.reconnectPath, { force: true });
    } catch {
      // Same reasoning as above.
    }
  }

  private async doRefresh(): Promise<void> {
    if (!this.tokens?.refresh_token) {
      throw new Error('No refresh token available');
    }
    // The token this flight is FOR. Everything below awaits — a managed refresh
    // for up to 20s — and the tokens on disk can change underneath it: a
    // disconnect deletes the file and reloadTokensFromDisk() nulls this cache, a
    // reconnect replaces it with a different grant. Without this binding the
    // merge below reads `this.tokens` again after the await and would either
    // RE-CREATE the file the user just revoked (with a live access token for the
    // account they revoked, since `{...null}` spreads nothing and drops the
    // refresh token silently) or overwrite a freshly delivered grant's access
    // token with one minted from the old one — and nothing refreshes on a 401,
    // so that costs up to an hour of failing polls.
    const bound = this.tokens.refresh_token;

    let data: { access_token: string; expires_in?: number; refresh_token?: string };

    // ONE recorder for both paths: a gone grant is a gone grant whether the
    // control plane told us or Google did, and the settings tab has to say so
    // either way.
    try {
      data = await this.fetchRefreshed(bound);
    } catch (err) {
      if (err instanceof GoogleReconnectRequired) await this.markReconnectRequired(bound, err.message);
      throw err;
    }

    // The grant moved while we were waiting: this result belongs to a token that
    // is no longer ours. Discard it rather than write it — see `bound` above.
    if (this.tokens?.refresh_token !== bound) {
      console.warn(
        '[GoogleAuth] discarding a refresh whose token was replaced while it was in flight',
      );
      throw new Error('the refresh token changed while the refresh was in flight');
    }

    this.tokens = {
      ...this.tokens,
      access_token: data.access_token,
      // Google does not normally rotate refresh tokens, but dropping one it DID
      // return would strand this instance at its next refresh.
      ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
      expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
    };

    await this.saveTokens(this.tokens);
    // A refresh that worked says the grant is alive, whatever we thought before.
    this.clearReconnect();
    console.log('[GoogleAuth] Token refreshed successfully');
  }

  /** The exchange itself: through the control plane when managed, else Google. */
  private async fetchRefreshed(
    refreshToken: string,
  ): Promise<{ access_token: string; expires_in?: number; refresh_token?: string }> {
    if (this.refreshVia) {
      // Managed: the control plane holds the secret and applies it for us.
      return await this.refreshVia(refreshToken);
    } else {
      const resp = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: refreshToken,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: 'refresh_token',
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        // `invalid_grant` is Google's answer for a revoked, expired, or
        // password-change-invalidated token — permanent, and fixed only by the
        // user connecting again. Classified here too, not just on the managed
        // path, or a self-hosted instance shows a green "connected" chip over a
        // dead grant forever.
        if (err.includes('invalid_grant')) {
          throw new GoogleReconnectRequired(
            'Google access is no longer valid — connect Google again',
          );
        }
        throw new Error(`Token refresh failed: ${clampReason(err)}`);
      }

      return (await resp.json()) as { access_token: string; expires_in?: number };
    }
  }
}

/** sha256 hex. Used to key the reconnect state without storing a token. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Bound and de-control-character an untrusted reason before it is stored or
 * shown.
 *
 * The managed path's message comes from whatever answers `refresh_url`, and it is
 * rendered to the user as this daemon's own explanation — so an unbounded or
 * newline-bearing string would be someone else's text in our voice, and in our
 * logs. Not XSS (React escapes it), but not ours to pass through either.
 */
export function clampReason(message: string): string {
  const flat = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}
