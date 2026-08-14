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
 * Branch ORDER matters: LiteLLM denies an out-of-plan model with a 401 "not
 * allowed to access model", so the model check MUST precede the generic auth
 * branch — otherwise a paying user who picks a model outside their plan is
 * told their subscription is inactive.
 *
 * The `(status)` marker is preserved because classifyErrorString keys retry
 * behaviour on it (429/503 retry; 400s do not).
 */
export function hostedProxyError(label: string, status: number, detail: string): Error {
  const safe = redactSecrets(detail);
  const lower = safe.toLowerCase();
  if (safe) console.warn(`[usejarvis] ${label} proxy error (${status}): ${safe.slice(0, 200)}`);

  if (lower.includes('budget') && (lower.includes('exceed') || lower.includes('over'))) {
    return new Error(
      `${label} error (${status}): your included AI usage is used up ` +
        `${describeBudgetWindow(safe)}. It resumes automatically - the usage meter shows when.`,
    );
  }
  if (lower.includes('model') && (lower.includes('not allowed') || lower.includes('invalid model'))) {
    return new Error(`${label} error (${status}): that model is not included in your plan.`);
  }
  if (status === 401 || status === 403) {
    return new Error(
      `${label} error (${status}): Usejarvis AI is not active on this account - ` +
        'an active plan is required.',
    );
  }
  // Truncated: an unbounded body is how a CDN error page (hostname included)
  // reaches a chat bubble.
  return new Error(`${label} error (${status})${safe ? `: ${safe.slice(0, 120)}` : ''}`);
}

/**
 * Turn a proxy budget body into the window phrase the friendly copy promises.
 * LiteLLM reports `budget_duration` and `budget_reset_at` on an exhausted key,
 * and the reset lands on a FIXED clock boundary (a 6h window minted
 * mid-morning resets at 12:00:00+00:00), so "resumes at 12:00 UTC" is exact
 * rather than approximate. Degrades to the generic phrase when the proxy omits
 * the fields — never guesses a time it was not told.
 *
 * Only the duration and timestamp are lifted out; the rest of the body stays
 * out of user-facing copy (it can carry the hosted hostname).
 */
export function describeBudgetWindow(body: string): string {
  const duration = body.match(/budget_duration["'\s:=]+([0-9]+[a-z]+)/i)?.[1];
  const resetAt = body.match(/budget_reset_at["'\s:=]+([0-9T:.+\-]{10,40})/i)?.[1];
  const window = duration ? `for this ${duration} window` : 'for this window';
  if (!resetAt) return window;
  const parsed = new Date(resetAt);
  if (Number.isNaN(parsed.getTime())) return window;
  const hh = String(parsed.getUTCHours()).padStart(2, '0');
  const mm = String(parsed.getUTCMinutes()).padStart(2, '0');
  return `${window} (resumes ${hh}:${mm} UTC)`;
}
