import { UsejarvisAIProvider } from '../../llm/usejarvis';
import { LLMProviderError } from '../../llm/provider';
import { fingerprint } from '../../actions/tools/composition-provenance';
import type { TransportAttempt, TransportStop } from './types';

/** The composer runs on the high tier; the hosted proxy names that slot `uj-high`. */
export const COMPOSITION_SLOT = 'high';
export const COMPOSITION_ALIAS = 'uj-' + COMPOSITION_SLOT;

/**
 * What an admin exported from the hosting control plane, unmodified:
 * `GET /api/llm/profiles` and `GET /api/llm/models`. Hosting stores no profile
 * revision, so the revision is the fingerprint of what the plan's profile
 * resolves to. Proxy fallbacks are stated explicitly, even when there are none.
 */
export interface AdminProfileEvidence {
  exportedAt: string; exportedBy: string;
  plan: { key: string; name: string };
  profileKey: string;
  proxyFallbacks: string[];
  profiles: unknown[]; models: unknown[];
}
export interface ResolvedProfileEvidence {
  planKey: string; planName: string; profileKey: string; slot: string; modelKey: string; upstreamModel: string;
  reasoningEffort: string | null; proxyFallbacks: string[]; exportedAt: string; exportedBy: string; revisionSha256: string;
}
export interface HostedProfile {
  id: string; version: string; intendedModel: string;
  baseUrl: string; apiKeyEnv: string; routingEvidence: string;
  rates?: { source: string; asOf: string; inputUsdPerMillion: number; cachedInputUsdPerMillion: number; outputUsdPerMillion: number };
  admin?: AdminProfileEvidence;
}
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

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
  if (p.admin !== undefined) resolveAdminEvidence(p);
  return p;
}

/** Resolves plan -> profile -> composition slot -> upstream model from the
 * export alone, and refuses a profile whose declared model is not what the
 * export says the slot serves. */
export function resolveAdminEvidence(profile: HostedProfile): ResolvedProfileEvidence {
  const a = profile.admin;
  if (!a) throw new Error('Profile has no admin evidence');
  if (!text(a.exportedBy) || !text(a.exportedAt) || !Number.isFinite(Date.parse(a.exportedAt)))
    throw new Error('Admin evidence requires exportedBy and an exportedAt timestamp');
  if (!text(a.plan?.key) || !text(a.plan?.name) || !text(a.profileKey)) throw new Error('Admin evidence requires the plan and its profile key');
  if (!Array.isArray(a.proxyFallbacks) || !a.proxyFallbacks.every(text))
    throw new Error('Admin evidence must list proxy fallbacks explicitly; use [] when none are configured');
  if (!Array.isArray(a.profiles) || !Array.isArray(a.models)) throw new Error('Admin evidence requires the profiles and models exports');
  const matches = a.profiles.filter((row: any) => row?.key === a.profileKey);
  const chosen = matches[0] as any;
  if (matches.length !== 1 || chosen.active !== true || !chosen.slots || typeof chosen.slots !== 'object')
    throw new Error('Admin evidence must contain exactly one active profile ' + a.profileKey);
  const models = new Map<string, any>();
  for (const row of a.models as any[]) if (text(row?.id)) models.set(row.id, row);
  const resolved: Record<string, unknown> = {};
  for (const slot of Object.keys(chosen.slots).sort()) {
    const model = models.get(chosen.slots[slot]);
    if (!model || !text(model.key) || !text(model.upstreamModel)) throw new Error('Profile slot ' + slot + ' references a model missing from the export');
    resolved[slot] = { key: model.key, upstreamModel: model.upstreamModel, modality: model.modality ?? null, active: model.active ?? null,
      reasoningEffort: model.reasoningEffort ?? null, pricing: model.pricing ?? null, updatedAt: model.updatedAt ?? null };
  }
  const slot = resolved[COMPOSITION_SLOT] as any;
  if (!slot || slot.active !== true || slot.modality !== 'chat') throw new Error('Profile ' + a.profileKey + ' has no active chat model in the ' + COMPOSITION_SLOT + ' slot');
  if (slot.upstreamModel !== profile.intendedModel)
    throw new Error('intendedModel ' + profile.intendedModel + ' is not the ' + COMPOSITION_SLOT + ' slot model in the export (' + slot.upstreamModel + ')');
  return { planKey: a.plan.key, planName: a.plan.name, profileKey: a.profileKey, slot: COMPOSITION_SLOT, modelKey: slot.key,
    upstreamModel: slot.upstreamModel, reasoningEffort: slot.reasoningEffort, proxyFallbacks: [...a.proxyFallbacks],
    exportedAt: a.exportedAt, exportedBy: a.exportedBy,
    revisionSha256: fingerprint({ profile: { key: chosen.key, rank: chosen.rank ?? null, active: chosen.active, slots: resolved },
      proxyFallbacks: a.proxyFallbacks }) };
}

export function tokensUsed(attempts: TransportAttempt[]): number {
  return attempts.reduce((sum, a) => sum + (a.usage ? a.usage.input + a.usage.cachedInput + a.usage.output : 0), 0);
}

const STOP_MESSAGES: Record<TransportStop['reason'], string> = {
  request_budget: 'Evaluation request budget exhausted',
  token_budget: 'Evaluation token budget exhausted',
  unaccounted_usage: 'Evaluation stopped: a successful response reported no usage, so spend can no longer be counted',
  routing_fallback: 'Evaluation refuses to send this request to a different alias than the profile under test',
};

/** Instruments the same hosted provider used by Jarvis. Every actual POST,
 * including provider-internal retries, consumes the run-wide request limit.
 * The token budget is checked before each POST against usage reported so
 * far, so one request in flight can exceed it by its own size. A pinned
 * alias turns the manager's silent fallback to the provider default into a
 * recorded stop instead of a row measured on another model. */
export class MeasuredHostedProvider extends UsejarvisAIProvider {
  readonly attempts: TransportAttempt[] = [];
  readonly stops: TransportStop[] = [];
  constructor(url: string, private readonly evaluationKey: string, readonly maxRequests: number,
    private readonly onEvent?: (event: unknown) => void, readonly limits: { maxTokens?: number; pinnedModel?: string } = {}) {
    super(url, evaluationKey);
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000) throw new Error('maxRequests must be 1..1000');
    if (limits.maxTokens !== undefined && (!Number.isSafeInteger(limits.maxTokens) || limits.maxTokens < 1)) throw new Error('maxTokens must be a positive integer');
  }
  private refusal(model: string | null): TransportStop['reason'] | null {
    if (this.limits.pinnedModel !== undefined && model !== this.limits.pinnedModel) return 'routing_fallback';
    if (this.attempts.length >= this.maxRequests) return 'request_budget';
    if (this.limits.maxTokens !== undefined) {
      if (this.attempts.some(a => a.status !== null && a.status >= 200 && a.status < 300 && a.usage === null)) return 'unaccounted_usage';
      if (tokensUsed(this.attempts) >= this.limits.maxTokens) return 'token_budget';
    }
    return null;
  }
  protected override async postChat(body: Record<string, unknown>, base?: string, signal?: AbortSignal, checkDeadline?: () => void): Promise<Response> {
    checkDeadline?.(); signal?.throwIfAborted();
    const requestedModel = typeof body.model === 'string' ? body.model : null;
    const refusal = this.refusal(requestedModel);
    if (refusal) {
      const stop: TransportStop = { reason: refusal, afterAttempts: this.attempts.length, requestedModel };
      this.stops.push(stop);
      this.onEvent?.({ type: 'transport_refused', stop });
      // 'forbidden' never fails over, so a refused fallback ends the call; budget stops keep the existing code.
      throw new LLMProviderError(STOP_MESSAGES[refusal], refusal === 'routing_fallback' ? 'forbidden' : 'quota_exhausted');
    }
    const row: TransportAttempt = { index: this.attempts.length + 1, status: null, elapsedMs: 0, requestedModel, reportedModel: null, usage: null };
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
