import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from './websocket.ts';
import { createApiRoutes, type ApiContext } from '../daemon/api-routes.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';

// A route that throws and does not catch it must not reach the caller as
// Bun's HTML error page (absolute paths, source lines). The daemon answers a
// plain JSON 500, with the same security headers as every other answer, and
// keeps the cause in its log.

// A unix socket, not a fixed port: parallel runs must not collide.
const dir = mkdtempSync(join(tmpdir(), 'jarvis-error-fallback-'));
const socket = join(dir, 'api.sock');
let server: WebSocketServer | null = null;
afterEach(() => { if (server?.isRunning()) server.stop(); server = null; rmSync(socket, { force: true }); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function expectSecurityHeaders(response: Response) {
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('same-origin');
}

test('an uncaught route error is a plain JSON 500 without internals', async () => {
  server = new WebSocketServer(0, socket);
  server.setInsecureOpenAccess(true);
  server.setApiRoutes({
    '/api/boom': { GET: () => { throw new Error('secret failure at /home/someone/src/thing.ts:12'); } },
    '/api/boom-async': { GET: async () => { throw new TypeError('datatype mismatch'); } },
  });
  server.start();
  const logged = console.error;
  console.error = () => {};
  try {
    for (const path of ['/api/boom', '/api/boom-async']) {
      const response = await fetch(`http://localhost${path}`, { unix: socket });
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(JSON.parse(text)).toEqual({ error: 'Something went wrong on our side. Try again.' });
      expect(text).not.toMatch(/secret|\/home\/|datatype|<html/i);
      expectSecurityHeaders(response);
    }
  } finally {
    console.error = logged;
  }
});

test('a bad request body answered by a real route is a plain 400 with the security headers', async () => {
  initDatabase(':memory:', { quiet: true });
  try {
    server = new WebSocketServer(0, socket);
    server.setInsecureOpenAccess(true);
    server.setApiRoutes(createApiRoutes({ config: {} } as unknown as ApiContext) as Parameters<WebSocketServer['setApiRoutes']>[0]);
    server.start();
    const response = await fetch('http://localhost/api/onboarding/tutorial/progress', {
      unix: socket,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(JSON.parse(text).error).toBe('Request body must be valid JSON.');
    expect(text).not.toMatch(/JSON Parse|SyntaxError|\/home\/|<html/i);
    expectSecurityHeaders(response);
  } finally {
    closeDb();
  }
});
