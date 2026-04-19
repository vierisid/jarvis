import type { LLMManager } from './manager.ts';
import type { JarvisConfig } from '../config/types.ts';

export type IntentTier = 'PREMIUM' | 'FREE_FAST' | 'ECO';
export type IntentType = 'SIMPLE' | 'COMPLEX';

export interface ProviderTierMap {
  [key: string]: IntentTier;
}

const DEFAULT_TIERS: ProviderTierMap = {
  'anthropic': 'PREMIUM',
  'openai': 'PREMIUM',
  'groq': 'FREE_FAST',
  'nvidia': 'FREE_FAST', // Default NVIDIA (usdcode etc)
  'gemini': 'ECO',       // Gemini Flash is often free-tier or very cheap
  'ollama': 'ECO',
};

// Specialized model-level tiers (if model is specified)
const MODEL_TIERS: Record<string, IntentTier> = {
  'mistral-nemo-minitron-8b-base': 'ECO',
  'gemini-1.5-flash': 'ECO',
  'usdcode': 'FREE_FAST',
};

export class LLMRouter {
  private manager: LLMManager;
  private config: JarvisConfig;
  private availableProviders: Set<string> = new Set();

  constructor(manager: LLMManager, config: JarvisConfig) {
    this.manager = manager;
    this.config = config;
    this.refreshAvailability();
  }

  refreshAvailability(): void {
    this.availableProviders.clear();
    const registered = this.manager.getProviderNames();
    for (const name of registered) {
      if (this.isActuallyAvailable(name)) {
        this.availableProviders.add(name);
      }
    }
  }

  private isActuallyAvailable(name: string): boolean {
    const { llm } = this.config;
    const env = process.env;

    switch (name) {
      case 'anthropic':
        return !!(llm.anthropic?.api_key || env.JARVIS_ANTHROPIC_KEY);
      case 'openai':
        return !!(llm.openai?.api_key || env.JARVIS_OPENAI_KEY);
      case 'groq':
        return !!(llm.groq?.api_key || env.JARVIS_GROQ_KEY);
      case 'gemini':
        return !!(llm.gemini?.api_key || env.JARVIS_GEMINI_KEY);
      case 'nvidia':
        return !!(llm.nvidia?.api_key || env.NVIDIA_API_KEY);
      case 'openrouter':
        return !!(llm.openrouter?.api_key || env.JARVIS_OPENROUTER_KEY);
      case 'ollama':
        return true; // Usually local, no key needed
      default:
        return false;
    }
  }

  getBestProvider(intent: IntentType): string {
    const tiers = this.getTierSequence(intent);
    
    for (const tier of tiers) {
      const provider = this.findAvailableProviderInTier(tier);
      if (provider) return provider;
    }

    // Fallback to primary if everything else fails
    return this.manager.getPrimary();
  }

  getCheapestAvailable(): string {
    return this.getBestProvider('SIMPLE');
  }

  private getTierSequence(intent: IntentType): IntentTier[] {
    if (intent === 'COMPLEX') {
      return ['PREMIUM', 'FREE_FAST', 'ECO'];
    }
    return ['ECO', 'FREE_FAST', 'PREMIUM'];
  }

  private findAvailableProviderInTier(tier: IntentTier): string | null {
    const providers = Array.from(this.availableProviders);
    
    // Sort to prioritize specific models if config allows
    for (const name of providers) {
      const providerTier = this.getProviderTier(name);
      if (providerTier === tier) return name;
    }

    return null;
  }

  private getProviderTier(name: string): IntentTier {
    const { llm } = this.config;
    const model = (llm as any)[name]?.model;
    
    if (model && MODEL_TIERS[model]) {
      return MODEL_TIERS[model]!;
    }

    return DEFAULT_TIERS[name] || 'ECO';
  }

  getAvailableNames(): string[] {
    return Array.from(this.availableProviders);
  }
}
