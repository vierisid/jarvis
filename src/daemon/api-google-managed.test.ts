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

/**
 * A REAL managed block: no client_id, no client_secret. Fixtures that carried
 * them let every "is this managed?" branch pass on the credentials clause
 * instead of the hosted one — the exact confusion this mode exists to end.
 */
const MANAGED = {
  refresh_url: 'https://app.usejarvis.dev/api/integrations/google/refresh',
  instance_id: 'inst-1',
  notify_secret: 'a'.repeat(64),
  connect_url: CONNECT_URL,
};

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
    const r = routes(MANAGED);
    const body = (await (await r['/api/auth/google/status']!.GET!(
      new Request('http://localhost/api/auth/google/status'),
    )).json()) as {
      managed: boolean;
      connect_url: string;
      status: string;
      is_authenticated: boolean;
      has_credentials: boolean;
    };
    expect(body.managed).toBe(true);
    expect(body.connect_url).toBe(CONNECT_URL);
    // Configured WITHOUT any credentials in the file — the whole point.
    expect(body.has_credentials).toBe(true);
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
    const r = routes(MANAGED);
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

  it('a partial managed block disables Google rather than using the file credentials', async () => {
    // A config carrying refresh_url but not instance_id/notify_secret is one we
    // mis-rendered. Falling through to the client_id/client_secret also present
    // would silently put a hosted instance back on the shared secret — and
    // nothing would look wrong, because Google would keep working.
    const r = routes({
      refresh_url: MANAGED.refresh_url,
      client_id: 'cid',
      client_secret: 'sec',
    });
    const body = (await (await r['/api/auth/google/status']!.GET!(
      new Request('http://localhost/api/auth/google/status'),
    )).json()) as { status: string; has_credentials: boolean };
    expect(body.has_credentials).toBe(false);
    expect(body.status).toBe('not_configured');
  });

  it('POST /api/config/google is refused when managed', async () => {
    // It REPLACES the whole google section, so one call from a stale tab used to
    // drop refresh_url, instance_id and notify_secret from the running config —
    // refresh dead, doorbell 404, hosted UI gone, no error anywhere.
    const r = routes(MANAGED);
    const res = await r['/api/config/google']!.POST!(
      new Request('http://localhost/api/config/google', {
        method: 'POST',
        body: JSON.stringify({ client_id: 'cid', client_secret: 'sec' }),
      }),
    );
    expect(res.status).toBe(409);
  });

  it('POST /api/config/google still works for a self-hosted instance', async () => {
    const r = routes({ client_id: 'old', client_secret: 'old' });
    const res = await r['/api/config/google']!.POST!(
      new Request('http://localhost/api/config/google', {
        method: 'POST',
        body: JSON.stringify({ client_id: '', client_secret: '' }),
      }),
    );
    // Rejected for its EMPTY body (400), not for being managed (409) — the
    // guard must not have swallowed the self-hosted path with it.
    expect(res.status).toBe(400);
  });
});
