import type { JarvisConfig } from '../config/types';
import { classifyGoogle, makeGoogleAuth } from '../integrations/google-managed-refresh';
import { isHostedInstall } from '../daemon/usejarvis-ai';
import type { ConnectedWorkspaceSources } from './connected-workspace';

/** Same canonical classification and persisted revocation marker as /api/auth/google/status. No refresh. */
export function connectedGoogle(config: JarvisConfig, tokensPath?: string): ReturnType<NonNullable<ConnectedWorkspaceSources['google']>> {
  const shape = classifyGoogle(config);
  if (shape.mode === 'none' && shape.reason) return { mode: 'unavailable', authenticated: false, reconnect: false, canSetup: false };
  const auth = makeGoogleAuth(config, undefined, tokensPath);
  const reconnect = !!auth?.reconnectRequired();
  return { mode: shape.mode, authenticated: !reconnect && (auth?.isAuthenticated() ?? false), reconnect,
    canSetup: shape.mode === 'managed' ? validManagedConnect(config.google?.connect_url) : !isHostedInstall(config) };
}
function validManagedConnect(value: string | undefined): boolean {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
