import { useEffect, useRef, useState } from 'react';
import { CONNECTION_PROVIDER_NAMES, type ConnectionProvider } from '../../../../src/integrations/connection-providers';
import { Button, Chip } from '../ui';
import { requestSettingsTab } from '../shell/settings-tab-request';
import { openRoom } from '../router';

interface Status { connected: boolean; configured: boolean; reconnect: boolean; url: string | null; account: string | null; settings: boolean; refused: boolean }
function parseStatus(provider: ConnectionProvider, body: Record<string, unknown>): Status {
  const google = provider === 'google';
  if (typeof body.configured !== 'boolean' || typeof body[google ? 'is_authenticated' : 'connected'] !== 'boolean') throw new Error('Invalid connection status');
  const reconnect = body.reconnect === true || body.status === 'reconnect_required';
  let url: string | null = null;
  if (body.connect_url) {
    const parsed = new URL(String(body.connect_url));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid connection link');
    url = parsed.href;
  }
  const account = body.account as { label?: unknown } | null;
  return { connected: body[google ? 'is_authenticated' : 'connected'] === true && !reconnect,
    configured: body.configured, reconnect, url,
    account: typeof account?.label === 'string' ? account.label : null,
    settings: google && body.managed !== true && !body.reason,
    // The daemon names why it refused this instance's setup config: a fault to fix, not an absent path.
    refused: typeof body.reason === 'string' && body.reason.length > 0 };
}

/**
 * The instance offers no way to set this provider up and nothing is connected:
 * a self-hosted install for every hosted-only provider (no connect link, no
 * Settings entry). Read from the daemon's own status, so a provider added to
 * the hosted list needs no change here. A failed status check, or a config the
 * daemon refused, is not this: those stay visible as rows.
 */
function noSetupPath(status: Status): boolean {
  return !status.configured && !status.connected && !status.reconnect && !status.url && !status.settings && !status.refused;
}

export type RowState = 'none' | 'pending' | 'shown';

/** Read-only status. The hosted Account page remains the sole OAuth entry point. */
export function ManagedConnectionRow({ provider, refreshKey = 0, onManualSetup, onCollapsed }: {
  provider: ConnectionProvider; refreshKey?: number; onManualSetup?: () => void;
  /** Given, the row renders nothing while it has no setup path ('none') or
   * before its first status answer ('pending'), and reports its state here
   * ('shown' once it renders, null when it unmounts), so a list can summarise
   * those providers once instead of flashing a row per provider on first
   * load (#1260). */
  onCollapsed?: (provider: ConnectionProvider, state: RowState | null) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const name = CONNECTION_PROVIDER_NAMES[provider];
  useEffect(() => {
    let live = true, generation = 0, pending: AbortController | undefined;
    setStatus(null); setError(false);
    const load = async () => {
      const current = ++generation;
      pending?.abort(); const request = new AbortController(); pending = request;
      const timeout = window.setTimeout(() => request.abort(), 15_000);
      try {
        const response = await fetch(provider === 'google' ? '/api/auth/google/status' : `/api/integrations/${provider}`, { signal: request.signal });
        if (!response.ok) throw new Error('Unavailable');
        const next = parseStatus(provider, await response.json());
        if (live && current === generation) { setStatus(next); setError(false); }
      } catch {
        if (live && current === generation) { setStatus(null); setError(true); }
      } finally { window.clearTimeout(timeout); }
    };
    void load(); window.addEventListener('focus', load);
    return () => { live = false; pending?.abort(); window.removeEventListener('focus', load); };
  }, [provider, refreshKey, retry]);
  // While a refresh is pending (status reset, no error) keep the last answer,
  // so Refresh does not briefly bring every collapsed row back. Before the
  // first answer there is none to keep: the row waits collapsed as 'pending'.
  const last = useRef<RowState>('pending');
  const state: RowState = !onCollapsed ? 'shown'
    : status ? (noSetupPath(status) ? 'none' : 'shown') : error ? 'shown' : last.current;
  useEffect(() => { last.current = state; }, [state]);
  useEffect(() => { onCollapsed?.(provider, state); }, [onCollapsed, provider, state]);
  useEffect(() => () => onCollapsed?.(provider, null), [onCollapsed, provider]);
  if (state !== 'shown') return null;
  const label = error ? 'Could not check connection' : !status ? 'Checking connection…'
    : status.reconnect ? 'Reconnect required' : status.connected ? 'Connected' : status.url || status.settings ? 'Not connected' : 'Setup unavailable';
  return <section className="wf-conn__managed-row" aria-label={`${name} connection`}>
    <div className="wf-conn__managed-details">
      <strong>{name}</strong>
      <div role="status"><Chip tone={status?.connected ? 'ok' : error || status?.reconnect ? 'warn' : 'neutral'}>{label}</Chip>
        {status?.connected && status.account && <span>{status.account}</span>}</div>
      {status && !status.url && !status.settings && <p>One-click setup is not available on this instance yet.</p>}
    </div>
    <div className="wf-conn__managed-actions">
      {status?.url && <a className="v2-btn v2-btn--ghost v2-btn--md wf-conn__connect" href={status.url} target="_blank" rel="noopener noreferrer">
        {status.connected ? `Manage ${name}` : status.reconnect ? `Reconnect ${name}` : `Connect ${name}`}
      </a>}
      {status?.settings && !status.url && <Button variant="ghost" onClick={() => { requestSettingsTab('integrations'); openRoom('settings'); }}>
        {status.connected ? 'Manage Google' : 'Connect Google'}
      </Button>}
      {error && <Button variant="ghost" onClick={() => setRetry(n => n + 1)}>Try again</Button>}
      {onManualSetup && status && !status.configured && !status.connected && !status.url && provider !== 'google'
        && <Button variant="ghost" onClick={onManualSetup}>Enter credentials manually</Button>}
    </div>
  </section>;
}
