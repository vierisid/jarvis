import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoogleAuth } from '../../integrations/google-auth.ts';
import { createGoogleGrantReader } from './verify-grant.ts';
import { GOOGLE_ONBOARDING_SCOPES } from './types.ts';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'on-b-03-grant-')); dirs.push(dir);
  const tokensPath = join(dir, 'google-tokens.json');
  const auth = () => new GoogleAuth('fixture-client', 'fixture-secret', { tokensPath });
  const tokens = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expiry_date: Date.now() + 3_600_000, token_type: 'Bearer' };
  await auth().saveTokens(tokens);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let info: unknown = { aud: 'fixture-client', scope: GOOGLE_ONBOARDING_SCOPES.join(' '), expires_in: '3600' };
  let profile: unknown = { emailAddress: 'alice@example.test' };
  let status = 200, time = 1000;
  let beforeProfile: (() => Promise<void>) | undefined;
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/profile')) { await beforeProfile?.(); return Response.json(profile); }
    return Response.json(info, { status });
  }) as typeof fetch;
  return { read: createGoogleGrantReader({ auth, clientId: 'fixture-client', fetch: request, now: () => time }), auth, calls, tokens, tokensPath,
    elapse: (ms: number) => { time += ms; },
    info: (value: unknown) => { info = value; }, profile: (value: unknown) => { profile = value; },
    status: (value: number) => { status = value; }, beforeProfile: (fn: () => Promise<void>) => { beforeProfile = fn; } };
}
describe('canonical Google grant reader with provider HTTP doubles', () => {
  it('verifies audience, live scope metadata and Gmail identity using real GoogleAuth storage', async () => {
    const f = await fixture();
    expect(await f.read()).toEqual({ state: 'verified', accountLabel: 'alice@example.test', scopes: [...GOOGLE_ONBOARDING_SCOPES] });
    expect(f.calls.map(c => c.url)).toEqual(['https://oauth2.googleapis.com/tokeninfo', 'https://gmail.googleapis.com/gmail/v1/users/me/profile']);
    expect(f.calls[0]!.init?.method).toBe('POST');
    for (const call of f.calls) {
      expect(call.url).not.toContain('fixture-access');
      expect(new Headers(call.init?.headers).get('Authorization')).toBe('Bearer fixture-access');
      expect(call.init?.redirect).toBe('error'); expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it('does not infer scopes from tokens, requested scopes, or a successful exchange', async () => {
    const f = await fixture();
    for (const info of [{}, { aud: 'foreign-client', scope: GOOGLE_ONBOARDING_SCOPES.join(' '), expires_in: 60 },
      { aud: 'fixture-client', scope: GOOGLE_ONBOARDING_SCOPES[0], expires_in: 60 },
      { aud: 'fixture-client', scope: GOOGLE_ONBOARDING_SCOPES.join(' '), expires_in: 0 }]) {
      f.info(info); expect(await f.read()).toEqual({ state: 'unverified' });
    }
    expect(f.calls.every(c => c.url.endsWith('tokeninfo'))).toBe(true);
  });
  it('distinguishes revoked, unavailable and absent grants', async () => {
    const f = await fixture(); f.status(401); expect(await f.read()).toEqual({ state: 'revoked' });
    f.status(503); expect(await f.read()).toEqual({ state: 'unverified' });
    await unlink(f.tokensPath); expect(await f.read()).toEqual({ state: 'absent' });
    expect(f.calls).toHaveLength(2);
  });
  it('does not accept a profile without a bounded usable identity', async () => {
    const f = await fixture();
    for (const emailAddress of ['', null, 'alice', 'alice\n@example.test', 'x'.repeat(321) + '@a']) {
      f.profile({ emailAddress }); expect(await f.read()).toEqual({ state: 'unverified' });
    }
  });
  it('does not resurrect a disconnect that happens during verification', async () => {
    const f = await fixture(); f.beforeProfile(() => unlink(f.tokensPath));
    expect(await f.read()).toEqual({ state: 'unverified' });
  });
  it('discards identity when a different grant replaces the token during verification', async () => {
    const f = await fixture(); f.beforeProfile(() => f.auth().saveTokens({ ...f.tokens, refresh_token: 'other-account', access_token: 'other-access' }));
    expect(await f.read()).toEqual({ state: 'unverified' });
  });
  it('never calls the network without a trusted client ID or when token storage is empty', async () => {
    const f = await fixture(); let calls = 0;
    const request = (async () => { calls++; throw new Error('must not call'); }) as unknown as typeof fetch;
    expect(await createGoogleGrantReader({ auth: f.auth, clientId: '', fetch: request })()).toEqual({ state: 'unverified' });
    expect(await createGoogleGrantReader({ auth: () => null, clientId: 'fixture-client', fetch: request })()).toEqual({ state: 'absent' });
    expect(calls).toBe(0);
  });
  it('rejects a token that expires while profile verification is in flight', async () => {
    const f = await fixture();
    f.info({ aud: 'fixture-client', scope: GOOGLE_ONBOARDING_SCOPES.join(' '), expires_in: 1 });
    f.beforeProfile(async () => { f.elapse(1000); });
    expect(await f.read()).toEqual({ state: 'unverified' });
  });
});
