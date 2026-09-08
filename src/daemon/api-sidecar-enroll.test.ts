import { describe, expect, it } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { JarvisConfig } from '../config/types.ts';

/**
 * Tests for POST /api/sidecars/enroll.
 *
 * This route mints a long-lived enrollment JWT and hands it to the page. On a
 * self-hosted install that is the only way to add a device and must keep
 * working. On a hosted install it is the one route on the data plane that can
 * turn a panel-session cookie into a permanent credential under a NEW sid --
 * which revoking the original device does not touch -- while not even being the
 * flow a hosted user is meant to use.
 *
 * So the two cases below are the feature: refused when hosted, untouched when
 * not. The manager is a stub that would throw if it were ever reached on the
 * hosted path, so a guard that stopped guarding fails loudly rather than
 * quietly minting.
 */

type Handler = (req: Request) => Response | Promise<Response>;

/** Records whether the guard let the request through to the manager. */
function handlerFor(config: Partial<JarvisConfig>) {
  const calls: string[] = [];
  const routes = createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: { llm: { providers: {} }, ...config } as JarvisConfig,
    sidecarManager: {
      enrollSidecar: async (name: string) => {
        calls.push(name);
        return { token: 'enrollment.jwt.value', sidecar: { id: 'sid-1', name } };
      },
    } as unknown as ApiContext['sidecarManager'],
  } as ApiContext);
  const route = routes['/api/sidecars/enroll'] as { POST?: Handler } | undefined;
  if (!route?.POST) throw new Error('Route /api/sidecars/enroll POST not registered');
  return { post: route.POST, calls };
}

const enroll = (name: unknown = 'laptop') =>
  new Request('http://localhost/api/sidecars/enroll', {
    method: 'POST',
    body: JSON.stringify({ name }),
    headers: { 'Content-Type': 'application/json' },
  });

/** A complete hosted block -- hasUsejarvisAi needs both fields. */
const HOSTED = { usejarvis_ai: { base_url: 'https://llm.usejarvis.dev', api_key: 'sk-uj-abcdefghijklmnop' } };

describe('POST /api/sidecars/enroll', () => {
  it('refuses on a hosted install, and never reaches the manager', async () => {
    const { post, calls } = handlerFor(HOSTED as Partial<JarvisConfig>);
    const res = await post(enroll());

    expect(res.status).toBe(403);
    // The credential is the point: nothing may be minted on this path.
    expect(calls).toEqual([]);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeDefined();
    // The message has to name the real path, because the user is standing in
    // front of a button that just stopped working.
    expect(body.error).toContain('sign in');
  });

  it('refuses before reading the body, so a malformed request still gets the real reason', async () => {
    // Otherwise a hosted user with a bad payload would be told "Missing name"
    // and go fix the wrong thing.
    const { post, calls } = handlerFor(HOSTED as Partial<JarvisConfig>);
    const res = await post(
      new Request('http://localhost/api/sidecars/enroll', { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('still enrolls on a self-hosted install', async () => {
    // The flow this route exists for. A guard that caught everything would be
    // just as broken as one that caught nothing.
    const { post, calls } = handlerFor({});
    const res = await post(enroll('workshop-mac'));

    expect(res.status).toBe(201);
    expect(calls).toEqual(['workshop-mac']);
    const body = (await res.json()) as { token?: string };
    expect(body.token).toBe('enrollment.jwt.value');
  });

  it('an incomplete hosted block is not a hosted install', async () => {
    // hasUsejarvisAi requires both fields. Half a block is a misrendered config,
    // and treating it as hosted would lock a self-hoster out of their only way
    // to add a device.
    const { post, calls } = handlerFor({
      usejarvis_ai: { base_url: 'https://llm.usejarvis.dev' },
    } as Partial<JarvisConfig>);
    const res = await post(enroll());

    expect(res.status).toBe(201);
    expect(calls).toEqual(['laptop']);
  });

  it('refuses a hosted instance that has no LLM proxy configured', async () => {
    // The gap the LLM block alone leaves open. LLM_PROXY_URL is optional in the
    // control plane, and every render path emits `usejarvisAi: null` without it
    // -- including the DR/rehydrate path -- so a whole VPS of tenants could be
    // re-rendered into looking self-hosted. `daemon.listen: unix:` cannot be
    // absent on a hosted instance, which is why the predicate ORs the two.
    const { post, calls } = handlerFor({
      daemon: { listen: 'unix:/run/jarvis/u_42/brain.sock' },
    } as unknown as Partial<JarvisConfig>);
    const res = await post(enroll());

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('refuses when the hosted LLM block is malformed rather than absent', async () => {
    // hasUsejarvisAi fails OPEN on a non-string field (it warns and treats the
    // block as missing), which is right for a feature and wrong for a gate. The
    // socket signal covers it.
    const { post, calls } = handlerFor({
      usejarvis_ai: { base_url: 123, api_key: 456 },
      daemon: { listen: 'unix:/run/jarvis/u_42/brain.sock' },
    } as unknown as Partial<JarvisConfig>);
    const res = await post(enroll());

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('a TCP-listening install is self-hosted', async () => {
    // The other side of the socket signal: `listen` omitted (or a TCP address)
    // is the self-host default and must keep working.
    const { post, calls } = handlerFor({
      daemon: { port: 3142, listen: '' },
    } as unknown as Partial<JarvisConfig>);
    const res = await post(enroll('desk'));

    expect(res.status).toBe(201);
    expect(calls).toEqual(['desk']);
  });

  it('follows the LIVE config, so a SIGHUP reload flips the gate', async () => {
    // ctx.config is the object reloadUsejarvisAiBlock mutates in place. If a
    // refactor ever snapshotted the predicate at route-construction time, an
    // instance that became hosted would keep minting until restarted.
    const config = { llm: { providers: {} } } as JarvisConfig;
    const calls: string[] = [];
    const routes = createApiRoutes({
      daemonStartedAt: Date.now(),
      healthMonitor: {} as ApiContext['healthMonitor'],
      config,
      sidecarManager: {
        enrollSidecar: async (name: string) => {
          calls.push(name);
          return { token: 'enrollment.jwt.value', sidecar: { id: 'sid-1', name } };
        },
      } as unknown as ApiContext['sidecarManager'],
    } as ApiContext);
    const post = (routes['/api/sidecars/enroll'] as { POST: Handler }).POST;

    expect((await post(enroll())).status).toBe(201);

    (config as unknown as { usejarvis_ai: unknown }).usejarvis_ai = HOSTED.usejarvis_ai;
    expect((await post(enroll())).status).toBe(403);
    expect(calls).toEqual(['laptop']);
  });

  it('self-hosted validation is unchanged', async () => {
    // A body with no name at all -- not `enroll(undefined)`, whose default
    // parameter would quietly supply one and test nothing.
    const { post, calls } = handlerFor({});
    const res = await post(
      new Request('http://localhost/api/sidecars/enroll', {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
