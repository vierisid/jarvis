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
 *
 * The labelled set grew when this became the filter in front of the log file
 * (src/util/log-file.ts): a log file is a durable artifact an operator hands
 * around, so the shapes jarvis's own dependencies put on a line matter even
 * where no call site demonstrably leaks one today. A review found these
 * passing through untouched: Telegram bot tokens (the exact
 * `bot<digits>:AA...` that src/comms/channels/telegram.ts puts in every request
 * URL), `ghp_`/`github_pat_`, `?token=`, `refresh_token=`, `client_secret:`,
 * `password=`, `https://user:pass@host`, `whsec_`, and `Cookie: session=`.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Credentials in a URL's userinfo. Runs first: the `user:pass` run would
  // otherwise be picked apart by the labelled patterns below.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}@/gi, '$1***redacted***@'],
  // Labelled secrets — keep the label so the message still says WHAT failed,
  // drop the value. Runs first so the label is consumed with its value.
  [/\b(api[-_]?key|authorization|x-api-key)(["'\s:=]+)(?:(?:bearer|basic|token)\s+)?[A-Za-z0-9._~+/=-]{12,}/gi, '$1$2***redacted***'],
  // The `key=value` / `key: value` forms: query strings, OAuth bodies, env
  // dumps, connection strings, JSON. The value class stops at a quote,
  // separator or bracket so only the value is eaten, not the rest of the line.
  [
    /\b(client[-_]?secret|refresh[-_]?token|access[-_]?token|id[-_]?token|auth[-_]?token|api[-_]?token|session[-_]?token|token|secret|password|passwd|passphrase|pwd)(["'\s]*[:=]["'\s]*)[^\s"'&,;)}\]]{6,}/gi,
    '$1$2***redacted***',
  ],
  // A Cookie / Set-Cookie header is a credential end to end, so the whole
  // value goes. The `name=` requirement keeps prose ("no cookie: found")
  // out of it.
  [/\b((?:set-)?cookie)(["'\s]*:\s*)[A-Za-z0-9_.-]{1,64}=[^\r\n]{1,4096}/gi, '$1$2***redacted***'],
  [/\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '***redacted***'],
  // Bare JWTs (three base64url segments) with no label at all — Vertex/Azure
  // bodies echo these unlabelled.
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}/g, '***redacted***'],
  // Known prefixes (ours included — sk-uj-… must never escape).
  [/\b(?:sk|gsk|xai|rk)[-_][A-Za-z0-9_-]{4,}/g, '***redacted***'],
  [/\bAIza[A-Za-z0-9_-]{10,}/g, '***redacted***'],
  [/\bAKIA[0-9A-Z]{12,}/g, '***redacted***'],
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, '***redacted***'],
  // GitHub: the fine-grained PAT form first, since `github_pat_` would
  // otherwise be left behind by the short-prefix pattern.
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***redacted***'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '***redacted***'],
  // Stripe-style webhook signing secrets.
  [/\bwhsec_[A-Za-z0-9_-]{8,}/g, '***redacted***'],
  // Telegram bot tokens: `<bot-id>:AA<base64url>`, optionally with the `bot`
  // prefix the Bot API wants in the path. Every telegram.ts request URL
  // carries one, so anything that logs a failing URL logs the token.
  [/\b(?:bot)?\d{6,16}:AA[A-Za-z0-9_-]{20,}/g, '***redacted***'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
