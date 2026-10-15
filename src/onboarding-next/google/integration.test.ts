import { expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoogleAuth } from '../../integrations/google-auth.ts';
import { GoogleOAuthFlowStore } from '../../integrations/google-oauth-flow.ts';
import { createGoogleProvider, createGoogleGrantReader } from './index.ts';
import { GOOGLE_ONBOARDING_SCOPES } from './types.ts';

it('completes existing OAuth exchange and canonical persistence with isolated provider HTTP fixtures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'on-b-03-exchange-'));
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: URLSearchParams }> = [];
  const tokensPath = join(dir, 'google-tokens.json'), redirectUri = 'https://jarvis.example.test/api/auth/google/callback';
  const owner = { actorId: 'fixture', projectId: 'fixture' };
  try {
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); requests.push({ url, body: new URLSearchParams(String(init?.body ?? '')) });
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 });
      if (url.endsWith('/tokeninfo')) return Response.json({ aud: 'test-client', scope: GOOGLE_ONBOARDING_SCOPES.join(' '), expires_in: 3600 });
      if (url.endsWith('/profile')) return Response.json({ emailAddress: 'fixture@example.test' });
      throw new Error('Unexpected fixture request');
    }) as typeof fetch;
    globalThis.fetch = request;
    const auth = () => new GoogleAuth('test-client', 'test-secret', { tokensPath, redirectUri });
    const binding = { id: 'test-vault', owner, installMode: 'self' as const,
      readGrant: createGoogleGrantReader({ auth, clientId: 'test-client', fetch: request }),
      self: { redirectUri, auth: auth(), flows: new GoogleOAuthFlowStore(), onTokensSaved() {} } };
    const provider = createGoogleProvider({ authorize: () => owner, resolve: () => binding });
    const begun = await provider.begin({}), url = new URL(begun.launch!.url);
    expect(url.searchParams.get('scope')).toBe(GOOGLE_ONBOARDING_SCOPES.join(' '));
    expect(requests).toHaveLength(0);
    const result = await provider.callback({}, { state: url.searchParams.get('state')!, code: 'fixture-code' });
    expect(result.connection).toMatchObject({ state: 'connected', attemptId: begun.launch!.attemptId, accountLabel: 'fixture@example.test' });
    expect(auth().getTokens()?.refresh_token).toBe('test-refresh');
    const exchange = requests[0]!.body;
    expect(exchange.get('redirect_uri')).toBe(redirectUri);
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge')!);
    expect(JSON.stringify(result)).not.toContain('test-access'); expect(JSON.stringify(result)).not.toContain('test-refresh');
    // Restart forgets in-memory attempts, then recovers canonical connection without relaunch.
    const restarted = createGoogleProvider({ authorize: () => owner, resolve: () => binding });
    expect((await restarted.read({})).connection).toMatchObject({ state: 'connected', attemptId: null });
  } finally { globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); }
});
