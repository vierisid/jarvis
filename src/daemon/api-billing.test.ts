import { afterEach, describe, expect, it } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { JarvisConfig } from '../config/types.ts';

/**
 * GET /api/billing (control plane: docs/BILLING.md "Billing inside the brain").
 *
 * The same two properties as the usage meter's route: availability that tells
 * self-hosted, hosted-but-unreadable and readable apart, and secrecy — this
 * body reaches a browser, so the endpoint, instance id and secret must never
 * appear in it.
 */

type Handler = (req: Request) => Response | Promise<Response>;

function handlerFor(config: Partial<JarvisConfig>): Handler {
  const routes = createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: { llm: { providers: {} }, ...config } as JarvisConfig,
  } as ApiContext);
  const route = routes['/api/billing'] as { GET?: Handler } | undefined;
  if (!route?.GET) throw new Error('Route /api/billing GET not registered');
  return route.GET;
}

const SECRET = 'd'.repeat(64);
// A distinct instance id per test: the route reads through the daemon's shared
// reader, whose cache is keyed by the credentials.
let n = 0;
const billingBlock = () => ({
  url: 'https://control-plane.internal/api/billing/instance',
  instance_id: `inst-billing-${++n}`,
  secret: SECRET,
  page_url: 'https://app.example/billing',
});
const req = () => new Request('http://localhost/api/billing');
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('GET /api/billing', () => {
  it('is 503 on a self-hosted install', async () => {
    expect((await handlerFor({})(req())).status).toBe(503);
  });

  it('is ok:false (not 503) on a hosted install whose control plane rendered no billing block', async () => {
    // Hosted per the unix-socket listen signal; the block is absent when the
    // control plane has no origin an instance can reach.
    const res = await handlerFor({
      daemon: { listen: 'unix:/run/jarvis/u_1/brain.sock' },
    } as Partial<JarvisConfig>)(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: 'Billing is unavailable right now', links: null });
  });

  it('serves the parsed summary and the account links', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          account: { email: 'o@e.com' },
          subscription: null,
          plans: [],
          paymentMethods: [],
          payments: [],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const res = await handlerFor({ usejarvis_billing: billingBlock() } as Partial<JarvisConfig>)(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; summary: { account: { email: string } }; links: { cancel: string } };
    expect(body.ok).toBe(true);
    expect(body.summary.account.email).toBe('o@e.com');
    expect(body.links.cancel).toBe('https://app.example/billing?action=cancel');
  });

  it('never echoes the endpoint, instance id or secret — on success or failure', async () => {
    for (const reply of [
      async () => {
        throw new Error('connect ECONNREFUSED https://control-plane.internal');
      },
      async () => new Response('https://control-plane.internal says no', { status: 401 }),
      async () =>
        new Response(JSON.stringify({ account: {}, subscription: null, plans: [], paymentMethods: null, payments: [] })),
    ]) {
      globalThis.fetch = reply as unknown as typeof fetch;
      const block = billingBlock();
      const text = await (await handlerFor({ usejarvis_billing: block } as Partial<JarvisConfig>)(req())).text();
      expect(text).not.toContain('control-plane.internal');
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(block.instance_id);
    }
  });

  it('reads are cached, and ?fresh=1 still shares a reading younger than the floor', async () => {
    let count = 0;
    globalThis.fetch = (async () => {
      count++;
      return new Response(
        JSON.stringify({ account: { email: 'o@e.com' }, subscription: null, plans: [], paymentMethods: [], payments: [] }),
      );
    }) as unknown as typeof fetch;
    const handler = handlerFor({ usejarvis_billing: billingBlock() } as Partial<JarvisConfig>);
    await handler(req());
    await handler(req());
    expect(count).toBe(1);
    // Inside the fresh floor, a fresh read still shares the reading just taken.
    await handler(new Request('http://localhost/api/billing?fresh=1'));
    expect(count).toBe(1);
  });

  it('still offers the account links when the read fails, so the user has a way forward', async () => {
    globalThis.fetch = (async () => new Response('', { status: 502 })) as unknown as typeof fetch;
    const res = await handlerFor({ usejarvis_billing: billingBlock() } as Partial<JarvisConfig>)(req());
    const body = (await res.json()) as { ok: boolean; links: { page: string } | null };
    expect(body.ok).toBe(false);
    expect(body.links?.page).toBe('https://app.example/billing');
  });
});
