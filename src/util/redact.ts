/**
 * Redact credential-shaped material from text that is about to reach a log,
 * an API response, or a chat bubble.
 *
 * Why this exists: the hosted proxy's error bodies can echo the bearer we
 * presented, and that per-account key is deliberately hidden from every other
 * surface (settings responses, the catalog route, the provider test
 * endpoint). Upstream providers' own auth errors can likewise echo THEIR
 * keys back through the proxy, so the pattern covers the common prefixes
 * rather than only ours.
 *
 * ONE definition on purpose: three copies drifted apart once already.
 */
const CREDENTIAL_RE = /\b(?:sk|gsk|xai|rk)[-_][A-Za-z0-9_-]{4,}|\bAIza[A-Za-z0-9_-]{10,}/g;

export function redactSecrets(text: string): string {
  return text.replace(CREDENTIAL_RE, '***redacted***');
}
