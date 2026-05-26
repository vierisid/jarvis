import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMErrorCode,
} from './provider.ts';
import { classifyErrorString } from './provider.ts';
import {
  type Tier,
  type TierAssignment,
  type TierMap,
  type TierResolution,
  TIERS,
  resolveTier,
} from './tiers.ts';
import { recordUsage } from './usage.ts';

export class LLMManager {
  private providers: Map<string, LLMProvider> = new Map();
  private primaryProvider = '';
  private fallbackChain: string[] = [];
  private tierMap: TierMap = {};
  private static readonly MAX_RETRIES_PER_PROVIDER = 3;
  private static readonly REQUEST_TIMEOUT_MS = 90000; // 90 second timeout for LLM calls
  private static readonly isDebugging = process.env.JARVIS_LOG_LEVEL === 'debug' || process.env.DEBUG_LLM === 'true';

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

  /**
   * Assign a tier to a provider (with optional model override). Pass null/undefined
   * provider to clear the assignment. Provider must already be registered.
   */
  setTierAssignment(tier: Tier, assignment: TierAssignment | null): void {
    if (!assignment) {
      delete this.tierMap[tier];
      return;
    }
    if (!this.providers.has(assignment.provider)) {
      throw new Error(`Provider '${assignment.provider}' not registered (tier '${tier}')`);
    }
    this.tierMap[tier] = { provider: assignment.provider, model: assignment.model };
  }

  /**
   * Bulk-replace the tier map. Validates that each referenced provider is
   * registered AND that the tier name is one of the canonical four. Invalid
   * tier names (typos in config) are dropped with a warning rather than
   * throwing - a partial config should still boot.
   */
  setTierMap(tiers: TierMap): void {
    const next: TierMap = {};
    const validTiers = new Set<string>(TIERS);
    for (const [tier, a] of Object.entries(tiers)) {
      if (!a) continue;
      if (!validTiers.has(tier)) {
        console.warn(`[LLM] Unknown tier '${tier}' in config - ignoring.`);
        continue;
      }
      if (!this.providers.has(a.provider)) {
        throw new Error(`Provider '${a.provider}' not registered (tier '${tier}')`);
      }
      next[tier as Tier] = { provider: a.provider, model: a.model };
    }
    this.tierMap = next;
  }

  getTierMap(): TierMap {
    return { ...this.tierMap };
  }

  /**
   * Whether the conversation tier is configured. When false, the system runs
   * in classic single-orchestrator mode (no router-first split).
   */
  hasConversationTier(): boolean {
    return Boolean(this.tierMap.conversation);
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

  private getProviderSequence(primaryOverride?: string | null): string[] {
    const primary = primaryOverride && this.providers.has(primaryOverride) ? primaryOverride : this.primaryProvider;
    return [primary, ...this.fallbackChain.filter((name) => name !== primary)];
  }

  private formatFailure(providerName: string, errors: string[]): string {
    // Report actual attempt count (non-retriable errors break the retry loop
    // early; we shouldn't claim "after 3 attempts" if we only tried once).
    const n = errors.length;
    const word = n === 1 ? 'attempt' : 'attempts';
    return `Provider '${providerName}' failed after ${n} ${word}:\n${errors.map((error) => `  ${error}`).join('\n')}`;
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
    // Prune tier assignments that reference now-removed providers
    for (const [tier, a] of Object.entries(this.tierMap) as [Tier, TierAssignment][]) {
      if (a && !newMap.has(a.provider)) delete this.tierMap[tier];
    }
  }

  /**
   * Add request timeout wrapper for network resilience
   */
  private async withTimeout<T>(promise: Promise<T>, provider: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`LLM request to ${provider} timed out after ${LLMManager.REQUEST_TIMEOUT_MS}ms`)),
          LLMManager.REQUEST_TIMEOUT_MS
        )
      )
    ]);
  }

  /**
   * Classify error for better retry logic
   */
  private shouldRetry(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const msg = error.message.toLowerCase();
    // Retry on network/timeout errors, not on auth/validation errors
    return msg.includes('timeout') ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('network') ||
      msg.includes('temporarily unavailable') ||
      msg.includes('429') ||  // rate limit
      msg.includes('503');    // service unavailable
  }

  /**
   * Resolve a tier to a concrete provider + model, walking the fall-up chain
   * if the requested tier is unassigned. Throws if no tier resolves (config
   * misconfiguration).
   */
  private resolveTierOrThrow(tier: Tier): { resolution: TierResolution; provider: LLMProvider } {
    const resolution = resolveTier(tier, this.tierMap);
    if (!resolution) {
      throw new Error(
        `No provider configured for tier '${tier}' or its fall-up chain. ` +
        `Configure llm.tiers.${tier} or llm.tiers.medium in config.yaml.`,
      );
    }
    const provider = this.providers.get(resolution.assignment.provider);
    if (!provider) {
      throw new Error(
        `Tier '${tier}' references provider '${resolution.assignment.provider}' which is not registered.`,
      );
    }
    return { resolution, provider };
  }

  /**
   * Tier-aware chat. Routes to the resolved provider for the requested tier,
   * records usage labeled by subsystem.
   */
  async chatTier(
    tier: Tier,
    subsystem: string,
    messages: LLMMessage[],
    options?: LLMOptions,
  ): Promise<LLMResponse> {
    const { resolution, provider } = this.resolveTierOrThrow(tier);
    const model = options?.model ?? resolution.assignment.model;
    const mergedOptions: LLMOptions = { ...options, ...(model ? { model } : {}) };

    const started = Date.now();
    try {
      const response = await this.invokeWithRetry(provider, messages, mergedOptions);
      recordUsage({
        tier,
        resolved_tier: resolution.tier,
        subsystem,
        provider: provider.name,
        model: response.model || model || '',
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        latency_ms: Date.now() - started,
      });
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordUsage({
        tier,
        resolved_tier: resolution.tier,
        subsystem,
        provider: provider.name,
        model: model || '',
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: Date.now() - started,
        error_code: classifyErrorString(msg),
      });
      throw err;
    }
  }

  /**
   * Tier-aware streaming. Records usage on completion (or error).
   */
  async *streamTier(
    tier: Tier,
    subsystem: string,
    messages: LLMMessage[],
    options?: LLMOptions,
  ): AsyncIterable<LLMStreamEvent> {
    const { resolution, provider } = this.resolveTierOrThrow(tier);
    const model = options?.model ?? resolution.assignment.model;
    const mergedOptions: LLMOptions = { ...options, ...(model ? { model } : {}) };

    const started = Date.now();
    let finalResponse: LLMResponse | null = null;
    let errored: string | null = null;

    try {
      for await (const event of this.streamWithRetry(provider, messages, mergedOptions)) {
        if (event.type === 'done') finalResponse = event.response;
        if (event.type === 'error') errored = event.error;
        yield event;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errored = msg;
      throw err;
    } finally {
      recordUsage({
        tier,
        resolved_tier: resolution.tier,
        subsystem,
        provider: provider.name,
        model: finalResponse?.model || model || '',
        input_tokens: finalResponse?.usage?.input_tokens ?? 0,
        output_tokens: finalResponse?.usage?.output_tokens ?? 0,
        latency_ms: Date.now() - started,
        error_code: errored ? classifyErrorString(errored) : undefined,
      });
    }
  }

  /**
   * Single-provider chat with retry. Used by tier-aware paths after the tier
   * has resolved to a concrete provider. No legacy fallback chain logic - tier
   * fall-up replaces it.
   */
  private async invokeWithRetry(
    provider: LLMProvider,
    messages: LLMMessage[],
    options?: LLMOptions,
  ): Promise<LLMResponse> {
    const errors: string[] = [];
    for (let attempt = 1; attempt <= LLMManager.MAX_RETRIES_PER_PROVIDER; attempt++) {
      try {
        const result = await this.withTimeout(provider.chat(messages, options), provider.name);
        if (LLMManager.isDebugging && attempt > 1) {
          console.log(`[DEBUG] LLM ${provider.name} succeeded on retry attempt ${attempt}`);
        }
        return result;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push(`attempt ${attempt}: ${errorMsg}`);
        const shouldRetry = this.shouldRetry(err);
        console.error(
          `[LLM] Provider ${provider.name} failed (attempt ${attempt}/${LLMManager.MAX_RETRIES_PER_PROVIDER})${!shouldRetry ? ' [no retry]' : ''}: ${errorMsg}`
        );
        if (!shouldRetry) break;
      }
    }
    throw new Error(this.formatFailure(provider.name, errors));
  }

  private async *streamWithRetry(
    provider: LLMProvider,
    messages: LLMMessage[],
    options?: LLMOptions,
  ): AsyncIterable<LLMStreamEvent> {
    const errors: string[] = [];
    let lastErrorCode: LLMErrorCode | undefined;
    for (let attempt = 1; attempt <= LLMManager.MAX_RETRIES_PER_PROVIDER; attempt++) {
      let emittedContent = false;
      try {
        let hasError = false;
        for await (const event of provider.stream(messages, options)) {
          if (event.type === 'error') {
            hasError = true;
            errors.push(`attempt ${attempt}: ${event.error}`);
            lastErrorCode = event.code ?? classifyErrorString(event.error);
            console.error(
              `[LLM] Provider ${provider.name} stream error (attempt ${attempt}/${LLMManager.MAX_RETRIES_PER_PROVIDER}): ${event.error}`
            );
            if (emittedContent) {
              yield {
                type: 'error',
                error: this.formatFailure(provider.name, errors),
                code: lastErrorCode,
              };
              return;
            }
            break;
          }
          if (event.type === 'text' || event.type === 'tool_call') {
            emittedContent = true;
          }
          yield event;
        }
        if (!hasError) return;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push(`attempt ${attempt}: ${errorMsg}`);
        lastErrorCode = classifyErrorString(errorMsg);
        const shouldRetry = this.shouldRetry(err);
        console.error(
          `[LLM] Provider ${provider.name} stream failed (attempt ${attempt}/${LLMManager.MAX_RETRIES_PER_PROVIDER})${!shouldRetry ? ' [no retry]' : ''}: ${errorMsg}`
        );
        if (emittedContent) {
          yield {
            type: 'error',
            error: this.formatFailure(provider.name, errors),
            code: lastErrorCode,
          };
          return;
        }
        if (!shouldRetry) break;
      }
    }
    yield {
      type: 'error',
      error: this.formatFailure(provider.name, errors),
      code: lastErrorCode ?? classifyErrorString(errors.join('\n')),
    };
  }

  /**
   * Temporarily override the primary provider for a single call.
   * Used for per-message LLM selection from chat dashboard.
   *
   * @deprecated Use chatTier() for new code. Kept for the chat-dashboard
   * per-message override and as a legacy fallback path.
   */
  async chatWithOverride(
    messages: LLMMessage[],
    overridePrimary: string | null,
    options?: LLMOptions
  ): Promise<LLMResponse> {
    const failures: string[] = [];

    for (const providerName of this.getProviderSequence(overridePrimary)) {
      const provider = this.providers.get(providerName);
      if (!provider) {
        failures.push(`Provider '${providerName}' not registered`);
        continue;
      }

      const errors: string[] = [];
      for (let attempt = 1; attempt <= LLMManager.MAX_RETRIES_PER_PROVIDER; attempt++) {
        try {
          const result = await this.withTimeout(provider.chat(messages, options), providerName);
          if (LLMManager.isDebugging && attempt > 1) {
            console.log(`[DEBUG] LLM ${providerName} succeeded on retry attempt ${attempt}`);
          }
          return result;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          errors.push(`attempt ${attempt}: ${errorMsg}`);

          const shouldRetry = this.shouldRetry(err);
          console.error(
            `[LLM] Provider ${providerName} failed (attempt ${attempt}/${LLMManager.MAX_RETRIES_PER_PROVIDER})${!shouldRetry ? ' [no retry]' : ''}: ${errorMsg}`
          );

          if (!shouldRetry) break;
        }
      }

      failures.push(this.formatFailure(providerName, errors));
    }

    throw new Error(failures.join('\n\n'));
  }

  /**
   * Legacy chat API. Routes through the `medium` tier (with fall-up) when a
   * tier map is configured; otherwise falls back to the legacy primary +
   * fallback chain. New code should call chatTier() with an explicit subsystem.
   *
   * @deprecated Prefer chatTier(tier, subsystem, messages, options).
   */
  async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    if (resolveTier('medium', this.tierMap)) {
      return this.chatTier('medium', 'legacy', messages, options);
    }
    return this.chatWithOverride(messages, null, options);
  }

  /**
   * Legacy stream API. See chat() comment.
   * @deprecated Prefer streamTier(tier, subsystem, messages, options).
   */
  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<LLMStreamEvent> {
    if (resolveTier('medium', this.tierMap)) {
      yield* this.streamTier('medium', 'legacy', messages, options);
      return;
    }
    // Legacy multi-provider fallback stream (no tier map configured).
    const failures: string[] = [];
    let lastErrorCode: LLMErrorCode | undefined;

    for (const providerName of this.getProviderSequence()) {
      const provider = this.providers.get(providerName);
      if (!provider) {
        failures.push(`Provider '${providerName}' not registered`);
        continue;
      }

      const errors: string[] = [];
      for (let attempt = 1; attempt <= LLMManager.MAX_RETRIES_PER_PROVIDER; attempt++) {
        let emittedContent = false;
        try {
          let hasError = false;
          for await (const event of provider.stream(messages, options)) {
            if (event.type === 'error') {
              hasError = true;
              errors.push(`attempt ${attempt}: ${event.error}`);
              lastErrorCode = event.code ?? classifyErrorString(event.error);
              console.error(
                `[LLM] Provider ${providerName} stream error (attempt ${attempt}/${LLMManager.MAX_RETRIES_PER_PROVIDER}): ${event.error}`
              );
              if (emittedContent) {
                yield {
                  type: 'error',
                  error: this.formatFailure(providerName, errors),
                  code: lastErrorCode,
                };
                return;
              }
              break;
            }
            if (event.type === 'text' || event.type === 'tool_call') {
              emittedContent = true;
            }
            yield event;
          }

          if (!hasError) {
            return;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          errors.push(`attempt ${attempt}: ${errorMsg}`);
          lastErrorCode = classifyErrorString(errorMsg);

          const shouldRetry = this.shouldRetry(err);
          console.error(
            `[LLM] Provider ${providerName} stream failed (attempt ${attempt}/${LLMManager.MAX_RETRIES_PER_PROVIDER})${!shouldRetry ? ' [no retry]' : ''}: ${errorMsg}`
          );

          if (emittedContent) {
            yield {
              type: 'error',
              error: this.formatFailure(providerName, errors),
              code: lastErrorCode,
            };
            return;
          }

          if (!shouldRetry) break;
        }
      }

      failures.push(this.formatFailure(providerName, errors));
    }

    const aggregated = failures.join('\n\n');
    yield {
      type: 'error',
      error: aggregated,
      code: lastErrorCode ?? classifyErrorString(aggregated),
    };
  }
}
