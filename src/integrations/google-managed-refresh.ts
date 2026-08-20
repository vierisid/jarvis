import { GoogleAuth, GoogleReconnectRequired, clampReason, type ManagedRefresh } from './google-auth.ts';
import { INSTANCE_SIGNATURE_HEADER, signWithSecret } from './google-signature.ts';
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
 * The request is signed with the per-instance REFRESH secret from the system
 * config — a different key from the doorbell's notify secret. The two travel in
 * opposite directions, and while one key served both, the same signature was
 * valid at either endpoint. The timestamp is inside the signed bytes so a captured
 * request cannot be replayed later.
 */
export interface ManagedRefreshConfig {
  refreshUrl: string;
  instanceId: string;
  /**
   * The REFRESH key, not the doorbell's. They are separate derivations because
   * they travel in opposite directions; see google-signature.ts.
   */
  refreshSecret: string;
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
    const signature = signWithSecret(cfg.refreshSecret, body);

    let res: Response;
    try {
      res = await fetchImpl(cfg.refreshUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [INSTANCE_SIGNATURE_HEADER]: signature },
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
    // `reconnect` is the control plane saying the grant is gone — 409 when the
    // token is not the one bound to this instance, 404 when there is no connected
    // record any more. Both are permanent, and retrying either forever would bury
    // the one action that helps.
    //
    // Taken from the FLAG, never inferred from the status: a bare 404 is also what
    // a wrong origin path, a rollback that drops the route, or a CDN answering for
    // an unknown path returns, and treating those as a dead grant would tell the
    // user to reconnect over a misconfiguration — then stop refreshing a token
    // that was fine.
    if (detail?.reconnect) {
      throw new GoogleReconnectRequired(
        // Someone else's text, shown to the user in our voice, so it is bounded
        // and stripped of control characters before it goes anywhere.
        detail.error ? clampReason(detail.error) : 'Google access is no longer valid — connect Google again',
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
/**
 * Which Google shape this config is — and, with it, the validated fields that
 * shape needs. Decided in ONE place so the daemon's status endpoint, the auth
 * builder and the reload applier cannot disagree about whether an instance is
 * hosted. `none` covers both "no Google" and a config too broken to use.
 */
export type GoogleShape =
  | { mode: 'managed'; refreshUrl: string; instanceId: string; refreshSecret: string }
  | { mode: 'self'; clientId: string; clientSecret: string }
  /** `reason` is set only when a config was REFUSED, not when there is no Google. */
  | { mode: 'none'; reason?: string };

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
    //
    // The reason is RETURNED, not logged: this function is called on every status
    // poll as well as at construction, and logging here printed the same line
    // twice per poll forever. The boot/reload edge logs it once, and the status
    // endpoint can show it to whoever has to fix it.
    if (!g.instance_id || !g.refresh_secret) {
      return {
        mode: 'none',
        reason:
          'the config carries refresh_url but not instance_id and refresh_secret, so Google ' +
          'is disabled rather than falling back to any credentials in this file',
      };
    }
    return {
      mode: 'managed',
      refreshUrl: g.refresh_url,
      instanceId: g.instance_id,
      refreshSecret: g.refresh_secret,
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
  /** Test seam — see ApiContext.googleTokensPath. */
  tokensPath?: string,
): GoogleAuth | null {
  const shape = classifyGoogle(config);
  if (shape.mode === 'none') return null;
  if (shape.mode === 'managed') {
    return GoogleAuth.managed(makeManagedRefresh(shape, fetchImpl), { tokensPath });
  }
  return new GoogleAuth(shape.clientId, shape.clientSecret, { tokensPath });
}

/**
 * A value that changes when the Google IDENTITY changes, for the settings-reload
 * applier's "rebuild or just reload the tokens?" decision. Covers both shapes —
 * keying it on credentials alone would leave a managed instance rebuilding on
 * every reload, or worse, never constructing at all.
 */
export function googleIdentity(config: { google?: JarvisConfig['google'] }): string | null {
  const shape = classifyGoogle(config);
  // The refresh SECRET is part of the identity, not just the URL and the id: it is
  // the one value that authenticates every refresh, and the managed refresher
  // closes over it. If it ever changed without the URL changing (a master-key
  // rotation on the control plane), an identity that ignored it would tell the
  // reload applier "same Google, just re-read the tokens" and leave the refresher
  // signing with a key the control plane no longer accepts — every refresh 401ing,
  // forever, until a restart nobody knows to perform.
  if (shape.mode === 'managed') {
    return `managed\n${shape.refreshUrl}\n${shape.instanceId}\n${shape.refreshSecret}`;
  }
  if (shape.mode === 'self') return `self\n${shape.clientId}\n${shape.clientSecret}`;
  return null;
}
