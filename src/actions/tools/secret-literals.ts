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
  ['an API key', /(?<![A-Za-z0-9])sk-(?=[A-Za-z0-9_-]{0,256}\d)[A-Za-z0-9_-]{16,}/g],
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
  // Bounded runs: an unbounded scheme made a long dotted string (`a.a.a...`)
  // quadratic, and the publish route runs this synchronously.
  ['a password inside a URL', /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@:{}]{1,256}:[^\s/@{}]{4,256}@/gi],
];
/**
 * A match that says it is not a real value: the AWS documentation key
 * (`AKIAIOSFODNN7EXAMPLE`), `sk-your-key-here-1`, `xxxx` runs and masked
 * values. Judged on the matched run only, so a real key elsewhere in the same
 * text is still found. Redaction still removes these: hiding a placeholder
 * costs nothing.
 */
const PLACEHOLDER = /example|placeholder|your|dummy|x{6,}|\*{4,}|redacted|removed/i;
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
    for (const match of text.matchAll(pattern)) if (!PLACEHOLDER.test(match[0])) { kinds.push(kind); break; }
  }
  for (const match of text.matchAll(BEARER)) if (looksLikeToken(match[1]!) && !PLACEHOLDER.test(match[1]!)) { kinds.push('a bearer token'); break; }
  return kinds;
}

/** Keys that link a step to the steps after, inside or under it (as `walkFlowNodes` follows them). */
const NODE_LINKS = new Set(['nextAction', 'firstLoopAction']);

/**
 * The Webhook trigger's signing secret (#961) is a secret by design: it is
 * stored in the trigger, hidden from the model (`versionAsModelSees`), and the
 * assistant is told to generate one (`assistantWebhookSecretRefusal`). There is
 * no connection to move it to, so it is neither refused nor warned about.
 */
const isWebhookSecret = (node: Record<string, unknown> | null, path: string): boolean => {
  const settings = node?.settings;
  return path === 'settings.input.secret' && !!settings && typeof settings === 'object'
    && (settings as Record<string, unknown>).pieceName === 'webhook';
};

/** A long random value in a field named like a credential. Redaction takes placeholders too. */
const isFieldToken = (field: string | null, value: string): boolean =>
  field !== null && CREDENTIAL_FIELD.test(field) && !isExpression(value) && value.length >= MIN_FIELD_SECRET_LENGTH
  && !/\s/.test(value) && looksLikeToken(value);
const isFieldSecret = (field: string | null, value: string): boolean => isFieldToken(field, value) && !PLACEHOLDER.test(value);

interface FindOptions {
  /** A value that is already there and is not reported again (a draft edit judges what it adds). */
  known?: (value: string) => boolean;
}

/** Findings in a graph: step name and field path, never the value itself. */
export function findSecretLiterals(graph: unknown, options: FindOptions = {}): SecretFinding[] {
  const found: SecretFinding[] = [];
  const seen = new Set<string>();
  const add = (path: string, kind: string) => {
    const key = `${path}\u0000${kind}`;
    if (found.length < MAX_FINDINGS && !seen.has(key)) { seen.add(key); found.push({ path, kind }); }
  };
  // `node` is the step the value belongs to; `isNode` says the value itself is
  // a step (the root, a `trigger` under a composed plan's root, or a link), so
  // an input object that merely has `name` and `type` keys is not taken for one.
  const walk = (value: unknown, node: Record<string, unknown> | null, step: string, path: string,
    field: string | null, depth: number, isNode: boolean): void => {
    if (depth > MAX_DEPTH || found.length >= MAX_FINDINGS) return;
    if (typeof value === 'string') {
      if (isWebhookSecret(node, path) || options.known?.(value)) return;
      const where = `step "${step}" ${path}`.trim();
      for (const kind of shapeKinds(value)) add(where, kind);
      if (isFieldSecret(field, value)) add(where, 'a secret typed into a credential field');
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, node, step, `${path}[${index}]`, field, depth + 1, isNode && field === 'children'));
      return;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const own = isNode && typeof record.name === 'string' ? record.name : step;
      const self = isNode ? record : node;
      const base = isNode ? '' : path;
      for (const [key, child] of Object.entries(record)) {
        if (isNode && (NODE_LINKS.has(key) || key === 'children')) { walk(child, self, own, key === 'children' ? 'children' : '', key, depth + 1, true); continue; }
        // A composed plan is `{ displayName, trigger }`: its trigger is the first step.
        const childIsNode = depth === 0 && !isNode && key === 'trigger';
        walk(child, self, childIsNode ? 'trigger' : own, childIsNode ? '' : base ? `${base}.${key}` : key, key, depth + 1, childIsNode);
      }
    }
  };
  const root = graph && typeof graph === 'object' && !Array.isArray(graph) ? graph as Record<string, unknown> : null;
  walk(graph, null, 'trigger', '', null, 0, !!root && typeof root.name === 'string' && 'type' in root);
  return found;
}

/**
 * Secrets a new graph holds that the saved one did not: what an edit adds.
 * A value already in the saved graph (anywhere: an edit may move or rename
 * a step) is the person's own and is left to the publish warning.
 */
export function findNewSecretLiterals(saved: unknown, next: unknown): SecretFinding[] {
  const values = new Set<string>();
  const collect = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (typeof value === 'string') values.add(value);
    else if (Array.isArray(value)) for (const item of value) collect(item, depth + 1);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item, depth + 1);
  };
  collect(saved, 0);
  return findSecretLiterals(next, { known: value => values.has(value) });
}

/**
 * What the model is told when its graph holds secrets: where, what, and what to
 * do instead. Names no value, so it is safe in logs, journals and the UI.
 */
export function secretLiteralFeedback(findings: readonly SecretFinding[]): string[] {
  return findings.map(({ path, kind }) =>
    `${path} contains ${kind} written into the workflow. Never put a key, token, password or private key in a step: `
    + 'use a connection for the service (the step\'s auth field) and reference it, or ask the person to add one in Connections. '
    + 'Where the step has no connection (a plain HTTP request, for one), leave the value empty so the person fills it in the editor. '
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
    `${path[0]!.toUpperCase()}${path.slice(1)} has ${kind} typed into it. It is stored as plain text in this workflow and can be copied into its run history. `
    + 'If the service can be added as a connection, use that instead and remove this value.');
}

/** A JSON string member: `"name": "value"`, bounded so a hostile text stays linear. */
const JSON_MEMBER = /"([^"\\\n]{1,64})"(\s*:\s*)"((?:[^"\\\n]|\\.){1,4096})"/g;

/**
 * Text with every secret-shaped run replaced, and the value of a JSON member
 * named like a credential when it is one: a model's raw reply holds the graph
 * as JSON text, and the credential-field rule must hold there too. For what is
 * stored in composition history.
 */
export function redactSecretText(text: string): string {
  let out = text;
  for (const [, pattern] of SHAPES) { pattern.lastIndex = 0; out = out.replace(pattern, '[secret removed]'); }
  out = out.replace(BEARER, (whole, token: string) => looksLikeToken(token) ? 'Bearer [secret removed]' : whole);
  return out.replace(JSON_MEMBER, (whole, name: string, colon: string, value: string) =>
    isFieldToken(name, value) ? `"${name}"${colon}"[secret removed]"` : whole);
}

/** A copy of the graph with secret literals replaced, by shape and by credential field. */
export function redactSecretLiterals<T>(graph: T): T {
  const walk = (value: unknown, field: string | null, depth: number): unknown => {
    if (depth > MAX_DEPTH) return value;
    if (typeof value === 'string') {
      const out = redactSecretText(value);
      return isFieldToken(field, out) ? '[secret removed]' : out;
    }
    if (Array.isArray(value)) return value.map(item => walk(item, field, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, walk(child, key, depth + 1)]));
    }
    return value;
  };
  return walk(graph, null, 0) as T;
}
