import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  // The doorbell key and the refresh key: different derivations, so a mix-up of
  // the two cannot pass a test that uses this fixture.
  notify_secret: 'a'.repeat(64),
  refresh_secret: 'c'.repeat(64),
  connect_url: CONNECT_URL,
};

function routes(google: Record<string, string> | undefined, googleTokensPath?: string) {
  return createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    googleTokensPath,
    config: {
      daemon: { port: 3142, data_dir: '/tmp/jarvis', db_path: '/tmp/jarvis/jarvis.db' },
      ...(google ? { google } : {}),
    } as JarvisConfig,
  } as ApiContext) as Record<string, { GET?: Handler; POST?: Handler }>;
}

async function status(r: Record<string, { GET?: Handler }>) {
  return (await (await r['/api/auth/google/status']!.GET!(
    new Request('http://localhost/api/auth/google/status'),
  )).json()) as {
    managed: boolean;
    connect_url: string;
    status: string;
    is_authenticated: boolean;
    configured: boolean;
    reconnect_reason?: string;
    reason?: string;
  };
}

describe('managed (hosted) Google mode', () => {
  it('status reports managed + where to connect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-google-status-'));
    const body = await status(routes(MANAGED, join(dir, 'google-tokens.json')));
    expect(body.managed).toBe(true);
    expect(body.connect_url).toBe(CONNECT_URL);
    // Configured WITHOUT any credentials in the file — the whole point, and the
    // reason the field is no longer called has_credentials.
    expect(body.configured).toBe(true);
    // Managed and unauthenticated must read "not_connected", NOT
    // "credentials_saved" — there are no credentials for the user to save here,
    // and telling them to would be the old self-hosted story. Asserted against an
    // empty tokens directory rather than as a mapping over "whatever this machine
    // happens to have".
    expect(body.status).toBe('not_connected');
    expect(body.is_authenticated).toBe(false);
  });

  it('a self-hosted instance is NOT managed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-google-self-'));
    const body = await status(
      routes({ client_id: 'cid', client_secret: 'sec' }, join(dir, 'google-tokens.json')),
    );
    // Its own credentials form and OAuth flow are the RIGHT ui there.
    expect(body.managed).toBe(false);
    expect(body.is_authenticated).toBe(false);
    expect(body.status).toBe('credentials_saved');
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
      instance_id: MANAGED.instance_id,
      // ...but no refresh_secret, so nothing here could sign a refresh request.
      client_id: 'cid',
      client_secret: 'sec',
    });
    const body = (await (await r['/api/auth/google/status']!.GET!(
      new Request('http://localhost/api/auth/google/status'),
    )).json()) as { status: string; configured: boolean; reason?: string };
    expect(body.configured).toBe(false);
    expect(body.status).toBe('not_configured');
    // ...and it says WHY, because this shape is a config we refused rather than a
    // deployment that simply does not run Google.
    expect(body.reason).toContain('refresh_url');
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

  it('POST /api/config/google is NOT swallowed by the managed guard when self-hosted', async () => {
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

  it('a connected instance reads connected; a REVOKED grant reads reconnect_required', async () => {
    // Previously untestable, and so untested: the route resolved the tokens path
    // through os.homedir(), which Bun fixes at process start — the older test in
    // this file even says so and asserts a mapping instead. With the path injected
    // both branches can be driven, which matters because "tokens on disk" and
    // "Google works" are exactly the two things this endpoint must stop
    // conflating: a revoked grant leaves the file untouched.
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-google-status-'));
    const tokensPath = join(dir, 'google-tokens.json');
    try {
      await Bun.write(
        tokensPath,
        JSON.stringify({
          access_token: 'a',
          refresh_token: '1//r',
          expiry_date: Date.now() + 3_600_000,
          token_type: 'Bearer',
        }),
      );
      const connected = await status(routes(MANAGED, tokensPath));
      expect(connected).toMatchObject({
        managed: true,
        configured: true,
        is_authenticated: true,
        status: 'connected',
      });

      // The verdict the refresh path records when the control plane says the
      // grant is gone. Same tokens on disk; opposite answer.
      await Bun.write(
        `${tokensPath}.reconnect`,
        JSON.stringify({
          tokenHash: createHash('sha256').update('1//r').digest('hex'),
          message: 'Google access is no longer valid — connect Google again',
        }),
      );
      const revoked = await status(routes(MANAGED, tokensPath));
      expect(revoked).toMatchObject({
        managed: true,
        // NOT authenticated, which is what puts the Connect button back in front
        // of the user instead of a green chip over a dead integration.
        is_authenticated: false,
        status: 'reconnect_required',
        connect_url: CONNECT_URL,
      });
      expect(revoked.reconnect_reason).toContain('connect Google again');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
