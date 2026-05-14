/**
 * LLM Settings — Bridge between DB settings, encrypted keychain, and in-memory config.
 *
 * Non-secret settings (provider, model, fallback) are stored in the SQLite `settings` table.
 * API keys are stored in the encrypted secrets file via the keychain module.
 */

import { getSetting, setSetting, deleteSetting, getSettingsByPrefix } from '../vault/settings.ts';
import { getSecret, setSecret, deleteSecret, hasSecret } from '../vault/keychain.ts';
import type { JarvisConfig } from '../config/types.ts';
import { AnthropicProvider } from '../llm/anthropic.ts';
import { OpenAIProvider } from '../llm/openai.ts';
import { GroqProvider } from '../llm/groq.ts';
import { GeminiProvider } from '../llm/gemini.ts';
import { OllamaProvider } from '../llm/ollama.ts';
import { OpenRouterProvider } from '../llm/openrouter.ts';
import { NVIDIAProvider } from '../llm/nvidia.ts';
import { OpenAICompatibleProvider } from '../llm/openai-compatible.ts';
import type { LLMProvider } from '../llm/provider.ts';
import type { LLMManager } from '../llm/manager.ts';

// Keychain key names
const KEY_ANTHROPIC = 'llm.anthropic.api_key';
const KEY_OPENAI = 'llm.openai.api_key';
const KEY_GROQ = 'llm.groq.api_key';
const KEY_GEMINI = 'llm.gemini.api_key';
const KEY_OPENROUTER = 'llm.openrouter.api_key';
const KEY_NVIDIA = 'llm.nvidia.api_key';
const KEY_OPENAI_COMPAT = 'llm.openai_compatible.api_key';

// DB setting keys
const SETTING_PRIMARY = 'llm.primary';
const SETTING_FALLBACK = 'llm.fallback';
const SETTING_ANTHROPIC_MODEL = 'llm.anthropic.model';
const SETTING_OPENAI_MODEL = 'llm.openai.model';
const SETTING_GROQ_MODEL = 'llm.groq.model';
const SETTING_GEMINI_MODEL = 'llm.gemini.model';
const SETTING_OLLAMA_MODEL = 'llm.ollama.model';
const SETTING_OLLAMA_BASE_URL = 'llm.ollama.base_url';
const SETTING_OPENROUTER_MODEL = 'llm.openrouter.model';
const SETTING_NVIDIA_MODEL = 'llm.nvidia.model';
const SETTING_OPENAI_COMPAT_MODEL = 'llm.openai_compatible.model';
const SETTING_OPENAI_COMPAT_BASE_URL = 'llm.openai_compatible.base_url';

export type LLMSettingsResponse = {
  primary: string;
  fallback: string[];
  anthropic: { model: string; has_api_key: boolean } | null;
  openai: { model: string; has_api_key: boolean } | null;
  groq: { model: string; has_api_key: boolean } | null;
  gemini: { model: string; has_api_key: boolean } | null;
  ollama: { base_url: string; model: string } | null;
  openrouter: { model: string; has_api_key: boolean } | null;
  nvidia: { model: string; has_api_key: boolean } | null;
  openai_compatible: { base_url: string; model: string; has_api_key: boolean } | null;
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
  const groqModel = getSetting(SETTING_GROQ_MODEL) ?? config.llm.groq?.model ?? 'llama-3.3-70b-versatile';
  const geminiModel = getSetting(SETTING_GEMINI_MODEL) ?? config.llm.gemini?.model ?? 'gemini-3-flash-preview';
  const openrouterModel = getSetting(SETTING_OPENROUTER_MODEL) ?? config.llm.openrouter?.model ?? 'anthropic/claude-sonnet-4';
  const nvidiaModel = getSetting(SETTING_NVIDIA_MODEL) ?? config.llm.nvidia?.model ?? 'meta/llama-3.3-70b-instruct';

  const hasAnthropicKey = hasSecret(KEY_ANTHROPIC) || !!config.llm.anthropic?.api_key;
  const hasOpenaiKey = hasSecret(KEY_OPENAI) || !!config.llm.openai?.api_key;
  const hasGroqKey = hasSecret(KEY_GROQ) || !!config.llm.groq?.api_key;
  const hasGeminiKey = hasSecret(KEY_GEMINI) || !!config.llm.gemini?.api_key;
  const hasOpenrouterKey = hasSecret(KEY_OPENROUTER) || !!config.llm.openrouter?.api_key;
  const hasNvidiaKey = hasSecret(KEY_NVIDIA) || !!config.llm.nvidia?.api_key;

  // Ollama is "configured" only when the user has explicitly set a base_url
  // (DB or env/yaml). Defaults alone shouldn't make it appear active in the UI.
  const dbOllamaUrl = getSetting(SETTING_OLLAMA_BASE_URL);
  const dbOllamaModel = getSetting(SETTING_OLLAMA_MODEL);
  const ollamaConfigured = !!(dbOllamaUrl || config.llm.ollama?.base_url);
  const ollama = ollamaConfigured
    ? {
        base_url: dbOllamaUrl ?? config.llm.ollama?.base_url ?? '',
        model: dbOllamaModel ?? config.llm.ollama?.model ?? 'llama3',
      }
    : null;

  // OpenAI-compatible: same rule as Ollama. Requires an explicit base_url
  // since there's no sensible default — it could be llama.cpp, vLLM,
  // LM Studio, or a hosted compatible endpoint. The API key is optional.
  const dbCompatUrl = getSetting(SETTING_OPENAI_COMPAT_BASE_URL);
  const dbCompatModel = getSetting(SETTING_OPENAI_COMPAT_MODEL);
  const compatConfigured = !!(dbCompatUrl || config.llm.openai_compatible?.base_url);
  const hasCompatKey = hasSecret(KEY_OPENAI_COMPAT) || !!config.llm.openai_compatible?.api_key;
  const openai_compatible = compatConfigured
    ? {
        base_url: dbCompatUrl ?? config.llm.openai_compatible?.base_url ?? '',
        model: dbCompatModel ?? config.llm.openai_compatible?.model ?? '',
        has_api_key: hasCompatKey,
      }
    : null;

  return {
    primary,
    fallback,
    anthropic: { model: anthropicModel, has_api_key: hasAnthropicKey },
    openai: { model: openaiModel, has_api_key: hasOpenaiKey },
    groq: { model: groqModel, has_api_key: hasGroqKey },
    gemini: { model: geminiModel, has_api_key: hasGeminiKey },
    ollama,
    openrouter: { model: openrouterModel, has_api_key: hasOpenrouterKey },
    nvidia: { model: nvidiaModel, has_api_key: hasNvidiaKey },
    openai_compatible,
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
    groq?: { api_key?: string; model?: string };
    gemini?: { api_key?: string; model?: string };
    ollama?: { base_url?: string; model?: string };
    openrouter?: { api_key?: string; model?: string };
    nvidia?: { api_key?: string; model?: string };
    openai_compatible?: { base_url?: string; api_key?: string; model?: string };
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

  // Groq
  if (body.groq) {
    if (body.groq.model) {
      setSetting(SETTING_GROQ_MODEL, body.groq.model);
    }
    if (body.groq.api_key) {
      setSecret(KEY_GROQ, body.groq.api_key);
    }
    config.llm.groq = {
      ...config.llm.groq,
      model: body.groq.model ?? config.llm.groq?.model,
      api_key: body.groq.api_key ?? getGroqApiKey(config) ?? '',
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

  // Ollama. Two independent fields (base_url, model) saved by two
  // independent UI buttons -- handle them independently so a "Save model"
  // POST that doesn't include base_url still persists the new model.
  //
  // An explicit empty base_url is a "disable / clear" signal: wipe the
  // stored URL/model so the provider stops appearing as configured in
  // the UI. A `model` without `base_url` updates only the model and keeps
  // the existing URL (the common case from the UI's "Save model" button).
  if (body.ollama) {
    const trimmedUrl = body.ollama.base_url?.trim();
    const clearingUrl = body.ollama.base_url !== undefined && !trimmedUrl;
    if (clearingUrl) {
      // Explicit clear: wipe everything.
      deleteSetting(SETTING_OLLAMA_BASE_URL);
      deleteSetting(SETTING_OLLAMA_MODEL);
      config.llm.ollama = undefined;
    } else {
      if (trimmedUrl) {
        setSetting(SETTING_OLLAMA_BASE_URL, trimmedUrl);
      }
      if (body.ollama.model) {
        setSetting(SETTING_OLLAMA_MODEL, body.ollama.model);
      }
      // Update in-memory config only if there's something useful to keep.
      // Skip when neither field is present (defensive: shouldn't happen
      // because we wouldn't be in this branch, but be safe).
      const nextUrl = trimmedUrl ?? config.llm.ollama?.base_url;
      const nextModel = body.ollama.model ?? config.llm.ollama?.model;
      if (nextUrl || nextModel) {
        config.llm.ollama = {
          ...config.llm.ollama,
          ...(nextModel ? { model: nextModel } : {}),
          ...(nextUrl ? { base_url: nextUrl } : {}),
        };
      }
    }
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

  // NVIDIA
  if (body.nvidia) {
    if (body.nvidia.model) {
      setSetting(SETTING_NVIDIA_MODEL, body.nvidia.model);
    }
    if (body.nvidia.api_key) {
      setSecret(KEY_NVIDIA, body.nvidia.api_key);
    }
    config.llm.nvidia = {
      ...config.llm.nvidia,
      model: body.nvidia.model ?? config.llm.nvidia?.model,
      api_key: body.nvidia.api_key ?? getNvidiaApiKey(config) ?? '',
    };
  }

  // OpenAI-compatible. Same independent-field model as Ollama: a `base_url`,
  // `model`, and `api_key` can each be saved independently. An explicit
  // empty `base_url` clears the provider entirely.
  if (body.openai_compatible) {
    const trimmedUrl = body.openai_compatible.base_url?.trim();
    const clearingUrl = body.openai_compatible.base_url !== undefined && !trimmedUrl;
    if (clearingUrl) {
      deleteSetting(SETTING_OPENAI_COMPAT_BASE_URL);
      deleteSetting(SETTING_OPENAI_COMPAT_MODEL);
      deleteSecret(KEY_OPENAI_COMPAT);
      config.llm.openai_compatible = undefined;
    } else {
      if (trimmedUrl) {
        setSetting(SETTING_OPENAI_COMPAT_BASE_URL, trimmedUrl);
      }
      if (body.openai_compatible.model) {
        setSetting(SETTING_OPENAI_COMPAT_MODEL, body.openai_compatible.model);
      }
      if (body.openai_compatible.api_key) {
        setSecret(KEY_OPENAI_COMPAT, body.openai_compatible.api_key);
      }
      const nextUrl = trimmedUrl ?? config.llm.openai_compatible?.base_url;
      const nextModel = body.openai_compatible.model ?? config.llm.openai_compatible?.model;
      const nextKey = body.openai_compatible.api_key ?? getOpenAICompatibleApiKey(config) ?? '';
      if (nextUrl || nextModel || nextKey) {
        config.llm.openai_compatible = {
          ...config.llm.openai_compatible,
          ...(nextModel ? { model: nextModel } : {}),
          ...(nextUrl ? { base_url: nextUrl } : {}),
          ...(nextKey ? { api_key: nextKey } : {}),
        };
      }
    }
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
 * Resolve the Groq API key: keychain > config.yaml > env var.
 */
function getGroqApiKey(config: JarvisConfig): string | null {
  return getSecret(KEY_GROQ) ?? config.llm.groq?.api_key ?? null;
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
 * Resolve the NVIDIA API key: keychain > config.yaml > env var.
 */
function getNvidiaApiKey(config: JarvisConfig): string | null {
  return getSecret(KEY_NVIDIA) ?? config.llm.nvidia?.api_key ?? null;
}

/**
 * Resolve the OpenAI-compatible API key: keychain > config.yaml.
 * Optional — many local servers (llama.cpp, LM Studio) don't require auth.
 */
function getOpenAICompatibleApiKey(config: JarvisConfig): string | null {
  return getSecret(KEY_OPENAI_COMPAT) ?? config.llm.openai_compatible?.api_key ?? null;
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

  // Groq
  const dbGroqModel = getSetting(SETTING_GROQ_MODEL);
  const keychainGroqKey = getSecret(KEY_GROQ);
  if (dbGroqModel || keychainGroqKey) {
    config.llm.groq = {
      ...config.llm.groq,
      api_key: (!process.env.JARVIS_GROQ_KEY && keychainGroqKey)
        ? keychainGroqKey
        : (config.llm.groq?.api_key ?? ''),
      model: dbGroqModel ?? config.llm.groq?.model,
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

  // NVIDIA
  const dbNvidiaModel = getSetting(SETTING_NVIDIA_MODEL);
  const keychainNvidiaKey = getSecret(KEY_NVIDIA);
  if (dbNvidiaModel || keychainNvidiaKey) {
    config.llm.nvidia = {
      ...config.llm.nvidia,
      api_key: (!process.env.NVIDIA_API_KEY && keychainNvidiaKey)
        ? keychainNvidiaKey
        : (config.llm.nvidia?.api_key ?? ''),
      model: dbNvidiaModel ?? config.llm.nvidia?.model,
    };
  }

  // OpenAI-compatible
  const dbCompatModel = getSetting(SETTING_OPENAI_COMPAT_MODEL);
  const dbCompatUrl = getSetting(SETTING_OPENAI_COMPAT_BASE_URL);
  const keychainCompatKey = getSecret(KEY_OPENAI_COMPAT);
  if (dbCompatModel || dbCompatUrl || keychainCompatKey) {
    config.llm.openai_compatible = {
      ...config.llm.openai_compatible,
      base_url: dbCompatUrl ?? config.llm.openai_compatible?.base_url,
      model: dbCompatModel ?? config.llm.openai_compatible?.model,
      api_key: keychainCompatKey ?? config.llm.openai_compatible?.api_key ?? '',
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
  if (llm.groq?.api_key) {
    providers.push(new GroqProvider(llm.groq.api_key, llm.groq.model));
    console.log('[LLM] Hot-reloaded Groq provider');
  }
  if (llm.gemini?.api_key) {
    providers.push(new GeminiProvider(llm.gemini.api_key, llm.gemini.model));
    console.log('[LLM] Hot-reloaded Gemini provider');
  }
  if (llm.openrouter?.api_key) {
    providers.push(new OpenRouterProvider(llm.openrouter.api_key, llm.openrouter.model));
    console.log('[LLM] Hot-reloaded OpenRouter provider');
  }
  if (llm.nvidia?.api_key) {
    providers.push(new NVIDIAProvider(llm.nvidia.api_key, llm.nvidia.model));
    console.log('[LLM] Hot-reloaded NVIDIA provider');
  }
  if (llm.ollama?.base_url) {
    providers.push(new OllamaProvider(llm.ollama.base_url, llm.ollama.model));
    console.log('[LLM] Hot-reloaded Ollama provider');
  }
  if (llm.openai_compatible?.base_url) {
    providers.push(new OpenAICompatibleProvider(
      llm.openai_compatible.base_url,
      llm.openai_compatible.model,
      llm.openai_compatible.api_key,
    ));
    console.log('[LLM] Hot-reloaded OpenAI-compatible provider');
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
    } else if (opts.provider === 'groq') {
      const key = opts.api_key || getSecret(KEY_GROQ) || config.llm.groq?.api_key;
      if (!key) return { ok: false, error: 'API key required' };
      instance = new GroqProvider(key, opts.model ?? config.llm.groq?.model);
    } else if (opts.provider === 'gemini') {
      const key = opts.api_key || config.llm.gemini?.api_key;
      if (!key) return { ok: false, error: 'API key required' };
      instance = new GeminiProvider(key, opts.model ?? config.llm.gemini?.model);
    } else if (opts.provider === 'openrouter') {
      const key = opts.api_key || getSecret(KEY_OPENROUTER) || config.llm.openrouter?.api_key;
      if (!key) return { ok: false, error: 'API key required' };
      instance = new OpenRouterProvider(key, opts.model ?? config.llm.openrouter?.model);
    } else if (opts.provider === 'nvidia') {
      const key = opts.api_key || getSecret(KEY_NVIDIA) || config.llm.nvidia?.api_key;
      if (!key) return { ok: false, error: 'API key required' };
      instance = new NVIDIAProvider(key, opts.model ?? config.llm.nvidia?.model);
    } else if (opts.provider === 'ollama') {
      instance = new OllamaProvider(
        opts.base_url ?? config.llm.ollama?.base_url,
        opts.model ?? config.llm.ollama?.model,
      );
    } else if (opts.provider === 'openai_compatible') {
      const baseUrl = opts.base_url ?? config.llm.openai_compatible?.base_url;
      if (!baseUrl) return { ok: false, error: 'Base URL required' };
      const model = opts.model ?? config.llm.openai_compatible?.model;
      const key = opts.api_key ?? getOpenAICompatibleApiKey(config) ?? '';
      instance = new OpenAICompatibleProvider(baseUrl, model, key);
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
