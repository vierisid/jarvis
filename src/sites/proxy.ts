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
 */

import type { DevServerManager } from './dev-server-manager.ts';

const PROXY_PATH_REGEX = /^\/api\/sites\/([^/]+)\/proxy(\/.*)?$/;
const COOKIE_NAME = '__proj';

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

    try {
      const headers = new Headers(req.headers);
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
      const respHeaders = new Headers(resp.headers);

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
