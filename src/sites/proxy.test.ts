import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import type { DevServerManager } from './dev-server-manager.ts';
import { SiteProxy } from './proxy.ts';

/**
 * The site dev server runs agent-authored code. The proxy sits on the
 * dashboard origin, so whatever it forwards to the dev server is readable by
 * that code, and whatever it passes back lands on the dashboard origin. These
 * tests stand up a real dev-server stand-in on loopback and assert what
 * crosses the proxy in each direction.
 */

let devServer: Server<undefined>;
// Copied inside the handler: Bun recycles a Request once its response is
// sent, so reading its headers afterwards sees nothing and every "was not
// forwarded" assertion would pass vacuously.
let seen: Array<{ url: string; headers: Headers }> = [];
let respondWith: () => Response = () => new Response('ok');

function proxy(): SiteProxy {
  const manager = { getPort: (id: string) => (id === 'proj1' ? devServer.port! : null) };
  return new SiteProxy(manager as unknown as DevServerManager);
}

function dashboardRequest(path: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost:3142${path}`, { headers });
}

beforeAll(() => {
  devServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      seen.push({ url: req.url, headers: new Headers(req.headers) });
      return respondWith();
    },
  });
});

afterAll(() => {
  devServer.stop(true);
});

beforeEach(() => {
  seen = [];
  respondWith = () => new Response('ok');
});

describe('SiteProxy request headers', () => {
  const credentialed = {
    cookie: 'panel_session=live-session-id; __proj=proj1; other=1',
    authorization: 'Bearer dashboard-secret',
    'proxy-authorization': 'Basic abc',
    'x-debug-rpc-token': 'debug-secret',
    'x-api-key': 'api-secret',
    'x-jarvis-signature': 'sig',
    'cf-access-jwt-assertion': 'gateway-jwt',
    'cf-access-client-secret': 'gateway-secret',
    'x-forwarded-access-token': 'gateway-token',
    'x-auth-request-access-token': 'gateway-token',
    'x-amzn-oidc-accesstoken': 'gateway-token',
    'x-ms-token-aad-access-token': 'gateway-token',
    'x-ms-client-principal': 'gateway-principal',
    'x-goog-iap-jwt-assertion': 'gateway-jwt',
    'x-goog-authenticated-user-email': 'accounts.google.com:me@example.com',
    'x-pomerium-jwt-assertion': 'gateway-jwt',
    'x-authentik-jwt': 'gateway-jwt',
    'x-forwarded-user': 'me',
    'x-forwarded-email': 'me@example.com',
    'x-forwarded-groups': 'admins',
    'remote-user': 'me',
    'remote-email': 'me@example.com',
    'tailscale-user-login': 'me@example.com',
    'x-webauth-user': 'me',
    accept: 'text/html',
  };

  test('the explicit route forwards no dashboard cookie or credential to the dev server', async () => {
    const resp = await proxy().proxyHttp(dashboardRequest('/api/sites/proj1/proxy/', credentialed), 'proj1', '/');
    expect(resp.status).toBe(200);
    expect(seen).toHaveLength(1);
    const h = seen[0]!.headers;
    for (const name of Object.keys(credentialed)) {
      if (name !== 'accept') expect([name, h.get(name)]).toEqual([name, null]);
    }
    // Non-credential headers still pass, so the strip is targeted.
    expect(h.get('accept')).toBe('text/html');
  });

  test('the cookie-routed catch-all forwards no dashboard cookie either', async () => {
    const resp = await proxy().proxyCatchAll(dashboardRequest('/src/main.tsx', credentialed), '/src/main.tsx');
    expect(resp?.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
    expect(seen[0]!.headers.get('authorization')).toBeNull();
    expect(new URL(seen[0]!.url).pathname).toBe('/src/main.tsx');
  });

  test('a service worker script fetch gets the self-unregistering script, never the dev server', async () => {
    for (const p of [proxy().proxyCatchAll(dashboardRequest('/sw.js', { cookie: '__proj=proj1', 'service-worker': 'script' }), '/sw.js'),
      proxy().proxyHttp(dashboardRequest('/api/sites/proj1/proxy/sw.js', { 'service-worker': 'script' }), 'proj1', '/sw.js')]) {
      const resp = (await p)!;
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toStartWith('text/javascript');
      // Lets it replace a root-scoped worker whose script is below the root.
      expect(resp.headers.get('service-worker-allowed')).toBe('/');
      expect(await resp.text()).toContain('self.registration.unregister()');
    }
    expect(seen).toHaveLength(0);
  });
});

describe('SiteProxy response headers', () => {
  test('dev-server Set-Cookie and origin-wide state headers never reach the browser', async () => {
    respondWith = () => {
      const h = new Headers({ 'content-type': 'text/html', 'x-custom': 'kept' });
      h.append('set-cookie', 'panel_session=attacker; Path=/');
      h.append('set-cookie', 'other=1; Path=/');
      h.set('clear-site-data', '"cookies", "storage"');
      h.set('service-worker-allowed', '/');
      h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
      h.set('alt-svc', 'h2=":443"');
      h.set('nel', '{"report_to":"x","max_age":31536000}');
      h.set('report-to', '{"group":"x","max_age":31536000,"endpoints":[{"url":"https://evil.example/r"}]}');
      h.set('reporting-endpoints', 'x="https://evil.example/r"');
      h.set('set-login', 'logged-in');
      h.set('secure-session-registration', '(ES256);path="/reg";challenge="c"');
      h.set('sec-session-registration', '(ES256);path="/reg";challenge="c"');
      h.set('sec-session-challenge', '"c"');
      h.set('accept-ch', 'Sec-CH-UA-Full-Version-List');
      h.set('critical-ch', 'Sec-CH-UA-Full-Version-List');
      h.set('observe-browsing-topics', '?1');
      h.set('attribution-reporting-register-source', '{}');
      h.set('attribution-reporting-register-trigger', '{}');
      return new Response('<p>hi</p>', { headers: h });
    };
    const resp = await proxy().proxyHttp(dashboardRequest('/api/sites/proj1/proxy/', {}), 'proj1', '/');
    expect(resp.status).toBe(200);
    // The only cookie set is the proxy's own routing cookie.
    expect(resp.headers.getSetCookie()).toEqual(['__proj=proj1; Path=/; SameSite=Lax']);
    for (const name of ['clear-site-data', 'service-worker-allowed', 'strict-transport-security', 'alt-svc', 'nel', 'report-to',
      'reporting-endpoints', 'set-login', 'secure-session-registration', 'sec-session-registration', 'sec-session-challenge', 'accept-ch', 'critical-ch',
      'observe-browsing-topics', 'attribution-reporting-register-source', 'attribution-reporting-register-trigger']) {
      expect([name, resp.headers.get(name)]).toEqual([name, null]);
    }
    expect(resp.headers.get('x-custom')).toBe('kept');
    expect(resp.headers.get('content-type')).toBe('text/html');
    expect(await resp.text()).toBe('<p>hi</p>');
  });

  test('the catch-all drops a dev-server Set-Cookie too', async () => {
    respondWith = () => new Response('x', { headers: { 'set-cookie': 'panel_session=attacker; Path=/' } });
    const resp = await proxy().proxyCatchAll(dashboardRequest('/x', { cookie: '__proj=proj1' }), '/x');
    expect(resp?.headers.getSetCookie()).toEqual([]);
  });
});
