import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { GoogleAuth, GoogleReconnectRequired } from './google-auth.ts';
import {
  classifyGoogle,
  googleIdentity,
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
/**
 * A REAL managed block: no client credentials at all. Carrying empty strings
 * here (as this fixture used to) made every "is this managed?" branch pass on
 * the credentials clause instead of the hosted one, and made a
 * `not.toContain('client_secret')` assertion vacuous twice over.
 *
 * notify_secret is the DOORBELL key and refresh_secret the one used here; they
 * are deliberately different values so a mix-up cannot pass.
 */
const MANAGED: JarvisConfig['google'] = {
  refresh_url: 'https://app.example.com/api/integrations/google/refresh',
  instance_id: 'inst-1',
  notify_secret: 'a'.repeat(64),
  refresh_secret: 'c'.repeat(64),
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
    refreshSecret: MANAGED!.refresh_secret!,
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
    const expected = createHmac('sha256', cfg.refreshSecret).update(seen!.body).digest('hex');
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

    // The control plane having no connected record any more is ALSO a reconnect,
    // and it says so with the flag — it is a 404 that carries `reconnect`. Taken
    // from the flag rather than inferred from the status, because a BARE 404 is
    // what a wrong origin path, a rollback that drops the route, or a CDN
    // answering for an unknown path returns; treating those as a gone grant would
    // tell the user to reconnect over a misconfiguration and stop refreshing a
    // token that was fine.
    const gone = makeManagedRefresh(cfg, (async () =>
      new Response(JSON.stringify({ error: 'no connected instance', reconnect: true }), {
        status: 404,
      })) as unknown as typeof fetch);
    await expect(gone('1//t')).rejects.toBeInstanceOf(GoogleReconnectRequired);

    const routing = makeManagedRefresh(cfg, (async () =>
      new Response('not found', { status: 404 })) as unknown as typeof fetch);
    await expect(routing('1//t')).rejects.not.toBeInstanceOf(GoogleReconnectRequired);

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
    // A moved instance keeps its id, and the push targets can change on a move
    // without the AUTH needing a rebuild — so the identity must ignore those.
    // (Comparing MANAGED to a spread of itself proved nothing: identical values
    // through a pure function.)
    expect(googleIdentity({ google: { ...MANAGED, pubsub_topic: 'projects/p/topics/t' } })).toBe(
      googleIdentity({ google: MANAGED }),
    );

    // ...but the REFRESH SECRET is part of it. It is the one value that
    // authenticates every refresh, and the refresher closes over it: an identity
    // that ignored it would tell the applier "same Google, just re-read the
    // tokens" after a master-key rotation and leave every refresh signing with a
    // key the control plane no longer accepts — 401ing forever, until a restart
    // nobody knows to perform.
    expect(googleIdentity({ google: { ...MANAGED, refresh_secret: 'd'.repeat(64) } })).not.toBe(
      googleIdentity({ google: MANAGED }),
    );
  });
});

describe('a grant that is gone', () => {
  const cfg = {
    refreshUrl: MANAGED!.refresh_url!,
    instanceId: MANAGED!.instance_id!,
    refreshSecret: MANAGED!.refresh_secret!,
  };

  /** A managed auth whose token on disk is already past the expiry buffer. */
  function staleAuth(refreshToken: string, fetchImpl: typeof fetch) {
    const path = tokensFile({
      access_token: 'old',
      refresh_token: refreshToken,
      expiry_date: Date.now() - 1000,
      token_type: 'Bearer',
    });
    return {
      path,
      auth: GoogleAuth.managed(makeManagedRefresh(cfg, fetchImpl), { tokensPath: path }),
    };
  }

  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test('is remembered ACROSS A RESTART, and clears when a new token arrives', async () => {
    // Without this the classification is inert: a revoked grant leaves the tokens
    // file untouched, so the settings tab shows a green "connected" chip over an
    // integration where every sync fails, and never offers the one action that
    // helps. Persisted rather than held in memory because refreshes only run on
    // the expiry clock — after a restart the lie would stand for up to an hour.
    const { auth, path } = staleAuth('1//dead', respond(409, { error: 'connect Google again', reconnect: true }));
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(GoogleReconnectRequired);
    expect(auth.reconnectRequired()).toContain('connect Google again');

    // A fresh process reading the same files — the restart case.
    const restarted = GoogleAuth.managed(makeManagedRefresh(cfg, respond(200, {})), {
      tokensPath: path,
    });
    expect(restarted.reconnectRequired()).toContain('connect Google again');

    // Keyed on the token that actually FAILED, so a delivered token clears it
    // with no reset call for anyone to forget: this is the reconnect case.
    await Bun.write(
      path,
      JSON.stringify({
        access_token: 'a',
        refresh_token: '1//after-reconnect',
        expiry_date: Date.now() + 60_000,
        token_type: 'Bearer',
      }),
    );
    const reconnected = GoogleAuth.managed(makeManagedRefresh(cfg, respond(200, {})), {
      tokensPath: path,
    });
    expect(reconnected.reconnectRequired()).toBeNull();
  });

  test('a successful refresh says the grant is alive again', async () => {
    const { auth } = staleAuth('1//dead', respond(409, { reconnect: true }));
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(GoogleReconnectRequired);
    expect(auth.reconnectRequired()).not.toBeNull();

    const revived = GoogleAuth.managed(
      makeManagedRefresh(cfg, respond(200, { access_token: 'ya29.fresh', expires_in: 3599 })),
      { tokensPath: (auth as unknown as { tokensPath: string }).tokensPath },
    );
    expect(await revived.getAccessToken()).toBe('ya29.fresh');
    expect(revived.reconnectRequired()).toBeNull();
  });

  test('a transient failure does NOT mark the grant dead', async () => {
    // Asserted against a state that is already DEAD for another token, so this
    // cannot pass merely because nothing was ever written.
    const { auth } = staleAuth('1//alive', respond(500, {}));
    await expect(auth.getAccessToken()).rejects.toThrow(/refused the refresh/);
    expect(auth.reconnectRequired()).toBeNull();

    // A bare 404 is transient too: it is also what a wrong origin path or a
    // rollback that drops the route returns, and telling the user to reconnect
    // over a misconfiguration would stop a perfectly good token being refreshed.
    const { auth: routing } = staleAuth('1//alive', respond(404, {}));
    await expect(routing.getAccessToken()).rejects.not.toBeInstanceOf(GoogleReconnectRequired);
    expect(routing.reconnectRequired()).toBeNull();
  });

  test("someone else's text does not become our voice, unbounded", async () => {
    // The reason is rendered to the user as this daemon's own explanation, so
    // whatever answers refresh_url must not be able to put newlines, control
    // characters or a wall of text into a log line and a settings panel.
    const hostile = `line-one\nline-two\u0007${'x'.repeat(500)}`;
    const { auth } = staleAuth('1//dead', respond(409, { error: hostile, reconnect: true }));
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(GoogleReconnectRequired);
    const shown = auth.reconnectRequired()!;
    expect(shown.length).toBeLessThanOrEqual(200);
    expect(shown).not.toContain('\n');
    expect(shown).not.toContain('\u0007');
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
