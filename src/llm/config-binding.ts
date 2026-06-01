/**
 * Bridge between the canonical config schema (llm.providers + llm.default /
 * llm.tiers, model refs as "name:model" strings) and the LLMManager runtime
 * (provider instances + structured TierMap).
 *
 * Two responsibilities:
 *  1. Instantiate provider classes from a `LLMProviderEntry` map and register
 *     them with the manager.
 *  2. Resolve `llm.default` + `llm.tiers` model-ref strings into a TierMap
 *     and apply it to the manager.
 *
 * Used by both the cold-start path (AgentService.start) and the hot-reload
 * path (llm-settings.hotReloadLLMProviders) so they stay in sync.
 */

import type { LLMConfig, LLMProviderEntry, LLMProviderKind } from '../config/types.ts';
import type { LLMManager } from './manager.ts';
import type { LLMProvider } from './provider.ts';
import { type Tier, type TierMap, parseModelRef } from './tiers.ts';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAIProvider } from './openai.ts';
import { GroqProvider } from './groq.ts';
import { GeminiProvider } from './gemini.ts';
import { OllamaProvider } from './ollama.ts';
import { OpenRouterProvider } from './openrouter.ts';
import { NVIDIAProvider } from './nvidia.ts';
import { OpenAICompatibleProvider } from './openai-compatible.ts';
import { LiteLLMProvider } from './litellm.ts';

/**
 * Instantiate a provider class from a single entry. Returns null when the
 * entry is missing the credentials/endpoint that class needs (so callers can
 * skip unconfigured slots without errors).
 *
 * The provider's `.name` is set to the configured name (the map key) - not
 * the `kind`. This lets multiple instances of the same kind coexist (e.g.
 * "ollama-local" + "ollama-remote") and model refs unambiguously route to
 * one specific instance.
 */
export function instantiateProvider(name: string, entry: LLMProviderEntry): LLMProvider | null {
  const kind: LLMProviderKind = (entry.kind ?? name) as LLMProviderKind;
  let provider: LLMProvider | null = null;
  switch (kind) {
    case 'anthropic':
      if (!entry.api_key) return null;
      provider = new AnthropicProvider(entry.api_key);
      break;
    case 'openai':
      if (!entry.api_key) return null;
      provider = new OpenAIProvider(entry.api_key);
      break;
    case 'groq':
      if (!entry.api_key) return null;
      provider = new GroqProvider(entry.api_key);
      break;
    case 'gemini':
      if (!entry.api_key) return null;
      provider = new GeminiProvider(entry.api_key);
      break;
    case 'openrouter':
      if (!entry.api_key) return null;
      provider = new OpenRouterProvider(entry.api_key);
      break;
    case 'nvidia':
      if (!entry.api_key) return null;
      provider = new NVIDIAProvider(entry.api_key);
      break;
    case 'ollama':
      if (!entry.base_url) return null;
      provider = new OllamaProvider(entry.base_url);
      break;
    case 'openai_compatible':
      if (!entry.base_url) return null;
      provider = new OpenAICompatibleProvider(entry.base_url, undefined, entry.api_key);
      break;
    case 'litellm':
      if (!entry.base_url) return null;
      provider = new LiteLLMProvider(entry.base_url, undefined, entry.api_key);
      break;
    default:
      console.warn(`[LLM] Unknown provider kind '${kind}' for '${name}' - skipping.`);
      return null;
  }
  if (provider) {
    // Override the provider's name to match the user-chosen key. This is
    // what model refs use ("name:model"), regardless of the underlying kind.
    (provider as { name: string }).name = name;
  }
  return provider;
}

/**
 * Build provider instances from a config map without touching the manager.
 * Caller decides how to apply them (registerLLMProviders for first-boot,
 * atomicReloadProviders for hot-reload).
 */
export function buildProviders(
  providers: Record<string, LLMProviderEntry>,
): LLMProvider[] {
  const out: LLMProvider[] = [];
  for (const [name, entry] of Object.entries(providers)) {
    if (!entry) continue;
    const provider = instantiateProvider(name, entry);
    if (!provider) continue;
    out.push(provider);
    console.log(`[LLM] Built provider '${name}' (kind=${entry.kind ?? name})`);
  }
  return out;
}

/**
 * First-boot path: incrementally register providers with the manager (which
 * is initially empty so atomicity doesn't matter). Returns true when at
 * least one provider was registered.
 */
export function registerLLMProviders(
  manager: LLMManager,
  providers: Record<string, LLMProviderEntry>,
): boolean {
  const built = buildProviders(providers);
  for (const p of built) manager.registerProvider(p);
  return built.length > 0;
}

/**
 * Hot-reload path: build the new provider list THEN atomic-swap into the
 * manager. Avoids the empty-providers window that an incremental
 * clear-then-add would create for in-flight requests.
 */
export function atomicReloadProviders(
  manager: LLMManager,
  providers: Record<string, LLMProviderEntry>,
): LLMProvider[] {
  const built = buildProviders(providers);
  manager.replaceProviders(built, '', []);
  return built;
}

/**
 * Build a TierMap from llm.default + llm.tiers and apply it to the manager.
 *
 * Semantics:
 *   - `llm.default` (single-LLM mode) populates low/medium/high to the same
 *     model. The conversation tier is left unset (router-first stays off).
 *   - `llm.tiers` overrides individual slots. When `tiers.conversation` is
 *     set, the router-first mode activates.
 *   - When both are set, tier values win over the default for that tier.
 *
 * Tier entries pointing at unregistered providers are dropped with a warning
 * so a partial config still boots.
 */
export function configureLLMTiers(manager: LLMManager, llm: LLMConfig): void {
  const tierMap: TierMap = {};

  // 1. Single-LLM mode populates task tiers from `default`.
  if (llm.default) {
    const ref = parseModelRef(llm.default);
    if (ref && manager.getProvider(ref.provider)) {
      tierMap.low = ref;
      tierMap.medium = ref;
      tierMap.high = ref;
    } else if (ref) {
      console.warn(
        `[LLM] llm.default ('${llm.default}') references unregistered provider '${ref.provider}' - skipping.`,
      );
    }
  }

  // 2. Per-tier overrides win.
  if (llm.tiers) {
    for (const tier of ['conversation', 'high', 'medium', 'low'] as Tier[]) {
      const ref = parseModelRef(llm.tiers[tier]);
      if (!ref) continue;
      if (!manager.getProvider(ref.provider)) {
        console.warn(
          `[LLM] Tier '${tier}' references unregistered provider '${ref.provider}' - skipping.`,
        );
        continue;
      }
      tierMap[tier] = ref;
    }
  }

  manager.setTierMap(tierMap);
}
