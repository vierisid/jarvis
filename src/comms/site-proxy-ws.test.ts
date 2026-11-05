import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Server } from 'bun';
import type { DevServerManager } from '../sites/dev-server-manager.ts';
import { SiteProxy } from '../sites/proxy.ts';
import { WebSocketServer } from './websocket.ts';

/**
 * The dev-server HMR bridge, end to end. The stand-in upstream behaves like
 * Vite >= 6.0.9: it upgrades only a socket that asks for `vite-hmr` AND
 * carries its `?token=`, and echoes the protocol back.
 */
let upstream: Server<{ protocol: string }>;
let daemon: WebSocketServer;
const PORT = 3162;
const upgrades: Array<{ search: string; protocol: string | null }> = [];

beforeAll(() => {
  upstream = Bun.serve<{ protocol: string }>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      const url = new URL(req.url);
      const protocol = req.headers.get('sec-websocket-protocol');
      upgrades.push({ search: url.search, protocol });
      if (protocol !== 'vite-hmr' || url.searchParams.get('token') !== 'vite-secret') {
        return new Response('refused', { status: 400 });
      }
      if (server.upgrade(req, { data: { protocol }, headers: { 'Sec-WebSocket-Protocol': 'vite-hmr' } })) return undefined;
      return new Response('upgrade failed', { status: 500 });
    },
    websocket: {
      message(ws, msg) { ws.send(`echo:${msg}`); },
    },
  });
  daemon = new WebSocketServer(PORT);
  daemon.setInsecureOpenAccess(true);
  const manager = { getPort: (id: string) => (id === 'proj1' ? upstream.port! : null) };
  daemon.setSiteProxy(new SiteProxy(manager as unknown as DevServerManager));
  daemon.start();
});

afterAll(() => {
  daemon.stop();
  upstream.stop(true);
});

async function roundTrip(url: string): Promise<{ protocol: string; reply: string } | 'failed'> {
  const ws = new WebSocket(url, 'vite-hmr');
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('failed'), 3000);
      ws.onopen = () => ws.send('ping');
      ws.onmessage = (e) => { clearTimeout(timer); resolve({ protocol: ws.protocol, reply: String(e.data) }); };
      ws.onerror = () => { clearTimeout(timer); resolve('failed'); };
      ws.onclose = () => { clearTimeout(timer); resolve('failed'); };
    });
  } finally {
    try { ws.close(); } catch { /* closed */ }
  }
}

test('the explicit proxy route bridges a Vite HMR socket with its token and subprotocol', async () => {
  upgrades.length = 0;
  const result = await roundTrip(`ws://localhost:${PORT}/api/sites/proj1/proxy/?token=vite-secret`);
  expect(upgrades.at(-1)).toEqual({ search: '?token=vite-secret', protocol: 'vite-hmr' });
  expect(result).toEqual({ protocol: 'vite-hmr', reply: 'echo:ping' });
});

test('the cookie-routed catch-all bridges it too', async () => {
  upgrades.length = 0;
  const ws = new WebSocket(`ws://localhost:${PORT}/?token=vite-secret`, { protocols: ['vite-hmr'], headers: { Cookie: '__proj=proj1' } } as any);
  const result = await new Promise<{ protocol: string; reply: string } | 'failed'>((resolve) => {
    const timer = setTimeout(() => resolve('failed'), 3000);
    ws.onopen = () => ws.send('ping');
    ws.onmessage = (e) => { clearTimeout(timer); resolve({ protocol: ws.protocol, reply: String(e.data) }); };
    ws.onerror = () => { clearTimeout(timer); resolve('failed'); };
  });
  try { ws.close(); } catch { /* closed */ }
  expect(upgrades.at(-1)).toEqual({ search: '?token=vite-secret', protocol: 'vite-hmr' });
  expect(result).toEqual({ protocol: 'vite-hmr', reply: 'echo:ping' });
});

test('an OPTIONS request without a panel session never reaches the dev server', async () => {
  const seen: string[] = [];
  const dev = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { seen.push(`${req.method} ${new URL(req.url).pathname}`); return new Response('dev'); } });
  const gated = new WebSocketServer(3165);
  gated.setSiteProxy(new SiteProxy({ getPort: () => dev.port! } as unknown as DevServerManager));
  gated.start();
  try {
    for (const path of ['/api/sites/proj1/proxy/', '/src/main.tsx']) {
      const res = await fetch(`http://localhost:3165${path}`, { method: 'OPTIONS', headers: { Cookie: '__proj=proj1' } });
      expect(await res.text()).not.toBe('dev');
    }
    expect(seen).toEqual([]);
  } finally {
    gated.stop();
    dev.stop(true);
  }
});
