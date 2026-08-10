import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMErrorCode,
} from './provider.ts';
import { classifyErrorString, LLMProviderError } from './provider.ts';
import {
  type Tier,
  type TierAssignment,
  type TierMap,
  type TierResolution,
  TIERS,
  TIER_FALLBACK,
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
  /**
   * Never park an interactive request for a very long quota reset. Applies
   * cumulatively across one provider's attempts (see waitForRetry).
   */
  private static readonly MAX_RETRY_AFTER_MS = 60000;
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

    if (error instanceof LLMProviderError) {
      return this.shouldRetryCode(error.code);
    }

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

  private shouldRetryCode(code: LLMErrorCode | undefined): boolean {
    return code === 'rate_limit' || code === 'network' || code === 'server';
  }

  /**
   * Tier failover is intentionally narrower than a provider-local retry.
   * Sending the same conversation to another provider is only appropriate
   * when the selected model is unavailable or the provider has no quota.
   */
  private shouldFailOver(code: LLMErrorCode | undefined, message: string): boolean {
    if (code === 'rate_limit') return true;
    if (code !== 'bad_request' && code !== 'not_found') return false;

    // A bare 404 can mean a bad endpoint or missing non-model resource. Only
    // cross the provider boundary when the upstream error identifies model
    // availability as the problem.
    return /\bmodel(?:[_ -](?:decommissioned|not[_ -]found|unsupported|unavailable|retired))\b/i.test(message)
      || /\bmodel\b.{0,160}\b(?:decommissioned|not found|does not exist|unsupported|unavailable|retired)\b/i.test(message)
      || /\b(?:decommissioned|retired)\b.{0,160}\bmodel\b/i.test(message);
  }

  /**
   * Honor provider Retry-After. The budget is shared across one provider's
   * attempts, so stacked Retry-After sleeps can never park a request for
   * longer than MAX_RETRY_AFTER_MS in total. Returns false when the wait
   * would overrun what remains — the caller stops retrying and fails over.
   */
  private async waitForRetry(
    retryAfterMs: number | undefined,
    budget: { remainingMs: number },
  ): Promise<boolean> {
    if (retryAfterMs === undefined || retryAfterMs <= 0) return true;
    if (retryAfterMs > budget.remainingMs) return false;
    budget.remainingMs -= retryAfterMs;
    await new Promise<void>((resolve) => setTimeout(resolve, retryAfterMs));
    return true;
  }

  private newRetryBudget(): { remainingMs: number } {
    return { remainingMs: LLMManager.MAX_RETRY_AFTER_MS };
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
   * Ordered failover candidates for a tier. Only explicitly tier-mapped
   * providers are eligible: merely configuring a provider does not authorize
   * the router to send conversation content to it. Each mapped provider's
   * default follows its assigned model so a retired model can recover without
   * waiting for the dashboard to refresh the saved setting.
   */
  private tierCandidates(tier: Tier): Array<{ resolution: TierResolution; provider: LLMProvider }> {
    const first = this.resolveTierOrThrow(tier);
    const out = [first];
    const seen = new Set([`${first.provider.name}\u0000${first.resolution.assignment.model ?? ''}`]);
    const add = (resolution: TierResolution) => {
      const provider = this.providers.get(resolution.assignment.provider);
      if (!provider) return;
      const key = `${provider.name}\u0000${resolution.assignment.model ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ resolution, provider });
    };

    // Recover the resolved provider's own default before crossing a provider
    // boundary (and potentially a cost boundary).
    add({ tier: first.resolution.tier, assignment: { provider: first.provider.name } });

    const mapped: TierResolution[] = [];
    // Respect the same explicit cost/routing boundary as normal tier
    // resolution. In particular, task/background tiers never spill into the
    // conversation tier merely because it happens to be configured.
    for (const candidateTier of [tier, ...TIER_FALLBACK[tier]]) {
      const assignment = this.tierMap[candidateTier];
      if (assignment) mapped.push({ tier: candidateTier, assignment });
    }
    for (const resolution of mapped) {
      add(resolution);
      add({ tier: resolution.tier, assignment: { provider: resolution.assignment.provider } });
    }
    return out;
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
    const failures: string[] = [];
    let lastFailureCode: LLMErrorCode = 'unknown';
    let lastRetryAfterMs: number | undefined;
    const exhaustedProviders = new Set<string>();
    const candidates = this.tierCandidates(tier);
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const { resolution, provider } = candidates[candidateIndex]!;
      if (exhaustedProviders.has(provider.name)) continue;
      const model = candidateIndex === 0
        ? options?.model ?? resolution.assignment.model
        : resolution.assignment.model;
      const mergedOptions: LLMOptions = { ...options };
      if (model) mergedOptions.model = model;
      else delete mergedOptions.model;
      const started = Date.now();
      const hasAlternativeProvider = candidates
        .slice(candidateIndex + 1)
        .some((candidate) => candidate.provider.name !== provider.name
          && !exhaustedProviders.has(candidate.provider.name));
      try {
        const response = await this.invokeWithRetry(
          provider,
          messages,
          mergedOptions,
          hasAlternativeProvider,
        );
        recordUsage({
          tier, resolved_tier: resolution.tier, subsystem, provider: provider.name,
          model: response.model || model || '',
          input_tokens: response.usage?.input_tokens ?? 0,
          output_tokens: response.usage?.output_tokens ?? 0,
          cache_read_input_tokens: response.usage?.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: response.usage?.cache_creation_input_tokens ?? 0,
          latency_ms: Date.now() - started,
        });
        return response;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = err instanceof LLMProviderError ? err.code : classifyErrorString(msg);
        lastFailureCode = code;
        const retryAfterMs = err instanceof LLMProviderError ? err.retryAfterMs : undefined;
        if (retryAfterMs !== undefined) lastRetryAfterMs = retryAfterMs;
        failures.push(msg);
        recordUsage({
          tier, resolved_tier: resolution.tier, subsystem, provider: provider.name,
          model: model || '', input_tokens: 0, output_tokens: 0,
          latency_ms: Date.now() - started, error_code: code,
        });
        if (!this.shouldFailOver(code, msg)) throw err;
        if (code === 'rate_limit') exhaustedProviders.add(provider.name);
      }
    }
    throw new LLMProviderError(failures.join('\n\n'), lastFailureCode, lastRetryAfterMs);
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
    const failures: Array<Extract<LLMStreamEvent, { type: 'error' }>> = [];
    const exhaustedProviders = new Set<string>();
    const candidates = this.tierCandidates(tier);
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const { resolution, provider } = candidates[candidateIndex]!;
      if (exhaustedProviders.has(provider.name)) continue;
      const model = candidateIndex === 0
        ? options?.model ?? resolution.assignment.model
        : resolution.assignment.model;
      const mergedOptions: LLMOptions = { ...options };
      if (model) mergedOptions.model = model;
      else delete mergedOptions.model;
      const started = Date.now();
      let finalResponse: LLMResponse | null = null;
      let terminalError: Extract<LLMStreamEvent, { type: 'error' }> | null = null;
      let emittedContent = false;
      const hasAlternativeProvider = candidates
        .slice(candidateIndex + 1)
        .some((candidate) => candidate.provider.name !== provider.name
          && !exhaustedProviders.has(candidate.provider.name));

      try {
        for await (const event of this.streamWithRetry(
          provider,
          messages,
          mergedOptions,
          hasAlternativeProvider,
        )) {
          if (event.type === 'done') finalResponse = event.response;
          if (event.type === 'text' || event.type === 'tool_call') emittedContent = true;
          if (event.type === 'error') {
            terminalError = event;
            continue; // hold it while a clean failover is still possible
          }
          yield event;
        }
      } finally {
        // Runs even when the consumer stops iterating mid-stream (client
        // disconnect / stop) so partial calls still land in telemetry.
        recordUsage({
          tier, resolved_tier: resolution.tier, subsystem, provider: provider.name,
          model: finalResponse?.model || model || '',
          input_tokens: finalResponse?.usage?.input_tokens ?? 0,
          output_tokens: finalResponse?.usage?.output_tokens ?? 0,
          cache_read_input_tokens: finalResponse?.usage?.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: finalResponse?.usage?.cache_creation_input_tokens ?? 0,
          latency_ms: Date.now() - started,
          error_code: terminalError?.code
            ?? (terminalError ? classifyErrorString(terminalError.error) : undefined),
        });
      }

      if (!terminalError) return;
      if (emittedContent) {
        yield terminalError;
        return;
      }
      const terminalCode = terminalError.code ?? classifyErrorString(terminalError.error);
      if (!this.shouldFailOver(terminalCode, terminalError.error)) {
        yield terminalError;
        return;
      }
      if (terminalCode === 'rate_limit') {
        exhaustedProviders.add(provider.name);
      }
      failures.push(terminalError);
    }

    const error = failures.map((event) => event.error).join('\n\n');
    const finalFailure = failures.at(-1);
    yield {
      type: 'error',
      error,
      code: finalFailure?.code ?? classifyErrorString(error),
      ...(finalFailure?.retry_after_ms !== undefined
        ? { retry_after_ms: finalFailure.retry_after_ms }
        : {}),
    };
  }

  /**
   * Single-provider chat with retry. Tier-aware callers layer model/provider
   * failover around this method after local retries are exhausted.
   */
  private async invokeWithRetry(
    provider: LLMProvider,
    messages: LLMMessage[],
    options?: LLMOptions,
    failFastOnRateLimit = false,
  ): Promise<LLMResponse> {
    const errors: string[] = [];
    let lastCode: LLMErrorCode = 'unknown';
    let lastRetryAfterMs: number | undefined;
    const retryBudget = this.newRetryBudget();
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
        lastCode = err instanceof LLMProviderError ? err.code : classifyErrorString(errorMsg);
        lastRetryAfterMs = err instanceof LLMProviderError ? err.retryAfterMs : undefined;
        const shouldRetry = this.shouldRetry(err);
        console.error(
          `[LLM] Provider ${provider.name} failed (attempt ${attempt}/${LLMManager.MAX_RETRIES_PER_PROVIDER})${!shouldRetry ? ' [no retry]' : ''}: ${errorMsg}`
        );
        if (!shouldRetry || attempt === LLMManager.MAX_RETRIES_PER_PROVIDER) break;
        const retryAfterMs = err instanceof LLMProviderError ? err.retryAfterMs : undefined;
        if (failFastOnRateLimit && lastCode === 'rate_limit') break;
        if (!await this.waitForRetry(retryAfterMs, retryBudget)) break;
      }
    }
    throw new LLMProviderError(
      this.formatFailure(provider.name, errors),
      lastCode,
      lastRetryAfterMs,
    );
  }

  private async *streamWithRetry(
    provider: LLMProvider,
    messages: LLMMessage[],
    options?: LLMOptions,
    failFastOnRateLimit = false,
  ): AsyncIterable<LLMStreamEvent> {
    const errors: string[] = [];
    let lastErrorCode: LLMErrorCode | undefined;
    let lastRetryAfterMs: number | undefined;
    const retryBudget = this.newRetryBudget();
    for (let attempt = 1; attempt <= LLMManager.MAX_RETRIES_PER_PROVIDER; attempt++) {
      let emittedContent = false;
      let retryableEvent = true;
      let eventRetryAfterMs: number | undefined;
      try {
        let hasError = false;
        for await (const event of provider.stream(messages, options)) {
          if (event.type === 'error') {
            hasError = true;
            errors.push(`attempt ${attempt}: ${event.error}`);
            lastErrorCode = event.code ?? classifyErrorString(event.error);
            retryableEvent = this.shouldRetryCode(lastErrorCode);
            eventRetryAfterMs = event.retry_after_ms;
            lastRetryAfterMs = event.retry_after_ms;
            console.error(
              `[LLM] Provider ${provider.name} stream error (attempt ${attempt}/${LLMManager.MAX_RETRIES_PER_PROVIDER}): ${event.error}`
            );
            if (emittedContent) {
              yield {
                type: 'error',
                error: this.formatFailure(provider.name, errors),
                code: lastErrorCode,
                ...(lastRetryAfterMs !== undefined ? { retry_after_ms: lastRetryAfterMs } : {}),
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
        if (!retryableEvent || attempt === LLMManager.MAX_RETRIES_PER_PROVIDER) break;
        if (failFastOnRateLimit && lastErrorCode === 'rate_limit') break;
        if (!await this.waitForRetry(eventRetryAfterMs, retryBudget)) break;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push(`attempt ${attempt}: ${errorMsg}`);
        lastErrorCode = err instanceof LLMProviderError ? err.code : classifyErrorString(errorMsg);
        const retryAfterMs = err instanceof LLMProviderError ? err.retryAfterMs : undefined;
        lastRetryAfterMs = retryAfterMs;
        const shouldRetry = this.shouldRetry(err);
        console.error(
          `[LLM] Provider ${provider.name} stream failed (attempt ${attempt}/${LLMManager.MAX_RETRIES_PER_PROVIDER})${!shouldRetry ? ' [no retry]' : ''}: ${errorMsg}`
        );
        if (emittedContent) {
          yield {
            type: 'error',
            error: this.formatFailure(provider.name, errors),
            code: lastErrorCode,
            ...(lastRetryAfterMs !== undefined ? { retry_after_ms: lastRetryAfterMs } : {}),
          };
          return;
        }
        if (!shouldRetry || attempt === LLMManager.MAX_RETRIES_PER_PROVIDER) break;
        if (failFastOnRateLimit && lastErrorCode === 'rate_limit') break;
        if (!await this.waitForRetry(retryAfterMs, retryBudget)) break;
      }
    }
    yield {
      type: 'error',
      error: this.formatFailure(provider.name, errors),
      code: lastErrorCode ?? classifyErrorString(errors.join('\n')),
      ...(lastRetryAfterMs !== undefined ? { retry_after_ms: lastRetryAfterMs } : {}),
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
      const retryBudget = this.newRetryBudget();
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
          const retryAfterMs = err instanceof LLMProviderError ? err.retryAfterMs : undefined;
          if (attempt < LLMManager.MAX_RETRIES_PER_PROVIDER && !await this.waitForRetry(retryAfterMs, retryBudget)) break;
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
    let lastRetryAfterMs: number | undefined;

    for (const providerName of this.getProviderSequence()) {
      const provider = this.providers.get(providerName);
      if (!provider) {
        failures.push(`Provider '${providerName}' not registered`);
        continue;
      }

      const errors: string[] = [];
      const retryBudget = this.newRetryBudget();
      for (let attempt = 1; attempt <= LLMManager.MAX_RETRIES_PER_PROVIDER; attempt++) {
        let emittedContent = false;
        let retryableEvent = true;
        let eventRetryAfterMs: number | undefined;
        try {
          let hasError = false;
          for await (const event of provider.stream(messages, options)) {
            if (event.type === 'error') {
              hasError = true;
              errors.push(`attempt ${attempt}: ${event.error}`);
              lastErrorCode = event.code ?? classifyErrorString(event.error);
              retryableEvent = this.shouldRetryCode(lastErrorCode);
              eventRetryAfterMs = event.retry_after_ms;
              lastRetryAfterMs = event.retry_after_ms;
              console.error(
                `[LLM] Provider ${providerName} stream error (attempt ${attempt}/${LLMManager.MAX_RETRIES_PER_PROVIDER}): ${event.error}`
              );
              if (emittedContent) {
                yield {
                  type: 'error',
                  error: this.formatFailure(providerName, errors),
                  code: lastErrorCode,
                  ...(lastRetryAfterMs !== undefined ? { retry_after_ms: lastRetryAfterMs } : {}),
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
          if (!retryableEvent || attempt === LLMManager.MAX_RETRIES_PER_PROVIDER) break;
          if (!await this.waitForRetry(eventRetryAfterMs, retryBudget)) break;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          errors.push(`attempt ${attempt}: ${errorMsg}`);
          lastErrorCode = err instanceof LLMProviderError ? err.code : classifyErrorString(errorMsg);
          const retryAfterMs = err instanceof LLMProviderError ? err.retryAfterMs : undefined;
          lastRetryAfterMs = retryAfterMs;

          const shouldRetry = this.shouldRetry(err);
          console.error(
            `[LLM] Provider ${providerName} stream failed (attempt ${attempt}/${LLMManager.MAX_RETRIES_PER_PROVIDER})${!shouldRetry ? ' [no retry]' : ''}: ${errorMsg}`
          );

          if (emittedContent) {
            yield {
              type: 'error',
              error: this.formatFailure(providerName, errors),
              code: lastErrorCode,
              ...(lastRetryAfterMs !== undefined ? { retry_after_ms: lastRetryAfterMs } : {}),
            };
            return;
          }

          if (!shouldRetry || attempt === LLMManager.MAX_RETRIES_PER_PROVIDER) break;
          if (!await this.waitForRetry(retryAfterMs, retryBudget)) break;
        }
      }

      failures.push(this.formatFailure(providerName, errors));
    }

    const aggregated = failures.join('\n\n');
    yield {
      type: 'error',
      error: aggregated,
      code: lastErrorCode ?? classifyErrorString(aggregated),
      ...(lastRetryAfterMs !== undefined ? { retry_after_ms: lastRetryAfterMs } : {}),
    };
  }
}
