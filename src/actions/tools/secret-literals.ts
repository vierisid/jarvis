/**
 * Secret-shaped literals in a composed workflow.
 *
 * A step that needs a credential gets it from a Connection, which stores it
 * encrypted and hands it to the step at run time. A key typed into a step's
 * own fields is stored in plaintext in the workflow version, shown on screen,
 * and copied into every run's trigger and step logs. The composer is a model:
 * it will paste a key it was shown, or invent one that looks real.
 *
 * Detection is deliberately narrow so a normal workflow is never refused:
 *   - recognizable credential formats (vendor prefixes, JWTs, private keys,
 *     `Bearer <token>`, a password inside a URL), anywhere in a string, and
 *   - a long, high-entropy value in a field whose NAME says it is a credential
 *     (`apiKey`, `token`, `password`, `Authorization`...).
 * A value that holds an expression (`{{ ... }}`) is a reference, not a literal,
 * and is never flagged.
 */

export interface SecretFinding {
  /** Where: the step's name, then the field path inside it. Never the value. */
  path: string;
  /** What it looks like, in words a person can act on. */
  kind: string;
}

/** Shape patterns. Each has a name for the feedback and a replacement for redaction. */
const SHAPES: ReadonlyArray<readonly [kind: string, pattern: RegExp]> = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  // `sk-` keys (OpenAI, Anthropic, others): digits are required so a word such as `sk-learn-pipeline` is not one.
  ['an API key', /(?<![A-Za-z0-9])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}/g],
  ['an API key', /(?<![A-Za-z0-9])(?:gsk|xai)-[A-Za-z0-9_-]{20,}/g],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['a GitHub token', /\bgithub_pat_[A-Za-z0-9_]{30,}/g],
  ['a Slack token', /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['a Google access token', /\bya29\.[0-9A-Za-z._-]{20,}/g],
  ['a Stripe key', /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g],
  ['a webhook signing secret', /\bwhsec_[A-Za-z0-9]{16,}/g],
  ['a SendGrid key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  ['a GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['an npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['a Hugging Face token', /\bhf_[A-Za-z0-9]{30,}/g],
  ['a Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g],
  ['a signed token (JWT)', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['a password inside a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:{}]+:[^\s/@{}]{4,}@/gi],
];
/** `Bearer <token>`: only a real-looking token counts (see looksLikeToken). */
const BEARER = /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g;

/** Field names that say the value is a credential. */
const CREDENTIAL_FIELD = /^(?:x-?)?(?:api[-_ ]?key|apikey|(?:access|auth|bearer|refresh|session|api)?[-_ ]?token|(?:client[-_ ]?)?secret|password|passwd|passphrase|authorization|private[-_ ]?key)$/i;
const MIN_FIELD_SECRET_LENGTH = 20;
const MIN_FIELD_SECRET_ENTROPY = 3.5;
const MAX_FINDINGS = 10;
const MAX_DEPTH = 40;

const isExpression = (value: string): boolean => value.includes('{{');

/** Shannon entropy in bits per character. */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) { const p = count / value.length; bits -= p * Math.log2(p); }
  return bits;
}

/** Letters and digits mixed, random-looking: not a sentence, a word or a number. */
function looksLikeToken(value: string): boolean {
  return /\d/.test(value) && /[A-Za-z]/.test(value) && entropy(value) >= MIN_FIELD_SECRET_ENTROPY;
}

/** Credential kinds a single string holds, whatever field it is in. */
function shapeKinds(text: string): string[] {
  if (isExpression(text) && !/-----BEGIN/.test(text)) {
    // A string mixing an expression with a literal key is still a literal key:
    // look at the text with the expressions cut out.
    text = text.replace(/\{\{[\s\S]*?\}\}/g, ' ');
  }
  const kinds: string[] = [];
  for (const [kind, pattern] of SHAPES) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) kinds.push(kind);
  }
  for (const match of text.matchAll(BEARER)) if (looksLikeToken(match[1]!)) { kinds.push('a bearer token'); break; }
  return kinds;
}

/** Findings in a graph: step name and field path, never the value itself. */
export function findSecretLiterals(graph: unknown): SecretFinding[] {
  const found: SecretFinding[] = [];
  const seen = new Set<string>();
  const add = (path: string, kind: string) => {
    const key = `${path}\u0000${kind}`;
    if (found.length < MAX_FINDINGS && !seen.has(key)) { seen.add(key); found.push({ path, kind }); }
  };
  const walk = (value: unknown, step: string, path: string, field: string | null, depth: number): void => {
    if (depth > MAX_DEPTH || found.length >= MAX_FINDINGS) return;
    if (typeof value === 'string') {
      const where = `step "${step}" ${path}`.trim();
      for (const kind of shapeKinds(value)) add(where, kind);
      if (field !== null && CREDENTIAL_FIELD.test(field) && !isExpression(value) && value.length >= MIN_FIELD_SECRET_LENGTH
        && !/\s/.test(value) && looksLikeToken(value)) add(where, 'a secret typed into a credential field');
      return;
    }
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, step, `${path}[${index}]`, field, depth + 1)); return; }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      // A step node names itself; fields inside it are reported under that name.
      const own = typeof record.name === 'string' && ('type' in record) ? record.name : step;
      const base = own === step ? path : '';
      for (const [key, child] of Object.entries(record)) {
        if (key === 'nextAction' || key === 'children') { walk(child, own, key === 'children' ? 'children' : '', null, depth + 1); continue; }
        walk(child, own, base ? `${base}.${key}` : key, key, depth + 1);
      }
    }
  };
  walk(graph, 'trigger', '', null, 0);
  return found;
}

/**
 * What the model is told when its graph holds secrets: where, what, and what to
 * do instead. Names no value, so it is safe in logs, journals and the UI.
 */
export function secretLiteralFeedback(findings: readonly SecretFinding[]): string[] {
  return findings.map(({ path, kind }) =>
    `${path} contains ${kind} written into the workflow. Never put a key, token, password or private key in a step: `
    + 'use a connection for the service (the step\'s auth field) and reference it, or ask the person to add one in Connections. '
    + 'If the value is not a real secret, rephrase it so it does not look like one.');
}

/**
 * What a person is told at publish when a workflow they are putting live
 * already holds a secret. A warning, not a refusal: readiness is re-checked
 * every time a trigger fires, so refusing here would stop workflows that run
 * today.
 */
export function secretLiteralWarnings(graph: unknown): string[] {
  return findSecretLiterals(graph).map(({ path, kind }) =>
    `${path[0]!.toUpperCase()}${path.slice(1)} has ${kind} typed into it. It is stored as plain text in this workflow and its run history. `
    + 'Add the service as a connection and use that instead, then replace this value.');
}

/** Text with every secret-shaped run replaced. For what is stored in composition history. */
export function redactSecretText(text: string): string {
  let out = text;
  for (const [, pattern] of SHAPES) { pattern.lastIndex = 0; out = out.replace(pattern, '[secret removed]'); }
  return out.replace(BEARER, (whole, token: string) => looksLikeToken(token) ? 'Bearer [secret removed]' : whole);
}

/** A copy of the graph with secret literals replaced, by shape and by credential field. */
export function redactSecretLiterals<T>(graph: T): T {
  const walk = (value: unknown, field: string | null, depth: number): unknown => {
    if (depth > MAX_DEPTH) return value;
    if (typeof value === 'string') {
      let out = redactSecretText(value);
      if (field !== null && CREDENTIAL_FIELD.test(field) && !isExpression(out) && out.length >= MIN_FIELD_SECRET_LENGTH
        && !/\s/.test(out) && looksLikeToken(out)) out = '[secret removed]';
      return out;
    }
    if (Array.isArray(value)) return value.map(item => walk(item, field, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, walk(child, key, depth + 1)]));
    }
    return value;
  };
  return walk(graph, null, 0) as T;
}
