import { describe, expect, test } from 'bun:test';
import { isOpenAccessHostAllowed } from './open-access-host.ts';
import { WebSocketServer } from './websocket.ts';

describe('isOpenAccessHostAllowed', () => {
  const opts = { corsOrigin: 'https://jarvis.example.com' };

  test('names an attacker cannot rebind are accepted', () => {
    for (const host of [
      'localhost', 'localhost:3142', 'LOCALHOST:3142', 'app.localhost:3142', 'localhost.',
      '127.0.0.1:3142', '192.168.1.10', '[::1]:3142', '[::1]', '[fe80::1]:80',
      'jarvis.example.com', 'jarvis.example.com:443',
    ]) expect({ host, ok: isOpenAccessHostAllowed(host, opts) }).toEqual({ host, ok: true });
  });

  test('any other name, and anything malformed, is refused', () => {
    for (const host of [
      'evil.example:3142', 'rebind.attacker.test', 'localhost.attacker.test', 'example.com',
      'jarvis.example.com.attacker.test', '127.0.0.1.nip.io',
      // LAN names resolve over LLMNR/mDNS, which a LAN peer can answer.
      'deskbox', 'deskbox:3142', 'deskbox.local:3142',
      '', '   ', 'localhost:abc', '[::1', '[::1]x', '999.1.1.1', 'a:b:c',
    ]) expect({ host, ok: isOpenAccessHostAllowed(host, opts) }).toEqual({ host, ok: false });
    expect(isOpenAccessHostAllowed(null, opts)).toBe(false);
  });

  test('without a configured origin only loopback names and IPs pass', () => {
    expect(isOpenAccessHostAllowed('jarvis.example.com')).toBe(false);
    expect(isOpenAccessHostAllowed('localhost:3142')).toBe(true);
  });
});

describe('open access refuses a rebound Host on every non-public route', () => {
  test('dashboard API, /ws and static pages answer 403 for a foreign Host; public routes do not', async () => {
    const server = new WebSocketServer(3160);
    server.setInsecureOpenAccess(true);
    server.setApiRoutes({
      '/api/health': { GET: () => Response.json({ ok: true }) },
      '/api/webhooks/x': { POST: () => Response.json({ ok: true }) },
    });
    server.start();
    try {
      const get = (path: string, host: string, init: RequestInit = {}) =>
        fetch(`http://127.0.0.1:3160${path}`, { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), Host: host } });
      // Same-origin from the browser's view: Origin and Host carry the rebound name.
      const rebound = 'rebind.attacker.test:3160';
      expect((await get('/api/health', rebound)).status).toBe(403);
      expect((await get('/api/health', rebound, { headers: { Origin: `http://${rebound}`, 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(403);
      expect((await get('/ws', rebound, { headers: { Origin: `http://${rebound}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } })).status).toBe(403);
      expect((await get('/', rebound)).status).toBe(403);
      // isPublicRoute passes every OPTIONS; the Host check must not, since the
      // dev-server proxies forward OPTIONS.
      expect((await get('/api/sites/p/proxy/', rebound, { method: 'OPTIONS' })).status).toBe(403);
      expect((await get('/src/main.tsx', rebound, { method: 'OPTIONS' })).status).toBe(403);
      const refused = await get('/api/health', rebound);
      expect(await refused.text()).toContain('daemon.public_url');
      expect((await get('/api/health', 'localhost:3160')).status).toBe(200);
      expect((await get('/api/health', '127.0.0.1:3160')).status).toBe(200);
      // Webhooks are reached through tunnels on any name.
      expect((await get('/api/webhooks/x', rebound, { method: 'POST' })).status).toBe(200);
      expect((await get('/health', rebound)).status).toBe(200);
    } finally {
      server.stop();
    }
  });

  test('with open access off the Host check does not apply (the session cookie is the gate)', async () => {
    const server = new WebSocketServer(3161);
    server.setApiRoutes({ '/api/webhooks/x': { POST: () => Response.json({ ok: true }) } });
    server.start();
    try {
      const res = await fetch('http://127.0.0.1:3161/api/health', { headers: { Host: 'rebind.attacker.test:3161' } });
      expect(res.status).toBe(401);
    } finally {
      server.stop();
    }
  });
});
