import { createHmac } from 'node:crypto';
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
      throw new GoogleReconnectRequired(
        detail?.error ?? 'Google access is no longer valid — connect Google again',
      );
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
export function makeGoogleAuth(
  config: { google?: JarvisConfig['google'] },
  fetchImpl: typeof fetch = fetch,
): GoogleAuth | null {
  const g = config.google;
  if (!g) return null;
  if (g.refresh_url && g.instance_id && g.notify_secret) {
    return new GoogleAuth('', '', {
      refreshVia: makeManagedRefresh(
        { refreshUrl: g.refresh_url, instanceId: g.instance_id, notifySecret: g.notify_secret },
        fetchImpl,
      ),
    });
  }
  if (g.client_id && g.client_secret) return new GoogleAuth(g.client_id, g.client_secret);
  return null;
}

/**
 * A value that changes when the Google IDENTITY changes, for the settings-reload
 * applier's "rebuild or just reload the tokens?" decision. Covers both shapes —
 * keying it on credentials alone would leave a managed instance rebuilding on
 * every reload, or worse, never constructing at all.
 */
export function googleIdentity(config: { google?: JarvisConfig['google'] }): string | null {
  const g = config.google;
  if (!g) return null;
  if (g.refresh_url && g.instance_id && g.notify_secret) {
    return `managed\n${g.refresh_url}\n${g.instance_id}`;
  }
  if (g.client_id && g.client_secret) return `self\n${g.client_id}\n${g.client_secret}`;
  return null;
}
