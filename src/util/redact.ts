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
 *
 * Prefix matching alone is not enough. The proxy fronts several upstreams,
 * and an auth failure echoed back from Bedrock, Vertex or Azure carries a
 * credential with NO recognizable prefix (`AKIA…`, a bare JWT, a 32-hex
 * api-key header). Those are caught by shape instead: an `Authorization:
 * Bearer <opaque>` run, or an `api[-_]key`-labelled value. The labelled forms
 * are matched before the bare-token form so the label itself is consumed.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Labelled secrets — keep the label so the message still says WHAT failed,
  // drop the value. Runs first so the label is consumed with its value.
  [/\b(api[-_]?key|authorization|x-api-key)(["'\s:=]+)(?:(?:bearer|basic|token)\s+)?[A-Za-z0-9._~+/=-]{12,}/gi, '$1$2***redacted***'],
  [/\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '***redacted***'],
  // Bare JWTs (three base64url segments) with no label at all — Vertex/Azure
  // bodies echo these unlabelled.
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}/g, '***redacted***'],
  // Known prefixes (ours included — sk-uj-… must never escape).
  [/\b(?:sk|gsk|xai|rk)[-_][A-Za-z0-9_-]{4,}/g, '***redacted***'],
  [/\bAIza[A-Za-z0-9_-]{10,}/g, '***redacted***'],
  [/\bAKIA[0-9A-Z]{12,}/g, '***redacted***'],
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, '***redacted***'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
