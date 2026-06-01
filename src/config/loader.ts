import YAML from 'yaml';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { JarvisConfig } from './types.ts';
import { DEFAULT_CONFIG } from './types.ts';
import { secureParentDirectory, secureWriteFile } from '../util/fs-secure.ts';

function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

function deepMerge(target: any, source: any): any {
  if (!source || typeof source !== 'object') {
    // If source is absent, return a clone of target so callers (or subsequent
    // mutation of the returned value) can never alias shared defaults.
    return source !== undefined ? source : structuredClone(target);
  }

  if (Array.isArray(source)) {
    return [...source];
  }

  const result = { ...target };

  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (
        source[key] &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        target[key] &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        result[key] = deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }

  return result;
}

/**
 * Apply environment variable overrides to config.
 * Env vars take highest precedence (over YAML and defaults).
 */
function applyEnvOverrides(config: JarvisConfig): void {
  const env = process.env;

  if (env.JARVIS_PORT) {
    const port = parseInt(env.JARVIS_PORT, 10);
    if (!isNaN(port)) config.daemon.port = port;
  }

  if (env.JARVIS_HOME) {
    const home = env.JARVIS_HOME;
    config.daemon.data_dir = home;
    config.daemon.db_path = join(home, 'jarvis.db');
  }

  if (env.JARVIS_API_KEY) {
    if (!config.llm.anthropic) config.llm.anthropic = { api_key: '', model: 'claude-sonnet-4-5-20250929' };
    config.llm.anthropic.api_key = env.JARVIS_API_KEY;
  }

  if (env.JARVIS_OPENAI_KEY) {
    if (!config.llm.openai) config.llm.openai = { api_key: '', model: 'gpt-4o' };
    config.llm.openai.api_key = env.JARVIS_OPENAI_KEY;
  }

  if (env.JARVIS_GROQ_KEY) {
    if (!config.llm.groq) config.llm.groq = { api_key: '', model: 'llama-3.3-70b-versatile' };
    config.llm.groq.api_key = env.JARVIS_GROQ_KEY;
  }

  if (env.JARVIS_OLLAMA_URL) {
    if (!config.llm.ollama) config.llm.ollama = { base_url: '', model: 'llama3' };
    config.llm.ollama.base_url = env.JARVIS_OLLAMA_URL;
  }

  if (env.JARVIS_OPENROUTER_KEY) {
    if (!config.llm.openrouter) config.llm.openrouter = { api_key: '', model: 'anthropic/claude-sonnet-4' };
    config.llm.openrouter.api_key = env.JARVIS_OPENROUTER_KEY;
  }

  if (env.NVIDIA_API_KEY) {
    if (!config.llm.nvidia) config.llm.nvidia = { api_key: '', model: 'meta/llama-3.3-70b-instruct' };
    config.llm.nvidia.api_key = env.NVIDIA_API_KEY;
  }

  if (env.JARVIS_LITELLM_URL || env.JARVIS_LITELLM_KEY) {
    if (!config.llm.litellm) config.llm.litellm = { base_url: 'http://localhost:4000/v1', api_key: '', model: '' };
    if (env.JARVIS_LITELLM_URL) config.llm.litellm.base_url = env.JARVIS_LITELLM_URL;
    if (env.JARVIS_LITELLM_KEY) config.llm.litellm.api_key = env.JARVIS_LITELLM_KEY;
  }

  if (env.JARVIS_BRAIN_DOMAIN) {
    config.daemon.brain_domain = env.JARVIS_BRAIN_DOMAIN;
  }

  if (env.JARVIS_AUTH_TOKEN) {
    if (!config.auth) config.auth = {};
    config.auth.token = env.JARVIS_AUTH_TOKEN;
  }

  if (env.JARVIS_WAKE_ENGINE) {
    const engine = env.JARVIS_WAKE_ENGINE;
    if (engine === 'openwakeword' || engine === 'webspeech' || engine === 'auto') {
      if (!config.voice) config.voice = { wake_engine: 'openwakeword' };
      config.voice.wake_engine = engine;
    } else {
      console.warn(`[Config] Invalid JARVIS_WAKE_ENGINE="${engine}" — must be openwakeword|webspeech|auto; ignoring.`);
    }
  }

  // Premium realtime voice (gpt-realtime-2). Truthy values enable; "0"/"false"
  // explicitly disable. See docs/GPT_REALTIME_2_INTEGRATION.md.
  if (env.JARVIS_REALTIME_VOICE !== undefined) {
    if (!config.voice) config.voice = { wake_engine: 'openwakeword' };
    if (!config.voice.realtime) config.voice.realtime = { enabled: false };
    const v = env.JARVIS_REALTIME_VOICE.trim().toLowerCase();
    config.voice.realtime.enabled = v !== '' && v !== '0' && v !== 'false' && v !== 'no';
  }
}

export async function loadConfig(configPath?: string): Promise<JarvisConfig> {
  const path = configPath || expandTilde('~/.jarvis/config.yaml');

  const file = Bun.file(path);
  const exists = await file.exists();

  if (!exists) {
    console.warn(`Config file not found at ${path}, using defaults`);
    const config = structuredClone(DEFAULT_CONFIG);
    config.daemon.data_dir = expandTilde(config.daemon.data_dir);
    config.daemon.db_path = expandTilde(config.daemon.db_path);
    applyEnvOverrides(config);
    return config;
  }

  // File exists — parse errors should be fatal.
  // `merge: true` enables YAML merge keys (`<<: *anchor`) so configs can share
  // blocks across environments. Removing this flag would silently break any
  // config that relies on anchors — keep it unless you're sure.
  const text = await file.text();
  const doc = YAML.parseDocument(text, { merge: true });
  if (doc.errors.length > 0) {
    // `yaml`'s error.message already embeds `at line X, column Y:` and a caret
    // diagram, so no need to prefix our own position info.
    const formatted = doc.errors.map((entry) => entry.message);
    throw new Error(`Failed to parse YAML config at ${path}:\n  ${formatted.join('\n  ')}`);
  }
  // `doc.toJS()` returns null for an empty (or comment-only) file — coerce to
  // an empty object so downstream merges fall back cleanly to defaults.
  const parsed = (doc.toJS() ?? {}) as Partial<JarvisConfig>;

  // Deep merge with defaults to ensure all required fields exist
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), parsed) as JarvisConfig;

  // Expand tilde in paths
  config.daemon.data_dir = expandTilde(config.daemon.data_dir);
  config.daemon.db_path = expandTilde(config.daemon.db_path);

  // Apply environment variable overrides
  applyEnvOverrides(config);

  return config;
}

/**
 * Migrate legacy LLM config shapes into the canonical
 * `llm.providers` + `llm.default` / `llm.tiers` shape, in-memory.
 *
 * Handles two layered migrations:
 *
 * 1. Legacy per-provider blocks (`llm.anthropic: {api_key, model}`) are
 *    promoted to `llm.providers.anthropic: {api_key}` and the model is
 *    captured for later use in tier/default model strings.
 *
 * 2. Legacy `llm.primary` + the captured per-provider model are combined
 *    into either `llm.default` (single-LLM mode) or `llm.tiers.medium`
 *    (when tiers are partially configured), keeping the old behavior.
 *
 * 3. Legacy `llm.tiers.{tier}: {provider, model?}` object form is
 *    converted to the new string form `"provider:model"`.
 *
 * 4. Legacy `llm.fallback` is dropped with a deprecation warning - tier
 *    fall-up replaces it.
 *
 * Idempotent: re-running the migration on an already-migrated config is a
 * no-op. Call this AFTER any source that may mutate the legacy fields
 * (env vars, DB settings merge) so the derived shape matches the final state.
 */
export function migrateLegacyLLMConfig(config: JarvisConfig): void {
  const llm = config.llm;
  if (!llm.providers) llm.providers = {};
  if (!llm.tiers) llm.tiers = {};

  // Track legacy per-provider models so we can rebuild model strings.
  const legacyModels: Record<string, string | undefined> = {};

  const promote = (
    name: string,
    block: { api_key?: string; base_url?: string; model?: string } | undefined,
  ) => {
    if (!block) return;
    if (block.model) legacyModels[name] = block.model;
    // Only register the provider if it has usable credentials/endpoint.
    const hasCreds = (block.api_key && block.api_key.length > 0) || (block.base_url && block.base_url.length > 0);
    if (!hasCreds) return;
    if (llm.providers![name]) return;  // explicit new-shape entry wins
    llm.providers![name] = {
      ...(block.api_key !== undefined ? { api_key: block.api_key } : {}),
      ...(block.base_url !== undefined ? { base_url: block.base_url } : {}),
    };
  };

  promote('anthropic', llm.anthropic);
  promote('openai', llm.openai);
  promote('groq', llm.groq);
  promote('gemini', llm.gemini);
  promote('ollama', llm.ollama);
  promote('openrouter', llm.openrouter);
  promote('nvidia', llm.nvidia);
  promote('openai_compatible', llm.openai_compatible);
  promote('litellm', llm.litellm);

  // Convert any legacy tier object form into string form.
  for (const tier of ['conversation', 'high', 'medium', 'low'] as const) {
    const value = llm.tiers[tier] as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as { provider?: string; model?: string };
      if (obj.provider) {
        const model = obj.model ?? legacyModels[obj.provider];
        if (model) {
          llm.tiers[tier] = `${obj.provider}:${model}`;
        } else {
          // Provider without a known model - leave undefined so resolution falls up.
          delete llm.tiers[tier];
        }
      }
    }
  }

  // If neither default nor any tier is set, derive single-LLM `default`
  // from the legacy primary so existing one-LLM configs keep working.
  const anyTierSet =
    llm.tiers.conversation || llm.tiers.high || llm.tiers.medium || llm.tiers.low;
  if (!llm.default && !anyTierSet && llm.primary) {
    const model = legacyModels[llm.primary];
    if (model) llm.default = `${llm.primary}:${model}`;
  }

  if (llm.fallback && llm.fallback.length > 0) {
    console.warn(
      '[Config] `llm.fallback` is deprecated. Configure per-tier models via `llm.tiers.{conversation,high,medium,low}` instead - tier fall-up replaces the fallback chain.',
    );
  }
}

/**
 * Strip legacy LLM config fields AND any api_keys in provider entries when
 * writing to disk. We always persist the canonical `providers` + `default`
 * / `tiers` shape; the legacy per-provider blocks and `primary`/`fallback`
 * aliases are only read by the loader for backward compatibility.
 *
 * api_keys live in the encrypted keychain. They may transiently appear in
 * `config.llm.providers.<name>.api_key` (injected by the settings merge so
 * providers can be instantiated) - those MUST be stripped before YAML write
 * to prevent leaking secrets to disk in plaintext.
 */
function stripLegacyLLMFields(config: JarvisConfig): JarvisConfig {
  const clone = structuredClone(config);
  const llm = clone.llm as Record<string, unknown>;
  delete llm.primary;
  delete llm.fallback;
  delete llm.anthropic;
  delete llm.openai;
  delete llm.groq;
  delete llm.gemini;
  delete llm.ollama;
  delete llm.openrouter;
  delete llm.nvidia;
  delete llm.openai_compatible;
  delete llm.litellm;
  if (clone.llm.providers) {
    for (const name of Object.keys(clone.llm.providers)) {
      const entry = clone.llm.providers[name];
      if (entry && 'api_key' in entry) {
        delete (entry as { api_key?: string }).api_key;
      }
    }
  }
  return clone;
}

export async function saveConfig(
  config: JarvisConfig,
  configPath?: string
): Promise<void> {
  const path = configPath || expandTilde('~/.jarvis/config.yaml');

  try {
    const canonical = stripLegacyLLMFields(config);
    const yaml = YAML.stringify(canonical, {
      indent: 2,
      lineWidth: 100,
      defaultStringType: 'PLAIN',
      defaultKeyType: 'PLAIN',
    });

    await secureParentDirectory(path);
    await secureWriteFile(path, yaml, 0o600, 'Config');
    console.log(`Config saved to ${path}`);
  } catch (err) {
    throw new Error(`Failed to save config to ${path}: ${err}`);
  }
}
