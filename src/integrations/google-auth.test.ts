import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth } from './google-auth.ts';

describe('GoogleAuth token storage', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('saves OAuth tokens with owner-only permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-google-auth-'));
    const tokensPath = join(dir, 'google-tokens.json');
    const auth = new GoogleAuth('client-id', 'client-secret', { tokensPath });

    await auth.saveTokens({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_date: Date.now() + 60_000,
      token_type: 'Bearer',
    });

    expect(existsSync(tokensPath)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(tokensPath).mode & 0o777).toBe(0o600);
  });

  test('does not chmod cwd for bare relative token paths', async () => {
    const originalCwd = process.cwd();
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-google-auth-cwd-'));
    await chmod(dir, 0o755);

    try {
      process.chdir(dir);
      const auth = new GoogleAuth('client-id', 'client-secret', {
        tokensPath: 'google-tokens.json',
      });

      await auth.saveTokens({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expiry_date: Date.now() + 60_000,
        token_type: 'Bearer',
      });

      expect(statSync(dir).mode & 0o777).toBe(0o755);
      expect(statSync(join(dir, 'google-tokens.json')).mode & 0o777).toBe(0o600);
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('uses the same custom redirect URI and PKCE verifier during exchange', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-google-auth-exchange-'));
    const tokensPath = join(dir, 'google-tokens.json');
    let exchangeBody = new URLSearchParams();
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      exchangeBody = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    try {
      const redirectUri = 'https://jarvis.example.com/api/auth/google/callback';
      const auth = new GoogleAuth('client-id', 'client-secret', { tokensPath, redirectUri });
      const authUrl = new URL(auth.getAuthUrl(['scope-a'], {
        state: 'state-token',
        codeChallenge: 'challenge-token',
      }));
      expect(authUrl.searchParams.get('redirect_uri')).toBe(redirectUri);
      expect(authUrl.searchParams.get('state')).toBe('state-token');
      expect(authUrl.searchParams.get('code_challenge')).toBe('challenge-token');
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');

      await auth.exchangeCode('authorization-code', { codeVerifier: 'verifier-token' });
      expect(exchangeBody.get('redirect_uri')).toBe(redirectUri);
      expect(exchangeBody.get('code_verifier')).toBe('verifier-token');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('GoogleAuth managed refresh', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** An auth whose token on disk is already past the 5-minute expiry buffer. */
  async function staleAuth(refreshVia: (t: string) => Promise<any>) {
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-google-auth-managed-'));
    const tokensPath = join(dir, 'google-tokens.json');
    const auth = new GoogleAuth('', '', { tokensPath, refreshVia });
    await auth.saveTokens({
      access_token: 'stale-access',
      refresh_token: 'refresh-1',
      expiry_date: Date.now() - 60_000,
      token_type: 'Bearer',
    });
    return { auth, dir, tokensPath };
  }

  test('concurrent callers share ONE refresh', async () => {
    // Six independent callers cross the expiry buffer together at boot (both
    // observers, both watch registrations, the suggestion engine, the workflow
    // credential source). Six refreshes used to go out; the control plane's
    // minimum-interval limiter now 429s five of them, and a watch that fails
    // to arm reports as a broken sync.
    globalThis.fetch = (() => {
      throw new Error('a managed refresh must not call Google directly');
    }) as unknown as typeof fetch;

    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { auth, dir } = await staleAuth(async () => {
      calls += 1;
      await gate;
      return { access_token: 'fresh-access', expires_in: 3600 };
    });

    try {
      const all = Promise.all(Array.from({ length: 6 }, () => auth.getAccessToken()));
      await Bun.sleep(0);
      release();
      expect(await all).toEqual(Array(6).fill('fresh-access'));
      expect(calls).toBe(1);

      // And the flight is released afterwards: a later expiry refreshes again
      // rather than serving the first result forever.
      await auth.saveTokens({ ...auth.getTokens()!, expiry_date: Date.now() - 60_000 });
      await auth.getAccessToken();
      expect(calls).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a failed refresh does not wedge the single-flight slot', async () => {
    let calls = 0;
    const { auth, dir } = await staleAuth(async () => {
      calls += 1;
      if (calls === 1) throw new Error('control plane unreachable');
      return { access_token: 'fresh-access', expires_in: 3600 };
    });

    try {
      await expect(auth.getAccessToken()).rejects.toThrow('control plane unreachable');
      expect(await auth.getAccessToken()).toBe('fresh-access');
      expect(calls).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a disconnect mid-flight does NOT re-create the tokens file', async () => {
    // THE case: a refresh is in the air (managed refreshes are bounded at 20s)
    // when the user hits Disconnect. revoke-google unlinks the tokens file and
    // the reload applier calls reloadTokensFromDisk(), nulling the cache. The
    // flight then resolved and wrote the file BACK — containing a live access
    // token for the account that was just revoked, and no refresh token at all,
    // because `{...null}` spreads nothing. It also bumped the settings-reload
    // fingerprint into a spurious observer restart.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { auth, dir, tokensPath } = await staleAuth(async () => {
      await gate;
      return { access_token: 'fresh-access', expires_in: 3600 };
    });

    try {
      const inFlight = auth.getAccessToken();
      await Bun.sleep(0);
      // The disconnect.
      await rm(tokensPath, { force: true });
      expect(auth.reloadTokensFromDisk()).toBe(false);
      release();

      await expect(inFlight).rejects.toThrow(/in flight/);
      expect(existsSync(tokensPath)).toBe(false);
      expect(auth.getTokens()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a reconnect mid-flight does not clobber the new grant', async () => {
    // The other direction: a new grant is delivered while an old-token refresh is
    // in the air. Writing that result would keep the NEW refresh token but pair it
    // with an access token minted from the OLD grant, and stamp an hour's expiry
    // on it. Nothing refreshes on a 401 — the observers only log — so if the old
    // grant is then revoked, every poll fails for that whole hour.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { auth, dir, tokensPath } = await staleAuth(async () => {
      await gate;
      return { access_token: 'from-the-OLD-grant', expires_in: 3600 };
    });

    try {
      const inFlight = auth.getAccessToken();
      await Bun.sleep(0);
      await Bun.write(
        tokensPath,
        JSON.stringify({
          access_token: 'delivered-access',
          refresh_token: 'refresh-2-delivered',
          expiry_date: Date.now() + 3_600_000,
          token_type: 'Bearer',
        }),
      );
      expect(auth.reloadTokensFromDisk()).toBe(true);
      release();

      await expect(inFlight).rejects.toThrow(/in flight/);
      const after = JSON.parse(await Bun.file(tokensPath).text()) as Record<string, string>;
      expect(after.access_token).toBe('delivered-access');
      expect(after.refresh_token).toBe('refresh-2-delivered');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a rotated refresh token is persisted, not dropped', async () => {
    // Google does not normally rotate, but dropping one it DID return strands
    // the instance at its next refresh — and the control plane binds on the
    // token's hash, so a stale token there is a hard reconnect.
    const { auth, dir, tokensPath } = await staleAuth(async () => ({
      access_token: 'fresh-access',
      refresh_token: 'refresh-2',
      expires_in: 3600,
    }));

    try {
      await auth.getAccessToken();
      expect(auth.getTokens()!.refresh_token).toBe('refresh-2');
      expect(JSON.parse(await Bun.file(tokensPath).text()).refresh_token).toBe('refresh-2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
