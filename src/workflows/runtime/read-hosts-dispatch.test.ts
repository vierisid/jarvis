/**
 * #1153: the engine side of the read list. A read the daemon let run without
 * asking comes back with the flow's list, and the piece runs inside it, so the
 * HTTP client it builds there reaches listed hosts only.
 */
import { expect, test } from 'bun:test';
import axios from 'axios';
import type { LookupAddress } from 'node:dns';
import { authorizePieceDispatch, executeAuthorizedPiece, type PieceAuthorizeResponse } from './piece-effect-guard';
import { egressGuardedAxios, EgressRefusedError } from './http-egress';

const HTTP = '@activepieces/piece-http';
const params = (reply: unknown) => ({
  apiUrl: 'http://daemon.invalid', engineToken: 't', stepName: 'get', executionPath: [] as Array<[string, number]>,
  piece: HTTP, action: 'send_request', input: { method: 'GET', url: 'http://ops.test/x' },
  fetchImpl: (async () => new Response(JSON.stringify(reply), { status: 200 })) as unknown as typeof fetch,
});

test('a malformed read list in the authorization is refused', async () => {
  for (const readHosts of ['ops.test', [1], {}]) {
    await expect(authorizePieceDispatch(params({ governed: true, dispatch: 'authorized', readHosts })))
      .rejects.toThrow(/malformed read list/);
  }
  expect(await authorizePieceDispatch(params({ governed: true, dispatch: 'authorized', readHosts: ['ops.test'] })))
    .toEqual({ governed: true, dispatch: 'authorized', readHosts: ['ops.test'] });
});

test('the piece runs inside the read list: its client refuses an unlisted host before any lookup, and is unbound without one', async () => {
  const lookups: string[] = [];
  const resolve = (host: string, _o: unknown, cb: (e: Error | null, a: LookupAddress[]) => void) => {
    lookups.push(host);
    cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }), []);
  };
  const run = (governance: PieceAuthorizeResponse) => executeAuthorizedPiece(params(governance), governance, async () =>
    egressGuardedAxios(axios, 'public-only', { read: true, resolve, timeoutMs: 2_000 }).request({ method: 'GET', url: 'http://ops.test/x' }));
  await expect(run({ governed: true, dispatch: 'authorized', readHosts: ['other.test'] })).rejects.toBeInstanceOf(EgressRefusedError);
  expect(lookups).toEqual([]);
  // Listed: it goes on to the lookup (which this stub fails).
  await expect(run({ governed: true, dispatch: 'authorized', readHosts: ['ops.test'] })).rejects.toThrow(/ENOTFOUND ops\.test/);
  // No list (an approved request): not held to one.
  await expect(run({ governed: true, dispatch: 'authorized' })).rejects.toThrow(/ENOTFOUND ops\.test/);
  expect(lookups).toEqual(['ops.test', 'ops.test']);
});

test('#1153 review: a failure the HTTP step continued past reaches later steps without the request body it sent', async () => {
  const governance: PieceAuthorizeResponse = { governed: true, dispatch: 'authorized' };
  const out = await executeAuthorizedPiece({ ...params(governance), input: { method: 'POST', url: 'http://ops.test/login' } }, governance,
    async () => ({ response: { status: 401, body: 'no' }, request: { body: { username: 'me', password: 'hunter2-SECRET' } } }));
  expect(JSON.stringify(out)).not.toContain('hunter2-SECRET');
  expect(out).toEqual({ response: { status: 401, body: 'no' }, request: { body: null } });
});
