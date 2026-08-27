import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { DEFAULT_CONFIG, type JarvisConfig, type VoiceConfig } from '../config/types.ts';
import { loadUserSection } from './user-settings.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { persistUserPatch, saveUserSection } from './user-settings.ts';
import { clearRealtimeGateCache } from './realtime-gate.ts';
import { getSecret } from '../vault/keychain.ts';
import { effectiveSttForBinding, effectiveTtsForBinding, realtimeEnablement, resetRealtimeVaultWarningForTest } from './usejarvis-ai.ts';

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

/**
 * A hosted install pointed at a host that cannot resolve.
 *
 * Deliberately NOT the real `llm.usejarvis.host`: reading the realtime block
 * misses the plan-gate cache and kicks a background catalog fetch, so a
 * production hostname here means every unit-test run sends a bearer token at
 * prod infra — and a 401 back would cache a DEFINITIVE "excluded" in the
 * module-level gate cache, flaking any later test that asserts availability.
 */
function hostedConfig(): JarvisConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.usejarvis_ai = { base_url: 'https://llm.invalid/v1', api_key: 'sk-uj-abc123' };
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
    clearRealtimeGateCache();
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

  // Self-hosted on purpose: on a HOSTED install the setup route now drops
  // stt/tts entirely (the wizard never shows those steps — see
  // api-onboarding-hosted.test.ts). The patch-over-stored-row discipline this
  // pins still governs self-hosted onboarding, which does send them.
  test("onboarding 'No voice' ({enabled:false}, no provider) does not mark the user as having chosen", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const routes = createApiRoutes(makeCtx(config));
    const res = await post(getHandler(routes, '/api/onboarding/setup', 'POST'), '/api/onboarding/setup', {
      tts: { enabled: false },
    });
    expect(res.status).toBe(200);

    expect(loadUserSection('tts')).toEqual({ enabled: false });
    const onboarding = loadUserSection('onboarding') as { setup_completed_at?: number };
    expect(typeof onboarding?.setup_completed_at).toBe('number');
    // The stored-row assertion above is the one that matters: it stays
    // provider-free, so nothing is pinned and a later hosted provisioning
    // would find no recorded choice. (effectiveTtsForBinding is not checked
    // here — on a self-hosted config it returns the runtime view, which
    // legitimately carries the DEFAULT_CONFIG 'edge' fill.)
  });

  test('onboarding with a genuine provider choice persists it', async () => {
    const config = structuredClone(DEFAULT_CONFIG); // self-hosted; see above
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

  // The Settings reset must restore SILENCE, never write 'usejarvis' — a
  // recorded choice pins the account and the plan default stops applying.
  test('POST /api/config/tts {provider:null} deletes the choice rather than recording usejarvis', async () => {
    const config = hostedConfig();
    const routes = createApiRoutes(makeCtx(config));
    const handler = getHandler(routes, '/api/config/tts', 'POST');

    // A real explicit choice first — with a credential, because the thing a
    // reset must never do is delete it from the keychain (review pr7#1).
    await post(handler, '/api/config/tts', {
      enabled: true, provider: 'elevenlabs', elevenlabs: { api_key: 'el-user', voice_id: 'v1' },
    });
    expect((loadUserSection('tts') as { provider?: string }).provider).toBe('elevenlabs');
    expect(effectiveTtsForBinding(config)?.provider).toBe('elevenlabs');
    expect(getSecret('tts.elevenlabs.api_key')).toBe('el-user');

    // …then reset.
    const res = await post(handler, '/api/config/tts', { provider: null });
    expect(res.status).toBe(200);
    const stored = loadUserSection('tts') as Record<string, unknown>;
    // The explicit "cleared" sentinel — never 'usejarvis' (a recorded choice
    // would pin the account), and not a bare deletion (the surviving
    // sub-block would read as intent again via the import heuristic).
    expect(stored.provider).toBe('');
    // Unrelated settings survive the reset.
    expect(stored.enabled).toBe(true);
    expect((stored.elevenlabs as Record<string, unknown>)?.voice_id).toBe('v1');
    // The credential survives in the keychain — the one-click reset must
    // never be the thing that destroys a key the user may not have anymore.
    expect(getSecret('tts.elevenlabs.api_key')).toBe('el-user');
    // Runtime follows, so the plan's voice speaks without a restart.
    expect(config.tts?.provider).toBeUndefined();
    expect(effectiveTtsForBinding(config)?.provider).toBe('usejarvis');
  });

  test('reset with no stored row reports "nothing to reset" instead of a fake success', async () => {
    const config = hostedConfig();
    const handler = getHandler(createApiRoutes(makeCtx(config)), '/api/config/tts', 'POST');
    const res = await post(handler, '/api/config/tts', { provider: null }) as Response;
    expect(res.status).toBe(200);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('Nothing to reset');
  });

  test('POST /api/config/stt {provider:null} likewise restores the plan default', async () => {
    const config = hostedConfig();
    const handler = getHandler(createApiRoutes(makeCtx(config)), '/api/config/stt', 'POST');
    await post(handler, '/api/config/stt', { provider: 'groq', groq: { api_key: 'gsk-user' } });
    expect(effectiveSttForBinding(config)?.provider).toBe('groq');

    await post(handler, '/api/config/stt', { provider: null });
    expect((loadUserSection('stt') as Record<string, unknown>).provider).toBe('');
    expect(effectiveSttForBinding(config)?.provider).toBe('usejarvis');
    // The sub-block AND the credential survive the reset: the row keeps the
    // stripped sub-block, and the key must still be in the encrypted keychain
    // — a reset that deletes it is the pr7#1 critical, not a reset.
    expect((loadUserSection('stt') as any).groq).toBeDefined();
    expect(getSecret('stt.groq.api_key')).toBe('gsk-user');
  });

  // Self-hosted has no plan default to fall back to — clearing the choice
  // would leave createSTTProvider with nothing and silently kill STT.
  test('reset is refused on a self-hosted install', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const handler = getHandler(createApiRoutes(makeCtx(config)), '/api/config/stt', 'POST');
    const res = await post(handler, '/api/config/stt', { provider: null });
    expect(res.status).toBeGreaterThanOrEqual(400);
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

describe('voice config routes: a save must not silently decline realtime', () => {
  let secretsDir: string;
  let prevSecretsDir: string | undefined;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
    prevEnv = process.env.JARVIS_REALTIME_VOICE;
    delete process.env.JARVIS_REALTIME_VOICE;
    secretsDir = mkdtempSync(join(tmpdir(), 'jarvis-api-rt-'));
    process.env.JARVIS_SECRETS_DIR = secretsDir;
    closeDb();
    initDatabase(':memory:');
    clearRealtimeGateCache();
  });
  afterEach(() => {
    closeDb();
    if (prevSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
    else process.env.JARVIS_SECRETS_DIR = prevSecretsDir;
    if (prevEnv === undefined) delete process.env.JARVIS_REALTIME_VOICE;
    else process.env.JARVIS_REALTIME_VOICE = prevEnv;
    rmSync(secretsDir, { recursive: true, force: true });
  });

  test('changing the WAKE ENGINE does not turn realtime off', async () => {
    // The regression: the route merged the patch over the in-memory section,
    // which always carries DEFAULT_CONFIG's `realtime.enabled: false`, and
    // saved the whole thing. That false then reads as an explicit decline.
    const config = hostedConfig();
    expect(realtimeEnablement(config)).toBe('hosted-default');

    const routes = createApiRoutes(makeCtx(config));
    const res = await post(getHandler(routes, '/api/config/voice', 'POST'), '/api/config/voice', {
      wake_engine: 'webspeech',
    });
    expect(res.status).toBe(200);

    const stored = loadUserSection('voice') as { wake_engine?: string; realtime?: { enabled?: unknown } };
    expect(stored.wake_engine).toBe('webspeech');
    // The patch never mentioned realtime, so the row must not claim an answer.
    expect(stored.realtime?.enabled).toBeUndefined();
    expect(realtimeEnablement(config)).toBe('hosted-default');
  });

  test('picking a realtime VOICE does not turn realtime off', async () => {
    // The cruellest version: the user is configuring realtime at the moment it
    // switches itself off, because the partial patch merges over a base that
    // carries the default false.
    const config = hostedConfig();
    const routes = createApiRoutes(makeCtx(config));
    const res = await post(getHandler(routes, '/api/config/voice', 'POST'), '/api/config/voice', {
      realtime: { voice: 'cedar' },
    });
    expect(res.status).toBe(200);

    const stored = loadUserSection('voice') as { realtime?: { voice?: string; enabled?: unknown } };
    expect(stored.realtime?.voice).toBe('cedar');
    expect(stored.realtime?.enabled).toBeUndefined();
    expect(realtimeEnablement(config)).toBe('hosted-default');
  });

  test('an EXPLICIT off is still recorded and still wins', async () => {
    // The flip side: the discipline must not make the toggle unusable.
    const config = hostedConfig();
    const routes = createApiRoutes(makeCtx(config));
    const res = await post(getHandler(routes, '/api/config/voice', 'POST'), '/api/config/voice', {
      realtime: { enabled: false },
    });
    expect(res.status).toBe(200);
    const stored = loadUserSection('voice') as { realtime?: { enabled?: unknown } };
    expect(stored.realtime?.enabled).toBe(false);
    expect(realtimeEnablement(config)).toBe('off');
  });
});

describe('a corrupt voice row is not an answer', () => {
  let secretsDir: string;
  let prevSecretsDir: string | undefined;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
    prevEnv = process.env.JARVIS_REALTIME_VOICE;
    delete process.env.JARVIS_REALTIME_VOICE;
    secretsDir = mkdtempSync(join(tmpdir(), 'jarvis-rt-corrupt-'));
    process.env.JARVIS_SECRETS_DIR = secretsDir;
    closeDb();
    initDatabase(':memory:');
    resetRealtimeVaultWarningForTest();
  });
  afterEach(() => {
    closeDb();
    if (prevSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
    else process.env.JARVIS_SECRETS_DIR = prevSecretsDir;
    if (prevEnv === undefined) delete process.env.JARVIS_REALTIME_VOICE;
    else process.env.JARVIS_REALTIME_VOICE = prevEnv;
    rmSync(secretsDir, { recursive: true, force: true });
  });

  test('unparseable JSON fails CLOSED rather than reading as "never asked"', () => {
    // Exercised against the real vault seam, not an injected fake: the default
    // loader is where the distinction lives. loadUserSection swallows a parse
    // error and returns undefined — which means "absent", which means "default
    // it on". A tenant who declined, whose row later corrupts, would have had
    // realtime switched back on.
    setSetting('cfg.voice', '{ this is not json');
    expect(realtimeEnablement(hostedConfig())).toBe('off');
  });

  test('a well-formed row still answers normally through the same seam', () => {
    setSetting('cfg.voice', JSON.stringify({ realtime: { enabled: true } }));
    expect(realtimeEnablement(hostedConfig())).toBe('user-on');
    setSetting('cfg.voice', JSON.stringify({ wake_engine: 'openwakeword' }));
    expect(realtimeEnablement(hostedConfig())).toBe('hosted-default');
  });

  test('the reader reads what the WRITER writes — no hardcoded key', () => {
    // Written through saveUserSection rather than setSetting so the settings
    // key is never spelled out on the read side. It once was, in a copy of the
    // `cfg.` prefix: had that prefix changed, the reader would have missed the
    // row, read it as "never asked", and switched realtime ON for a tenant who
    // had explicitly declined — silently, and into billed audio sessions.
    saveUserSection('voice', { realtime: { enabled: false } } as unknown as VoiceConfig);
    expect(realtimeEnablement(hostedConfig())).toBe('off');

    saveUserSection('voice', { realtime: { enabled: true } } as unknown as VoiceConfig);
    expect(realtimeEnablement(hostedConfig())).toBe('user-on');

    saveUserSection('voice', { wake_engine: 'openwakeword' } as unknown as VoiceConfig);
    expect(realtimeEnablement(hostedConfig())).toBe('hosted-default');
  });
});

describe('GET /api/config/voice tells the truth about who pays', () => {
  let secretsDir: string;
  let prevSecretsDir: string | undefined;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
    prevEnv = process.env.JARVIS_REALTIME_VOICE;
    delete process.env.JARVIS_REALTIME_VOICE;
    secretsDir = mkdtempSync(join(tmpdir(), 'jarvis-rt-served-'));
    process.env.JARVIS_SECRETS_DIR = secretsDir;
    closeDb();
    initDatabase(':memory:');
    clearRealtimeGateCache();
  });
  afterEach(() => {
    closeDb();
    if (prevSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
    else process.env.JARVIS_SECRETS_DIR = prevSecretsDir;
    if (prevEnv === undefined) delete process.env.JARVIS_REALTIME_VOICE;
    else process.env.JARVIS_REALTIME_VOICE = prevEnv;
    rmSync(secretsDir, { recursive: true, force: true });
  });

  const read = async (config: JarvisConfig) => {
    const routes = createApiRoutes(makeCtx(config));
    const res = await getHandler(routes, '/api/config/voice', 'GET')(
      new Request('http://x/api/config/voice'),
    );
    return (await res.json()) as { realtime: { served_by_plan?: boolean; enabled: boolean } };
  };

  test('a hosted tenant who DECLINED is still told the plan would serve it', async () => {
    // The regression: served_by_plan was derived from a resolution computed
    // under the current enablement, so an off toggle made it false — and the
    // tab then told them they would be "billed by OpenAI, ~$0.30/min", right
    // next to the switch they were deciding whether to flip. Who would serve a
    // session is a property of the install, not of whether one is running.
    setSetting('cfg.voice', JSON.stringify({ realtime: { enabled: false } }));
    const body = await read(hostedConfig());
    expect(body.realtime.enabled).toBe(false);
    expect(body.realtime.served_by_plan).toBe(true);
  });

  test('a hosted tenant with realtime on is told the same thing', async () => {
    const body = await read(hostedConfig());
    expect(body.realtime.enabled).toBe(true);
    expect(body.realtime.served_by_plan).toBe(true);
  });

  test('a hosted tenant with a BYO OpenAI key is NOT told they pay for it', async () => {
    // The whole point of the precedence inversion: their own key is not read
    // on a hosted install, so the billing copy must not claim otherwise.
    const config = hostedConfig();
    config.llm = { providers: { openai: { api_key: 'sk-their-own' } } } as JarvisConfig['llm'];
    expect((await read(config)).realtime.served_by_plan).toBe(true);
  });

  test('a self-hosted install says the opposite, because it IS their key', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.llm = { providers: { openai: { api_key: 'sk-their-own' } } } as JarvisConfig['llm'];
    expect((await read(config)).realtime.served_by_plan).toBe(false);
  });
});

describe('replacing an unreadable settings row says so', () => {
  let secretsDir: string;
  let prevSecretsDir: string | undefined;
  let warnings: string[];
  let realWarn: typeof console.warn;

  beforeEach(() => {
    prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
    secretsDir = mkdtempSync(join(tmpdir(), 'jarvis-rt-warn-'));
    process.env.JARVIS_SECRETS_DIR = secretsDir;
    closeDb();
    initDatabase(':memory:');
    warnings = [];
    realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  });
  afterEach(() => {
    console.warn = realWarn;
    closeDb();
    if (prevSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
    else process.env.JARVIS_SECRETS_DIR = prevSecretsDir;
    rmSync(secretsDir, { recursive: true, force: true });
  });

  const replaced = () => warnings.filter((w) => w.includes('is being REPLACED'));

  test('warns when the row will not parse', () => {
    // The read path fails closed on corruption; the write path cannot refuse
    // without locking someone out of their own settings, so it is loud instead
    // — an explicit realtime decline is about to be lost.
    setSetting('cfg.voice', '{ not json');
    persistUserPatch('voice', { wake_engine: 'webspeech' });
    expect(replaced()).toHaveLength(1);
  });

  test('warns when the row parses to the WRONG SHAPE', () => {
    // The earlier condition keyed on loadUserSection returning undefined, which
    // this case does not: valid JSON of the wrong type parses fine and was
    // replaced in silence.
    setSetting('cfg.voice', '[1,2]');
    persistUserPatch('voice', { wake_engine: 'webspeech' });
    expect(replaced()).toHaveLength(1);
  });

  test('stays QUIET for an absent row and for a canonical null row', () => {
    // saveUserSection writes 'null' for an absent section, so warning on it
    // would fire on ordinary saves for anyone who has never set voice options.
    persistUserPatch('voice', { wake_engine: 'webspeech' });
    expect(replaced()).toHaveLength(0);
    setSetting('cfg.voice', 'null');
    persistUserPatch('voice', { wake_engine: 'openwakeword' });
    expect(replaced()).toHaveLength(0);
  });

  test('stays quiet for a healthy row, and preserves it', () => {
    setSetting('cfg.voice', JSON.stringify({ realtime: { enabled: false } }));
    persistUserPatch('voice', { wake_engine: 'webspeech' });
    expect(replaced()).toHaveLength(0);
    const stored = JSON.parse(getSetting('cfg.voice')!) as { realtime?: { enabled?: boolean } };
    expect(stored.realtime?.enabled).toBe(false); // the decline survived
  });
});
