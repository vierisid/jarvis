import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { loadUserSection } from './user-settings.ts';
import { effectiveLlmForBinding, effectiveTtsForBinding } from './usejarvis-ai.ts';

/**
 * The hosted onboarding contract, enforced SERVER-side.
 *
 * The wizard hides brain/hearing/speaking on a hosted install and posts no
 * provider config — but the UI cannot be the guarantee. A stale cached
 * bundle, a replayed request, or curl would otherwise write:
 *
 *   - llm.default   → effectiveLlmForBinding bails out on it, disabling all
 *                     four uj-* tiers so everything collapses onto uj-chat;
 *   - tts.provider  → marks the user as having chosen, so the included
 *                     hosted voice never applies again.
 *
 * Both are silent: the account keeps working, just off its own plan.
 */

type Handler = (req: Request) => Response | Promise<Response>;

function getHandler(routes: Record<string, unknown>, path: string, method: 'POST'): Handler {
  const route = routes[path] as { POST?: Handler } | undefined;
  const handler = route?.[method];
  if (!handler) throw new Error(`${method} ${path} not registered`);
  return handler;
}

function makeCtx(config: JarvisConfig): ApiContext {
  return {
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config,
    // The hot-reload path calls a handful of manager methods whose identity is
    // irrelevant here — what this file asserts is what gets PERSISTED. A
    // permissive stub keeps the test from breaking every time that path grows
    // a call.
    agentService: {
      getLLMManager: () => new Proxy({}, {
        get: (_t, prop) => (prop === 'getProviderNames' ? () => [] : () => null),
      }),
    } as unknown as ApiContext['agentService'],
  } as ApiContext;
}

const hostedConfig = (): JarvisConfig => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.usejarvis_ai = { base_url: 'https://llm.usejarvis.host', api_key: 'sk-uj-abc123' };
  return config;
};

const post = (handler: Handler, body: unknown) =>
  handler(new Request('http://x/api/onboarding/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

describe('POST /api/onboarding/setup on a hosted install', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  test('drops provider config a bypassing client sends, and keeps the plan defaults live', async () => {
    const config = hostedConfig();
    const handler = getHandler(createApiRoutes(makeCtx(config)), '/api/onboarding/setup', 'POST');

    const res = await post(handler, {
      llm: { providers: { anthropic: { kind: 'anthropic', api_key: 'sk-ant-x' } }, default: 'anthropic:claude-x' },
      stt: { provider: 'openai', openai: { api_key: 'sk-user' } },
      tts: { enabled: true, provider: 'edge', voice: 'en-US-AriaNeural' },
    });
    expect(res.status).toBe(200);

    // The tier wiring survives — this is what llm.default would have killed.
    expect(config.llm.default).toBeUndefined();
    expect(effectiveLlmForBinding(config).tiers).toMatchObject({
      conversation: 'usejarvis_ai:uj-chat',
      high: 'usejarvis_ai:uj-high',
    });
    // No voice intent was recorded, so the included voice still applies.
    expect(loadUserSection('stt') ?? null).toBeNull();
    expect(loadUserSection('tts') ?? null).toBeNull();
    expect(effectiveTtsForBinding(config)?.provider).toBe('usejarvis');
  });

  test('still completes setup, so onboarding does not replay next launch', async () => {
    const config = hostedConfig();
    const handler = getHandler(createApiRoutes(makeCtx(config)), '/api/onboarding/setup', 'POST');
    const res = await post(handler, { llm: { mode: 'multi-tier' } });
    expect(res.status).toBe(200);
    expect(config.onboarding?.setup_completed_at).toBeGreaterThan(0);
  });

  test('a self-hosted install is untouched by the guard', async () => {
    const config = structuredClone(DEFAULT_CONFIG); // no usejarvis_ai block
    const handler = getHandler(createApiRoutes(makeCtx(config)), '/api/onboarding/setup', 'POST');
    const res = await post(handler, {
      llm: { providers: { anthropic: { kind: 'anthropic', api_key: 'sk-ant-x' } }, default: 'anthropic:claude-x' },
      tts: { enabled: true, provider: 'edge' },
    });
    expect(res.status).toBe(200);
    // Configuring an LLM is mandatory here — it must persist exactly as sent.
    expect(config.llm.default).toBe('anthropic:claude-x');
    expect(loadUserSection('tts')).toMatchObject({ provider: 'edge' });
  });
});
