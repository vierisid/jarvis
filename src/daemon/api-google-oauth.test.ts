import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { JarvisConfig } from '../config/types.ts';

type Handler = (req: Request) => Response | Promise<Response>;

function makeRoutes(publicUrl: string | null = 'https://jarvis.example.com') {
  const config = {
    daemon: {
      port: 3142,
      data_dir: '/tmp/jarvis',
      db_path: '/tmp/jarvis/jarvis.db',
      ...(publicUrl ? { public_url: publicUrl } : {}),
    },
    google: { client_id: 'client-id', client_secret: 'client-secret' },
  } as JarvisConfig;
  return createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config,
  } as ApiContext) as Record<string, { GET?: Handler; POST?: Handler }>;
}

describe('Google OAuth API external origin', () => {
  it('returns an authorization URL bound to the configured public callback', async () => {
    const routes = makeRoutes();
    const response = await routes['/api/auth/google/init']!.POST!(new Request(
      'http://localhost:3142/api/auth/google/init',
      { method: 'POST' },
    ));
    const body = await response.json() as { auth_url: string; redirect_uri: string };
    const authUrl = new URL(body.auth_url);

    expect(body.redirect_uri).toBe('https://jarvis.example.com/api/auth/google/callback');
    expect(authUrl.searchParams.get('redirect_uri')).toBe(body.redirect_uri);
    expect(authUrl.searchParams.get('state')?.length).toBeGreaterThan(30);
    expect(authUrl.searchParams.get('code_challenge')?.length).toBeGreaterThan(30);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('publishes the resolved callback through deployment diagnostics', async () => {
    const routes = makeRoutes('https://jarvis.example.com/');
    const response = await routes['/api/system/external-origin']!.GET!(new Request(
      'http://localhost:3142/api/system/external-origin',
    ));
    expect(await response.json()).toMatchObject({
      public_origin: 'https://jarvis.example.com',
      websocket_origin: 'wss://jarvis.example.com',
      source: 'public_url',
      google_callback: 'https://jarvis.example.com/api/auth/google/callback',
    });
  });

  it('never derives the callback from request headers when no public URL is configured', async () => {
    const routes = makeRoutes(null);
    const response = await routes['/api/auth/google/init']!.POST!(new Request(
      'http://jarvis.example.com/api/auth/google/init',
      { method: 'POST', headers: { Origin: 'https://attacker.example.com' } },
    ));
    const body = await response.json() as { redirect_uri: string };
    expect(body.redirect_uri).toBe('http://localhost:3142/api/auth/google/callback');
  });

  it('rejects callbacks without a valid one-time state', async () => {
    const routes = makeRoutes();
    const response = await routes['/api/auth/google/callback']!.GET!(new Request(
      'https://jarvis.example.com/api/auth/google/callback?code=attacker-code',
    ));
    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toBe('text/html');
    expect(await response.text()).toContain('missing its OAuth state');
  });

  it('rejects callbacks whose state is unknown or already used', async () => {
    const routes = makeRoutes();
    const response = await routes['/api/auth/google/callback']!.GET!(new Request(
      'https://jarvis.example.com/api/auth/google/callback?code=attacker-code&state=forged-state',
    ));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('already used or has expired');
  });

  describe('callback happy path', () => {
    const realFetch = globalThis.fetch;
    const realHome = process.env.HOME;

    afterEach(() => {
      globalThis.fetch = realFetch;
      if (realHome !== undefined) process.env.HOME = realHome;
    });

    it('exchanges the code with the state-bound verifier and redirect URI', async () => {
      process.env.HOME = mkdtempSync(path.join(tmpdir(), 'jarvis-oauth-test-'));
      const exchangeRequests: URLSearchParams[] = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        exchangeRequests.push(new URLSearchParams(String(init?.body)));
        return new Response(JSON.stringify({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        }), { headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;

      const routes = makeRoutes();
      const initResponse = await routes['/api/auth/google/init']!.POST!(new Request(
        'http://localhost:3142/api/auth/google/init', { method: 'POST' },
      ));
      const { auth_url, redirect_uri } = await initResponse.json() as { auth_url: string; redirect_uri: string };
      const authUrl = new URL(auth_url);
      const state = authUrl.searchParams.get('state')!;
      const codeChallenge = authUrl.searchParams.get('code_challenge')!;

      const callbackResponse = await routes['/api/auth/google/callback']!.GET!(new Request(
        `https://jarvis.example.com/api/auth/google/callback?code=auth-code&state=${state}`,
      ));
      expect(callbackResponse.status).toBe(200);
      expect(await callbackResponse.text()).toContain('Authorization Complete');

      expect(exchangeRequests).toHaveLength(1);
      const body = exchangeRequests[0]!;
      expect(body.get('code')).toBe('auth-code');
      expect(body.get('redirect_uri')).toBe(redirect_uri);
      const verifier = body.get('code_verifier')!;
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(codeChallenge);

      // The state is one-time: replaying the same callback must fail.
      const replay = await routes['/api/auth/google/callback']!.GET!(new Request(
        `https://jarvis.example.com/api/auth/google/callback?code=auth-code&state=${state}`,
      ));
      expect(replay.status).toBe(400);
    });
  });
});
