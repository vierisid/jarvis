import { describe, expect, it } from 'bun:test';
import { GoogleOAuthFlowStore } from '../../integrations/google-oauth-flow.ts';
import { createGoogleProvider } from './provider.ts';
import { GOOGLE_ONBOARDING_SCOPES, type GoogleBinding, type GoogleGrant, type GoogleScope } from './types.ts';

const owner = { actorId: 'alice', projectId: 'project-a' };
const verified: GoogleGrant = { state: 'verified', accountLabel: 'alice@example.test', scopes: [...GOOGLE_ONBOARDING_SCOPES] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(mode: 'hosted' | 'self' = 'self') {
  let time = 1000, grant: GoogleGrant = { state: 'absent' }, reads = 0, exchanges = 0, reloads = 0;
  let exchange: (() => Promise<void>) | undefined;
  const binding: GoogleBinding = { id: 'vault-a', owner, installMode: mode,
    hostedConnectUrl: 'https://account.example.test/connect',
    readGrant: async () => { reads++; return grant; },
    self: { redirectUri: 'https://jarvis.example.test/api/auth/google/callback', flows: new GoogleOAuthFlowStore(),
      auth: {
        getAuthUrl(scopes, options) {
          expect(scopes).toEqual([...GOOGLE_ONBOARDING_SCOPES]);
          return `https://accounts.google.com/o/oauth2/v2/auth?state=${options?.state}&code_challenge=${options?.codeChallenge}`;
        },
        async exchangeCode(code, options) {
          exchanges++; expect(code).toBe('fixture-code'); expect(options?.codeVerifier?.length).toBeGreaterThan(30);
          if (exchange) await exchange();
          grant = verified;
          return { access_token: 'fixture', refresh_token: 'fixture', expiry_date: 10000, token_type: 'Bearer' };
        },
      }, onTokensSaved: () => { reloads++; },
    },
  };
  const provider = createGoogleProvider<GoogleScope | null>({ authorize: scope => scope,
    resolve: scope => ({ ...binding, owner: scope }), now: () => time });
  return { provider, binding, stats: () => ({ reads, exchanges, reloads }), setGrant: (g: GoogleGrant) => { grant = g; },
    elapse: (ms: number) => { time += ms; }, exchange: (fn: () => Promise<void>) => { exchange = fn; } };
}
async function start(f: ReturnType<typeof fixture>) {
  const result = await f.provider.begin(owner);
  expect(result.snapshot.connection.state).toBe('pending');
  return { id: result.launch!.attemptId, state: new URL(result.launch!.url).searchParams.get('state')! };
}

describe('google-state.v1', () => {
  it('constructs without effects and requires authentication on every operation', async () => {
    const f = fixture(); expect(f.stats()).toEqual({ reads: 0, exchanges: 0, reloads: 0 });
    for (const op of [() => f.provider.read(null), () => f.provider.begin(null), () => f.provider.cancel(null, 'attempt'),
      () => f.provider.externalFailed(null, 'attempt'), () => f.provider.callback(null, { state: 'x', code: 'fixture-code' })]) {
      await expect(op()).rejects.toMatchObject({ code: 'unauthorized' });
    }
    expect(f.stats().exchanges).toBe(0);
  });
  it('rejects owner mismatch and missing bindings without reading credentials', async () => {
    const f = fixture();
    const p = createGoogleProvider({ authorize: () => owner, resolve: () => ({ ...f.binding, owner: { ...owner, actorId: 'bob' } }) });
    await expect(p.read({})).rejects.toMatchObject({ code: 'unavailable' });
    await expect(createGoogleProvider({ authorize: () => owner, resolve: () => null }).read({})).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.stats().reads).toBe(0);
  });
  it('checks a live grant before opening; already connected starts no attempt', async () => {
    const f = fixture(); f.setGrant(verified);
    const result = await f.provider.begin(owner);
    expect(result.launch).toBeUndefined();
    expect(result.snapshot.connection).toMatchObject({ state: 'connected', attemptId: null, accountLabel: 'alice@example.test' });
    expect(f.stats().exchanges).toBe(0);
  });
  it('uses one-time existing PKCE flow, then verifies the saved account and granted scopes', async () => {
    const f = fixture(), a = await start(f);
    const result = await f.provider.callback(owner, { state: a.state, code: 'fixture-code' });
    expect(result.connection).toMatchObject({ state: 'connected', attemptId: a.id, scopes: [...GOOGLE_ONBOARDING_SCOPES] });
    expect(f.stats()).toEqual({ reads: 2, exchanges: 1, reloads: 1 });
    await expect(f.provider.callback(owner, { state: a.state, code: 'fixture-code' })).rejects.toMatchObject({ code: 'invalid_callback' });
    expect(f.stats().exchanges).toBe(1);
  });
  it('rejects foreign actor, foreign project, forged state and stale callbacks before exchange', async () => {
    const f = fixture(), a = await start(f);
    for (const scope of [{ ...owner, actorId: 'bob' }, { ...owner, projectId: 'project-b' }]) {
      await expect(f.provider.callback(scope, { state: a.state, code: 'fixture-code' })).rejects.toMatchObject({ code: 'invalid_callback' });
    }
    await expect(f.provider.callback(owner, { state: 'forged', code: 'fixture-code' })).rejects.toMatchObject({ code: 'invalid_callback' });
    await f.provider.cancel(owner, a.id); const b = await start(f);
    await expect(f.provider.callback(owner, { state: a.state, code: 'fixture-code' })).rejects.toMatchObject({ code: 'invalid_callback' });
    expect((await f.provider.read(owner)).connection).toEqual({ state: 'pending', attemptId: b.id });
    expect(f.stats().exchanges).toBe(0);
  });
  it('consumes denied consent once and redacts upstream error content', async () => {
    const f = fixture(), a = await start(f);
    const result = await f.provider.callback(owner, { state: a.state, error: '<script>secret-token</script>' });
    expect(result.reason).toBe('consent_denied'); expect(JSON.stringify(result)).not.toContain('secret-token');
    await expect(f.provider.callback(owner, { state: a.state, code: 'fixture-code' })).rejects.toMatchObject({ code: 'invalid_callback' });
    expect(f.stats().exchanges).toBe(0);
  });
  it('expires waiting and refuses an expired grant exchange', async () => {
    const f = fixture(), a = await start(f); f.elapse(600_000);
    expect((await f.provider.read(owner)).connection).toEqual({ state: 'expired', attemptId: a.id });
    await expect(f.provider.callback(owner, { state: a.state, code: 'fixture-code' })).rejects.toMatchObject({ code: 'invalid_callback' });
  });
  it('cancels without connecting or revoking; late valid grant is unattributed', async () => {
    const f = fixture(), a = await start(f);
    expect((await f.provider.cancel(owner, a.id)).connection.state).toBe('cancelled');
    expect((await f.provider.read(owner)).connection.state).toBe('cancelled');
    expect(f.stats().exchanges).toBe(0);
    expect((await f.provider.callback(owner, { state: a.state, code: 'fixture-code' })).connection).toMatchObject({ state: 'connected', attemptId: null });
  });
  it('cancels during exchange immediately and does not attribute completion after it', async () => {
    const f = fixture(), a = await start(f), entered = deferred<void>(), release = deferred<void>();
    f.exchange(async () => { entered.resolve(); await release.promise; });
    const callback = f.provider.callback(owner, { state: a.state, code: 'fixture-code' }); await entered.promise;
    expect((await f.provider.cancel(owner, a.id)).connection.state).toBe('cancelled');
    release.resolve(); expect((await callback).connection).toMatchObject({ state: 'connected', attemptId: null });
  });
  it('does not let an in-flight read overwrite cancellation', async () => {
    const f = fixture(), a = await start(f), entered = deferred<void>(), release = deferred<GoogleGrant>();
    f.binding.readGrant = async () => { entered.resolve(); return release.promise; };
    const read = f.provider.read(owner); await entered.promise; await f.provider.cancel(owner, a.id);
    release.resolve(verified); expect((await read).connection.state).toBe('cancelled');
  });
  it('serializes concurrent begin and callback requests', async () => {
    const f = fixture(); const starts = await Promise.all([f.provider.begin(owner), f.provider.begin(owner)]);
    expect(starts.filter(r => r.launch)).toHaveLength(1);
    const state = new URL(starts[0]!.launch!.url).searchParams.get('state')!;
    const callbacks = await Promise.allSettled([f.provider.callback(owner, { state, code: 'fixture-code' }), f.provider.callback(owner, { state, code: 'fixture-code' })]);
    expect(callbacks.map(r => r.status)).toEqual(['fulfilled', 'rejected']); expect(f.stats().exchanges).toBe(1);
  });
  it('refreshes external grants/revocation without trusting a client success event', async () => {
    const f = fixture('hosted'); const a = await f.provider.begin(owner);
    expect(a.launch?.url).toBe('https://account.example.test/connect');
    expect(a.snapshot.connection.state).toBe('pending');
    f.setGrant(verified); expect((await f.provider.read(owner)).connection).toMatchObject({ state: 'connected', attemptId: null });
    f.setGrant({ state: 'revoked' }); expect((await f.provider.read(owner)).reason).toBe('grant_revoked');
    expect(f.stats().exchanges).toBe(0);
  });
  it('fails closed on unknown or insufficient granted access', async () => {
    const f = fixture();
    for (const grant of [{ state: 'unverified' }, { ...verified, scopes: [] }] as GoogleGrant[]) {
      f.setGrant(grant); expect((await f.provider.read(owner)).ready).toBe(false);
    }
    f.binding.readGrant = async () => { throw new Error('secret-token'); };
    expect(JSON.stringify(await f.provider.read(owner))).not.toContain('secret-token');
  });
  it('handles blocked windows, stale cancellation, retry and missing hosted configuration', async () => {
    const f = fixture(), a = await start(f);
    expect((await f.provider.externalFailed(owner, a.id)).reason).toBe('external_open_failed');
    const b = await start(f);
    expect((await f.provider.cancel(owner, a.id)).connection).toEqual({ state: 'pending', attemptId: b.id });
    const hosted = fixture('hosted'); hosted.binding.hostedConnectUrl = 'javascript:alert(1)';
    expect((await hosted.provider.begin(owner)).snapshot.connection.state).toBe('unavailable');
  });
  it('rejects callbacks after the canonical binding changes', async () => {
    const f = fixture(), a = await start(f); f.binding.id = 'different-vault';
    await expect(f.provider.callback(owner, { state: a.state, code: 'fixture-code' })).rejects.toMatchObject({ code: 'invalid_callback' });
    expect(f.stats().exchanges).toBe(0);
  });
  it('reports exchange failures without leaking response bodies', async () => {
    const f = fixture(), a = await start(f); f.exchange(async () => { throw new Error('secret-token'); });
    const result = await f.provider.callback(owner, { state: a.state, code: 'fixture-code' });
    expect(result.reason).toBe('exchange_failed'); expect(JSON.stringify(result)).not.toContain('secret-token');
  });
  it('does not relaunch when cancellation arrives during a begin status read', async () => {
    const f = fixture(), a = await start(f), entered = deferred<void>(), release = deferred<GoogleGrant>();
    f.binding.readGrant = async () => { entered.resolve(); return release.promise; };
    const begin = f.provider.begin(owner); await entered.promise;
    await f.provider.cancel(owner, a.id); release.resolve({ state: 'absent' });
    const result = await begin;
    expect(result.launch).toBeUndefined(); expect(result.snapshot.connection.state).toBe('cancelled');
  });
  it('refuses an old binding result after canonical ownership selection changes mid-read', async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<GoogleGrant>();
    f.binding.readGrant = async () => { entered.resolve(); return release.promise; };
    const read = f.provider.read(owner); await entered.promise; f.binding.id = 'replacement-vault'; release.resolve(verified);
    await expect(read).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('gives an evicted scope a new revision stream and rejects malformed callback input', async () => {
    const f = fixture(), before = await f.provider.read(owner);
    f.elapse(1_200_001); await f.provider.read({ actorId: 'other', projectId: 'other' });
    const after = await f.provider.read(owner);
    expect(after.streamId).not.toBe(before.streamId);
    await expect(f.provider.callback(owner, null as never)).rejects.toMatchObject({ code: 'invalid_callback' });
  });
});
