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
 * A key blocked for a provider-policy sanction answers exactly like an unpaid
 * one (401, blocked), so the proxy alone cannot tell "restricted" from "no
 * plan"; the caller passes the hosted usage meter's `restricted` field, which
 * the control plane reads from its own records.
 *
 * The error body carries NO reset timestamp (confirmed — none is ever sent);
 * the reset time lives on the proxy's `GET /key/info`, which the PROVIDER
 * fetches and hands in as `resetAt`. This function never parses times out of
 * bodies: it states a time only when explicitly given one.
 *
 * The `(status)` marker is preserved in every message. The retryable kinds
 * still lean on it (classifyErrorString reads 429/503 out of text), while the
 * kinds a retry cannot change travel with an explicit code: the provider turns
 * `kind` into an LLMProviderError, so nothing downstream has to guess.
 */

/** What a hosted failure means for the person, beyond its status code. */
export type HostedErrorKind =
  | 'quota_exhausted'
  | 'content_policy'
  | 'restricted'
  | 'model_not_in_plan'
  | 'inactive'
  | 'generic';

/** The hosted usage meter's restriction, exactly as the control plane serves it. */
export interface HostedRestriction {
  reason: 'content_policy' | 'account_suspended' | 'account_banned';
  /** Where to appeal (an address or URL), or null when none is configured. */
  contact: string | null;
}

export class HostedProxyError extends Error {
  constructor(
    message: string,
    readonly kind: HostedErrorKind,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HostedProxyError';
  }
}

/**
 * The reason the platform's safety gate attaches to a request it blocks; the
 * proxy answers 400 with it inside the error body. Matched as a marker rather
 * than by status: a plain 400 is an invalid request and must keep its own copy.
 */
export const CONTENT_POLICY_MARKER = 'usejarvis_content_policy';

/**
 * A denial of the MODEL rather than of the account. Some key shapes answer an
 * out-of-plan model with a 401 carrying this text, so it is recognised before
 * a 401 is read as "inactive" or "restricted" — and the provider uses it to
 * skip a meter read whose answer could not change the copy.
 */
export function isModelDenial(status: number, detail: string): boolean {
  const lower = detail.toLowerCase();
  return status === 403 || (lower.includes('model') && (lower.includes('not allowed') || lower.includes('invalid model')));
}

export function hostedProxyError(
  label: string,
  status: number,
  detail: string,
  resetAt?: Date | null,
  restricted?: HostedRestriction | null,
): HostedProxyError {
  const safe = redactSecrets(detail);
  const lower = safe.toLowerCase();

  if (lower.includes(CONTENT_POLICY_MARKER)) {
    // No body in the log either: the gate's reason can quote the very text it
    // blocked, and a daemon log is not where that should end up.
    console.warn(`[usejarvis] ${label} request blocked by the content policy (${status})`);
    return new HostedProxyError(
      `${label} error (${status}): this request was blocked by the Usejarvis AI content policy and was not processed.`,
      'content_policy',
      status,
    );
  }
  if (safe) console.warn(`[usejarvis] ${label} proxy error (${status}): ${safe.slice(0, 200)}`);
  if (isBudgetExhaustion(safe)) {
    const valid = resetAt && !Number.isNaN(resetAt.getTime());
    const resumes = valid
      ? ` (resumes ${String(resetAt.getUTCHours()).padStart(2, '0')}:${String(resetAt.getUTCMinutes()).padStart(2, '0')} UTC)`
      : '';
    return new HostedProxyError(
      `${label} error (${status}): your included AI usage is used up for this window${resumes}. ` +
        'It resumes automatically - the usage meter shows when.',
      'quota_exhausted',
      status,
    );
  }
  if (isModelDenial(status, safe)) {
    return new HostedProxyError(
      `${label} error (${status}): that model is not included in your plan.`,
      'model_not_in_plan',
      status,
    );
  }
  if (status === 401) {
    if (restricted) {
      return new HostedProxyError(`${label} error (${status}): ${restrictionCopy(restricted)}`, 'restricted', status);
    }
    return new HostedProxyError(
      `${label} error (${status}): Usejarvis AI is not active on this account - ` +
        'an active plan is required.',
      'inactive',
      status,
    );
  }
  // Invariant 2, enforced: the body NEVER rides along in user-facing copy —
  // even truncated-and-redacted, a CDN 502 page puts the hosted hostname in
  // its first line. Operators already have the full (redacted) body from the
  // console.warn above.
  return new HostedProxyError(
    `${label} error (${status}): the AI service could not process this request. It usually recovers on its own - try again shortly.`,
    'generic',
    status,
  );
}

/**
 * The sentence a restricted account is shown. The contact is admin-set text
 * from the control plane, validated there as one plain line; it is re-bounded
 * here anyway because it lands in a chat bubble.
 */
export function restrictionCopy(restricted: HostedRestriction): string {
  const why =
    restricted.reason === 'account_banned'
      ? 'Usejarvis AI is no longer available on this account.'
      : restricted.reason === 'account_suspended'
        ? 'Usejarvis AI is unavailable while this account is suspended.'
        : 'Usejarvis AI is restricted on this account for a usage-policy violation.';
  const contact = (restricted.contact ?? '').replace(/[\r\n\t<>]/g, ' ').trim().slice(0, 200);
  return `${why} To appeal, contact ${contact || 'support'}.`;
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

/**
 * Copy for an error a HOSTED realtime voice session reports.
 *
 * Invariant 2 above, for the websocket surface. The proxy relays the upstream
 * provider's realtime `error` events verbatim, so their text is the provider
 * talking about the PLATFORM's account, not the user's: "You have no credits
 * remaining. Add credits to continue using the API at <billing link>" reached
 * a tenant's chat this way (2026-09-14). Nothing in such a message is
 * something the user can act on, and the session ends whatever it says, so
 * one generic line is the whole answer. Operators keep the redacted original
 * in the daemon log, same as hostedProxyError.
 *
 * The session's own local failures (socket error, unparseable event) arrive
 * through the same sink and get the same copy, which is why the log line says
 * "session error" rather than blaming the proxy.
 */
export function hostedRealtimeError(detail: string): string {
  const safe = redactSecrets(detail);
  if (safe) console.warn(`[usejarvis] Usejarvis AI realtime session error: ${safe.slice(0, 200)}`);
  return 'Live voice stopped: the AI service could not process this request. It usually recovers on its own - try again shortly.';
}
