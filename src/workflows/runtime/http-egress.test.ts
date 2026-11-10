/**
 * #961: the HTTP step's egress guard. Every test here talks to a real server
 * through real axios and Node's http transport, so it checks where the
 * connection actually goes, not only what the classifier says.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import axios from 'axios';
import type { LookupAddress } from 'node:dns';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { MAX_RESPONSE_BYTES, ResponseTooLargeError, resolveGuardedAddress, addressAllowed, assertHostAllowed, canonicalAddress, classifyAddress, destinationAllowed, egressGuardedAxios, egressPolicyFromEnv,
  egressRefusalIn, guardedFileDownload, guardedLookup, interfaceAddresses, EGRESS_POLICY_ENV, EgressRefusedError, readHostKey, refusedBeforeSend, withReadHosts } from './http-egress';

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
      const big = /^\/big\?n=(\d+)(&chunked)?$/u.exec(req.url ?? '');
      if (big) {
        const n = Number(big[1]);
        // Chunked: no length up front, so only counting the bytes can stop it.
        res.writeHead(200, big[2] ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/octet-stream', 'content-length': String(n) });
        const chunk = Buffer.alloc(1024 * 1024, 120);
        let left = n;
        const pump = () => { while (left > 0) { const part = chunk.subarray(0, Math.min(left, chunk.length)); left -= part.length; if (!res.write(part)) { res.once('drain', pump); return; } } res.end(); };
        pump();
        return;
      }
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

  test('#1153: a response larger than a step can carry is refused, with or without a length; up to it is read', async () => {
    // The engine's run-data ceiling (logging-utils.ts: 10 MiB default, 256 KiB error offset), base64 for a binary body.
    const logging = readFileSync(resolvePath(import.meta.dir, '../activepieces/packages/server/engine/src/lib/helper/logging-utils.ts'), 'utf8');
    expect(logging).toContain("const DEFAULT_MAX_LOG_SIZE_FOR_TESTING = '10'");
    expect(logging).toContain('const ERROR_OFFSET = 256 * 1024');
    expect(MAX_RESPONSE_BYTES).toBe(((10 * 1024 * 1024 - 256 * 1024) * 3) / 4);
    expect(Number.isInteger(MAX_RESPONSE_BYTES)).toBe(true);
    const get = (n: number, chunked = false) => client(true, onlyLocal).request({ method: 'GET', url: `http://ops.test:${port}/big?n=${n}${chunked ? '&chunked' : ''}`, responseType: 'arraybuffer' });
    expect((await get(MAX_RESPONSE_BYTES)).data.byteLength).toBe(MAX_RESPONSE_BYTES);
    await expect(get(MAX_RESPONSE_BYTES + 1)).rejects.toBeInstanceOf(ResponseTooLargeError);
    await expect(get(MAX_RESPONSE_BYTES + 1, true)).rejects.toBeInstanceOf(ResponseTooLargeError);
    // A refusal, so the pieces fail the step on it rather than retry or continue past it.
    expect(egressRefusalIn(await get(MAX_RESPONSE_BYTES + 1).catch((e) => e))).toBeInstanceOf(ResponseTooLargeError);
    // Raised after the request went out, which a "refused, so not sent" reading must not miss.
    expect(new ResponseTooLargeError('x').afterSend).toBe(true);
    // A larger cap a request asks for is not honoured; a smaller one is.
    await expect(client(true, onlyLocal).request({ method: 'GET', url: `http://ops.test:${port}/big?n=${MAX_RESPONSE_BYTES + 1}`, maxContentLength: -1 })).rejects.toThrow(/maxContentLength/);
    await expect(client(true, onlyLocal).request({ method: 'GET', url: `http://ops.test:${port}/big?n=2048`, maxContentLength: 1024 })).rejects.toThrow(/maxContentLength/);
    // A stream would escape the cap, so it is refused; redirects stay at follow-redirects' default or fewer.
    await expect(client(true, onlyLocal).request({ method: 'GET', url: `http://ops.test:${port}/ok`, responseType: 'stream' })).rejects.toBeInstanceOf(EgressRefusedError);
    let seenConfig: { maxRedirects?: number } = {};
    const probe = client(true, onlyLocal);
    // Registered after the guard's, so it runs before it; the guard then sets the same config object.
    probe.interceptors.request.use((config) => { seenConfig = config; return config; });
    await probe.request({ method: 'GET', url: `http://ops.test:${port}/ok`, maxRedirects: 1000 });
    expect(seenConfig.maxRedirects).toBe(21);
    // The engine's file download is held to the same size.
    await expect(guardedFileDownload(axios, `http://ops.test:${port}/big?n=${MAX_RESPONSE_BYTES + 1}`, 'public-only', { resolve, allowAddress: onlyLocal, timeoutMs: FAST }))
      .rejects.toBeInstanceOf(ResponseTooLargeError);
  }, 30_000);

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

  test('#1153: a refusal before sending reads as not sent; one after a request went out (a refused redirect) does not', async () => {
    const reason = async (p: Promise<unknown>) => { try { await p; } catch (error) { return error; } throw new Error('expected a refusal'); };
    // Before: the name resolves inward, an IP literal, a host off the read list. Nothing reached the server.
    seen.length = 0;
    for (const before of [
      await reason(client(false).request({ method: 'POST', url: `http://ops.test:${port}/ok`, data: { a: 1 }, maxRedirects: 0 })),
      await reason(client(false).request({ method: 'POST', url: `http://127.0.0.1:${port}/ok`, data: { a: 1 } })),
      await reason(withReadHosts(['other.test'], () => client(true, onlyLocal).request({ method: 'GET', url: `http://ops.test:${port}/ok` }))),
    ]) expect(refusedBeforeSend(before)).toBe(true);
    expect(seen).toEqual([]);
    // After: each of these requests reached the server, and only its redirect was refused,
    // whether by the hop check (another origin, a metadata literal) or by the next hop's lookup.
    for (const after of [
      await reason(client(false, onlyLocal).request({ method: 'POST', url: `http://ops.test:${port}/to-other-origin`, data: { a: 1 } })),
      await reason(client(false, onlyLocal).request({ method: 'POST', url: `http://ops.test:${port}/to-metadata`, data: { a: 1 } })),
      await reason(client(false, onlyLocal).request({ method: 'POST', url: `http://ops.test:${port}/to-blocked-name`, data: { a: 1 } })),
    ]) {
      expect(after).toBeInstanceOf(EgressRefusedError);
      expect(refusedBeforeSend(after)).toBe(false);
    }
    expect(seen.length).toBe(3);
    // A transport error is not a refusal, and another bundle's copy keeps afterSend.
    expect(refusedBeforeSend(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))).toBe(false);
    expect(refusedBeforeSend({ cause: Object.assign(new Error('x'), { code: 'ERR_EGRESS_REFUSED', afterSend: true }) })).toBe(false);
    expect(refusedBeforeSend({ cause: Object.assign(new Error('x'), { code: 'ERR_EGRESS_REFUSED' }) })).toBe(true);
    expect(refusedBeforeSend(new ResponseTooLargeError('big'))).toBe(false);
  });

  test('#1153: a read that ran without asking reaches listed hosts only, its redirects included', async () => {
    seen.length = 0;
    // Built inside the scope, as the HTTP piece builds its client inside the authorized run.
    const listed = (hosts: string[], url: string) => withReadHosts(hosts, () => client(true, onlyLocal).request({ method: 'GET', url }));
    // A listed host's redirect to an unlisted one is refused before it is followed.
    await expect(listed(['ops.test'], `http://ops.test:${port}/to-other-origin`)).rejects.toThrow(/a redirect goes to other\.test, which is not on this flow's read list/);
    // To a listed host it is followed, and a same-host redirect always is.
    expect((await listed(['ops.test', 'OTHER.test'], `http://ops.test:${port}/to-other-origin`)).data).toEqual({ ok: true, url: '/landing' });
    expect((await listed(['ops.test'], `http://ops.test:${port}/to-same-origin`)).data).toEqual({ ok: true, url: '/landing' });
    // The first hop is held to the list too.
    await expect(listed(['other.test'], `http://ops.test:${port}/plain`)).rejects.toBeInstanceOf(EgressRefusedError);
    // An empty list reaches nothing.
    await expect(listed([], `http://ops.test:${port}/plain`)).rejects.toThrow(/not on this flow's read list/);
    expect(seen).toEqual([`GET ops.test:${port} /to-other-origin`, `GET ops.test:${port} /to-other-origin`, `GET other.test:${port} /landing`,
      `GET ops.test:${port} /to-same-origin`, `GET ops.test:${port} /landing`]);
    // A Host header naming another virtual host on the listed address is refused before sending.
    await expect(withReadHosts(['ops.test'], () => client(true, onlyLocal).request({ method: 'GET', url: `http://ops.test:${port}/plain`, headers: { Host: 'tenant.example' } })))
      .rejects.toThrow(/may not set its own Host header/);
    expect(seen).toHaveLength(5);
    // Outside the scope (an approved request, or any other step) a read still follows another origin.
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

describe('#961: a non-HTTP connection (SMTP, SFTP, FTP) is resolved once and connects to the checked address', () => {
  const resolver = (answers: Record<string, string[]>, seen: string[]) =>
    ((host: string, _opts: unknown, cb: (e: Error | null, a: LookupAddress[]) => void) => {
      seen.push(host);
      const list = answers[host];
      if (!list) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }), []);
      cb(null, list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
    }) as never;

  test('a name is resolved once and the first checked address is what the client connects to', async () => {
    const seen: string[] = [];
    await expect(resolveGuardedAddress('mail.example.com', 'public-only', { label: 'SMTP connection', resolve: resolver({ 'mail.example.com': ['93.184.216.34', '93.184.216.35'] }, seen) }))
      .resolves.toBe('93.184.216.34');
    expect(seen).toEqual(['mail.example.com']);
    // IPv4 first when a name has both, whatever order DNS answered in.
    await expect(resolveGuardedAddress('dual.example.com', 'public-only', { label: 'SMTP connection',
      resolve: resolver({ 'dual.example.com': ['2606:2800:220:1:248:1893:25c8:1946', '93.184.216.34'] }, []) })).resolves.toBe('93.184.216.34');
    await expect(resolveGuardedAddress('v6.example.com', 'public-only', { label: 'SMTP connection',
      resolve: resolver({ 'v6.example.com': ['2606:2800:220:1:248:1893:25c8:1946'] }, []) })).resolves.toBe('2606:2800:220:1:248:1893:25c8:1946');
  });

  test('a name with ANY address outside the policy is refused, naming the connection', async () => {
    const seen: string[] = [];
    await expect(resolveGuardedAddress('mixed.example.com', 'private-allowed', { label: 'SFTP connection', resolve: resolver({ 'mixed.example.com': ['93.184.216.34', '127.0.0.1'] }, seen) }))
      .rejects.toThrow(/^SFTP connection to mixed\.example\.com refused: it resolves to 127\.0\.0\.1/);
    await expect(resolveGuardedAddress('nas.lan', 'public-only', { label: 'FTP connection', resolve: resolver({ 'nas.lan': ['192.168.1.5'] }, []) }))
      .rejects.toThrow(/reach only public addresses/);
    await expect(resolveGuardedAddress('nas.lan', 'private-allowed', { label: 'FTP connection', resolve: resolver({ 'nas.lan': ['192.168.1.5'] }, []) }))
      .resolves.toBe('192.168.1.5');
  });

  test('a literal is checked without a lookup, brackets and all; an empty host is refused', async () => {
    const seen: string[] = [];
    const opts = { label: 'SMTP connection', resolve: resolver({}, seen) };
    await expect(resolveGuardedAddress('[::1]', 'private-allowed', opts)).rejects.toThrow(/refused/);
    await expect(resolveGuardedAddress('169.254.169.254', 'private-allowed', opts)).rejects.toThrow(/refused/);
    await expect(resolveGuardedAddress('93.184.216.34', 'public-only', opts)).resolves.toBe('93.184.216.34');
    await expect(resolveGuardedAddress('[2606:2800:220:1:248:1893:25c8:1946]', 'public-only', opts)).resolves.toBe('2606:2800:220:1:248:1893:25c8:1946');
    await expect(resolveGuardedAddress('  ', 'public-only', opts)).rejects.toThrow(/no host/);
    expect(seen).toEqual([]);
  });
});

describe('#1153: read-list host names', () => {
  test('a bare host in URL hostname form; anything else is not one', () => {
    expect(readHostKey('API.Example.com')).toBe('api.example.com');
    expect(readHostKey('example.com.')).toBe('example.com');
    expect(readHostKey('b\u00fccher.de')).toBe('xn--bcher-kva.de');
    expect(readHostKey('[::1]')).toBe('::1');
    expect(readHostKey('10.0.0.1')).toBe('10.0.0.1');
    for (const bad of ['', ' ', 'a.com:443', 'a.com/x', 'https://a.com', '*.a.com', 'u@a.com', 'a b', 'a.com?x', 'a.com#x', 'a\\b', 7, null]) {
      expect(readHostKey(bad)).toBeNull();
    }
  });
});

