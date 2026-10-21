/**
 * #961: the HTTP step's egress guard. Every test here talks to a real server
 * through real axios and Node's http transport, so it checks where the
 * connection actually goes, not only what the classifier says.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import axios from 'axios';
import type { LookupAddress } from 'node:dns';
import { addressAllowed, assertHostAllowed, canonicalAddress, classifyAddress, destinationAllowed, egressGuardedAxios, egressPolicyFromEnv,
  guardedFileDownload, guardedLookup, interfaceAddresses, EGRESS_POLICY_ENV, EgressRefusedError } from './http-egress';

describe('which addresses the HTTP step may reach', () => {
  const table: Array<[string, 'public' | 'private' | 'blocked']> = [
    ['93.184.216.34', 'public'], ['8.8.8.8', 'public'], ['1.1.1.1', 'public'],
    ['10.1.2.3', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.1.10', 'private'],
    ['100.64.0.1', 'private'], ['100.127.255.254', 'private'],
    ['172.15.255.255', 'public'], ['172.32.0.0', 'public'], ['100.63.255.255', 'public'], ['100.128.0.0', 'public'],
    ['127.0.0.1', 'blocked'], ['127.255.255.254', 'blocked'], ['0.0.0.0', 'blocked'], ['0.1.2.3', 'blocked'],
    ['169.254.169.254', 'blocked'], ['169.254.0.1', 'blocked'], ['100.100.100.200', 'blocked'], ['192.0.0.192', 'blocked'],
    ['168.63.129.16', 'blocked'], ['::ffff:168.63.129.16', 'blocked'], ['168.63.129.15', 'public'], ['168.63.129.17', 'public'],
    ['192.0.2.1', 'blocked'], ['198.51.100.1', 'blocked'], ['203.0.113.9', 'blocked'], ['198.18.0.1', 'blocked'],
    ['192.88.99.1', 'blocked'], ['224.0.0.1', 'blocked'], ['239.255.255.250', 'blocked'], ['255.255.255.255', 'blocked'], ['240.0.0.1', 'blocked'],
    ['2606:4700:4700::1111', 'public'], ['2a00:1450:4001:80b::200e', 'public'], ['2001:4860:4860::8888', 'public'],
    ['fd12:3456:789a::1', 'private'], ['fc00::1', 'private'],
    ['::1', 'blocked'], ['::', 'blocked'], ['fe80::1', 'blocked'], ['fd00:ec2::254', 'blocked'], ['ff02::1', 'blocked'],
    ['2001:db8::1', 'blocked'], ['2001::1', 'blocked'], ['2002:7f00:1::1', 'blocked'], ['64:ff9b::7f00:1', 'blocked'],
    ['::ffff:127.0.0.1', 'blocked'], ['::ffff:7f00:1', 'blocked'], ['::ffff:10.0.0.1', 'private'], ['::ffff:8.8.8.8', 'public'],
    ['::127.0.0.1', 'blocked'], ['[::1]', 'blocked'], ['fe80::1%eth0', 'blocked'],
    ['', 'blocked'], ['localhost', 'blocked'], ['1.2.3', 'blocked'], ['256.1.1.1', 'blocked'], ['1:2:3:4:5:6:7:8:9', 'blocked'],
  ];
  for (const [address, kind] of table) test(`${address || '(empty)'} is ${kind}`, () => expect(classifyAddress(address)).toBe(kind));

  test('a hosted engine reaches only public addresses; a self-hosted one also reaches private ranges, never loopback or metadata', () => {
    for (const [address, kind] of table) {
      expect(`${address}: ${addressAllowed(address, 'public-only')}`).toBe(`${address}: ${kind === 'public'}`);
      expect(`${address}: ${addressAllowed(address, 'private-allowed')}`).toBe(`${address}: ${kind !== 'blocked'}`);
    }
  });

  test('this machine\'s own addresses are refused under either policy, however they are spelled', () => {
    const own = new Set(['192.168.1.179', '172.17.0.1', '203.0.113.50', canonicalAddress('2a01:4f8::1')!]);
    for (const address of ['192.168.1.179', '::ffff:192.168.1.179', '172.17.0.1', '2a01:4f8:0:0::1']) {
      expect(`${address}: ${destinationAllowed(address, 'private-allowed', own)}`).toBe(`${address}: false`);
    }
    expect(destinationAllowed('192.168.1.180', 'private-allowed', own)).toBe(true);
    expect(destinationAllowed('93.184.216.34', 'public-only', own)).toBe(true);
    // The real interface list holds at least loopback, and every entry reads back canonical.
    const real = interfaceAddresses();
    expect(real.has('127.0.0.1')).toBe(true);
    for (const address of real) expect(canonicalAddress(address)).toBe(address);
  });

  test('an engine told nothing applies the hosted rule', () => {
    expect(egressPolicyFromEnv({})).toBe('public-only');
    expect(egressPolicyFromEnv({ [EGRESS_POLICY_ENV]: 'yes' })).toBe('public-only');
    expect(egressPolicyFromEnv({ [EGRESS_POLICY_ENV]: 'private-allowed' })).toBe('private-allowed');
  });

  test('an IP literal is checked as it stands; a name is left to the lookup', () => {
    expect(() => assertHostAllowed('127.0.0.1', 'private-allowed')).toThrow(EgressRefusedError);
    expect(() => assertHostAllowed('[::1]', 'private-allowed')).toThrow(EgressRefusedError);
    expect(() => assertHostAllowed('10.0.0.5', 'public-only')).toThrow(/reach only public addresses/);
    expect(() => assertHostAllowed('10.0.0.5', 'private-allowed')).not.toThrow();
    expect(() => assertHostAllowed('ops.example.test', 'public-only')).not.toThrow();
  });

  test('a name is refused when ANY address it resolves to is outside the policy', async () => {
    const resolveTo = (addresses: string[]) => (_host: string, _opts: unknown, cb: (e: Error | null, a: LookupAddress[]) => void) =>
      cb(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
    const ask = (addresses: string[], all: boolean) => new Promise<{ error: Error | null; result: unknown }>((resolve) =>
      guardedLookup('public-only', resolveTo(addresses))('x.test', { all }, (error, address) => resolve({ error, result: address })));
    expect((await ask(['93.184.216.34', '169.254.169.254'], true)).error).toBeInstanceOf(EgressRefusedError);
    expect((await ask([], true)).error).toBeInstanceOf(EgressRefusedError);
    expect(await ask(['93.184.216.34', '1.1.1.1'], true)).toEqual({ error: null,
      result: [{ address: '93.184.216.34', family: 4 }, { address: '1.1.1.1', family: 4 }] });
    expect(await ask(['93.184.216.34'], false)).toEqual({ error: null, result: '93.184.216.34' });
  });
});

describe('the guarded client connects only where it checked', () => {
  let server: Server;
  let port = 0;
  const seen: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.headers.host} ${req.url}`);
      if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
      if (req.url === '/to-blocked-name') { res.writeHead(302, { location: `http://internal.test:${port}/secret` }); res.end(); return; }
      if (req.url === '/to-other-origin') { res.writeHead(307, { location: `http://other.test:${port}/landing` }); res.end(); return; }
      if (req.url === '/to-same-origin') { res.writeHead(307, { location: '/landing' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  // The server is on loopback, which the real policy always refuses; this
  // seam lets exactly 127.0.0.1 through so a request can complete, and every
  // other address is judged as production judges it.
  const onlyLocal = (address: string) => address === '127.0.0.1';
  const names: Record<string, string> = { 'ops.test': '127.0.0.1', 'other.test': '127.0.0.1', 'internal.test': '127.0.0.2' };
  let lookups: string[] = [];
  const resolve = (host: string, _opts: unknown, cb: (e: Error | null, a: LookupAddress[]) => void) => {
    lookups.push(host);
    const address = names[host];
    return address ? cb(null, [{ address, family: 4 }]) : cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }), []);
  };
  // A short timeout: were the guard to regress, a refusal test would otherwise
  // wait minutes on an unroutable address instead of failing.
  const FAST = 3_000;
  const client = (read: boolean, allowAddress?: (a: string) => boolean) =>
    egressGuardedAxios(axios, 'public-only', { read, resolve, timeoutMs: FAST, ...(allowAddress ? { allowAddress } : {}) });

  test('a name is connected to at the address its lookup checked, with one lookup', async () => {
    lookups = []; seen.length = 0;
    const response = await client(true, onlyLocal).request({ method: 'GET', url: `http://ops.test:${port}/ok`, maxRedirects: 0 });
    expect(response.data).toEqual({ ok: true, url: '/ok' });
    // ops.test exists nowhere but in this lookup, so reaching the server proves the connection used it.
    expect(lookups).toEqual(['ops.test']);
    expect(seen).toEqual([`GET ops.test:${port} /ok`]);
  });

  test('with the real policy, a name resolving to loopback is refused before any connection', async () => {
    seen.length = 0;
    const refused = client(true).request({ method: 'GET', url: `http://ops.test:${port}/ok`, maxRedirects: 0 });
    await expect(refused).rejects.toThrow(/refused: it resolves to 127.0.0.1/);
    // As itself, not a transport error the piece's client would report as a bare 500.
    await expect(refused).rejects.toBeInstanceOf(EgressRefusedError);
    expect(seen).toEqual([]);
  });

  test('an IP literal outside the policy is refused before any connection', async () => {
    seen.length = 0;
    for (const host of ['127.0.0.1', '[::1]', '169.254.169.254', '0.0.0.0']) {
      await expect(client(true).request({ method: 'GET', url: `http://${host}:${port}/ok`, maxRedirects: 0 })).rejects.toThrow(EgressRefusedError);
    }
    expect(seen).toEqual([]);
  });

  test('a redirect is checked before it is followed: to a metadata literal, and to a name that resolves inward', async () => {
    seen.length = 0;
    await expect(client(true, onlyLocal).request({ method: 'GET', url: `http://ops.test:${port}/to-metadata` })).rejects.toThrow(/169\.254\.169\.254/);
    await expect(client(true, onlyLocal).request({ method: 'GET', url: `http://ops.test:${port}/to-metadata` })).rejects.toBeInstanceOf(EgressRefusedError);
    await expect(client(true, onlyLocal).request({ method: 'GET', url: `http://ops.test:${port}/to-blocked-name` })).rejects.toThrow(/127\.0\.0\.2/);
    expect(seen).toEqual([`GET ops.test:${port} /to-metadata`, `GET ops.test:${port} /to-metadata`, `GET ops.test:${port} /to-blocked-name`]);
  });

  test('a request that is not a read follows a redirect on its own origin only', async () => {
    seen.length = 0;
    const same = await client(false, onlyLocal).request({ method: 'POST', url: `http://ops.test:${port}/to-same-origin`, data: { a: 1 } });
    expect(same.data).toEqual({ ok: true, url: '/landing' });
    await expect(client(false, onlyLocal).request({ method: 'POST', url: `http://ops.test:${port}/to-other-origin`, data: { a: 1 } }))
      .rejects.toThrow(/redirected to another origin/);
    expect(seen).toEqual([`POST ops.test:${port} /to-same-origin`, `POST ops.test:${port} /landing`, `POST ops.test:${port} /to-other-origin`]);
    // A read may follow it.
    expect((await client(true, onlyLocal).request({ method: 'GET', url: `http://ops.test:${port}/to-other-origin` })).data).toEqual({ ok: true, url: '/landing' });
  });

  test('an agent, a socket path or a proxy on the request cannot route around the check', async () => {
    seen.length = 0;
    const { Agent } = await import('node:http');
    await expect(client(true).request({ method: 'GET', url: `http://ops.test:${port}/ok`, maxRedirects: 0, httpAgent: new Agent(),
      proxy: { protocol: 'http', host: '127.0.0.1', port }, socketPath: undefined })).rejects.toThrow(/ops\.test refused: it resolves to 127\.0\.0\.1/);
    expect(seen).toEqual([]);
  });

  test('a keep-alive socket another request left open is not reused past the check', async () => {
    seen.length = 0;
    const { Agent } = await import('node:http');
    // An unguarded request -- another piece's -- leaves a pooled socket to ops.test on the global agent.
    const plainLookup = (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
      opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
    await axios.request({ method: 'GET', url: `http://ops.test:${port}/ok`, maxRedirects: 0, adapter: 'http', lookup: plainLookup as never,
      httpAgent: (await import('node:http')).globalAgent });
    const pooled = new Agent({ keepAlive: true });
    await axios.request({ method: 'GET', url: `http://ops.test:${port}/ok`, maxRedirects: 0, adapter: 'http', lookup: plainLookup as never,
      httpAgent: pooled });
    await expect(client(true).request({ method: 'GET', url: `http://ops.test:${port}/ok`, maxRedirects: 0 })).rejects.toThrow(/refused: it resolves to 127\.0\.0\.1/);
    expect(seen).toEqual([`GET ops.test:${port} /ok`, `GET ops.test:${port} /ok`]);
    pooled.destroy();
  });

  test('a file property URL is downloaded through the same guard, redirects included', async () => {
    seen.length = 0;
    const file = await guardedFileDownload(axios, `http://ops.test:${port}/ok`, 'public-only', { resolve, allowAddress: onlyLocal, timeoutMs: FAST });
    expect(JSON.parse(file.data.toString('utf8'))).toEqual({ ok: true, url: '/ok' });
    await expect(guardedFileDownload(axios, `http://127.0.0.1:${port}/ok`, 'private-allowed', { timeoutMs: FAST })).rejects.toBeInstanceOf(EgressRefusedError);
    await expect(guardedFileDownload(axios, `http://ops.test:${port}/ok`, 'private-allowed', { resolve, timeoutMs: FAST })).rejects.toBeInstanceOf(EgressRefusedError);
    await expect(guardedFileDownload(axios, `http://ops.test:${port}/to-metadata`, 'public-only', { resolve, allowAddress: onlyLocal, timeoutMs: FAST }))
      .rejects.toBeInstanceOf(EgressRefusedError);
    expect(seen).toEqual([`GET ops.test:${port} /ok`, `GET ops.test:${port} /to-metadata`]);
  });

  test('only http and https are spoken', async () => {
    await expect(client(true).request({ method: 'GET', url: 'file:///etc/passwd' })).rejects.toThrow(/not http or https/);
  });
});
