import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('withSecurityHeaders keeps a header the route set and handles immutable responses', () => {
  const own = new Response('x', { headers: { 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" } });
  const out = withSecurityHeaders(own);
  expect(out.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(out.headers.get('x-frame-options')).toBe('SAMEORIGIN');

  const immutable = Response.error();
  expect(() => withSecurityHeaders(immutable)).not.toThrow();
});
