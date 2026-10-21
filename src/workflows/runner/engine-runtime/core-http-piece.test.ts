/**
 * #961: the vendored HTTP piece as the engine runs it -- its compiled
 * `dist/` -- carries the egress guard and sends a request that is not a read
 * once. `http-egress.test.ts` covers the guard itself; this proves the piece
 * is wired to it, so a vendor sync that dropped the patch would fail here.
 *
 * Needs the compiled piece. Like the other engine suites it skips without one,
 * and CI builds it in the engine step (`JARVIS_TEST_ENGINE_BUILD=1`).
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ENGINE_BUILD_PATHS } from './build';
import { buildPiece } from './build-pieces';
import { EGRESS_POLICY_ENV } from '../../runtime/http-egress';

const pieceDir = resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/core/http');
const bundle = resolve(pieceDir, 'dist/src/index.js');
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const skip = !buildOptIn && !existsSync(bundle);
const require = createRequire(import.meta.url);

type Run = (context: { propsValue: Record<string, unknown> }) => Promise<unknown>;
let run: Run;
const dns = require('node:dns') as { lookup: (...args: unknown[]) => void };
const realLookup = dns.lookup;
let lookups: string[] = [];

describe.skipIf(skip)('the compiled core HTTP piece', () => {
  beforeAll(async () => {
    if (buildOptIn) await buildPiece(pieceDir);
    const mod = require(bundle) as { http: { getAction(name: string): { run: Run } | undefined } };
    run = mod.http.getAction('send_request')!.run;
  });
  afterEach(() => {
    dns.lookup = realLookup;
    delete process.env[EGRESS_POLICY_ENV];
  });

  // A name that resolves nowhere: every attempt costs exactly one lookup, and
  // nothing is ever sent, so the count is the number of attempts.
  const failingLookup = () => {
    lookups = [];
    dns.lookup = ((host: string, _opts: unknown, cb: (e: Error) => void) => {
      lookups.push(host);
      cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
    }) as never;
  };
  const props = (method: string, extra: Record<string, unknown> = {}) => ({ method, url: 'http://ops.invalid/logs', headers: {},
    queryParams: {}, authType: 'NONE', body_type: 'none', failureMode: 'retry_all', ...extra });

  test('a request that is not a read is sent once, even with "Retry on all errors"; a read is tried three times', async () => {
    failingLookup();
    await expect(run({ propsValue: props('POST') })).rejects.toBeDefined();
    expect(lookups).toEqual(['ops.invalid']);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      failingLookup();
      await expect(run({ propsValue: props(method) })).rejects.toBeDefined();
      expect(`${method}: ${lookups.length}`).toBe(`${method}: 1`);
    }
    failingLookup();
    await expect(run({ propsValue: props('GET') })).rejects.toBeDefined();
    expect(lookups).toEqual(['ops.invalid', 'ops.invalid', 'ops.invalid']);
  });

  test('loopback and metadata are refused by name or literal, under either policy, and a refusal is not retried', async () => {
    for (const policy of [undefined, 'private-allowed']) {
      if (policy) process.env[EGRESS_POLICY_ENV] = policy; else delete process.env[EGRESS_POLICY_ENV];
      for (const url of ['http://localhost:9/x', 'http://127.0.0.1:9/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:9/x']) {
        await expect(run({ propsValue: props('GET', { url }) })).rejects.toThrow(/refused/);
      }
    }
  });

  test('a private address is refused on a hosted engine, which is what an engine told nothing is', async () => {
    lookups = [];
    dns.lookup = ((host: string, _opts: unknown, cb: (e: null, a: unknown) => void) => {
      lookups.push(host);
      cb(null, [{ address: '10.20.30.40', family: 4 }]);
    }) as never;
    await expect(run({ propsValue: props('GET', { url: 'http://nas.internal/status' }) })).rejects.toThrow(/reach only public addresses/);
    // Refused once, not retried.
    expect(lookups).toEqual(['nas.internal']);
  });

  test('a proxy is refused rather than used without the check', async () => {
    await expect(run({ propsValue: props('GET', { use_proxy: true, proxy_settings: { proxy_host: '127.0.0.1', proxy_port: 3128 } }) }))
      .rejects.toThrow(/does not send HTTP steps through a proxy/);
  });
});
