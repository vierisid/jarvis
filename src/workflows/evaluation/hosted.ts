import { UsejarvisAIProvider } from '../../llm/usejarvis';
import { LLMProviderError } from '../../llm/provider';
import type { TransportAttempt } from './types';

export interface HostedProfile {
  id: string; version: string; intendedModel: string;
  baseUrl: string; apiKeyEnv: string; routingEvidence: string;
  rates?: { source: string; asOf: string; inputUsdPerMillion: number; cachedInputUsdPerMillion: number; outputUsdPerMillion: number };
}
export function validateProfile(value: unknown): HostedProfile {
  const p = value as HostedProfile;
  for (const key of ['id', 'version', 'intendedModel', 'baseUrl', 'apiKeyEnv', 'routingEvidence'] as const)
    if (typeof p?.[key] !== 'string' || !p[key].trim()) throw new Error('Profile requires ' + key);
  const url = new URL(p.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Hosted profile requires a credential-free HTTPS URL');
  if (!/^[A-Z][A-Z0-9_]*$/.test(p.apiKeyEnv)) throw new Error('apiKeyEnv must name an environment variable');
  if (p.rates && (typeof p.rates.source !== 'string' || !p.rates.source.trim()
    || typeof p.rates.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.rates.asOf)
    || !Number.isFinite(Date.parse(p.rates.asOf)) ||
    ['inputUsdPerMillion', 'cachedInputUsdPerMillion', 'outputUsdPerMillion'].some(k =>
      !Number.isFinite((p.rates as any)[k]) || (p.rates as any)[k] < 0))) throw new Error('Invalid dated pricing evidence');
  return p;
}

/** Instruments the same hosted provider used by Jarvis. Every actual POST,
 * including provider-internal retries, consumes the run-wide request limit. */
export class MeasuredHostedProvider extends UsejarvisAIProvider {
  readonly attempts: TransportAttempt[] = [];
  constructor(url: string, private readonly evaluationKey: string, readonly maxRequests: number, private readonly onEvent?: (event: unknown) => void) {
    super(url, evaluationKey);
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000) throw new Error('maxRequests must be 1..1000');
  }
  protected override async postChat(body: Record<string, unknown>, base?: string, signal?: AbortSignal, checkDeadline?: () => void): Promise<Response> {
    checkDeadline?.(); signal?.throwIfAborted();
    if (this.attempts.length >= this.maxRequests) throw new LLMProviderError('Evaluation request budget exhausted', 'quota_exhausted');
    const row: TransportAttempt = { index: this.attempts.length + 1, status: null, elapsedMs: 0, requestedModel: typeof body.model === 'string' ? body.model : null, reportedModel: null, usage: null };
    this.attempts.push(row);
    this.onEvent?.({ type: 'transport_started', attempt: { ...row } });
    const start = performance.now();
    try {
      const response = await super.postChat(body, base, signal, checkDeadline);
      row.status = response.status;
      try {
        const data = await response.clone().json() as any;
        row.reportedModel = typeof data.model === 'string' ? data.model : null;
        const u = data.usage, cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
        // Missing usage on errors/timeouts is unknown, not a zero-cost call.
        if (response.ok && [u?.prompt_tokens, u?.completion_tokens, cached].every(n => Number.isSafeInteger(n) && n >= 0)
          && cached <= u.prompt_tokens && !u.cache_creation_input_tokens) {
          row.usage = { input: u.prompt_tokens - cached, output: u.completion_tokens, cachedInput: cached };
        }
      } catch { /* preserve an unreadable response for the provider to classify */ }
      return response;
    } catch (error) {
      row.error = String(error).replaceAll(this.evaluationKey, '[REDACTED]');
      throw error;
    } finally { row.elapsedMs = performance.now() - start; this.onEvent?.({ type: 'transport_finished', attempt: row }); }
  }
}
export function estimatedCost(attempts: TransportAttempt[], profile?: HostedProfile) {
  const complete = attempts.length > 0 && attempts.every(a => a.usage !== null);
  const applicable = complete && profile?.rates && attempts.every(a => a.reportedModel !== null && !a.reportedModel.startsWith('uj-') && a.reportedModel === profile.intendedModel);
  return { complete, usd: applicable ? attempts.reduce((sum, a) => {
    const u = a.usage!, r = profile!.rates!;
    return sum + (u.input * r.inputUsdPerMillion + u.cachedInput * r.cachedInputUsdPerMillion + u.output * r.outputUsdPerMillion) / 1_000_000;
  }, 0) : null };
}
