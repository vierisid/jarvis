/**
 * Inline credentials of HTTP and GraphQL steps outside the approval path
 * (#1153). Those steps take a token, a password or an API key as plain props
 * (`redactHttpInput`), and the engine records each step's resolved input on
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
import { GRAPHQL_PIECE, HTTP_PIECE, REDACTED, redactCredentials, redactGraphqlInput, redactHttpInput } from './piece-effects';

type Redactor = (input: Record<string, unknown>) => Record<string, unknown>;

/** Pieces whose props carry a credential inline, and what hides it. */
const CREDENTIAL_REDACTORS: ReadonlyMap<string, Redactor> = new Map<string, Redactor>([
  [HTTP_PIECE, redactHttpInput],
  [GRAPHQL_PIECE, redactGraphqlInput],
]);

/**
 * The one action of those pieces whose output does not repeat its input:
 * `parse_url` returns the URL's query, fragment and path, so a credential in
 * the URL of such a step is shown by its output whatever its input reads.
 */
const SENDING_ACTION = 'send_request';

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

/** The redactor for a recorded step: by its graph node, else by its shape when the graph has no such step. */
function redactorFor(name: string, input: unknown, redactors: Redactors): Redactor | undefined {
  const named = redactors.byName.get(name);
  if (named) return named;
  return !redactors.names.has(name) && looksLikeRequest(input) ? redactGraphqlInput : undefined;
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
      return JSON.stringify({ ...parsed, request: { ...parsed.request, body: redactCredentials(parsed.request.body) } });
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
      out = { ...out, output: { ...output, request: { ...output.request, body: redactCredentials(output.request.body) } } };
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
    graph.settings!.input = { ...input, secret: REDACTED };
  }
  const out: V = { ...version, trigger: graph };
  if (object(version.sampleData)) (out as { sampleData: unknown }).sampleData = redactStepMap(version.sampleData, redactors, 0);
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
  if (before.size === 0) return edited;
  const graph = structuredClone(edited);
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

const urlHost = (url: unknown): string | null => {
  if (typeof url !== 'string') return null;
  try { return new URL(url.trim()).host.toLowerCase(); } catch { return null; }
};

/** A node without its subgraph links, with its input as the model would see it. */
function visibleNode(node: FlowTriggerNode): string {
  const { nextAction: _n, children: _c, firstLoopAction: _l, ...rest } = node as FlowTriggerNode & { firstLoopAction?: unknown; children?: unknown };
  const redact = credentialRedactor(node.settings?.pieceName);
  // Redacted only where it is still a request: a parse_url step's output shows its URL.
  const hidden = redact && node.settings?.actionName === SENDING_ACTION && object(node.settings.input);
  return JSON.stringify(hidden ? { ...rest, settings: { ...rest.settings, input: redact!(node.settings!.input!) } } : rest);
}

const markers = (value: unknown): number => (JSON.stringify(value ?? null).match(/\[redacted\]/gu) ?? []).length;

/**
 * Why a draft edit may not be saved, or null (#1153). The model reads
 * credential-taking steps redacted, and its edit is checked against the saved
 * draft's stored credentials:
 *   - none may end up where the model would see it: in a step that no longer
 *     takes credentials (its piece changed), in a parse_url step (its output
 *     shows the URL), or in a field redaction no longer covers (a form field
 *     renamed away from a credential name);
 *   - a step still holding one may not be pointed at another host, which would
 *     send a credential set up for one service to another;
 *   - no step may keep the marker where the saved draft held a credential
 *     (an edit that kept `[redacted]` inside a changed URL or header value),
 *     which would replace the credential with the marker.
 * Credentials shorter than four characters are matched only in the step that
 * held them, since a short string recurs by chance anywhere else.
 */
export function credentialEditRefusal(saved: FlowTriggerNode, edited: FlowTriggerNode): string | null {
  const stored = storedCredentials(saved);
  const savedByName = new Map<string, FlowTriggerNode>();
  for (const node of walkFlowNodes(saved)) savedByName.set(node.name, node);
  // Matched as they appear inside JSON text.
  const json = (secret: string) => JSON.stringify(secret).slice(1, -1);
  const all = [...stored.values()].flatMap((parts) => [...parts]);
  for (const node of walkFlowNodes(edited)) {
    const own = stored.get(node.name) ?? new Set<string>();
    const visible = visibleNode(node);
    if (all.some((secret) => (secret.length >= 4 || own.has(secret)) && visible.includes(json(secret)))) {
      return `step "${node.name}" would show a stored credential the assistant may not see; leave its piece, action and credential fields unchanged, or ask the user to make this change in the workflow editor`;
    }
    const input = JSON.stringify(node.settings?.input ?? null);
    const prior = savedByName.get(node.name);
    if ([...own].some((secret) => input.includes(json(secret))) && urlHost(node.settings?.input?.url) !== urlHost(prior?.settings?.input?.url)) {
      return `step "${node.name}" would send its stored credentials to another host; ask the user to change the address in the workflow editor`;
    }
    if (credentialRedactor(node.settings?.pieceName) && markers(node.settings?.input) > markers(prior?.settings?.input)) {
      return `step "${node.name}" would store ${REDACTED} in place of a credential the assistant cannot see; keep that value unchanged, or ask the user to edit it in the workflow editor`;
    }
  }
  return null;
}
