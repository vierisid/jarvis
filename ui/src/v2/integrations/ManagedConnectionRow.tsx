import { useEffect, useState } from 'react';
import { CONNECTION_PROVIDER_NAMES, type ConnectionProvider } from '../../../../src/integrations/connection-providers';
import { Button, Chip } from '../ui';
import { requestSettingsTab } from '../shell/settings-tab-request';
import { openRoom } from '../router';

interface Status { connected: boolean; configured: boolean; reconnect: boolean; url: string | null; account: string | null; settings: boolean }
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
    settings: google && body.managed !== true && !body.reason };
}

/** Read-only status. The hosted Account page remains the sole OAuth entry point. */
export function ManagedConnectionRow({ provider, refreshKey = 0, onManualSetup }: {
  provider: ConnectionProvider; refreshKey?: number; onManualSetup?: () => void;
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
  const state = error ? 'Could not check connection' : !status ? 'Checking connection…'
    : status.reconnect ? 'Reconnect required' : status.connected ? 'Connected' : status.url || status.settings ? 'Not connected' : 'Setup unavailable';
  return <section className="wf-conn__managed-row" aria-label={`${name} connection`}>
    <div className="wf-conn__managed-details">
      <strong>{name}</strong>
      <div role="status"><Chip tone={status?.connected ? 'ok' : error || status?.reconnect ? 'warn' : 'neutral'}>{state}</Chip>
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
