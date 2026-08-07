import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMErrorCode,
} from './provider.ts';
import { classifyErrorString, LLMProviderError, parseRetryAfterMs } from './provider.ts';
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
  /** Explicit llm.default assignment; also authorizes cross-provider fallback. */
  private defaultAssignment: TierAssignment | null = null;
  private static readonly MAX_RETRIES_PER_PROVIDER = 3;
  private static readonly MAX_RETRY_SLEEP_MS = 60_000;
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

  setDefaultAssignment(assignment: TierAssignment | null): void {
    if (assignment && !this.providers.has(assignment.provider)) {
      throw new Error(`Provider '${assignment.provider}' not registered (llm.default)`);
    }
    this.defaultAssignment = assignment
      ? { provider: assignment.provider, model: assignment.model }
      : null;
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

  private errorCode(error: unknown): LLMErrorCode {
    const structured = error && typeof error === 'object'
      ? (error as { code?: LLMErrorCode }).code
      : undefined;
    if (structured) return structured;
    return classifyErrorString(error instanceof Error ? error.message : String(error));
  }

  private retryAfterMs(error: unknown): number | undefined {
    const structured = error && typeof error === 'object'
      ? (error as { retryAfterMs?: unknown }).retryAfterMs
      : undefined;
    if (typeof structured === 'number' && Number.isFinite(structured) && structured >= 0) {
      return structured;
    }
    return parseRetryAfterMs(undefined, error instanceof Error ? error.message : String(error));
  }

  /**
   * Wait only when this provider is the last authorized candidate. Long waits
   * are surfaced to the caller instead of freezing an interactive request.
   */
  private async waitForRetry(provider: string, retryAfterMs: number | undefined): Promise<boolean> {
    if (retryAfterMs === undefined) return true;
    if (retryAfterMs > LLMManager.MAX_RETRY_SLEEP_MS) return false;
    if (retryAfterMs > 0) {
      const delay = retryAfterMs >= 1000
        ? `${Math.ceil(retryAfterMs / 1000)}s`
        : `${Math.ceil(retryAfterMs)}ms`;
      console.log(`[LLM] ${provider} rate-limited — retrying in ${delay}`);
      await Bun.sleep(retryAfterMs);
    }
    return true;
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
    if (this.defaultAssignment && !newMap.has(this.defaultAssignment.provider)) {
      this.defaultAssignment = null;
    }
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

    if (this.shouldRetryCode(this.errorCode(error))) return true;

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
   * Cross-provider fallback is allowed for provider availability failures and
   * model-specific failures. Request/schema errors stay on the selected
   * provider so a malformed request is never sprayed across providers.
   */
  private shouldFailOver(code: LLMErrorCode | undefined, message: string): boolean {
    if (code === 'auth' || code === 'rate_limit' || code === 'network' || code === 'server') {
      return true;
    }
    if (code !== 'bad_request' && code !== 'not_found') return false;
    return /\bmodel(?:[_ -](?:decommissioned|not[_ -]found|unsupported|unavailable|retired))\b/i.test(message)
      || /\bmodel\b.{0,160}\b(?:decommissioned|not found|does not exist|unsupported|unavailable|retired)\b/i.test(message)
      || /\b(?:decommissioned|retired)\b.{0,160}\bmodel\b/i.test(message);
  }

  private isProviderFailure(code: LLMErrorCode | undefined): boolean {
    return code === 'auth' || code === 'rate_limit' || code === 'network' || code === 'server';
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
   * Build an ordered, explicitly-authorized fallback list. A configured
   * provider is not enough: it must be mapped to the requested tier/fall-up
   * path or selected as llm.default. This prevents accidental data/cost spill.
   */
  private tierCandidates(tier: Tier): Array<{ resolution: TierResolution; provider: LLMProvider }> {
    const first = this.resolveTierOrThrow(tier);
    const candidates = [first];
    const seen = new Set([`${first.provider.name}\u0000${first.resolution.assignment.model ?? ''}`]);
    const add = (resolution: TierResolution) => {
      const provider = this.providers.get(resolution.assignment.provider);
      if (!provider) return;
      const key = `${provider.name}\u0000${resolution.assignment.model ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ resolution, provider });
    };

    // A retired saved model gets one chance to recover via that provider's
    // current default before crossing a provider boundary.
    add({ tier: first.resolution.tier, assignment: { provider: first.provider.name } });

    for (const candidateTier of [tier, ...TIER_FALLBACK[tier]]) {
      const assignment = this.tierMap[candidateTier];
      if (!assignment) continue;
      add({ tier: candidateTier, assignment });
      add({ tier: candidateTier, assignment: { provider: assignment.provider } });
    }

    // llm.default is an explicit user-selected safety net. It is especially
    // important for conversation, whose normal tier fall-up is intentionally
    // empty because configuring it toggles router-first mode.
    if (this.defaultAssignment) {
      add({ tier, assignment: this.defaultAssignment });
      add({ tier, assignment: { provider: this.defaultAssignment.provider } });
    }
    return candidates;
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
    const failures: Array<{ message: string; code: LLMErrorCode; retryAfterMs?: number }> = [];
    const exhaustedProviders = new Set<string>();
    const candidates = this.tierCandidates(tier);

    for (let index = 0; index < candidates.length; index++) {
      const { resolution, provider } = candidates[index]!;
      if (exhaustedProviders.has(provider.name)) continue;
      const model = index === 0 ? options?.model ?? resolution.assignment.model : resolution.assignment.model;
      const mergedOptions: LLMOptions = { ...options };
      if (model) mergedOptions.model = model;
      else delete mergedOptions.model;
      const hasAlternativeProvider = candidates
        .slice(index + 1)
        .some((candidate) => candidate.provider.name !== provider.name
          && !exhaustedProviders.has(candidate.provider.name));
      const started = Date.now();

      try {
        const response = await this.invokeWithRetry(provider, messages, mergedOptions, hasAlternativeProvider);
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
        const message = err instanceof Error ? err.message : String(err);
        const code = this.errorCode(err);
        const retryAfterMs = this.retryAfterMs(err);
        failures.push({ message, code, retryAfterMs });
        recordUsage({
          tier, resolved_tier: resolution.tier, subsystem, provider: provider.name,
          model: model || '', input_tokens: 0, output_tokens: 0,
          latency_ms: Date.now() - started, error_code: code,
        });
        if (!this.shouldFailOver(code, message)) throw err;
        if (this.isProviderFailure(code)) exhaustedProviders.add(provider.name);
      }
    }

    const last = failures.at(-1);
    throw new LLMProviderError(failures.map((failure) => failure.message).join('\n\n'), {
      code: last?.code,
      retryAfterMs: last?.retryAfterMs,
    });
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

    for (let index = 0; index < candidates.length; index++) {
      const { resolution, provider } = candidates[index]!;
      if (exhaustedProviders.has(provider.name)) continue;
      const model = index === 0 ? options?.model ?? resolution.assignment.model : resolution.assignment.model;
      const mergedOptions: LLMOptions = { ...options };
      if (model) mergedOptions.model = model;
      else delete mergedOptions.model;
      const hasAlternativeProvider = candidates
        .slice(index + 1)
        .some((candidate) => candidate.provider.name !== provider.name
          && !exhaustedProviders.has(candidate.provider.name));
      const started = Date.now();
      let finalResponse: LLMResponse | null = null;
      let terminalError: Extract<LLMStreamEvent, { type: 'error' }> | null = null;
      let emittedContent = false;

      for await (const event of this.streamWithRetry(provider, messages, mergedOptions, hasAlternativeProvider)) {
        if (event.type === 'done') finalResponse = event.response;
        if (event.type === 'text' || event.type === 'tool_call') emittedContent = true;
        if (event.type === 'error') {
          terminalError = event;
          continue;
        }
        yield event;
      }

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

      if (!terminalError) return;
      if (emittedContent) {
        yield terminalError;
        return;
      }
      const code = terminalError.code ?? classifyErrorString(terminalError.error);
      if (!this.shouldFailOver(code, terminalError.error)) {
        yield terminalError;
        return;
      }
      if (this.isProviderFailure(code)) exhaustedProviders.add(provider.name);
      failures.push(terminalError);
    }

    const error = failures.map((failure) => failure.error).join('\n\n');
    const lastFailure = failures.at(-1);
    yield {
      type: 'error',
      error,
      code: lastFailure?.code ?? classifyErrorString(error),
      retryAfterMs: lastFailure?.retryAfterMs,
    };
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
    failFastForAlternative = false,
  ): Promise<LLMResponse> {
    const errors: string[] = [];
    let lastErrorCode: LLMErrorCode | undefined;
    let lastRetryAfterMs: number | undefined;
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
        lastErrorCode = this.errorCode(err);
        lastRetryAfterMs = this.retryAfterMs(err);
        const shouldRetry = this.shouldRetry(err);
        console.error(
          `[LLM] Provider ${provider.name} failed (attempt ${attempt}/${LLMManager.MAX_RETRIES_PER_PROVIDER})${!shouldRetry ? ' [no retry]' : ''}: ${errorMsg}`
        );
        if (failFastForAlternative && this.shouldFailOver(lastErrorCode, errorMsg)) break;
        if (!shouldRetry) break;
        if (
          attempt < LLMManager.MAX_RETRIES_PER_PROVIDER
          && !(await this.waitForRetry(provider.name, lastRetryAfterMs))
        ) break;
      }
    }
    throw new LLMProviderError(this.formatFailure(provider.name, errors), {
      code: lastErrorCode,
      retryAfterMs: lastRetryAfterMs,
    });
  }

  private async *streamWithRetry(
    provider: LLMProvider,
    messages: LLMMessage[],
    options?: LLMOptions,
    failFastForAlternative = false,
  ): AsyncIterable<LLMStreamEvent> {
    const errors: string[] = [];
    let lastErrorCode: LLMErrorCode | undefined;
    let lastRetryAfterMs: number | undefined;
    for (let attempt = 1; attempt <= LLMManager.MAX_RETRIES_PER_PROVIDER; attempt++) {
      let emittedContent = false;
      let retryableEvent = true;
      try {
        let hasError = false;
        for await (const event of provider.stream(messages, options)) {
          if (event.type === 'error') {
            hasError = true;
            errors.push(`attempt ${attempt}: ${event.error}`);
            lastErrorCode = event.code ?? classifyErrorString(event.error);
            lastRetryAfterMs = event.retryAfterMs
              ?? parseRetryAfterMs(undefined, event.error);
            retryableEvent = this.shouldRetryCode(lastErrorCode);
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
        if (!retryableEvent || failFastForAlternative) break;
        if (
          attempt < LLMManager.MAX_RETRIES_PER_PROVIDER
          && !(await this.waitForRetry(provider.name, lastRetryAfterMs))
        ) break;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push(`attempt ${attempt}: ${errorMsg}`);
        lastErrorCode = this.errorCode(err);
        lastRetryAfterMs = this.retryAfterMs(err);
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
        if (failFastForAlternative && this.shouldFailOver(lastErrorCode, errorMsg)) break;
        if (!shouldRetry) break;
        if (
          attempt < LLMManager.MAX_RETRIES_PER_PROVIDER
          && !(await this.waitForRetry(provider.name, lastRetryAfterMs))
        ) break;
      }
    }
    yield {
      type: 'error',
      error: this.formatFailure(provider.name, errors),
      code: lastErrorCode ?? classifyErrorString(errors.join('\n')),
      retryAfterMs: lastRetryAfterMs,
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
