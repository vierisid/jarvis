import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from './websocket.ts';
import { resetDatabaseLost, stopWatchingDatabaseFile, watchDatabaseFile } from '../vault/db-guard.ts';

// A database file deleted under a running daemon: writes would be accepted and
// lost on restart. They get a loud 503 instead; reads, health and the stop
// controls keep answering.
let server: WebSocketServer | null = null;
let dir: string; let dbPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jarvis-ws-db-')); dbPath = join(dir, 'jarvis.db'); writeFileSync(dbPath, 'x'.repeat(8192)); });
afterEach(() => { if (server?.isRunning()) server.stop(); server = null; stopWatchingDatabaseFile(); resetDatabaseLost(); rmSync(dir, { recursive: true, force: true }); });

test('writes get 503 once the database file is gone; reads and Pause still work', async () => {
  const wrote: string[] = [];
  // A unix socket in the temp dir: no fixed TCP port to collide with.
  const socket = join(dir, 'api.sock');
  server = new WebSocketServer(0, socket);
  server.setInsecureOpenAccess(true);
  server.setApiRoutes({
    '/api/things': { GET: () => Response.json({ items: [] }), POST: () => { wrote.push('thing'); return Response.json({ ok: true }, { status: 201 }); } },
    '/api/authority/emergency/pause': { POST: () => Response.json({ ok: true, state: 'paused' }) },
  });
  server.start();
  watchDatabaseFile(dbPath, 60_000);
  const post = (path: string) => fetch(`http://localhost${path}`, { method: 'POST', body: '{}', unix: socket });

  expect((await post('/api/things')).status).toBe(201);
  rmSync(dbPath);

  const refused = await post('/api/things');
  expect(refused.status).toBe(503);
  const body = await refused.json() as { error: string; code: string };
  expect(body.code).toBe('database_lost');
  expect(body.error).toContain('deleted while it was running');
  expect(wrote).toEqual(['thing']);

  expect((await fetch('http://localhost/api/things', { unix: socket })).status).toBe(200);
  expect((await post('/api/authority/emergency/pause')).status).toBe(200);
});
