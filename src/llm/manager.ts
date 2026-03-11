import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse,
  LLMStreamEvent,
} from './provider.ts';

export class LLMManager {
  private providers: Map<string, LLMProvider> = new Map();
  private primaryProvider = '';
  private fallbackChain: string[] = [];

  constructor() {}

  registerProvider(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);

    // Set as primary if it's the first provider
    if (!this.primaryProvider) {
      this.primaryProvider = provider.name;
    }
  }

  setPrimary(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider '${name}' not registered`);
    }
    this.primaryProvider = name;
  }

  setFallbackChain(names: string[]): void {
    for (const name of names) {
      if (!this.providers.has(name)) {
        throw new Error(`Provider '${name}' not registered`);
      }
    }
    this.fallbackChain = names;
  }

  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  getPrimary(): string {
    return this.primaryProvider;
  }

  getFallbackChain(): string[] {
    return [...this.fallbackChain];
  }

  getProviderNames(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Atomically replace all providers. Safe for in-flight requests because
   * JS is single-threaded and the map assignment is atomic.
   */
  replaceProviders(providers: LLMProvider[], primary: string, fallback: string[]): void {
    const newMap = new Map<string, LLMProvider>();
    for (const p of providers) {
      newMap.set(p.name, p);
    }
    this.providers = newMap;
    this.primaryProvider = newMap.has(primary) ? primary : (providers[0]?.name ?? '');
    this.fallbackChain = fallback.filter(n => newMap.has(n));
  }

  async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const providerNames = [this.primaryProvider, ...this.fallbackChain];
    const errors: Array<{ provider: string; error: string }> = [];

    for (const providerName of providerNames) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      try {
        return await provider.chat(messages, options);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push({ provider: providerName, error: errorMsg });
        console.error(`Provider ${providerName} failed:`, errorMsg);
      }
    }

    throw new Error(
      `All providers failed:\n${errors.map(e => `  ${e.provider}: ${e.error}`).join('\n')}`
    );
  }

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<LLMStreamEvent> {
    const providerNames = [this.primaryProvider, ...this.fallbackChain];
    const errors: Array<{ provider: string; error: string }> = [];

    for (const providerName of providerNames) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      try {
        let hasError = false;
        for await (const event of provider.stream(messages, options)) {
          if (event.type === 'error') {
            hasError = true;
            errors.push({ provider: providerName, error: event.error });
            console.error(`Provider ${providerName} stream error:`, event.error);
            break;
          }
          yield event;
        }

        if (!hasError) {
          return; // Successful stream completion
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push({ provider: providerName, error: errorMsg });
        console.error(`Provider ${providerName} stream failed:`, errorMsg);
      }
    }

    yield {
      type: 'error',
      error: `All providers failed:\n${errors.map(e => `  ${e.provider}: ${e.error}`).join('\n')}`,
    };
  }
}
