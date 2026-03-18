/**
 * LLM Settings — Bridge between DB settings, encrypted keychain, and in-memory config.
 *
 * Non-secret settings (provider, model, fallback) are stored in the SQLite `settings` table.
 * API keys are stored in the encrypted secrets file via the keychain module.
 */

import { getSetting, setSetting, getSettingsByPrefix } from '../vault/settings.ts';
import { getSecret, setSecret, deleteSecret, hasSecret } from '../vault/keychain.ts';
import type { JarvisConfig } from '../config/types.ts';
import { AnthropicProvider } from '../llm/anthropic.ts';
import { OpenAIProvider } from '../llm/openai.ts';
import { GeminiProvider } from '../llm/gemini.ts';
import { OllamaProvider } from '../llm/ollama.ts';
import { OpenRouterProvider } from '../llm/openrouter.ts';
import type { LLMProvider } from '../llm/provider.ts';
import type { LLMManager } from '../llm/manager.ts';

// Keychain key names
const KEY_ANTHROPIC = 'llm.anthropic.api_key';
const KEY_OPENAI = 'llm.openai.api_key';
const KEY_GEMINI = 'llm.gemini.api_key';
const KEY_OPENROUTER = 'llm.openrouter.api_key';

// DB setting keys
const SETTING_PRIMARY = 'llm.primary';
const SETTING_FALLBACK = 'llm.fallback';
const SETTING_ANTHROPIC_MODEL = 'llm.anthropic.model';
const SETTING_OPENAI_MODEL = 'llm.openai.model';
const SETTING_GEMINI_MODEL = 'llm.gemini.model';
const SETTING_OLLAMA_MODEL = 'llm.ollama.model';
const SETTING_OLLAMA_BASE_URL = 'llm.ollama.base_url';
const SETTING_OPENROUTER_MODEL = 'llm.openrouter.model';

export type LLMSettingsResponse = {
  primary: string;
  fallback: string[];
  anthropic: { model: string; has_api_key: boolean } | null;
  openai: { model: string; has_api_key: boolean } | null;
  gemini: { model: string; has_api_key: boolean } | null;
  ollama: { base_url: string; model: string } | null;
  openrouter: { model: string; has_api_key: boolean } | null;
};

/**
 * Read LLM settings from DB + keychain and return a dashboard-safe response.
 * Falls back to in-memory config values for anything not yet saved to DB.
 */
export function getLLMSettings(config: JarvisConfig): LLMSettingsResponse {
  const primary = getSetting(SETTING_PRIMARY) ?? config.llm.primary;
  const fallbackRaw = getSetting(SETTING_FALLBACK);
  const fallback = fallbackRaw ? JSON.parse(fallbackRaw) : config.llm.fallback;

  const anthropicModel = getSetting(SETTING_ANTHROPIC_MODEL) ?? config.llm.anthropic?.model ?? 'claude-sonnet-4-6';
  const openaiModel = getSetting(SETTING_OPENAI_MODEL) ?? config.llm.openai?.model ?? 'gpt-5.4';
  const geminiModel = getSetting(SETTING_GEMINI_MODEL) ?? config.llm.gemini?.model ?? 'gemini-3-flash-preview';
  const ollamaModel = getSetting(SETTING_OLLAMA_MODEL) ?? config.llm.ollama?.model ?? 'llama3';
  const ollamaBaseUrl = getSetting(SETTING_OLLAMA_BASE_URL) ?? config.llm.ollama?.base_url ?? 'http://localhost:11434';

  const openrouterModel = getSetting(SETTING_OPENROUTER_MODEL) ?? config.llm.openrouter?.model ?? 'anthropic/claude-sonnet-4';

  const hasAnthropicKey = hasSecret(KEY_ANTHROPIC) || !!config.llm.anthropic?.api_key;
  const hasOpenaiKey = hasSecret(KEY_OPENAI) || !!config.llm.openai?.api_key;
  const hasGeminiKey = hasSecret(KEY_GEMINI) || !!config.llm.gemini?.api_key;
  const hasOpenrouterKey = hasSecret(KEY_OPENROUTER) || !!config.llm.openrouter?.api_key;

  return {
    primary,
    fallback,
    anthropic: { model: anthropicModel, has_api_key: hasAnthropicKey },
    openai: { model: openaiModel, has_api_key: hasOpenaiKey },
    gemini: { model: geminiModel, has_api_key: hasGeminiKey },
    ollama: { base_url: ollamaBaseUrl, model: ollamaModel },
    openrouter: { model: openrouterModel, has_api_key: hasOpenrouterKey },
  };
}

/**
 * Save LLM settings to DB + keychain and update the in-memory config.
 */
export function saveLLMSettings(
  config: JarvisConfig,
  body: {
    primary?: string;
    fallback?: string[];
    anthropic?: { api_key?: string; model?: string };
    openai?: { api_key?: string; model?: string };
    gemini?: { api_key?: string; model?: string };
    ollama?: { base_url?: string; model?: string };
    openrouter?: { api_key?: string; model?: string };
  },
): void {
  // Save non-secret settings to DB
  if (body.primary) {
    setSetting(SETTING_PRIMARY, body.primary);
    config.llm.primary = body.primary;
  }
  if (body.fallback) {
    setSetting(SETTING_FALLBACK, JSON.stringify(body.fallback));
    config.llm.fallback = body.fallback;
  }

  // Anthropic
  if (body.anthropic) {
    if (body.anthropic.model) {
      setSetting(SETTING_ANTHROPIC_MODEL, body.anthropic.model);
    }
    if (body.anthropic.api_key) {
      setSecret(KEY_ANTHROPIC, body.anthropic.api_key);
    }
    config.llm.anthropic = {
      ...config.llm.anthropic,
      model: body.anthropic.model ?? config.llm.anthropic?.model,
      api_key: body.anthropic.api_key ?? getAnthropicApiKey(config) ?? '',
    };
  }

  // OpenAI
  if (body.openai) {
    if (body.openai.model) {
      setSetting(SETTING_OPENAI_MODEL, body.openai.model);
    }
    if (body.openai.api_key) {
      setSecret(KEY_OPENAI, body.openai.api_key);
    }
    config.llm.openai = {
      ...config.llm.openai,
      model: body.openai.model ?? config.llm.openai?.model,
      api_key: body.openai.api_key ?? getOpenAIApiKey(config) ?? '',
    };
  }

  // Gemini
  if (body.gemini) {
    if (body.gemini.model) {
      setSetting(SETTING_GEMINI_MODEL, body.gemini.model);
    }
    if (body.gemini.api_key) {
      setSecret(KEY_GEMINI, body.gemini.api_key);
    }
    config.llm.gemini = {
      ...config.llm.gemini,
      model: body.gemini.model ?? config.llm.gemini?.model,
      api_key: body.gemini.api_key ?? getGeminiApiKey(config) ?? '',
    };
  }

  // Ollama
  if (body.ollama) {
    if (body.ollama.model) {
      setSetting(SETTING_OLLAMA_MODEL, body.ollama.model);
    }
    if (body.ollama.base_url) {
      setSetting(SETTING_OLLAMA_BASE_URL, body.ollama.base_url);
    }
    config.llm.ollama = {
      ...config.llm.ollama,
      model: body.ollama.model ?? config.llm.ollama?.model,
      base_url: body.ollama.base_url ?? config.llm.ollama?.base_url,
    };
  }

  // OpenRouter
  if (body.openrouter) {
    if (body.openrouter.model) {
      setSetting(SETTING_OPENROUTER_MODEL, body.openrouter.model);
    }
    if (body.openrouter.api_key) {
      setSecret(KEY_OPENROUTER, body.openrouter.api_key);
    }
    config.llm.openrouter = {
      ...config.llm.openrouter,
      model: body.openrouter.model ?? config.llm.openrouter?.model,
      api_key: body.openrouter.api_key ?? getOpenRouterApiKey(config) ?? '',
    };
  }
}

/**
 * Resolve the Anthropic API key: keychain > config.yaml > env var.
 */
function getAnthropicApiKey(config: JarvisConfig): string | null {
  return getSecret(KEY_ANTHROPIC) ?? config.llm.anthropic?.api_key ?? null;
}

/**
 * Resolve the OpenAI API key: keychain > config.yaml > env var.
 */
function getOpenAIApiKey(config: JarvisConfig): string | null {
  return getSecret(KEY_OPENAI) ?? config.llm.openai?.api_key ?? null;
}

/**
 * Resolve the Gemini API key: keychain > config.yaml > env var.
 */
function getGeminiApiKey(config: JarvisConfig): string | null {
  return getSecret(KEY_GEMINI) ?? config.llm.gemini?.api_key ?? null;
}

/**
 * Resolve the OpenRouter API key: keychain > config.yaml > env var.
 */
function getOpenRouterApiKey(config: JarvisConfig): string | null {
  return getSecret(KEY_OPENROUTER) ?? config.llm.openrouter?.api_key ?? null;
}

/**
 * Merge DB/keychain LLM settings into config at startup.
 * Env vars (already applied by loadConfig) take priority over DB values.
 */
export function mergeLLMSettingsIntoConfig(config: JarvisConfig): void {
  // Only override from DB if env vars are NOT set
  const dbPrimary = getSetting(SETTING_PRIMARY);
  if (dbPrimary) config.llm.primary = dbPrimary;

  const dbFallback = getSetting(SETTING_FALLBACK);
  if (dbFallback) config.llm.fallback = JSON.parse(dbFallback);

  // Anthropic
  const dbAnthropicModel = getSetting(SETTING_ANTHROPIC_MODEL);
  const keychainAnthropicKey = getSecret(KEY_ANTHROPIC);
  if (dbAnthropicModel || keychainAnthropicKey) {
    config.llm.anthropic = {
      ...config.llm.anthropic,
      api_key: (!process.env.JARVIS_API_KEY && keychainAnthropicKey)
        ? keychainAnthropicKey
        : (config.llm.anthropic?.api_key ?? ''),
      model: dbAnthropicModel ?? config.llm.anthropic?.model,
    };
  }

  // OpenAI
  const dbOpenaiModel = getSetting(SETTING_OPENAI_MODEL);
  const keychainOpenaiKey = getSecret(KEY_OPENAI);
  if (dbOpenaiModel || keychainOpenaiKey) {
    config.llm.openai = {
      ...config.llm.openai,
      api_key: (!process.env.JARVIS_OPENAI_KEY && keychainOpenaiKey)
        ? keychainOpenaiKey
        : (config.llm.openai?.api_key ?? ''),
      model: dbOpenaiModel ?? config.llm.openai?.model,
    };
  }

  // Gemini
  const dbGeminiModel = getSetting(SETTING_GEMINI_MODEL);
  const keychainGeminiKey = getSecret(KEY_GEMINI);
  if (dbGeminiModel || keychainGeminiKey) {
    config.llm.gemini = {
      ...config.llm.gemini,
      api_key: (!process.env.JARVIS_GEMINI_KEY && keychainGeminiKey)
        ? keychainGeminiKey
        : (config.llm.gemini?.api_key ?? ''),
      model: dbGeminiModel ?? config.llm.gemini?.model,
    };
  }

  // Ollama
  const dbOllamaModel = getSetting(SETTING_OLLAMA_MODEL);
  const dbOllamaUrl = getSetting(SETTING_OLLAMA_BASE_URL);
  if (dbOllamaModel || dbOllamaUrl) {
    config.llm.ollama = {
      ...config.llm.ollama,
      model: dbOllamaModel ?? config.llm.ollama?.model,
      base_url: (!process.env.JARVIS_OLLAMA_URL && dbOllamaUrl)
        ? dbOllamaUrl
        : (config.llm.ollama?.base_url ?? 'http://localhost:11434'),
    };
  }

  // OpenRouter
  const dbOpenrouterModel = getSetting(SETTING_OPENROUTER_MODEL);
  const keychainOpenrouterKey = getSecret(KEY_OPENROUTER);
  if (dbOpenrouterModel || keychainOpenrouterKey) {
    config.llm.openrouter = {
      ...config.llm.openrouter,
      api_key: (!process.env.JARVIS_OPENROUTER_KEY && keychainOpenrouterKey)
        ? keychainOpenrouterKey
        : (config.llm.openrouter?.api_key ?? ''),
      model: dbOpenrouterModel ?? config.llm.openrouter?.model,
    };
  }
}

/**
 * Build fresh LLM provider instances from the current config and hot-reload them
 * into the shared LLMManager (atomic swap, safe for in-flight requests).
 */
export function hotReloadLLMProviders(config: JarvisConfig, llmManager: LLMManager): void {
  const { llm } = config;
  const providers: LLMProvider[] = [];

  if (llm.anthropic?.api_key) {
    providers.push(new AnthropicProvider(llm.anthropic.api_key, llm.anthropic.model));
    console.log('[LLM] Hot-reloaded Anthropic provider');
  }
  if (llm.openai?.api_key) {
    providers.push(new OpenAIProvider(llm.openai.api_key, llm.openai.model));
    console.log('[LLM] Hot-reloaded OpenAI provider');
  }
  if (llm.gemini?.api_key) {
    providers.push(new GeminiProvider(llm.gemini.api_key, llm.gemini.model));
    console.log('[LLM] Hot-reloaded Gemini provider');
  }
  if (llm.openrouter?.api_key) {
    providers.push(new OpenRouterProvider(llm.openrouter.api_key, llm.openrouter.model));
    console.log('[LLM] Hot-reloaded OpenRouter provider');
  }
  if (llm.ollama) {
    providers.push(new OllamaProvider(llm.ollama.base_url, llm.ollama.model));
    console.log('[LLM] Hot-reloaded Ollama provider');
  }

  const fallback = llm.fallback.filter(n => providers.some(p => p.name === n));
  llmManager.replaceProviders(providers, llm.primary, fallback);
  console.log(`[LLM] Providers active: ${providers.map(p => p.name).join(', ') || 'none'} (primary: ${llm.primary})`);
}

/**
 * Test an LLM provider connection. Uses provided credentials if given,
 * otherwise falls back to stored keys (keychain > config).
 */
export async function testLLMProvider(
  opts: {
    provider: string;
    api_key?: string;
    model?: string;
    base_url?: string;
  },
  config: JarvisConfig,
): Promise<{ ok: boolean; model?: string; error?: string }> {
  try {
    let instance: LLMProvider;

    if (opts.provider === 'anthropic') {
      const key = opts.api_key || getSecret(KEY_ANTHROPIC) || config.llm.anthropic?.api_key;
      if (!key) return { ok: false, error: 'API key required' };
      instance = new AnthropicProvider(key, opts.model ?? config.llm.anthropic?.model);
    } else if (opts.provider === 'openai') {
      const key = opts.api_key || getSecret(KEY_OPENAI) || config.llm.openai?.api_key;
      if (!key) return { ok: false, error: 'API key required' };
      instance = new OpenAIProvider(key, opts.model ?? config.llm.openai?.model);
    } else if (opts.provider === 'gemini') {
      const key = opts.api_key || config.llm.gemini?.api_key;
      if (!key) return { ok: false, error: 'API key required' };
      instance = new GeminiProvider(key, opts.model ?? config.llm.gemini?.model);
    } else if (opts.provider === 'openrouter') {
      const key = opts.api_key || getSecret(KEY_OPENROUTER) || config.llm.openrouter?.api_key;
      if (!key) return { ok: false, error: 'API key required' };
      instance = new OpenRouterProvider(key, opts.model ?? config.llm.openrouter?.model);
    } else if (opts.provider === 'ollama') {
      instance = new OllamaProvider(
        opts.base_url ?? config.llm.ollama?.base_url,
        opts.model ?? config.llm.ollama?.model,
      );
    } else {
      return { ok: false, error: `Unknown provider: ${opts.provider}` };
    }

    const resp = await instance.chat(
      [{ role: 'user', content: 'Say OK' }],
      { max_tokens: 5 },
    );
    return { ok: true, model: resp.model };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
