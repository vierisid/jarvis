/**
 * Site Builder — HTTP/WebSocket Proxy
 *
 * Proxies requests to project dev servers running on localhost.
 *
 * Two routing modes on the same port:
 *  1. Explicit:  /api/sites/:id/proxy/*  → sets __proj cookie, proxies to dev server
 *  2. Catch-all: any unmatched path      → reads __proj cookie, proxies to dev server
 *
 * Because the iframe uses allow-same-origin, absolute paths emitted by
 * frameworks (e.g. /src/main.tsx) naturally hit the main server. The
 * catch-all picks them up via the cookie — zero URL rewriting needed.
 *
 * Trust boundary: the dev server runs agent-authored code, and this proxy
 * serves it on the DASHBOARD origin. So nothing that authenticates the
 * dashboard may cross to the dev server (the HttpOnly panel_session cookie
 * would let that code replay a live session against any /api route), and
 * nothing the dev server answers may set state on the dashboard origin
 * (Set-Cookie could overwrite panel_session; Clear-Site-Data, HSTS, NEL and
 * friends are origin-wide and outlive the preview). A service worker script
 * never reaches the dev server: registered from the preview it would control
 * the whole dashboard origin long after the preview closed, so the fetch gets
 * a script that unregisters itself (service-worker-kill-switch.ts).
 *
 * What this does NOT fix: scripts in the preview still run same-origin with
 * the dashboard and can call /api with the browser's own cookie while the
 * preview is open. Dropping allow-same-origin (or a CSP sandbox) strips the
 * cookie from every subresource and HMR request the preview makes, and the
 * auth gate then refuses them all, so the real fix is serving previews from
 * a separate origin.
 */

import type { DevServerManager } from './dev-server-manager.ts';
import { isServiceWorkerScriptRequest, serviceWorkerKillSwitch } from '../comms/service-worker-kill-switch.ts';

const PROXY_PATH_REGEX = /^\/api\/sites\/([^/]+)\/proxy(\/.*)?$/;
const COOKIE_NAME = '__proj';

/**
 * Request headers that carry dashboard credentials. Cookie is dropped whole:
 * the dev server needs none of the dashboard's cookies (the proxy reads
 * __proj itself before forwarding), and a site cookie set from the preview
 * would share the jar with panel_session anyway.
 */
const STRIPPED_REQUEST_HEADERS = [
  'cookie',
  'authorization',
  'proxy-authorization',
  'x-debug-rpc-token',
  'x-api-key',
  // Identity an auth gateway in front of the daemon adds per request.
  'x-forwarded-access-token',
  'x-forwarded-user',
  'x-forwarded-email',
];

/**
 * Header prefixes stripped on the way to the dev server: this daemon's own
 * headers, and the credentials and identity common auth gateways inject
 * (Cloudflare Access, oauth2-proxy, AWS ALB OIDC, Azure App Service auth,
 * Google IAP, Pomerium, authentik). Where the gateway is the only auth layer,
 * its assertion is a full credential. The list is NOT exhaustive: a gateway
 * not named here still leaks its headers, which a separate preview origin
 * would end.
 */
const STRIPPED_REQUEST_PREFIXES = [
  'x-jarvis-',
  'cf-access-',
  'x-auth-request-',
  'x-amzn-oidc-',
  'x-ms-token-',
  'x-ms-client-principal',
  'x-goog-iap-',
  'x-goog-authenticated-user-',
  'x-pomerium-',
  'x-authentik-',
];

/** Response headers that set state on the dashboard origin, not the page. */
const STRIPPED_RESPONSE_HEADERS = [
  'set-cookie',
  'set-cookie2',
  'clear-site-data',
  'service-worker-allowed',
  'strict-transport-security',
  'alt-svc',
  'nel',
  'report-to',
  'reporting-endpoints',
  'set-login',
  'secure-session-registration',
  'sec-session-registration',
  'sec-session-challenge',
  'accept-ch',
  'critical-ch',
  'observe-browsing-topics',
];

const STRIPPED_RESPONSE_PREFIXES = ['attribution-reporting-register-'];

function deleteMatching(headers: Headers, names: string[], prefixes: string[]): Headers {
  for (const name of names) headers.delete(name);
  for (const name of [...headers.keys()]) {
    if (prefixes.some((prefix) => name.startsWith(prefix))) headers.delete(name);
  }
  return headers;
}

function forwardRequestHeaders(source: Headers): Headers {
  return deleteMatching(new Headers(source), STRIPPED_REQUEST_HEADERS, STRIPPED_REQUEST_PREFIXES);
}

function returnResponseHeaders(source: Headers): Headers {
  return deleteMatching(new Headers(source), STRIPPED_RESPONSE_HEADERS, STRIPPED_RESPONSE_PREFIXES);
}

export class SiteProxy {
  constructor(private devServerManager: DevServerManager) {}

  /**
   * Check if a pathname matches the explicit proxy pattern.
   */
  matchProxy(pathname: string): { projectId: string; subPath: string } | null {
    const match = pathname.match(PROXY_PATH_REGEX);
    if (!match) return null;
    return {
      projectId: match[1]!,
      subPath: match[2] || '/',
    };
  }

  /**
   * Proxy an HTTP request to a project's dev server (explicit route).
   * Sets the __proj cookie so the catch-all can route subsequent requests.
   */
  async proxyHttp(req: Request, projectId: string, subPath: string): Promise<Response> {
    const port = this.devServerManager.getPort(projectId);
    if (port === null) {
      return Response.json({ error: `Dev server for "${projectId}" is not running` }, { status: 502 });
    }

    const resp = await this.forward(req, port, subPath);
    // Set cookie so the catch-all knows which project subsequent requests belong to
    resp.headers.append('set-cookie', `${COOKIE_NAME}=${projectId}; Path=/; SameSite=Lax`);
    return resp;
  }

  /**
   * Proxy an HTTP request using the __proj cookie (catch-all route).
   * Returns null if no cookie or project isn't running.
   */
  async proxyCatchAll(req: Request, pathname: string): Promise<Response | null> {
    const projectId = this.projectFromCookie(req);
    if (!projectId) return null;

    const port = this.devServerManager.getPort(projectId);
    if (port === null) return null;

    return this.forward(req, port, pathname);
  }

  /**
   * Get the WebSocket target URL for a proxied connection.
   */
  getWebSocketTarget(projectId: string, subPath: string): string | null {
    const port = this.devServerManager.getPort(projectId);
    if (port === null) return null;
    return `ws://127.0.0.1:${port}${subPath}`;
  }

  /**
   * Get the WebSocket target URL using the __proj cookie (catch-all).
   */
  getWebSocketTargetFromCookie(req: Request, pathname: string): string | null {
    const projectId = this.projectFromCookie(req);
    if (!projectId) return null;
    const port = this.devServerManager.getPort(projectId);
    if (port === null) return null;
    return `ws://127.0.0.1:${port}${pathname}`;
  }

  // ── Internal ──

  private projectFromCookie(req: Request): string | null {
    const cookies = req.headers.get('cookie') || '';
    const m = cookies.match(/__proj=([^;]+)/);
    return m?.[1] ?? null;
  }

  private async forward(req: Request, targetPort: number, path: string): Promise<Response> {
    const targetUrl = `http://127.0.0.1:${targetPort}${path}`;

    // A service worker registered from the preview would control the whole
    // dashboard origin; no preview needs one. The daemon answers these before
    // routing too (websocket.ts); this keeps the proxy safe on its own.
    if (isServiceWorkerScriptRequest(req)) return serviceWorkerKillSwitch();

    try {
      const headers = forwardRequestHeaders(req.headers);
      headers.delete('host');
      headers.set('host', `127.0.0.1:${targetPort}`);

      const clientIp = req.headers.get('x-forwarded-for')
        || req.headers.get('x-real-ip')
        || '127.0.0.1';
      headers.set('x-forwarded-for', clientIp);
      headers.set('x-forwarded-proto', 'http');

      const init: RequestInit = {
        method: req.method,
        headers,
        redirect: 'manual',
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.body = req.body;
      }

      const resp = await fetch(targetUrl, init);
      const respHeaders = returnResponseHeaders(resp.headers);

      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const safeMsg = rawMsg
        .replace(/127\.0\.0\.1:\d+/g, '<dev-server>')
        .replace(/\/home\/[^\s"']*/g, '<path>');
      return Response.json({ error: `Proxy error: ${safeMsg}` }, { status: 502 });
    }
  }

}
