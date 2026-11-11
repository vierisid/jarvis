import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from './websocket.ts';

// A route that throws and does not catch it must not reach the caller as
// Bun's HTML error page (absolute paths, source lines). The daemon answers a
// plain JSON 500 and keeps the cause in its log.

// A unix socket, not a fixed port: parallel runs must not collide.
const dir = mkdtempSync(join(tmpdir(), 'jarvis-error-fallback-'));
const socket = join(dir, 'api.sock');
let server: WebSocketServer | null = null;
afterEach(() => { if (server?.isRunning()) server.stop(); server = null; rmSync(dir, { recursive: true, force: true }); });

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
    }
  } finally {
    console.error = logged;
  }
});
