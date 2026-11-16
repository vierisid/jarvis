/**
 * Inline credentials of HTTP and GraphQL steps outside the approval path
 * (#1153), and the zip steps' password. Those steps take a token, a password
 * or an API key as plain props (`redactHttpInput`, `redactZipPassword`), and the engine records each step's resolved input on
 * its step output, which the daemon keeps in run history (`flow_run.steps`)
 * and copies into a version's sample data. The approval card and the effect
 * record were already redacted; run history, sample data and the version the
 * model reads were not.
 *
 * Here: the same redaction on a run's recorded step inputs (and on the request
 * body a failed request echoes in its output and error), on a version's step
 * inputs, sample data and sample inputs as the model sees them, and the
 * inverse for a draft edit, so a value the model read back as `[redacted]`
 * and wrote back unchanged keeps the stored credential instead of replacing it
 * with the marker. An edit that would move a stored credential somewhere the
 * model can see it, or send it to another host, is refused
 * (`credentialEditRefusal`).
 */

import { walkFlowNodes } from '../db/flow-graph';
import type { FlowTriggerNode } from '../db/repos/flow-version';
import { GRAPHQL_PIECE, HTTP_PIECE, isSchemedCredential, isSecretName, REDACTED, redactCredentials, redactGraphqlInput, redactHttpInput } from './piece-effects';

type Redactor = (input: Record<string, unknown>) => Record<string, unknown>;

const FILE_HELPER_PIECE = '@activepieces/piece-file-helper';

/**
 * The zip steps' password (file-helper `zipFiles` and `unzipFile`), which they
 * take under `passwordOptions` once "Use password" is on.
 */
export function redactZipPassword(input: Record<string, unknown>): Record<string, unknown> {
  const options = input.passwordOptions;
  if (!object(options) || !('password' in options)) return input;
  const password = options.password;
  if (password === null || password === undefined || password === '') return input;
  return { ...input, passwordOptions: { ...options, password: REDACTED } };
}

/** Pieces whose props carry a credential inline, and what hides it. */
const CREDENTIAL_REDACTORS: ReadonlyMap<string, Redactor> = new Map<string, Redactor>([
  [HTTP_PIECE, redactHttpInput],
  [GRAPHQL_PIECE, redactGraphqlInput],
  [FILE_HELPER_PIECE, redactZipPassword],
]);

/**
 * The one action of those pieces whose output does not repeat its input:
 * `parse_url` returns the URL's query, fragment and path, so a credential in
 * the URL of such a step is shown by its output whatever its input reads.
 */
const SENDING_ACTION = 'send_request';

/** Whether a step's output leaves its credentials out, so its input is judged as the model reads it. */
const outputHidesCredentials = (settings: FlowTriggerNode['settings'] | undefined): boolean =>
  settings?.actionName === SENDING_ACTION || settings?.pieceName === FILE_HELPER_PIECE;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The redactor for a piece that takes credentials inline, or null. */
export function credentialRedactor(pieceName: unknown): Redactor | null {
  return typeof pieceName === 'string' ? CREDENTIAL_REDACTORS.get(pieceName) ?? null : null;
}

/**
 * An input shaped like an HTTP or GraphQL step's, for a recorded step the
 * graph no longer names (renamed or removed since): redacted by its shape.
 */
function looksLikeRequest(input: unknown): boolean {
  return object(input) && typeof input.url === 'string'
    && ['headers', 'queryParams', 'authFields', 'authType', 'body', 'proxy_settings', 'variables'].some((key) => key in input);
}

/** Step name -> redactor, for every step of the graph that takes credentials inline. */
function redactorsByStep(trigger: FlowTriggerNode | null | undefined): { byName: Map<string, Redactor>; names: Set<string> } {
  const byName = new Map<string, Redactor>();
  const names = new Set<string>();
  for (const node of walkFlowNodes(trigger)) {
    if (typeof node.name !== 'string') continue;
    names.add(node.name);
    const redact = credentialRedactor(node.settings?.pieceName);
    if (redact) byName.set(node.name, redact);
  }
  return { byName, names };
}

type Redactors = ReturnType<typeof redactorsByStep>;

/** A zip step's input: a password under `passwordOptions`. */
const looksLikeZip = (input: unknown): boolean => object(input) && object(input.passwordOptions) && 'password' in input.passwordOptions;

/** The redactor for a recorded step: by its graph node, else by its shape when the graph has no such step. */
function redactorFor(name: string, input: unknown, redactors: Redactors): Redactor | undefined {
  const named = redactors.byName.get(name);
  if (named) return named;
  if (redactors.names.has(name)) return undefined;
  if (looksLikeRequest(input)) return redactGraphqlInput;
  return looksLikeZip(input) ? redactZipPassword : undefined;
}

/**
 * A request body a failed request echoes: a form-data body (serialized as the
 * `form-data` stream, field values under `_streams`) hidden whole, since its
 * values carry no names a redactor can read; any other by its field names.
 */
function redactRequestBody(body: unknown): unknown {
  if (object(body) && ('_streams' in body || '_boundary' in body)) return REDACTED;
  return redactCredentials(body);
}

/**
 * The text a failed request leaves (`HttpError`: its message is the JSON of
 * `{ response, request: { body } }`): the request body's credential fields
 * redacted, parsed when it parses, as text otherwise.
 */
function redactErrorText(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (object(parsed) && object(parsed.request) && 'body' in parsed.request) {
      return JSON.stringify({ ...parsed, request: { ...parsed.request, body: redactRequestBody(parsed.request.body) } });
    }
  } catch { /* not JSON: redact as text */ }
  return redactCredentials(text) as string;
}

/** A step output (`{ type, status, input, output, errorMessage }`) with its credentials redacted. */
function redactStepOutput(name: string, step: Record<string, unknown>, redactors: Redactors, depth: number): Record<string, unknown> {
  let out = step;
  const redact = redactorFor(name, step.input, redactors);
  if (redact) {
    if (object(step.input)) out = { ...out, input: redact(step.input) };
    // A failure the step continued past returns `{ response, request: { body } }`,
    // and a failure it stopped on keeps the same as its error message.
    const output = step.output;
    if (object(output) && object(output.request) && 'body' in output.request) {
      out = { ...out, output: { ...output, request: { ...output.request, body: redactRequestBody(output.request.body) } } };
    }
    if (typeof step.errorMessage === 'string') out = { ...out, errorMessage: redactErrorText(step.errorMessage) };
  }
  // A loop records each iteration's steps under its own output.
  const inner = out.output;
  if (object(inner) && Array.isArray(inner.iterations)) {
    out = { ...out, output: { ...inner, iterations: inner.iterations.map((iteration) =>
      object(iteration) ? redactStepMap(iteration, redactors, depth + 1) : iteration) } };
  }
  return out;
}

function redactStepMap(steps: Record<string, unknown>, redactors: Redactors, depth: number): Record<string, unknown> {
  if (depth > 16) return steps;
  return Object.fromEntries(Object.entries(steps).map(([name, raw]) => {
    if (!object(raw)) return [name, raw];
    // The worker handler stores `{ output: StepOutput }`; the engine's own
    // state and older rows hold the StepOutput itself.
    const enveloped = Object.keys(raw).length === 1 && object(raw.output) && typeof raw.type !== 'string';
    if (enveloped) return [name, { output: redactStepOutput(name, raw.output as Record<string, unknown>, redactors, depth) }];
    return [name, redactStepOutput(name, raw, redactors, depth)];
  }));
}

/**
 * A run's recorded steps with the inline credentials of its HTTP and GraphQL
 * steps redacted, found by step name in the graph the run ran, or by shape
 * for a step that graph does not name. Idempotent.
 */
export function redactRunSteps<S extends Record<string, unknown> | null | undefined>(steps: S, trigger: FlowTriggerNode | null | undefined): S {
  if (!object(steps)) return steps;
  return redactStepMap(steps, redactorsByStep(trigger), 0) as S;
}

/**
 * Header names whose value is withheld, besides every name `isSecretName`
 * judges a credential's (`Authorization`, `Cookie`, `X-Api-Key`,
 * `X-Goog-Api-Key`, `X-Auth-Key`, `Stripe-Signature`, ...). Run-together
 * names it would miss (`X-Shopify-Hmac-Sha256`, `X-Hubsignature`), and the
 * Jarvis timestamp, which only means something next to its signature.
 */
const SECRET_HEADER_NAME = /token|secret|signature|password|hmac/iu;
const CREDENTIAL_HEADERS = new Set(['x-jarvis-timestamp']);
/** Names `isSecretName` takes for a credential (`key`) that only name a delivery. */
const DELIVERY_KEY_HEADERS = new Set(['idempotency-key', 'x-idempotency-key']);

/**
 * Whether a request header carries a credential: by name, in any case, or by
 * shape, a `Bearer x` or `Basic x` value under any name. One rule for the
 * webhook trigger, which withholds such headers from the trigger data it
 * builds, and for run history, which withholds them from rows stored before it did.
 */
export function isCredentialHeader(name: string, value: unknown): boolean {
  const key = name.toLowerCase();
  if (DELIVERY_KEY_HEADERS.has(key)) return false;
  return CREDENTIAL_HEADERS.has(key) || SECRET_HEADER_NAME.test(key) || isSecretName(key)
    || (typeof value === 'string' && isSchemedCredential(value));
}

/** Headers with every credential header's value replaced by `[redacted]`, names kept. */
export function redactHeaderRecord<V>(headers: Record<string, V>): Record<string, V | typeof REDACTED> {
  const out: Record<string, V | typeof REDACTED> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isCredentialHeader(name, value) ? REDACTED : value;
  }
  return out;
}

/** The Crypto piece's password generator: its output is a credential the workflow made. */
const PASSWORD_STEPS: ReadonlyMap<string, ReadonlySet<string>> = new Map([['@activepieces/piece-crypto', new Set(['generate-password'])]]);
/** A shown value is scrubbed of a secret found elsewhere in the run only when it is at least this long, so a short one cannot blank ordinary text. */
const SCRUB_MIN = 6;

/** Step names whose output is a generated password, at any depth of the graph. */
function passwordSteps(trigger: FlowTriggerNode | null | undefined): Set<string> {
  const names = new Set<string>();
  for (const node of walkFlowNodes(trigger)) {
    const actions = typeof node.settings?.pieceName === 'string' ? PASSWORD_STEPS.get(node.settings.pieceName) : undefined;
    if (typeof node.name === 'string' && actions?.has(String(node.settings?.actionName))) names.add(node.name);
  }
  return names;
}

/** Values that are not secrets however they are stored: placeholders a broken sender writes. */
const PLACEHOLDERS = new Set(['undefined', 'null', 'none', 'false', 'true', 'bearer', 'basic']);

/** Add one form of a secret, if it can be told from ordinary text. */
function addSecret(text: string, secrets: Set<string>): void {
  const trimmed = text.trim();
  if (trimmed.length < SCRUB_MIN || /^\d+$/u.test(trimmed) || PLACEHOLDERS.has(trimmed.toLowerCase()) || trimmed.includes(REDACTED)) return;
  secrets.add(trimmed);
  // As a later step may have sent it in a URL or a form body.
  const encoded = encodeURIComponent(trimmed);
  if (encoded !== trimmed) secrets.add(encoded);
}

/**
 * Note a secret for scrubbing elsewhere in the run: the whole value, the token
 * of a `Bearer x` value, each value of a `Cookie` header, and a signature
 * without its `sha256=` prefix. Numbers and placeholders are not noted, so a
 * timestamp or an `undefined` cannot blank ordinary text.
 */
function noteSecret(value: unknown, secrets: Set<string>, header?: string): void {
  if (typeof value !== 'string' || value === REDACTED) return;
  addSecret(value, secrets);
  const token = /^\s*\S+\s+(\S+)\s*$/u.exec(value)?.[1];
  // A credential header's `<scheme> <token>`, or a value shaped so.
  if (token && (header !== undefined || isSchemedCredential(value))) addSecret(token, secrets);
  if (header && /cookie/iu.test(header)) for (const pair of value.split(';')) addSecret(pair.slice(pair.indexOf('=') + 1), secrets);
  const signed = /^[a-z0-9-]{2,16}=(.+)$/iu.exec(value)?.[1];
  if (signed && header && /sig|hmac/iu.test(header)) addSecret(signed, secrets);
}

/** Every `_webhook.headers` in a value (trigger data, or a step that passed it on) with its credential headers withheld. */
function hideWebhookHeaders(value: unknown, secrets: Set<string>, depth: number): unknown {
  if (depth > 64) return value;
  if (Array.isArray(value)) {
    const out = value.map((item) => hideWebhookHeaders(item, secrets, depth + 1));
    return out.some((item, i) => item !== value[i]) ? out : value;
  }
  if (!object(value)) return value;
  const entries = Object.entries(value).map(([key, item]): [string, unknown] => {
    if (key === '_webhook' && object(item) && object(item.headers)) {
      // A timestamp is withheld by name but, a bare number, not looked for elsewhere (`addSecret`).
      for (const [name, header] of Object.entries(item.headers)) if (isCredentialHeader(name, header)) noteSecret(header, secrets, name);
      return [key, { ...item, headers: redactHeaderRecord(item.headers) }];
    }
    return [key, hideWebhookHeaders(item, secrets, depth + 1)];
  });
  return entries.some(([key, item]) => item !== value[key]) ? Object.fromEntries(entries) : value;
}

/** A step map (`{ name: StepOutput }` or the worker's `{ name: { output: StepOutput } }`) with generated passwords withheld, in loops too. */
function hidePasswords(steps: Record<string, unknown>, names: Set<string>, secrets: Set<string>, depth: number): Record<string, unknown> {
  if (depth > 16) return steps;
  const hideStep = (name: string, step: Record<string, unknown>): Record<string, unknown> => {
    let out = step;
    if (names.has(name) && 'output' in step && step.output !== null && step.output !== undefined && step.output !== REDACTED) {
      noteSecret(step.output, secrets);
      out = { ...out, output: REDACTED };
    }
    const inner = out.output;
    if (object(inner) && Array.isArray(inner.iterations)) {
      out = { ...out, output: { ...inner, iterations: inner.iterations.map((iteration) =>
        object(iteration) ? hidePasswords(iteration, names, secrets, depth + 1) : iteration) } };
    }
    return out;
  };
  return Object.fromEntries(Object.entries(steps).map(([name, raw]) => {
    if (!object(raw)) return [name, raw];
    const enveloped = Object.keys(raw).length === 1 && object(raw.output) && typeof raw.type !== 'string';
    return [name, enveloped ? { output: hideStep(name, raw.output as Record<string, unknown>) } : hideStep(name, raw)];
  }));
}

/**
 * Replaces each secret in text with `[redacted]`, in one pass whatever the
 * number of secrets: candidates are found by their first `SCRUB_MIN`
 * characters, longest first, so a run with thousands of generated passwords
 * costs a lookup per character, not a pass per password.
 */
export type Scrubber = (text: string) => string;
function scrubber(secrets: Iterable<string>): Scrubber | null {
  const byPrefix = new Map<string, string[]>();
  for (const secret of secrets) {
    const key = secret.slice(0, SCRUB_MIN);
    const list = byPrefix.get(key);
    if (list) list.push(secret); else byPrefix.set(key, [secret]);
  }
  if (byPrefix.size === 0) return null;
  for (const list of byPrefix.values()) list.sort((a, b) => b.length - a.length);
  return (text) => {
    if (text.length < SCRUB_MIN) return text;
    let out = '', from = 0;
    for (let i = 0; i + SCRUB_MIN <= text.length;) {
      const hit = byPrefix.get(text.slice(i, i + SCRUB_MIN))?.find((secret) => text.startsWith(secret, i));
      if (hit) { out += text.slice(from, i) + REDACTED; i += hit.length; from = i; } else i++;
    }
    return from === 0 ? text : out + text.slice(from);
  };
}

/** Every string in a value scrubbed; a part with nothing to scrub is returned as it is, the same object. */
export function scrubValue(value: unknown, scrub: Scrubber | null, depth = 0): unknown {
  if (!scrub || depth > 64) return value;
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) {
    const out = value.map((item) => scrubValue(item, scrub, depth + 1));
    return out.some((item, i) => item !== value[i]) ? out : value;
  }
  if (!object(value)) return value;
  const entries = Object.entries(value).map(([key, item]) => [key, scrubValue(item, scrub, depth + 1)] as const);
  return entries.some(([key, item]) => item !== value[key]) ? Object.fromEntries(entries) : value;
}

/**
 * A run's recorded steps (or a version's sample data) as a person or the
 * model is shown them. Read side only: the stored row keeps what the engine
 * needs, since a resumed run with no state backup rebuilds the steps the next
 * one reads from `flow_run.steps`. On top of `redactRunSteps`:
 *   - credential headers in any `_webhook.headers`, including trigger data
 *     stored before the webhook trigger withheld them (#1359);
 *   - the output of a password generator step (Crypto: Generate Password);
 *   - either value wherever else the run repeats it (a later step's input or
 *     output, the failed step's message), as written or URL-encoded, at
 *     least `SCRUB_MIN` long and not a bare number. A shorter generated
 *     password is withheld as its step's output only.
 * `failedMessage` is scrubbed of the same values. Idempotent.
 */
export function stepsAsShown<S extends Record<string, unknown> | null | undefined>(
  steps: S, trigger: FlowTriggerNode | null | undefined, failedMessage?: string,
): { steps: S; failedMessage: string | undefined; scrub: Scrubber | null } {
  if (!object(steps)) return { steps, failedMessage, scrub: null };
  const secrets = new Set<string>();
  const credentialed = redactRunSteps(steps, trigger) as Record<string, unknown>;
  const passwords = passwordSteps(trigger);
  const hidden = hideWebhookHeaders(passwords.size > 0 ? hidePasswords(credentialed, passwords, secrets, 0) : credentialed, secrets, 0);
  const scrub = scrubber(secrets);
  return { steps: scrubValue(hidden, scrub) as S, failedMessage: failedMessage === undefined || !scrub ? failedMessage : scrub(failedMessage), scrub };
}

/** A run as a person or the model is shown it: `stepsAsShown` over its steps and its failed step's message. */
export function runAsShown<R extends { steps: Record<string, unknown> | null; failedStep: { errorMessage?: string } | null }>(
  run: R, trigger: FlowTriggerNode | null | undefined,
): R {
  const shown = stepsAsShown(run.steps, trigger, run.failedStep?.errorMessage);
  return { ...run, steps: shown.steps,
    ...(run.failedStep && shown.failedMessage !== undefined ? { failedStep: { ...run.failedStep, errorMessage: shown.failedMessage } } : {}) };
}

/** What else a run's records must not show of the secrets its steps hold (its effect records): a scrubber, or null when there are none. */
export function runScrubber(run: { steps: Record<string, unknown> | null }, trigger: FlowTriggerNode | null | undefined): Scrubber | null {
  return stepsAsShown(run.steps, trigger).scrub;
}

/**
 * A sample-data entry the editor saves, with every value it was shown as
 * `[redacted]` (a generated password, an old webhook credential header) and
 * sent back unchanged put back from the stored entry, so saving a sample does
 * not store the marker in place of the captured value. Any other edit stands.
 */
export function restoreShownSample(
  version: { trigger: FlowTriggerNode; sampleData: Record<string, unknown> | null } | null, stepName: string, edited: unknown,
): unknown {
  const saved = version?.sampleData?.[stepName];
  if (!version?.sampleData || saved === undefined || edited === null) return edited;
  const shown = (stepsAsShown(version.sampleData, version.trigger).steps as Record<string, unknown>)[stepName];
  return restoreValue(edited, saved, shown, 0);
}

/**
 * A failed step's error message as the run keeps it: for an HTTP or GraphQL
 * step (or one the graph no longer names), the request body it echoes has its
 * credential fields redacted.
 */
export function redactFailedStepMessage(stepName: string, message: string, trigger: FlowTriggerNode | null | undefined): string {
  const { byName, names } = redactorsByStep(trigger);
  return byName.has(stepName) || !names.has(stepName) ? redactErrorText(message) : message;
}

/** A graph with every credential-taking step's `settings.input` redacted. */
export function redactGraphCredentials(trigger: FlowTriggerNode): FlowTriggerNode {
  const graph = structuredClone(trigger);
  for (const node of walkFlowNodes(graph)) {
    const redact = credentialRedactor(node.settings?.pieceName);
    if (redact && node.settings && object(node.settings.input)) node.settings.input = redact(node.settings.input);
  }
  return graph;
}

/**
 * A version as the model reads it: credential-taking steps' inputs, their
 * sample data (a recorded step output carries the input) and their sample
 * input overrides redacted, and the Webhook trigger's signing secret (#961)
 * replaced. Also what a draft's revision is computed over, so the revision
 * cannot be used to test a guess at a credential.
 */
export function versionAsModelSees<V extends { trigger?: unknown; sampleData?: unknown; sampleInput?: unknown }>(version: V): V {
  const trigger = version.trigger as FlowTriggerNode | undefined;
  if (!trigger || typeof trigger !== 'object') return version;
  const redactors = redactorsByStep(trigger);
  const graph = redactGraphCredentials(trigger);
  const input = graph.settings?.input;
  if (input && typeof input === 'object' && 'secret' in input && input.secret !== undefined && input.secret !== '') {
    // The scheme too: the save rules derive it from whether the secret is
    // already stored, so showing it would let a written guess be tested.
    const { signature_scheme: _scheme, ...rest } = input as Record<string, unknown>;
    graph.settings!.input = { ...rest, secret: REDACTED };
  }
  const out: V = { ...version, trigger: graph };
  if (object(version.sampleData)) (out as { sampleData: unknown }).sampleData = stepsAsShown(version.sampleData, trigger).steps;
  if (object(version.sampleInput)) {
    (out as { sampleInput: unknown }).sampleInput = Object.fromEntries(Object.entries(version.sampleInput).map(([name, value]) => {
      const redact = redactorFor(name, value, redactors);
      return [name, redact && object(value) ? redact(value) : value];
    }));
  }
  return out;
}

/**
 * Put back what the model could not see (#1153). Where the edited value is
 * exactly the redacted form of the saved one, and redaction changed it, the
 * saved value is kept: the model read `[redacted]` and wrote it back. Any
 * other edit stands.
 */
function restoreValue(edited: unknown, saved: unknown, shown: unknown, depth: number): unknown {
  if (depth > 64) return edited;
  // A non-string credential (a numeric token) is shown as the marker string too.
  if (typeof edited === 'string') return typeof shown === 'string' && edited === shown && shown !== saved ? saved : edited;
  if (Array.isArray(edited)) {
    if (!Array.isArray(saved) || !Array.isArray(shown)) return edited;
    return edited.map((item, i) => restoreValue(item, saved[i], shown[i], depth + 1));
  }
  if (object(edited)) {
    if (!object(saved) || !object(shown)) return edited;
    return Object.fromEntries(Object.entries(edited).map(([key, item]) =>
      [key, Object.hasOwn(saved, key) && Object.hasOwn(shown, key) ? restoreValue(item, saved[key], shown[key], depth + 1) : item]));
  }
  return edited;
}

/**
 * An edited graph with the stored credentials restored wherever the edit
 * carried their redacted form unchanged. Steps are matched by name and piece.
 */
export function restoreRedactedCredentials(saved: FlowTriggerNode, edited: FlowTriggerNode): FlowTriggerNode {
  const before = new Map<string, FlowTriggerNode>();
  for (const node of walkFlowNodes(saved)) if (credentialRedactor(node.settings?.pieceName)) before.set(node.name, node);
  const graph = structuredClone(edited);
  // The Webhook trigger's secret, which the model reads as the marker.
  const secret = saved.settings?.pieceName === 'webhook' ? saved.settings.input?.secret : undefined;
  if (typeof secret === 'string' && secret !== '' && graph.settings?.pieceName === 'webhook' && graph.settings.input?.secret === REDACTED) {
    graph.settings.input = { ...graph.settings.input, secret };
  }
  if (before.size === 0) return graph;
  for (const node of walkFlowNodes(graph)) {
    const redact = credentialRedactor(node.settings?.pieceName);
    const prior = before.get(node.name);
    if (!redact || !prior || prior.settings?.pieceName !== node.settings?.pieceName) continue;
    const savedInput = prior.settings?.input, input = node.settings?.input;
    if (!object(savedInput) || !object(input)) continue;
    node.settings!.input = restoreValue(input, savedInput, redact(savedInput), 0) as Record<string, unknown>;
  }
  return graph;
}

/**
 * The parts of `raw` that redaction replaced in `shown`: the text between the
 * markers' literal neighbours. `[redacted]` replaces a value whole, possibly
 * with the cut note after it, so what `shown` keeps around each marker is
 * found in `raw` in order and what lies between is the credential.
 */
function hiddenParts(raw: unknown, shown: unknown, out: Set<string>, depth = 0): void {
  if (depth > 64) return;
  if (typeof shown === 'string' && shown.includes(REDACTED)) {
    if (typeof raw !== 'string') { if (raw !== null && raw !== undefined) out.add(JSON.stringify(raw)); return; }
    const pieces = shown.split(REDACTED);
    let at = 0;
    for (let i = 0; i < pieces.length - 1; i++) {
      const start = raw.indexOf(pieces[i]!, at);
      if (start < 0) return;
      const from = start + pieces[i]!.length;
      const next = pieces[i + 1]!;
      // The next literal starts after the value; the last value runs to the end.
      const end = next === '' && i === pieces.length - 2 ? raw.length : raw.indexOf(next, from);
      if (end < 0) return;
      if (end > from) out.add(raw.slice(from, end));
      at = end;
    }
    return;
  }
  if (Array.isArray(shown) && Array.isArray(raw)) shown.forEach((item, i) => hiddenParts(raw[i], item, out, depth + 1));
  else if (object(shown) && object(raw)) for (const key of Object.keys(shown)) hiddenParts(raw[key], shown[key], out, depth + 1);
}

/** Every credential the saved graph's credential-taking steps hold, by step. */
function storedCredentials(saved: FlowTriggerNode): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const node of walkFlowNodes(saved)) {
    const redact = credentialRedactor(node.settings?.pieceName);
    const input = node.settings?.input;
    if (!redact || !object(input)) continue;
    const parts = new Set<string>();
    hiddenParts(input, redact(input), parts);
    if (parts.size > 0) out.set(node.name, parts);
  }
  return out;
}


/** A node without its subgraph links, with its input as the model would see it. */
function visibleNode(node: FlowTriggerNode): string {
  const { nextAction: _n, children: _c, firstLoopAction: _l, ...rest } = node as FlowTriggerNode & { firstLoopAction?: unknown; children?: unknown };
  const redact = credentialRedactor(node.settings?.pieceName);
  // Redacted only where the output does not repeat it: a parse_url step's output shows its URL.
  const hidden = redact && outputHidesCredentials(node.settings) && object(node.settings?.input);
  return JSON.stringify(hidden ? { ...rest, settings: { ...rest.settings, input: redact!(node.settings!.input!) } } : rest);
}

const markers = (value: unknown): number => (JSON.stringify(value ?? null).match(/\[redacted\]/gu) ?? []).length;

/** A node without its subgraph links, as JSON. */
const nodeText = (node: FlowTriggerNode | undefined): string => {
  if (!node) return '';
  const { nextAction: _n, children: _c, firstLoopAction: _l, ...rest } = node as FlowTriggerNode & { firstLoopAction?: unknown; children?: unknown };
  return JSON.stringify(rest);
};

const urlParts = (url: unknown): { origin: string | null; text: unknown } => {
  if (typeof url !== 'string') return { origin: null, text: url };
  try { const u = new URL(url.trim()); return { origin: `${u.protocol}//${u.host.toLowerCase()}`, text: url }; } catch { return { origin: null, text: url }; }
};

/**
 * Why a draft edit may not be saved, or null (#1153). The model's patches are
 * applied to the draft as it reads it (`versionAsModelSees`), so `written`
 * holds only what it wrote and the markers it read; `restored` is that with
 * the stored credentials put back (`restoreRedactedCredentials`). Only what
 * the restore put back is judged, never text the model wrote itself, so a
 * refusal cannot tell the model whether a guess of its own is a stored
 * credential. A step left exactly as saved is not judged at all.
 *   - A credential the restore put back may not end up where the model would
 *     see it: a field redaction no longer covers (a form field renamed away
 *     from a credential name), or a parse_url step, whose output shows its URL.
 *   - A step holding a restored credential may not change the scheme or host
 *     its request goes to, and a URL with no readable host (filled in at run
 *     time) may not change at all: a credential set up for one service is not
 *     sent to another.
 *   - No step may keep a marker the restore could not put back (in a changed
 *     URL or header value, or after the piece changed), which would store the
 *     marker in place of the credential.
 */
export function credentialEditRefusal(saved: FlowTriggerNode, written: FlowTriggerNode, restored: FlowTriggerNode): string | null {
  const stored = storedCredentials(saved);
  const json = (secret: string) => JSON.stringify(secret).slice(1, -1);
  const savedByName = new Map<string, FlowTriggerNode>();
  for (const node of walkFlowNodes(saved)) savedByName.set(node.name, node);
  const writtenByName = new Map<string, FlowTriggerNode>();
  for (const node of walkFlowNodes(written)) writtenByName.set(node.name, node);
  const all = [...stored.values()].flatMap((parts) => [...parts]);
  for (const node of walkFlowNodes(restored)) {
    const prior = savedByName.get(node.name);
    if (prior && nodeText(prior) === nodeText(node)) continue;
    const mine = writtenByName.get(node.name);
    const visible = visibleNode(node), wrote = mine ? visibleNode(mine) : '';
    if (all.some((secret) => visible.includes(json(secret)) && !wrote.includes(json(secret)))) {
      return `step "${node.name}" would show a stored credential the assistant may not see; leave its credential fields as they are, or ask the user to make this change in the workflow editor`;
    }
    const input = JSON.stringify(node.settings?.input ?? null), wroteInput = JSON.stringify(mine?.settings?.input ?? null);
    if (all.some((secret) => input.includes(json(secret)) && !wroteInput.includes(json(secret)))) {
      const now = urlParts(node.settings?.input?.url), before = urlParts(prior?.settings?.input?.url);
      if (now.origin === null || before.origin === null ? now.text !== before.text : now.origin !== before.origin) {
        return `step "${node.name}" would send its stored credentials to another address; ask the user to change the address in the workflow editor`;
      }
    }
    if (markers(node.settings?.input) > markers(prior?.settings?.input)) {
      return `step "${node.name}" would store ${REDACTED} in place of a credential the assistant cannot see; keep that value unchanged, or ask the user to edit it in the workflow editor`;
    }
  }
  return null;
}
