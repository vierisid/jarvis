import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { GoogleAuth, GoogleReconnectRequired } from './google-auth.ts';
import { googleIdentity, makeGoogleAuth, makeManagedRefresh } from './google-managed-refresh.ts';
import type { JarvisConfig } from '../config/types.ts';

/**
 * Refreshing through the control plane (GOOGLE.md).
 *
 * The property being protected is that a HOSTED instance holds no Google client
 * credentials — this daemon runs as the tenant's own user, so a secret it could
 * use is a secret the tenant could read. Everything here checks that the managed
 * path works without them, and that the self-hosted path is untouched.
 */
const MANAGED: JarvisConfig['google'] = {
  client_id: '',
  client_secret: '',
  refresh_url: 'https://app.example.com/api/integrations/google/refresh',
  instance_id: 'inst-1',
  notify_secret: 'a'.repeat(64),
};

function tokensFile(tokens: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-managed-'));
  const p = join(dir, 'google-tokens.json');
  writeFileSync(p, JSON.stringify(tokens));
  return p;
}

describe('makeManagedRefresh', () => {
  const cfg = {
    refreshUrl: MANAGED!.refresh_url!,
    instanceId: MANAGED!.instance_id!,
    notifySecret: MANAGED!.notify_secret!,
  };

  test('signs the exact body it sends, and never sends a client secret', async () => {
    let seen: { url: string; body: string; signature: string | null } | null = null;
    const refresh = makeManagedRefresh(cfg, (async (url: string, init: RequestInit) => {
      seen = {
        url,
        body: String(init.body),
        signature: new Headers(init.headers).get('x-jarvis-signature'),
      };
      return new Response(JSON.stringify({ access_token: 'ya29.fresh', expires_in: 3599 }), {
        status: 200,
      });
    }) as unknown as typeof fetch);

    const out = await refresh('1//token');
    expect(out.access_token).toBe('ya29.fresh');
    // The signature must cover the bytes actually sent — re-serialising would
    // change them and the control plane would reject every request.
    const expected = createHmac('sha256', cfg.notifySecret).update(seen!.body).digest('hex');
    expect(seen!.signature).toBe(expected);
    const sent = JSON.parse(seen!.body) as { instanceId: string; refreshToken: string; at: string };
    expect(sent).toMatchObject({ instanceId: 'inst-1', refreshToken: '1//token' });
    // A timestamp inside the signed bytes is what bounds replay.
    expect(Number.isFinite(Date.parse(sent.at))).toBe(true);
    // THE property: no credential of ours crosses the wire.
    expect(seen!.body).not.toContain('client_secret');
  });

  test('a gone grant is permanent; everything else is transient', async () => {
    const reconnect = makeManagedRefresh(cfg, (async () =>
      new Response(JSON.stringify({ error: 'expired', reconnect: true }), { status: 409 })) as unknown as typeof fetch);
    await expect(reconnect('1//t')).rejects.toBeInstanceOf(GoogleReconnectRequired);

    // 404 = the control plane has no connected record any more. Also only fixed
    // by connecting again, so it must not read as a retryable blip.
    const gone = makeManagedRefresh(cfg, (async () =>
      new Response('{}', { status: 404 })) as unknown as typeof fetch);
    await expect(gone('1//t')).rejects.toBeInstanceOf(GoogleReconnectRequired);

    // A 500, or an unreachable control plane, is transient: the next poll
    // retries, and telling the user to reconnect over a blip would be wrong.
    const down = makeManagedRefresh(cfg, (async () =>
      new Response('{}', { status: 500 })) as unknown as typeof fetch);
    await expect(down('1//t')).rejects.not.toBeInstanceOf(GoogleReconnectRequired);
    const unreachable = makeManagedRefresh(cfg, (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    await expect(unreachable('1//t')).rejects.not.toBeInstanceOf(GoogleReconnectRequired);
  });
});

describe('makeGoogleAuth', () => {
  test('a managed config produces an auth with NO credentials that refreshes remotely', async () => {
    const path = tokensFile({
      access_token: 'old',
      refresh_token: '1//r',
      // Already expired, so the very next getAccessToken must refresh.
      expiry_date: Date.now() - 1000,
      token_type: 'Bearer',
    });
    let calledControlPlane = false;
    const auth = new GoogleAuth('', '', {
      tokensPath: path,
      refreshVia: async () => {
        calledControlPlane = true;
        return { access_token: 'ya29.viaControlPlane', expires_in: 3599 };
      },
    });
    expect(await auth.getAccessToken()).toBe('ya29.viaControlPlane');
    expect(calledControlPlane).toBe(true);
  });

  test('MANAGED WINS over credentials that are also present', async () => {
    // A config carrying both (a transitional render, or a mistake) must take the
    // managed path: the whole point is that a hosted instance never uses the
    // shared secret, and preferring credentials would silently keep the old
    // behaviour alive on exactly the instances this protects.
    const path = tokensFile({
      access_token: 'old',
      refresh_token: '1//r',
      expiry_date: Date.now() - 1000,
      token_type: 'Bearer',
    });
    const seen: string[] = [];
    const auth = makeGoogleAuth(
      { google: { ...MANAGED, client_id: 'cid', client_secret: 'leaked-secret' } },
      (async (url: string) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ access_token: 'ya29.managed', expires_in: 3599 }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    )!;
    // Force a refresh through whichever path was chosen. The injected fetch is
    // wired ONLY to the managed client, so reaching it proves the choice.
    (auth as unknown as { tokensPath: string }).tokensPath = path;
    auth.reloadTokensFromDisk();
    expect(await auth.getAccessToken()).toBe('ya29.managed');
    expect(seen[0]).toBe(MANAGED!.refresh_url);
  });

  test('managed is chosen over credentials, and self-hosted still works', () => {
    expect(makeGoogleAuth({ google: MANAGED })).not.toBeNull();
    // Nothing configured at all.
    expect(makeGoogleAuth({})).toBeNull();
    expect(makeGoogleAuth({ google: { client_id: '', client_secret: '' } })).toBeNull();
    // Self-hosted keeps its own credentials path.
    expect(makeGoogleAuth({ google: { client_id: 'cid', client_secret: 'sec' } })).not.toBeNull();
  });

  test('the reload identity distinguishes both shapes', () => {
    // The settings-reload applier decides "rebuild or just reload tokens?" from
    // this. Keying it on credentials alone (as it once did) means a managed
    // instance never constructs an auth at all.
    expect(googleIdentity({ google: MANAGED })).toContain('managed');
    expect(googleIdentity({ google: { client_id: 'cid', client_secret: 'sec' } })).toContain('self');
    expect(googleIdentity({})).toBeNull();
    // A moved instance keeps its id, so its identity is stable — no needless
    // rebuild, and the tokens are simply re-read.
    expect(googleIdentity({ google: MANAGED })).toBe(googleIdentity({ google: { ...MANAGED } }));
  });
});
