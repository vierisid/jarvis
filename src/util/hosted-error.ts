import { redactSecrets } from './redact.ts';

/**
 * Map a hosted-proxy error body into copy a user can act on.
 *
 * ONE definition for every hosted surface — chat, STT, TTS. They all talk to
 * the same LiteLLM proxy, so they all get the same budget/plan/model answers,
 * and a per-surface copy would drift (the voice providers shipped throwing
 * raw proxy JSON while chat had this mapping).
 *
 * Two invariants live here:
 *
 * 1. Redact FIRST. Proxy auth bodies can echo the bearer we presented, and the
 *    per-account key is deliberately hidden from every other surface.
 * 2. The proxy's own body never rides along in the returned copy. This is not
 *    a log-only channel — the message becomes a chat bubble or a settings
 *    toast — and an upstream body carries the hosted hostname that the
 *    settings surface and the catalog route both withhold. Operators get the
 *    original via console.warn instead.
 *
 * Status semantics, confirmed by the platform team (2026-08-19): 401 = bad or
 * blocked key, 403 = model not allowed (`team_model_access_denied`), 429 with
 * a budget_exceeded body = included usage exhausted. Some key shapes have
 * historically denied out-of-plan models with a 401 "not allowed to access
 * model" TEXT instead, so the model-text check still precedes the auth branch.
 *
 * The error body carries NO reset timestamp (confirmed — none is ever sent);
 * the reset time lives on the proxy's `GET /key/info`, which the PROVIDER
 * fetches and hands in as `resetAt`. This function never parses times out of
 * bodies: it states a time only when explicitly given one.
 *
 * The `(status)` marker is preserved because classifyErrorString keys retry
 * behaviour on it (429/503 retry; 400s do not).
 */
export function hostedProxyError(
  label: string,
  status: number,
  detail: string,
  resetAt?: Date | null,
): Error {
  const safe = redactSecrets(detail);
  const lower = safe.toLowerCase();
  if (safe) console.warn(`[usejarvis] ${label} proxy error (${status}): ${safe.slice(0, 200)}`);

  if (isBudgetExhaustion(safe)) {
    const valid = resetAt && !Number.isNaN(resetAt.getTime());
    const resumes = valid
      ? ` (resumes ${String(resetAt.getUTCHours()).padStart(2, '0')}:${String(resetAt.getUTCMinutes()).padStart(2, '0')} UTC)`
      : '';
    return new Error(
      `${label} error (${status}): your included AI usage is used up for this window${resumes}. ` +
        'It resumes automatically - the usage meter shows when.',
    );
  }
  if (status === 403 || (lower.includes('model') && (lower.includes('not allowed') || lower.includes('invalid model')))) {
    return new Error(`${label} error (${status}): that model is not included in your plan.`);
  }
  if (status === 401) {
    return new Error(
      `${label} error (${status}): Usejarvis AI is not active on this account - ` +
        'an active plan is required.',
    );
  }
  // Invariant 2, enforced: the body NEVER rides along in user-facing copy —
  // even truncated-and-redacted, a CDN 502 page puts the hosted hostname in
  // its first line. Operators already have the full (redacted) body from the
  // console.warn above.
  return new Error(`${label} error (${status}): the AI service could not process this request. It usually recovers on its own - try again shortly.`);
}

/**
 * Budget-exhaustion detector, shared with the provider layer (which uses it
 * to decide whether a `/key/info` reset-time lookup is worth making before
 * building the copy). Matches LiteLLM's `budget_exceeded` code and its
 * "ExceededBudget" / "budget has been exceeded" message family; an ordinary
 * rate limit ("rate limited") carries none of these words and stays on the
 * retryable generic branch.
 */
export function isBudgetExhaustion(detail: string): boolean {
  const lower = detail.toLowerCase();
  return lower.includes('budget') && (lower.includes('exceed') || lower.includes('over'));
}
