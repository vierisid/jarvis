import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import os from 'node:os';
import { buildPayload, sendPing } from './client.ts';
import { telemetryEndpoint } from './constants.ts';

describe('buildPayload', () => {
  test('contains exactly the four expected fields, all non-empty', () => {
    const p = buildPayload(process.cwd());
    expect(Object.keys(p).sort()).toEqual(['anon_id', 'app_version', 'install_method', 'os']);
    expect(p.anon_id).toMatch(/^[0-9a-f]{32}$/);
    expect(p.app_version.length).toBeGreaterThan(0);
    expect(p.install_method.length).toBeGreaterThan(0);
    expect(p.os).toBe(`${process.platform}/${process.arch}`);
  });

  test('carries no raw hostname', () => {
    const hostname = os.hostname();
    // Skip on the degenerate empty-hostname case so we never trivially pass.
    if (hostname.length > 2) {
      expect(JSON.stringify(buildPayload(process.cwd()))).not.toContain(hostname);
    }
  });

  test('does not throw even when the package root is bogus', () => {
    expect(() => buildPayload('/nonexistent/path/to/nowhere')).not.toThrow();
  });
});

describe('telemetryEndpoint', () => {
  test('resolves to the configured Supabase collector', () => {
    const ep = telemetryEndpoint();
    expect(ep).not.toBeNull();
    expect(ep?.url).toMatch(/^https:\/\/.+\.supabase\.co\/rest\/v1\/telemetry_pings$/);
    expect(ep?.key.length).toBeGreaterThan(0);
  });
});

const PAYLOAD = { anon_id: 'x', app_version: '0.0.0', install_method: 'dev', os: 'linux/x64' } as const;

describe('sendPing failure handling (never throws)', () => {
  test('unconfigured endpoint -> {ok:false, reason:unconfigured}', async () => {
    const out = await sendPing(PAYLOAD, { endpoint: null });
    expect(out).toEqual({ ok: false, reason: 'unconfigured' });
  });

  // A real loopback server lets us prove the HTTP/network branches rather
  // than mock fetch. Each test points sendPing at a throwaway endpoint.
  describe('against a local server', () => {
    let server: ReturnType<typeof Bun.serve>;
    let received: unknown = null;

    beforeAll(() => {
      server = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === '/ok') {
            received = await req.json();
            return new Response(null, { status: 201 });
          }
          if (url.pathname === '/boom') return new Response('nope', { status: 500 });
          if (url.pathname === '/slow') {
            await Bun.sleep(2000);
            return new Response(null, { status: 201 });
          }
          return new Response(null, { status: 404 });
        },
      });
    });

    afterAll(() => server.stop(true));

    const ep = (path: string) => ({ url: `http://localhost:${server.port}${path}`, key: 'test-key' });

    test('2xx -> {ok:true} and posts the exact payload', async () => {
      const out = await sendPing(PAYLOAD, { endpoint: ep('/ok') });
      expect(out.ok).toBe(true);
      expect(out.status).toBe(201);
      expect(received).toEqual(PAYLOAD);
    });

    test('5xx -> {ok:false, reason:http, status:500}', async () => {
      const out = await sendPing(PAYLOAD, { endpoint: ep('/boom') });
      expect(out).toEqual({ ok: false, reason: 'http', status: 500 });
    });

    test('timeout -> {ok:false, reason:timeout}', async () => {
      const out = await sendPing(PAYLOAD, { endpoint: ep('/slow'), timeoutMs: 100 });
      expect(out).toEqual({ ok: false, reason: 'timeout' });
    });
  });

  test('unreachable host -> {ok:false} (network or timeout, never throws)', async () => {
    // Port 1 is never listening. Some OSes refuse instantly (network),
    // others silently drop until our timeout fires -- both are acceptable
    // non-fatal outcomes; the contract is "ok:false, no throw".
    const out = await sendPing(PAYLOAD, {
      endpoint: { url: 'http://127.0.0.1:1/x', key: 'k' },
      timeoutMs: 1000,
    });
    expect(out.ok).toBe(false);
    expect(out.reason === 'network' || out.reason === 'timeout').toBe(true);
  });

  test('malformed URL -> {ok:false, reason:network} (no throw)', async () => {
    const out = await sendPing(PAYLOAD, { endpoint: { url: 'not-a-url', key: 'k' } });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('network');
  });
});
