import { createHash, createHmac } from 'node:crypto';
import { GoogleAuth, GoogleReconnectRequired, type ManagedRefresh } from './google-auth.ts';
import type { JarvisConfig } from '../config/types.ts';

/**
 * Ask the control plane to refresh this instance's Google access token
 * (GOOGLE.md "Refresh"). HOSTED ONLY.
 *
 * The instance holds the refresh token; the control plane holds the client
 * secret. Neither side has both, which is the point: this daemon runs as the
 * tenant's own Linux user, so a secret it could use would be one the tenant
 * could read — and the control plane storing refresh tokens would make a single
 * compromise worth every user's mailbox.
 *
 * The request is signed with the per-instance notify secret from the system
 * config, the same key the push bridge's doorbell is verified with, used here in
 * the other direction. The timestamp is inside the signed bytes so a captured
 * request cannot be replayed later.
 */
export interface ManagedRefreshConfig {
  refreshUrl: string;
  instanceId: string;
  notifySecret: string;
}

/** How long to wait on the control plane. The caller is blocked on this. */
const TIMEOUT_MS = 20_000;

/**
 * The last grant we were told is GONE, remembered so the settings UI can say so.
 *
 * Without this the classification is inert: a revoked grant leaves the tokens
 * file in place, so status keeps reading "connected" while every sync quietly
 * fails, and the one action that fixes it (connect again) is never offered.
 *
 * Keyed by a hash of the refresh token that failed — never the token — so it
 * self-clears the moment the control plane delivers a new one, with no
 * cross-module reset to forget to call.
 */
let deadGrant: { tokenHash: string; message: string } | null = null;

const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * The reason this instance must connect Google again, or null. Reported by
 * /api/auth/google/status; tokens on disk are NOT proof of a live grant.
 */
export function googleReconnectRequired(auth: GoogleAuth | null): string | null {
  const token = auth?.getTokens()?.refresh_token;
  if (!token || !deadGrant) return null;
  return deadGrant.tokenHash === tokenHash(token) ? deadGrant.message : null;
}

export function makeManagedRefresh(
  cfg: ManagedRefreshConfig,
  fetchImpl: typeof fetch = fetch,
): (refreshToken: string) => Promise<ManagedRefresh> {
  return async (refreshToken: string) => {
    const body = JSON.stringify({
      instanceId: cfg.instanceId,
      refreshToken,
      at: new Date().toISOString(),
    });
    const signature = createHmac('sha256', cfg.notifySecret).update(body).digest('hex');

    let res: Response;
    try {
      res = await fetchImpl(cfg.refreshUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-jarvis-signature': signature },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Unreachable control plane is TRANSIENT: the next poll tries again, and
      // telling the user to reconnect over a network blip would be wrong.
      throw new Error(
        `could not reach the control plane to refresh: ${err instanceof Error ? err.message : err}`,
      );
    }

    if (res.status === 200) {
      const data = (await res.json()) as ManagedRefresh;
      if (!data?.access_token) throw new Error('control plane returned no access token');
      deadGrant = null;
      return data;
    }

    const detail = (await res.json().catch(() => null)) as
      | { error?: string; reconnect?: boolean }
      | null;
    // 409+reconnect is the grant being gone; 404 means the control plane no
    // longer has a connected record for this instance, which the user also fixes
    // by connecting again. Both are permanent — retrying either forever would
    // bury the one action that helps.
    if (detail?.reconnect || res.status === 404) {
      const message = detail?.error ?? 'Google access is no longer valid — connect Google again';
      deadGrant = { tokenHash: tokenHash(refreshToken), message };
      throw new GoogleReconnectRequired(message);
    }
    throw new Error(`control plane refused the refresh (${res.status})`);
  };
}

/**
 * Build the right GoogleAuth for this deployment, or null when Google is not
 * configured at all.
 *
 * MANAGED (hosted) instances carry `refresh_url` and no credentials: the control
 * plane holds the client id and secret and applies them on the instance's
 * behalf. SELF-HOSTED instances carry their own credentials and talk to Google
 * directly. Both shapes are legitimate; what must never happen is a hosted
 * instance holding the shared secret, which is why the managed branch is checked
 * FIRST and constructs with no credentials at all.
 */
/**
 * Which Google shape this config is — and, with it, the validated fields that
 * shape needs. Decided in ONE place so the daemon's status endpoint, the auth
 * builder and the reload applier cannot disagree about whether an instance is
 * hosted. `none` covers both "no Google" and a config too broken to use.
 */
export type GoogleShape =
  | { mode: 'managed'; refreshUrl: string; instanceId: string; notifySecret: string }
  | { mode: 'self'; clientId: string; clientSecret: string }
  | { mode: 'none' };

export function classifyGoogle(config: { google?: JarvisConfig['google'] }): GoogleShape {
  const g = config.google;
  if (!g) return { mode: 'none' };
  if (g.refresh_url) {
    // MANAGED, or a managed block we mis-rendered. Refuse a partial one rather
    // than falling through to any client_id/client_secret also present: that
    // would put a hosted instance back on the path this whole design exists to
    // remove, and do it invisibly, since everything would keep working. The
    // control plane's own googleAppCredsFromEnv refuses a half-set pair for the
    // same reason.
    if (!g.instance_id || !g.notify_secret) {
      console.error(
        '[google] the config carries refresh_url but not instance_id and notify_secret — ' +
          'Google is disabled rather than falling back to any credentials in this file.',
      );
      return { mode: 'none' };
    }
    return {
      mode: 'managed',
      refreshUrl: g.refresh_url,
      instanceId: g.instance_id,
      notifySecret: g.notify_secret,
    };
  }
  if (g.client_id && g.client_secret) {
    return { mode: 'self', clientId: g.client_id, clientSecret: g.client_secret };
  }
  return { mode: 'none' };
}

/**
 * Build the right GoogleAuth for this deployment, or null when Google is not
 * configured at all.
 *
 * MANAGED (hosted) instances carry `refresh_url` and no credentials: the control
 * plane holds the client id and secret and applies them on the instance's
 * behalf. SELF-HOSTED instances carry their own credentials and talk to Google
 * directly. Both shapes are legitimate; what must never happen is a hosted
 * instance holding the shared secret, which is why the managed branch is checked
 * FIRST and constructs with no credentials at all.
 */
export function makeGoogleAuth(
  config: { google?: JarvisConfig['google'] },
  fetchImpl: typeof fetch = fetch,
): GoogleAuth | null {
  const shape = classifyGoogle(config);
  if (shape.mode === 'none') return null;
  if (shape.mode === 'managed') {
    return new GoogleAuth('', '', { refreshVia: makeManagedRefresh(shape, fetchImpl) });
  }
  return new GoogleAuth(shape.clientId, shape.clientSecret);
}

/**
 * A value that changes when the Google IDENTITY changes, for the settings-reload
 * applier's "rebuild or just reload the tokens?" decision. Covers both shapes —
 * keying it on credentials alone would leave a managed instance rebuilding on
 * every reload, or worse, never constructing at all.
 */
export function googleIdentity(config: { google?: JarvisConfig['google'] }): string | null {
  const shape = classifyGoogle(config);
  if (shape.mode === 'managed') return `managed\n${shape.refreshUrl}\n${shape.instanceId}`;
  if (shape.mode === 'self') return `self\n${shape.clientId}\n${shape.clientSecret}`;
  return null;
}
