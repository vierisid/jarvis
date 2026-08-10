import { describe, expect, it } from 'bun:test';
import { GoogleOAuthFlowStore } from './google-oauth-flow.ts';

describe('GoogleOAuthFlowStore', () => {
  it('binds a one-time state to the exact callback and PKCE verifier', () => {
    const store = new GoogleOAuthFlowStore(60_000);
    const started = store.start('https://jarvis.example.com/api/auth/google/callback', 1_000);
    expect(started.state.length).toBeGreaterThan(30);
    expect(started.codeChallenge.length).toBeGreaterThan(30);

    expect(store.consume(started.state, 2_000)).toEqual({
      redirectUri: 'https://jarvis.example.com/api/auth/google/callback',
      codeVerifier: started.codeVerifier,
      expiresAt: 61_000,
    });
    expect(store.consume(started.state, 2_000)).toBeNull();
  });

  it('rejects expired attempts', () => {
    const store = new GoogleOAuthFlowStore(1_000);
    const started = store.start('https://jarvis.example.com/callback', 1_000);
    expect(store.consume(started.state, 2_001)).toBeNull();
  });
});
