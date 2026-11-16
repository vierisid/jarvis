import { afterEach, expect, test } from 'bun:test';
import { WebSocketServer } from './websocket.ts';
import { resetStorageStatus, STORAGE_FULL_MESSAGE } from '../vault/storage-health.ts';

// A route that fails because the disk is full answers in plain words, whether
// it threw or returned the raw SQLite text itself.
const PORT = 3173;
let server: WebSocketServer | null = null;
afterEach(() => { if (server?.isRunning()) server.stop(); server = null; resetStorageStatus(); });

test('full-disk failures answer with the plain message, other errors are untouched', async () => {
  server = new WebSocketServer(PORT);
  server.setInsecureOpenAccess(true);
  server.setApiRoutes({
    '/api/thrown': { GET: () => { throw new Error('SQLiteError: database or disk is full'); } },
    '/api/returned': { GET: () => Response.json({ error: 'database or disk is full' }, { status: 500 }) },
    '/api/other': { GET: () => Response.json({ error: 'something else broke' }, { status: 500 }) },
  });
  server.start();
  for (const path of ['thrown', 'returned']) {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/${path}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: STORAGE_FULL_MESSAGE, code: 'storage_full' });
  }
  const other = await fetch(`http://127.0.0.1:${PORT}/api/other`);
  expect(await other.json()).toEqual({ error: 'something else broke' });
});
