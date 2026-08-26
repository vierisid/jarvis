import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { issueTrialEntitlement, startTrialClock } from '../trial/entitlement.ts';
import { ACCESS_TOKEN_TTL_SECONDS } from '../sidecar/manager.ts';
import { TRIAL_SESSION_RENEW_MS } from '../../ui/src/v2/trial/sessionRenew.ts';

/**
 * The founder said yes, three key results landed in their vault, and their
 * screen did not change. Not because the write failed, not because the room
 * was never opened, and not because it was never told to re-fetch. All three
 * of those were fine. The re-fetch was REFUSED.
 *
 * The dashboard's data plane authenticates with a ten-minute sidecar access
 * token in an HttpOnly cookie. The /ws socket authenticates once, at upgrade,
 * and then lives as long as the socket. The trial is the first surface that
 * keeps one page open for an hour, so it is the first place those two facts
 * ever meet: past the tenth minute the conversation is still perfect and every
 * room under it is quietly refusing to load.
 *
 * These tests pin the two halves of the fix. The endpoint may only ever extend
 * a session that a trial is running behind, and the cadence the trial renews at
 * has to stay well inside the credential it is renewing.
 */

type Handler = (req: Request) => Response | Promise<Response>;

const PATH = '/api/trial/session/renew';

function handler(routes: Record<string, unknown>): Handler {
  const route = routes[PATH] as { POST?: Handler } | undefined;
  if (!route?.POST) throw new Error(`POST ${PATH} not registered`);
  return route.POST;
}

/** A sidecar manager that answers about tokens and nothing else. */
function fakeSidecars(opts: { verifies?: boolean; mints?: boolean } = {}) {
  const verifies = opts.verifies ?? true;
  const mints = opts.mints ?? true;
  return {
    minted: [] as string[],
    manager: {
      verifyAccessToken: async (tok: string) =>
        verifies && tok === 'live-token' ? { sid: 'sid-1' } : null,
      issueAccessToken: async (sid: string) =>
        mints ? { token: `fresh-for-${sid}`, expiresIn: ACCESS_TOKEN_TTL_SECONDS } : null,
    } as unknown as ApiContext['sidecarManager'],
  };
}

function ctxWith(sidecarManager?: ApiContext['sidecarManager']): ApiContext {
  const config = structuredClone(DEFAULT_CONFIG) as JarvisConfig;
  return {
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config,
    agentService: {} as ApiContext['agentService'],
    sidecarManager,
  } as ApiContext;
}

function post(h: Handler, cookie?: string, url = `http://x${PATH}`): Promise<Response> {
  return Promise.resolve(
    h(new Request(url, { method: 'POST', headers: cookie ? { Cookie: cookie } : {} })),
  );
}

describe(PATH, () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
  });
  afterEach(() => closeDb());

  test('is off on an install with no trial, so no other surface changes', async () => {
    const { manager } = fakeSidecars();
    const res = await post(handler(createApiRoutes(ctxWith(manager))), 'token=live-token');
    expect(res.status).toBe(409);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  test('is off once the trial has expired', async () => {
    const past = Date.now() - 72 * 60 * 60 * 1000;
    issueTrialEntitlement({ now: past });
    startTrialClock(past);
    const { manager } = fakeSidecars();
    const res = await post(handler(createApiRoutes(ctxWith(manager))), 'token=live-token');
    expect(res.status).toBe(409);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  test('hands the running trial a fresh cookie on the same credential', async () => {
    issueTrialEntitlement({ now: Date.now() });
    const { manager } = fakeSidecars();
    const res = await post(handler(createApiRoutes(ctxWith(manager))), 'token=live-token');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, renewed: true, expires_in: ACCESS_TOKEN_TTL_SECONDS });
    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain('token=fresh-for-sid-1');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/');
    // Not Secure over plain http, or the browser drops it and the founder is
    // back where they started with no way to tell.
    expect(cookie).not.toContain('Secure');
  });

  test('marks the cookie Secure behind TLS', async () => {
    issueTrialEntitlement({ now: Date.now() });
    const { manager } = fakeSidecars();
    const res = await post(handler(createApiRoutes(ctxWith(manager))), 'token=live-token', `https://x${PATH}`);
    expect(res.headers.get('Set-Cookie') ?? '').toContain('Secure');
  });

  test('extends a session; it never mints one out of nothing', async () => {
    issueTrialEntitlement({ now: Date.now() });
    const { manager } = fakeSidecars({ verifies: false });
    const res = await post(handler(createApiRoutes(ctxWith(manager))), 'token=someone-elses');
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  test('says so honestly when there is no cookie to renew', async () => {
    // `auth.insecure_open_access`: no credential, nothing expiring, and the
    // page cannot tell by itself because the cookie is HttpOnly.
    issueTrialEntitlement({ now: Date.now() });
    const { manager } = fakeSidecars();
    const res = await post(handler(createApiRoutes(ctxWith(manager))), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, renewed: false });
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });
});

describe('the trial renews inside the credential it is renewing', () => {
  /**
   * THE TEST THAT WOULD HAVE CAUGHT IT.
   *
   * Nothing in the codebase related the lifetime of the founder's PAGE to the
   * lifetime of its credential, so the two were free to be an hour and ten
   * minutes and nobody noticed. This is that relationship, written down.
   */
  test('the cadence leaves room for renewals to fail', () => {
    const ttlMs = ACCESS_TOKEN_TTL_SECONDS * 1000;
    expect(TRIAL_SESSION_RENEW_MS).toBeLessThan(ttlMs);
    // Two whole renewals can fail, silently, and the third still lands before
    // the founder's rooms go blind.
    expect(TRIAL_SESSION_RENEW_MS * 2).toBeLessThan(ttlMs);
  });
});
