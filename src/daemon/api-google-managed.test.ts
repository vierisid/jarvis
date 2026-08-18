import { describe, expect, it } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { JarvisConfig } from '../config/types.ts';

type Handler = (req: Request) => Response | Promise<Response>;

/**
 * Hosted ("managed") mode for the daemon's own Google surface (GOOGLE.md).
 *
 * The point of the hosted integration is that it REPLACES the self-hosted one in
 * this UI. That means two things have to be true here: the status endpoint has to
 * say so (the settings tab keys its whole rendering off it), and the daemon's own
 * OAuth flow has to refuse — its redirect URI is this instance's own hostname,
 * which is not registered with Google and cannot be, since there is exactly one
 * registered URI on the control plane so that moving hosts never breaks it. A
 * user who reached that flow would get a redirect_uri_mismatch error page.
 */
const CONNECT_URL = 'https://app.usejarvis.dev/account';

function routes(google: Record<string, string> | undefined) {
  return createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: {
      daemon: { port: 3142, data_dir: '/tmp/jarvis', db_path: '/tmp/jarvis/jarvis.db' },
      ...(google ? { google } : {}),
    } as JarvisConfig,
  } as ApiContext) as Record<string, { GET?: Handler; POST?: Handler }>;
}

describe('managed (hosted) Google mode', () => {
  it('status reports managed + where to connect', async () => {
    const r = routes({
      client_id: 'cid',
      client_secret: 'sec',
      notify_secret: 'a'.repeat(64),
      connect_url: CONNECT_URL,
    });
    const body = (await (await r['/api/auth/google/status']!.GET!(
      new Request('http://localhost/api/auth/google/status'),
    )).json()) as {
      managed: boolean;
      connect_url: string;
      status: string;
      is_authenticated: boolean;
    };
    expect(body.managed).toBe(true);
    expect(body.connect_url).toBe(CONNECT_URL);
    // The MAPPING is the assertion, relative to whatever token file this machine
    // happens to have: unauthenticated + managed must read "not_connected", NOT
    // "credentials_saved" — there are no credentials for the user to save here,
    // and telling them to would be the old self-hosted story. Written this way
    // because GoogleAuth resolves its path through os.homedir(), which Bun fixes
    // at process start and no test can redirect.
    expect(body.status).toBe(body.is_authenticated ? 'connected' : 'not_connected');
  });

  it('a self-hosted instance is NOT managed', async () => {
    const r = routes({ client_id: 'cid', client_secret: 'sec' });
    const body = (await (await r['/api/auth/google/status']!.GET!(
      new Request('http://localhost/api/auth/google/status'),
    )).json()) as { managed: boolean; status: string; is_authenticated: boolean };
    // Its own credentials form and OAuth flow are the RIGHT ui there.
    expect(body.managed).toBe(false);
    expect(body.status).toBe(body.is_authenticated ? 'connected' : 'credentials_saved');
  });

  it('the daemon OAuth flow is refused when managed, and points at the account page', async () => {
    const r = routes({
      client_id: 'cid',
      client_secret: 'sec',
      connect_url: CONNECT_URL,
    });
    const res = await r['/api/auth/google/init']!.POST!(
      new Request('http://localhost/api/auth/google/init', { method: 'POST' }),
    );
    // Refused at the API, not merely hidden in the UI: otherwise a stale tab or a
    // direct call still starts a flow that can only end in redirect_uri_mismatch.
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain(CONNECT_URL);
  });

  it('the daemon OAuth flow still works for a self-hosted instance', async () => {
    const r = routes({ client_id: 'cid', client_secret: 'sec' });
    const res = await r['/api/auth/google/init']!.POST!(
      new Request('http://localhost/api/auth/google/init', { method: 'POST' }),
    );
    // The hosted change must not break the self-hosted product.
    expect(res.status).not.toBe(409);
  });
});
