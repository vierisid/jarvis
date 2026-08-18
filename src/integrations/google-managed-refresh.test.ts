import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { GoogleAuth, GoogleReconnectRequired } from './google-auth.ts';
import {
  classifyGoogle,
  googleIdentity,
  googleReconnectRequired,
  makeGoogleAuth,
  makeManagedRefresh,
} from './google-managed-refresh.ts';
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

describe('a grant the control plane says is gone', () => {
  const cfg = {
    refreshUrl: MANAGED!.refresh_url!,
    instanceId: MANAGED!.instance_id!,
    notifySecret: MANAGED!.notify_secret!,
  };

  function authWith(refreshToken: string): GoogleAuth {
    return new GoogleAuth('', '', {
      tokensPath: tokensFile({
        access_token: 'a',
        refresh_token: refreshToken,
        expiry_date: Date.now() + 60_000,
        token_type: 'Bearer',
      }),
    });
  }

  test('is remembered, and clears itself when a new token arrives', async () => {
    // Without this the classification is inert: a revoked grant leaves the
    // tokens file untouched, so the settings tab keeps showing a green
    // "connected" chip over an integration where every sync fails, and never
    // offers the one action that fixes it.
    const dead = makeManagedRefresh(cfg, (async () =>
      new Response(JSON.stringify({ error: 'connect Google again', reconnect: true }), {
        status: 409,
      })) as unknown as typeof fetch);
    await expect(dead('1//dead')).rejects.toBeInstanceOf(GoogleReconnectRequired);

    expect(googleReconnectRequired(authWith('1//dead'))).toContain('connect Google again');
    // Keyed on the token that actually failed: a DIFFERENT one is a reconnect
    // that already happened, and must not inherit the old verdict.
    expect(googleReconnectRequired(authWith('1//fresh-after-reconnect'))).toBeNull();
    expect(googleReconnectRequired(null)).toBeNull();

    // A refresh that succeeds says the grant is alive again.
    const ok = makeManagedRefresh(cfg, (async () =>
      new Response(JSON.stringify({ access_token: 'ya29.fresh', expires_in: 3599 }), {
        status: 200,
      })) as unknown as typeof fetch);
    await ok('1//dead');
    expect(googleReconnectRequired(authWith('1//dead'))).toBeNull();
  });

  test('a transient failure does NOT mark the grant dead', async () => {
    const down = makeManagedRefresh(cfg, (async () =>
      new Response('{}', { status: 500 })) as unknown as typeof fetch);
    await expect(down('1//alive')).rejects.toThrow();
    expect(googleReconnectRequired(authWith('1//alive'))).toBeNull();
  });
});

describe('classifyGoogle', () => {
  test('a partial managed block is none, not a fallback to the file credentials', () => {
    expect(classifyGoogle({ google: MANAGED }).mode).toBe('managed');
    expect(classifyGoogle({ google: { client_id: 'cid', client_secret: 'sec' } }).mode).toBe('self');
    expect(classifyGoogle({}).mode).toBe('none');
    // refresh_url without its companions: a config we mis-rendered. Using the
    // credentials that happen to sit beside it would put a hosted instance back
    // on the shared secret, invisibly, because Google would keep working.
    for (const partial of [
      { refresh_url: MANAGED!.refresh_url, client_id: 'cid', client_secret: 'sec' },
      { refresh_url: MANAGED!.refresh_url, instance_id: 'inst-1', client_id: 'cid', client_secret: 'sec' },
      { refresh_url: MANAGED!.refresh_url, notify_secret: 'a'.repeat(64) },
    ]) {
      expect(classifyGoogle({ google: partial }).mode).toBe('none');
      expect(makeGoogleAuth({ google: partial })).toBeNull();
      expect(googleIdentity({ google: partial })).toBeNull();
    }
    // notify_secret alone is the push doorbell's key — legitimate on a
    // self-hosted instance, and must not disable it.
    expect(
      classifyGoogle({
        google: { client_id: 'cid', client_secret: 'sec', notify_secret: 'a'.repeat(64) },
      }).mode,
    ).toBe('self');
  });
});
