import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DevServerManager } from '../sites/dev-server-manager.ts';
import { SiteProxy } from '../sites/proxy.ts';
import { WebSocketServer } from './websocket.ts';
import { withSecurityHeaders } from './security-headers.ts';

function expectBaseline(res: Response) {
  expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('same-origin');
}

test('dashboard HTML, the 401 page and API JSON all carry the framing and nosniff headers', async () => {
  const staticDir = mkdtempSync(path.join(tmpdir(), 'jarvis-sechdr-'));
  const srv = new WebSocketServer(3211);
  try {
    await Bun.write(path.join(staticDir, 'index.html'), '<!doctype html><title>Jarvis</title>');
    srv.setStaticDir(staticDir);
    srv.start();

    // Logged-out dashboard: the 401 HTML page.
    const page401 = await fetch('http://localhost:3211/');
    expect(page401.status).toBe(401);
    expectBaseline(page401);

    // API JSON 401, and the public health route.
    const api = await fetch('http://localhost:3211/api/health');
    expect(api.status).toBe(401);
    expect(api.headers.get('x-content-type-options')).toBe('nosniff');
    expectBaseline(await fetch('http://localhost:3211/health'));
  } finally {
    srv.stop();
    rmSync(staticDir, { recursive: true, force: true });
  }
});

test('the served dashboard HTML (open access) is not framable by another origin', async () => {
  const staticDir = mkdtempSync(path.join(tmpdir(), 'jarvis-sechdr-'));
  const srv = new WebSocketServer(3212);
  srv.setInsecureOpenAccess(true);
  try {
    await Bun.write(path.join(staticDir, 'index.html'), '<!doctype html><title>Jarvis</title>');
    srv.setStaticDir(staticDir);
    srv.start();
    const res = await fetch('http://localhost:3212/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expectBaseline(res);
  } finally {
    srv.stop();
    rmSync(staticDir, { recursive: true, force: true });
  }
});

test('withSecurityHeaders keeps a header the route set', () => {
  const own = new Response('x', { headers: { 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" } });
  const out = withSecurityHeaders(own);
  expect(out.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(out.headers.get('x-frame-options')).toBe('SAMEORIGIN');
});

test('withSecurityHeaders rebuilds a response whose headers refuse writes, and passes a network error through', async () => {
  // Bun's own Response headers are always writable (Response.error() and
  // fetch() included), so the read-only case is built by hand.
  class ReadOnlyHeaders extends Headers {
    override set(): void { throw new TypeError('immutable'); }
  }
  const locked = new Response('body', { status: 404, headers: { 'X-Mine': '1' } });
  Object.defineProperty(locked, 'headers', { value: new ReadOnlyHeaders(locked.headers) });
  const out = withSecurityHeaders(locked);
  expect(out).not.toBe(locked);
  expect(out.status).toBe(404);
  expect(out.headers.get('x-mine')).toBe('1');
  expectBaseline(out);
  expect(await out.text()).toBe('body');

  const networkError = Response.error();
  Object.defineProperty(networkError, 'headers', { value: new ReadOnlyHeaders() });
  expect(withSecurityHeaders(networkError)).toBe(networkError);
});

test('a route that throws still answers with the headers, not the bare default error page', async () => {
  const srv = new WebSocketServer(3213);
  srv.setInsecureOpenAccess(true);
  srv.setApiRoutes({ '/api/boom': { GET: () => { throw new Error('route-source-detail'); } } });
  try {
    srv.start();
    const res = await fetch('http://localhost:3213/api/boom');
    expect(res.status).toBe(500);
    expectBaseline(res);
    expect(await res.text()).not.toContain('route-source-detail');
  } finally {
    srv.stop();
  }
});

test('a proxied site preview is framable by the dashboard only, and keeps its own page behaviour', async () => {
  let upstreamHeaders: Record<string, string> = {};
  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('<!doctype html><title>preview</title>', { headers: { 'Content-Type': 'text/html', ...upstreamHeaders } }),
  });
  const srv = new WebSocketServer(3214);
  srv.setInsecureOpenAccess(true);
  srv.setSiteProxy(new SiteProxy({ getPort: (id: string) => (id === 'proj1' ? upstream.port! : null) } as unknown as DevServerManager));
  try {
    srv.start();
    // Explicit route and the cookie-routed catch-all both relay the page.
    for (const [url, init] of [
      ['http://localhost:3214/api/sites/proj1/proxy/', {}],
      ['http://localhost:3214/src/main.tsx', { headers: { Cookie: '__proj=proj1' } }],
    ] as const) {
      const res = await fetch(url, init);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('preview');
      // The dashboard (same origin) may frame it; another origin may not.
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      // The previewed site behaves as it would on its own server.
      expect(res.headers.get('referrer-policy')).toBeNull();
      expect(res.headers.get('x-content-type-options')).toBeNull();
    }

    // What the dev server sets itself comes through untouched.
    upstreamHeaders = { 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Content-Security-Policy': "default-src 'self'" };
    const own = await fetch('http://localhost:3214/api/sites/proj1/proxy/');
    expect(own.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(own.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(own.headers.get('x-frame-options')).toBe('SAMEORIGIN');

    // A proxy error is the daemon's own answer and gets the full set.
    const down = await fetch('http://localhost:3214/api/sites/nope/proxy/');
    expect(down.status).toBe(502);
    expectBaseline(down);
  } finally {
    srv.stop();
    upstream.stop(true);
  }
});
