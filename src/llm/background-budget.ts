import type { Database } from 'bun:sqlite';
import { currentOrigin } from './origin';
import { getLLMErrorCode, LLMProviderError, type LLMMessage, type LLMOptions, type LLMProvider, type LLMStreamEvent } from './provider';

/** Resource bounds, not a price or a promise about provider tokenization. */
export const BACKGROUND_LIMITS = Object.freeze({
  concurrency: 2, requests: 240, inputBytes: 16 * 1024 * 1024, outputTokens: 524_288,
  requestBytes: 2 * 1024 * 1024, requestOutputTokens: 8192, windowMs: 86_400_000,
});
export type BackgroundLimits = { [K in keyof typeof BACKGROUND_LIMITS]: number };
export class BackgroundThrottled extends LLMProviderError {
  constructor(readonly reason: string, readonly retryAt: number | null) {
    super(`Background work paused: ${reason}.`, 'background_throttled', retryAt === null ? undefined : Math.max(0, retryAt - Date.now()));
  }
}

export class BackgroundBudget {
  private active = 0;
  private foreground = 0;
  private refused = 0;
  private lastReason: string | null = null;
  constructor(private db: () => Database, readonly limits: BackgroundLimits = BACKGROUND_LIMITS, private now = Date.now) {
    const database = db();
    database.run(`CREATE TABLE IF NOT EXISTS background_model_reservations (
      id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, input_bytes INTEGER NOT NULL, output_tokens INTEGER NOT NULL
    )`);
    database.run('CREATE INDEX IF NOT EXISTS idx_background_model_started ON background_model_reservations(started_at)');
    database.run('CREATE TABLE IF NOT EXISTS background_model_backoff (id INTEGER PRIMARY KEY CHECK(id = 1), retry_at INTEGER NOT NULL, reason TEXT NOT NULL)');
  }
  snapshot() {
    const now = this.now();
    const usage = this.db().query<{ requests: number; inputBytes: number; outputTokens: number; oldest: number | null }, [number]>(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(input_bytes),0) AS inputBytes,
      COALESCE(SUM(output_tokens),0) AS outputTokens, MIN(started_at) AS oldest
      FROM background_model_reservations WHERE started_at > ?`).get(now - this.limits.windowMs)!;
    const backoff = this.db().query<{ retry_at: number; reason: string }, []>('SELECT retry_at, reason FROM background_model_backoff WHERE id = 1').get();
    const retryAt = backoff?.retry_at ?? 0;
    const reason = this.foreground ? 'foreground_busy' : this.active >= this.limits.concurrency ? 'concurrency'
      : retryAt > now ? backoff!.reason
      : usage.requests >= this.limits.requests || usage.inputBytes >= this.limits.inputBytes || usage.outputTokens >= this.limits.outputTokens ? 'daily_budget' : null;
    return { state: reason ? 'throttled' as const : 'ready' as const, reason,
      retryAt: retryAt > now && reason === backoff?.reason ? retryAt : reason === 'daily_budget' ? (usage.oldest ?? now) + this.limits.windowMs : null,
      active: this.active, foreground: this.foreground, refused: this.refused, lastReason: this.lastReason, usage, limits: this.limits };
  }
  private refuse(reason: string, retryAt: number | null): never {
    this.refused++; this.lastReason = reason;
    throw new BackgroundThrottled(reason, retryAt);
  }
  foregroundStarted(): () => void {
    this.foreground++;
    let released = false;
    return () => { if (!released) { released = true; this.foreground--; } };
  }
  private backoff(reason: string, retryAt: number) {
    this.db().run(`INSERT INTO background_model_backoff VALUES (1,?,?) ON CONFLICT(id)
      DO UPDATE SET reason = CASE WHEN excluded.retry_at >= retry_at THEN excluded.reason ELSE reason END,
      retry_at = MAX(retry_at, excluded.retry_at)`, [retryAt, reason]);
  }
  acquire(messages: LLMMessage[], options?: LLMOptions) {
    options?.signal?.throwIfAborted();
    // Refuse excess traffic before serializing screenshots or tool catalogs.
    if (this.foreground) this.refuse('foreground_busy', null);
    if (this.active >= this.limits.concurrency) this.refuse('concurrency', null);
    const inputBytes = Buffer.byteLength(JSON.stringify({ messages, tools: options?.tools ?? [] }));
    const requested = options?.max_tokens ?? this.limits.requestOutputTokens;
    if (!Number.isSafeInteger(requested) || requested < 1 || inputBytes > this.limits.requestBytes) this.refuse('request_size', null);
    const outputTokens = Math.min(requested, this.limits.requestOutputTokens);
    try {
      this.db().transaction(() => {
        const state = this.snapshot(), now = this.now();
        if (state.reason) this.refuse(state.reason, state.retryAt);
        if (state.usage.inputBytes + inputBytes > this.limits.inputBytes || state.usage.outputTokens + outputTokens > this.limits.outputTokens) {
          this.refuse('daily_budget', (state.usage.oldest ?? now) + this.limits.windowMs);
        }
        // Reserve BEFORE transport; failures, cancellation and unknown usage are never refunded.
        this.db().run('DELETE FROM background_model_reservations WHERE started_at <= ?', [now - this.limits.windowMs]);
        this.db().run('INSERT INTO background_model_reservations(started_at,input_bytes,output_tokens) VALUES (?,?,?)', [now, inputBytes, outputTokens]);
      }).immediate();
    } catch (error) {
      if (error instanceof BackgroundThrottled) {
        if (error.reason === 'daily_budget' && error.retryAt !== null) {
          try { this.backoff('daily_budget', error.retryAt); } catch { /* Next admission fails closed. */ }
        }
        throw error;
      }
      this.refuse('budget_unavailable', null);
    }
    this.active++;
    let released = false;
    return { options: { ...options, max_tokens: outputTokens }, release: () => {
      if (!released) { released = true; this.active--; }
    } };
  }
  failed(error: unknown): void {
    const code = getLLMErrorCode(error);
    if (!['rate_limit', 'quota_exhausted', 'restricted', 'network', 'server', 'auth'].includes(code)) return;
    const retry = error instanceof LLMProviderError ? error.retryAfterMs : undefined;
    const delay = Math.min(this.limits.windowMs, Math.max(retry ?? 0,
      ['quota_exhausted', 'restricted', 'auth'].includes(code) ? 300_000 : 60_000));
    try {
      this.backoff('provider_backoff', this.now() + delay);
    } catch { /* The next reservation fails closed if the database went away. */ }
  }
}

let budget: BackgroundBudget | null = null;
/** Set once after vault startup. Shared by all managers in the daemon. */
export function setBackgroundBudget(value: BackgroundBudget | null): void { budget = value; }
export function backgroundBudgetStatus() {
  if (!budget) return { state: 'unavailable' as const, reason: 'not_configured', retryAt: null };
  try { return budget.snapshot(); }
  catch { return { state: 'unavailable' as const, reason: 'budget_unavailable', retryAt: null }; }
}

/** A provider-internal retry is another transport, not part of the first reservation. */
function acquireProviderLease(governor: BackgroundBudget, messages: LLMMessage[], options?: LLMOptions) {
  let lease = governor.acquire(messages, options);
  const reserveRetry = (retryOptions: LLMOptions): LLMOptions => {
    // The provider has settled its previous transport. Release only its slot;
    // the durable allowance stays spent. Admission rechecks all current limits.
    lease.release();
    retryOptions.checkDeadline?.();
    lease = governor.acquire(messages, retryOptions);
    return { ...lease.options, reserveRetry };
  };
  return { options: { ...lease.options, reserveRetry }, release: () => lease.release() };
}

export async function backgroundChat(provider: LLMProvider, messages: LLMMessage[], options?: LLMOptions) {
  const governor = currentOrigin() === 'background' ? budget : null;
  if (!governor) {
    const release = currentOrigin() === 'user' ? budget?.foregroundStarted() : undefined;
    try { return await provider.chat(messages, options); } finally { release?.(); }
  }
  const lease = acquireProviderLease(governor, messages, options);
  try { return await provider.chat(messages, lease.options); }
  catch (error) { governor.failed(error); throw error; }
  // Keep the slot until the actual transport settles, even if its caller stopped waiting.
  finally { lease.release(); }
}
export async function* backgroundStream(provider: LLMProvider, messages: LLMMessage[], options?: LLMOptions): AsyncIterable<LLMStreamEvent> {
  const governor = currentOrigin() === 'background' ? budget : null;
  if (!governor) {
    const release = currentOrigin() === 'user' ? budget?.foregroundStarted() : undefined;
    try { yield* provider.stream(messages, options); } finally { release?.(); }
    return;
  }
  const lease = acquireProviderLease(governor, messages, options);
  try {
    for await (const event of provider.stream(messages, lease.options)) {
      if (event.type === 'error') governor.failed(new LLMProviderError(event.error, event.code ?? 'unknown', event.retry_after_ms));
      yield event;
    }
  } catch (error) { governor.failed(error); throw error; }
  finally { lease.release(); }
}
