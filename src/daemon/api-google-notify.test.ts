import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { JarvisConfig } from '../config/types.ts';

type Handler = (req: Request) => Response | Promise<Response>;

/**
 * The hosted push bridge's doorbell (GOOGLE.md "Push bridging").
 *
 * This route is PUBLIC — it has to be, since the caller is the control plane and
 * holds no enrolled-device token — so the HMAC is the entire access control. It
 * lives under `/api/webhooks/`, which is already the signature-verified public
 * prefix (see isPublicRoute in comms/websocket.ts), rather than adding a bespoke
 * exception that would widen the unauthenticated surface.
 */
const SECRET = 'a'.repeat(64);

function makeRoutes(opts?: {
  secret?: string | null;
  onSync?: (source: 'gmail' | 'calendar') => Promise<string[]>;
}) {
  const secret = opts?.secret === undefined ? SECRET : opts.secret;
  const config = {
    daemon: { port: 3142, data_dir: '/tmp/jarvis', db_path: '/tmp/jarvis/jarvis.db' },
    google: {
      client_id: 'client-id',
      client_secret: 'client-secret',
      ...(secret ? { notify_secret: secret } : {}),
    },
  } as JarvisConfig;
  const synced: Array<'gmail' | 'calendar'> = [];
  const routes = createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config,
    ...(opts?.onSync === null
      ? {}
      : {
          observerService: {
            syncNow: async (source: 'gmail' | 'calendar') => {
              synced.push(source);
              return opts?.onSync ? opts.onSync(source) : [source === 'gmail' ? 'email' : 'calendar'];
            },
          },
        }),
  } as ApiContext) as Record<string, { POST?: Handler }>;
  return { post: routes['/api/webhooks/google/notify']!.POST!, synced };
}

const signed = (body: string, secret = SECRET) =>
  new Request('http://localhost/api/webhooks/google/notify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-jarvis-signature': createHmac('sha256', secret).update(body).digest('hex'),
    },
    body,
  });

const doorbell = (source = 'gmail', at = new Date().toISOString()) =>
  JSON.stringify({ source, at });

describe('POST /api/webhooks/google/notify', () => {
  it('syncs the named integration when the signature is valid', async () => {
    const { post, synced } = makeRoutes();
    const body = doorbell('gmail');
    const res = await post(signed(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, synced: ['email'] });
    expect(synced).toEqual(['gmail']);

    const cal = await post(signed(doorbell('calendar')));
    expect(cal.status).toBe(200);
    expect(synced).toEqual(['gmail', 'calendar']);
  });

  it('rejects a wrong, missing or truncated signature', async () => {
    const { post, synced } = makeRoutes();
    const body = doorbell('gmail');

    // Signed with the wrong key: the whole access control of a public route.
    const wrongKey = await post(signed(body, 'b'.repeat(64)));
    expect(wrongKey.status).toBe(401);

    const missing = await post(
      new Request('http://localhost/api/webhooks/google/notify', { method: 'POST', body }),
    );
    expect(missing.status).toBe(401);

    // A prefix of the real signature must not pass a lazy comparison.
    const real = createHmac('sha256', SECRET).update(body).digest('hex');
    const truncated = await post(
      new Request('http://localhost/api/webhooks/google/notify', {
        method: 'POST',
        headers: { 'x-jarvis-signature': real.slice(0, 16) },
        body,
      }),
    );
    expect(truncated.status).toBe(401);

    // A 64-CHARACTER signature that is not 64 BYTES. This is the one that used
    // to escape: String.length counts UTF-16 units, so it passed the length gate
    // and then made timingSafeEqual throw — a 500 with a stack trace instead of
    // a 401, from an unauthenticated caller, on a route that is public by design
    // and sits under a Bun.serve with no error handler above it.
    const nonAscii = await post(
      new Request('http://localhost/api/webhooks/google/notify', {
        method: 'POST',
        headers: { 'x-jarvis-signature': 'é'.repeat(64) },
        body,
      }),
    );
    expect(nonAscii.status).toBe(401);
    expect(synced).toEqual([]);
  });

  it('rejects a body whose bytes differ from what was signed', async () => {
    const { post, synced } = makeRoutes();
    // Signature over one body, sent with another: the check must cover the exact
    // bytes, not merely be present.
    const req = new Request('http://localhost/api/webhooks/google/notify', {
      method: 'POST',
      headers: {
        'x-jarvis-signature': createHmac('sha256', SECRET).update(doorbell('gmail')).digest('hex'),
      },
      body: doorbell('calendar'),
    });
    expect((await post(req)).status).toBe(401);
    expect(synced).toEqual([]);
  });

  it('rejects a stale or undated doorbell', async () => {
    const { post, synced } = makeRoutes();
    // The timestamp is inside the signed bytes, so a REPLAYED notification can be
    // refused without keeping a nonce store — and anything genuinely missed is
    // covered by the poll timer.
    const old = doorbell('gmail', new Date(Date.now() - 60 * 60 * 1000).toISOString());
    expect((await post(signed(old))).status).toBe(400);
    const undated = JSON.stringify({ source: 'gmail' });
    expect((await post(signed(undated))).status).toBe(400);
    const gibberishDate = JSON.stringify({ source: 'gmail', at: 'not-a-date' });
    expect((await post(signed(gibberishDate))).status).toBe(400);
    expect(synced).toEqual([]);
  });

  it('rejects an unknown source and a malformed body', async () => {
    const { post, synced } = makeRoutes();
    expect((await post(signed(JSON.stringify({ source: 'drive', at: new Date().toISOString() })))).status).toBe(400);
    expect((await post(signed('not json'))).status).toBe(400);
    expect(synced).toEqual([]);
  });

  it('404s when no notify secret is configured', async () => {
    // Self-hosted, or a hosted config predating the bridge: there is nothing to
    // verify against, so nothing may be accepted. Notably it must NOT fall
    // through to syncing.
    const { post, synced } = makeRoutes({ secret: null });
    const res = await post(signed(doorbell('gmail')));
    expect(res.status).toBe(404);
    expect(synced).toEqual([]);
  });

  it('answers honestly when the observers are not running', async () => {
    const routes = createApiRoutes({
      daemonStartedAt: Date.now(),
      healthMonitor: {} as ApiContext['healthMonitor'],
      config: {
        daemon: { port: 3142, data_dir: '/tmp/jarvis', db_path: '/tmp/jarvis/jarvis.db' },
        google: { client_id: 'c', client_secret: 's', notify_secret: SECRET },
      } as JarvisConfig,
    } as ApiContext) as Record<string, { POST?: Handler }>;
    const res = await routes['/api/webhooks/google/notify']!.POST!(signed(doorbell('gmail')));
    // 200 with an empty list, not a lie about having synced: the bridge logs the
    // difference, and the tokens may simply not be delivered yet.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, synced: [] });
  });

  it('reports an empty sync when the observer could not run', async () => {
    // An observer that threw, or one with no syncNow. The doorbell is
    // best-effort by design, so this is a 200 with nothing synced rather than an
    // error that would make the bridge log a delivery failure.
    const { post } = makeRoutes({ onSync: async () => [] });
    const res = await post(signed(doorbell('gmail')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, synced: [] });
  });
});
