import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  // The setup route persists a user section, which writes section secrets to
  // the keychain — and keychain.ts REFUSES to run under test without an
  // explicit secrets dir, because a file that forgot this once wiped real
  // keys. Without it every case here 500s on the write and the failure reads
  // as a broken route rather than a missing fixture.
  let secretsDir: string;
  let prevSecretsDir: string | undefined;

  beforeEach(() => {
    prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
    secretsDir = mkdtempSync(join(tmpdir(), 'jarvis-onboarding-hosted-'));
    process.env.JARVIS_SECRETS_DIR = secretsDir;
    closeDb();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDb();
    if (prevSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
    else process.env.JARVIS_SECRETS_DIR = prevSecretsDir;
    rmSync(secretsDir, { recursive: true, force: true });
  });

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
    // No voice PROVIDER intent was recorded, so the included voice applies…
    expect(loadUserSection('stt') ?? null).toBeNull();
    expect((loadUserSection('tts') as { provider?: string } | undefined)?.provider).toBeUndefined();
    expect(effectiveTtsForBinding(config)?.provider).toBe('usejarvis');
    // …and the assistant actually SPEAKS. DEFAULT_CONFIG.tts.enabled is
    // false, so dropping `enabled` along with the provider would ship a
    // hosted install mute while the wizard promises voice is included.
    expect(config.tts?.enabled).toBe(true);
    // The guard REPORTS what it stripped: a wizard that raced the hosted
    // probe collected this config, and a plain ok would let it print
    // "✓ brain · Anthropic" for credentials that were never saved.
    const body = await (res as Response).json() as { dropped?: string[] };
    expect(body.dropped?.sort()).toEqual(['llm', 'stt', 'tts']);
  });

  test('a clean hosted payload (mode + enabled only) reports nothing dropped', async () => {
    const config = hostedConfig();
    const handler = getHandler(createApiRoutes(makeCtx(config)), '/api/onboarding/setup', 'POST');
    const res = await post(handler, { llm: { mode: 'multi-tier' }, tts: { enabled: true } });
    const body = await (res as Response).json() as { dropped?: string[] };
    expect(body.dropped).toEqual([]);
  });

  test('still completes setup, so onboarding does not replay next launch', async () => {
    const config = hostedConfig();
    const handler = getHandler(createApiRoutes(makeCtx(config)), '/api/onboarding/setup', 'POST');
    const res = await post(handler, { llm: { mode: 'multi-tier' }, tts: { enabled: true } });
    expect(res.status).toBe(200);
    expect(config.onboarding?.setup_completed_at).toBeGreaterThan(0);
  });

  test('the tts whitelist admits enabled ONLY — a smuggled provider is still dropped', async () => {
    const config = hostedConfig();
    const handler = getHandler(createApiRoutes(makeCtx(config)), '/api/onboarding/setup', 'POST');
    await post(handler, { tts: { enabled: true, provider: 'edge', voice: 'en-GB-SoniaNeural' } });

    expect(config.tts?.enabled).toBe(true);
    const stored = loadUserSection('tts') as Record<string, unknown> | undefined;
    expect(stored?.provider).toBeUndefined();
    expect(stored?.voice).toBeUndefined();
    // Still silent, so the plan's voice is what speaks.
    expect(effectiveTtsForBinding(config)?.provider).toBe('usejarvis');
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
