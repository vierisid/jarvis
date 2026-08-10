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
