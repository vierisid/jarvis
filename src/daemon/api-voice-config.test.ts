import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { loadUserSection } from './user-settings.ts';
import { effectiveSttForBinding, effectiveTtsForBinding } from './usejarvis-ai.ts';

/**
 * Route-level regressions for the voice-config persistence discipline.
 *
 * The hosted "Usejarvis AI" STT/TTS defaults key off SILENCE: a stored
 * cfg.stt / cfg.tts row without a `provider` field. These routes used to
 * persist the merged in-memory section (which carries DEFAULT_CONFIG fills
 * like provider 'edge'), so a bare "Enable TTS" toggle or the onboarding
 * "No voice" answer stamped a provider choice the user never made and
 * permanently defeated the default. Every save path must instead persist the
 * request PATCH over the stored row (persistUserPatch).
 */

type Handler = (req: Request) => Response | Promise<Response>;
type MethodHandlers = { GET?: Handler; POST?: Handler };

function getHandler(routes: Record<string, unknown>, path: string, method: 'GET' | 'POST'): Handler {
  const route = routes[path] as MethodHandlers | undefined;
  if (!route) throw new Error(`Route ${path} not registered`);
  const handler = route[method];
  if (!handler) throw new Error(`Method ${method} not registered for ${path}`);
  return handler;
}

function hostedConfig(): JarvisConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.usejarvis_ai = { base_url: 'https://llm.usejarvis.host', api_key: 'sk-uj-abc123' };
  return config;
}

function makeCtx(config: JarvisConfig): ApiContext {
  return {
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config,
    agentService: {} as ApiContext['agentService'],
  } as ApiContext;
}

function post(handler: Handler, url: string, body: unknown): Response | Promise<Response> {
  return handler(new Request(`http://x${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('voice config routes: persistence stays silence-preserving', () => {
  // These routes reach persistSectionSecrets — redirect the keychain to a
  // throwaway dir so tests never touch the real store (same as user-settings.test.ts).
  let secretsDir: string;
  let prevSecretsDir: string | undefined;

  beforeEach(() => {
    prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
    secretsDir = mkdtempSync(join(tmpdir(), 'jarvis-api-voice-'));
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

  test('POST /api/config/tts {enabled:true} leaves the stored row provider-free (hosted default survives)', async () => {
    const config = hostedConfig();
    const routes = createApiRoutes(makeCtx(config));
    const res = await post(getHandler(routes, '/api/config/tts', 'POST'), '/api/config/tts', { enabled: true });
    expect(res.status).toBe(200);

    // The row records exactly what was asked — no DEFAULT provider stamp.
    expect(loadUserSection('tts')).toEqual({ enabled: true });
    // Runtime view updated...
    expect(config.tts?.enabled).toBe(true);
    // ...and the hosted default still fires because the user is still silent.
    expect(effectiveTtsForBinding(config)?.provider).toBe('usejarvis');
  });

  test('POST /api/config/stt with a key-only patch leaves the stored row provider-free', async () => {
    const config = hostedConfig();
    const routes = createApiRoutes(makeCtx(config));
    const res = await post(getHandler(routes, '/api/config/stt', 'POST'), '/api/config/stt', {
      openai: { api_key: 'sk-user' },
    });
    expect(res.status).toBe(200);

    // Row is written stripped (credentials split to the keychain) — what this
    // pins is the absence of a `provider`, not the key round-tripping.
    expect(loadUserSection('stt')).toEqual({ openai: {} });
    expect(config.stt?.openai?.api_key).toBe('sk-user'); // runtime view
    // A row carrying a provider sub-block IS intent (storedProviderChoice):
    // the user who pasted an OpenAI key gets their own provider, not the
    // hosted default silently re-routing their audio past it.
    expect(effectiveSttForBinding(config)?.provider).toBe('openai');
  });

  test('POST /api/config/stt with an explicit provider records intent and wins over the default', async () => {
    const config = hostedConfig();
    const routes = createApiRoutes(makeCtx(config));
    await post(getHandler(routes, '/api/config/stt', 'POST'), '/api/config/stt', {
      provider: 'groq',
      groq: { api_key: 'gsk-user' },
    });

    expect(loadUserSection('stt')).toEqual({ provider: 'groq', groq: {} });
    expect(effectiveSttForBinding(config)?.provider).toBe('groq');
  });

  test("onboarding 'No voice' ({enabled:false}, no provider) does not mark the user as having chosen", async () => {
    const config = hostedConfig();
    const routes = createApiRoutes(makeCtx(config));
    const res = await post(getHandler(routes, '/api/onboarding/setup', 'POST'), '/api/onboarding/setup', {
      tts: { enabled: false },
    });
    expect(res.status).toBe(200);

    expect(loadUserSection('tts')).toEqual({ enabled: false });
    const onboarding = loadUserSection('onboarding') as { setup_completed_at?: number };
    expect(typeof onboarding?.setup_completed_at).toBe('number');
    // When TTS is enabled later, the included hosted voice is the default.
    expect(effectiveTtsForBinding(config)?.provider).toBe('usejarvis');
  });

  test('onboarding with a genuine provider choice persists it', async () => {
    const config = hostedConfig();
    const routes = createApiRoutes(makeCtx(config));
    await post(getHandler(routes, '/api/onboarding/setup', 'POST'), '/api/onboarding/setup', {
      tts: { enabled: true, provider: 'edge', voice: 'en-GB-SoniaNeural', rate: '+0%' },
    });

    expect(loadUserSection('tts')).toEqual({
      enabled: true, provider: 'edge', voice: 'en-GB-SoniaNeural', rate: '+0%',
    });
    expect(effectiveTtsForBinding(config)?.provider).toBe('edge');
  });

  test('POST /api/config/tts rejects provider usejarvis on a self-hosted install', async () => {
    const config = structuredClone(DEFAULT_CONFIG); // no usejarvis_ai block
    const routes = createApiRoutes(makeCtx(config));
    const res = await post(getHandler(routes, '/api/config/tts', 'POST'), '/api/config/tts', { provider: 'usejarvis' }) as Response;
    expect(res.status).toBe(400);
    expect(loadUserSection('tts')).toBeUndefined(); // nothing persisted
  });

  test('POST /api/config/tts rejects an unknown provider string', async () => {
    const config = hostedConfig();
    const routes = createApiRoutes(makeCtx(config));
    const res = await post(getHandler(routes, '/api/config/tts', 'POST'), '/api/config/tts', { provider: 'espeak' }) as Response;
    expect(res.status).toBe(400);
  });

  test('POST /api/config/tts that yields no provider clears the live one instead of leaving it speaking', async () => {
    const config = hostedConfig();
    const setCalls: unknown[] = [];
    const ctx = makeCtx(config);
    (ctx as unknown as Record<string, unknown>).wsService = {
      setTTSProvider: (p: unknown) => { setCalls.push(p); },
    };
    const routes = createApiRoutes(ctx);
    const res = await post(getHandler(routes, '/api/config/tts', 'POST'), '/api/config/tts', { enabled: false }) as Response;
    expect(res.status).toBe(200);
    expect(setCalls).toEqual([null]); // published the null, not skipped it
  });

  test('GET /api/config/tts reports the binding-view provider and availability, no key material', async () => {
    const config = hostedConfig();
    const routes = createApiRoutes(makeCtx(config));
    const res = await getHandler(routes, '/api/config/tts', 'GET')(new Request('http://x/api/config/tts'));
    const body = await (res as Response).json() as Record<string, unknown>;
    expect(body.provider).toBe('usejarvis');
    expect(body.usejarvis_available).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-uj-abc123');
  });
});
