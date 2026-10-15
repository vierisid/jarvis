import type { GoogleAuth } from '../../integrations/google-auth.ts';
import { GOOGLE_ONBOARDING_SCOPES, type GoogleGrant } from './types.ts';

interface VerificationPorts {
  /** Fresh canonical service for this bound owner, using its existing token path. */
  auth(): GoogleAuth | null;
  /** Trusted OAuth client ID, including the public client ID for hosted installs. */
  clientId: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Read-only grant inspection; exchange, refresh and persistence remain GoogleAuth's. */
export function createGoogleGrantReader(ports: VerificationPorts): () => Promise<GoogleGrant> {
  return async () => {
    if (!ports.clientId) return { state: 'unverified' };
    const auth = ports.auth();
    if (!auth || !auth.reloadTokensFromDisk()) return { state: 'absent' };
    if (auth.reconnectRequired()) return { state: 'revoked' };
    const refresh = auth.getTokens()?.refresh_token;
    try {
      const token = await auth.getAccessToken();
      const request = ports.fetch ?? fetch;
      const options = { headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000), redirect: 'error' as const };
      // Google's own client uses POST + bearer header, never a token in the URL.
      const infoResponse = await request('https://oauth2.googleapis.com/tokeninfo', {
        ...options, method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (infoResponse.status === 400 || infoResponse.status === 401) return { state: 'revoked' };
      if (!infoResponse.ok) return { state: 'unverified' };
      const info = await infoResponse.json() as { aud?: unknown; scope?: unknown; expires_in?: unknown };
      if (info.aud !== ports.clientId || typeof info.scope !== 'string' || info.scope.length > 16_384
        || !['number', 'string'].includes(typeof info.expires_in)
        || !Number.isFinite(Number(info.expires_in)) || Number(info.expires_in) <= 0) return { state: 'unverified' };
      const now = ports.now ?? Date.now;
      const expiresAt = now() + Number(info.expires_in) * 1000;
      const scopes = [...new Set(info.scope.split(/\s+/).filter(Boolean))];
      if (!GOOGLE_ONBOARDING_SCOPES.every(scope => scopes.includes(scope))) return { state: 'unverified' };
      // Gmail's existing readonly scope supplies account identity without adding email/profile scopes.
      const profileResponse = await request('https://gmail.googleapis.com/gmail/v1/users/me/profile', options);
      if (profileResponse.status === 401) return { state: 'revoked' };
      if (!profileResponse.ok) return { state: 'unverified' };
      const profile = await profileResponse.json() as { emailAddress?: unknown };
      if (typeof profile.emailAddress !== 'string' || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(profile.emailAddress)
        || profile.emailAddress.length > 320) return { state: 'unverified' };
      // Disconnect/reconnect during either request must not resurrect an old account.
      if (!auth.reloadTokensFromDisk() || auth.reconnectRequired()
        || auth.getTokens()?.refresh_token !== refresh || auth.getTokens()?.access_token !== token
        || expiresAt <= now()) return { state: 'unverified' };
      return { state: 'verified', accountLabel: profile.emailAddress, scopes };
    } catch {
      // Provider errors can contain token bodies/URLs. They never leave this boundary.
      return { state: auth.reconnectRequired() ? 'revoked' : 'unverified' };
    }
  };
}
