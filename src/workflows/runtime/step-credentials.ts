/**
 * Inline credentials of HTTP and GraphQL steps outside the approval path
 * (#1153). Those steps take a token, a password or an API key as plain props
 * (`redactHttpInput`), and the engine records each step's resolved input on
 * its step output, which the daemon keeps in run history (`flow_run.steps`)
 * and copies into a version's sample data. The approval card and the effect
 * record were already redacted; run history, sample data and the version the
 * model reads were not.
 *
 * Here: the same redaction on a run's recorded step inputs, on a version's
 * step inputs, sample data and sample inputs as the model sees them, and the
 * inverse for a draft edit, so a value the model read back as `[redacted]`
 * and wrote back unchanged keeps the stored credential instead of replacing it
 * with the marker.
 */

import { walkFlowNodes } from '../db/flow-graph';
import type { FlowTriggerNode } from '../db/repos/flow-version';
import { GRAPHQL_PIECE, HTTP_PIECE, redactGraphqlInput, redactHttpInput } from './piece-effects';

type Redactor = (input: Record<string, unknown>) => Record<string, unknown>;

/** Pieces whose props carry a credential inline, and what hides it. */
const CREDENTIAL_REDACTORS: ReadonlyMap<string, Redactor> = new Map<string, Redactor>([
  [HTTP_PIECE, redactHttpInput],
  [GRAPHQL_PIECE, redactGraphqlInput],
]);

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The redactor for a piece that takes credentials inline, or null. */
export function credentialRedactor(pieceName: unknown): Redactor | null {
  return typeof pieceName === 'string' ? CREDENTIAL_REDACTORS.get(pieceName) ?? null : null;
}

/** Step name -> redactor, for every step of the graph that takes credentials inline. */
function redactorsByStep(trigger: FlowTriggerNode | null | undefined): Map<string, Redactor> {
  const out = new Map<string, Redactor>();
  for (const node of walkFlowNodes(trigger)) {
    const redact = credentialRedactor(node.settings?.pieceName);
    if (redact && typeof node.name === 'string') out.set(node.name, redact);
  }
  return out;
}

/** A step output (`{ type, status, input, output }`) with its input redacted. */
function redactStepOutput(step: Record<string, unknown>, redact: Redactor | undefined, redactors: Map<string, Redactor>, depth: number): Record<string, unknown> {
  let out = step;
  if (redact && object(step.input)) out = { ...out, input: redact(step.input) };
  // A loop records each iteration's steps under its own output.
  const inner = step.output;
  if (object(inner) && Array.isArray(inner.iterations)) {
    out = { ...out, output: { ...inner, iterations: inner.iterations.map((iteration) =>
      object(iteration) ? redactStepMap(iteration, redactors, depth + 1) : iteration) } };
  }
  return out;
}

function redactStepMap(steps: Record<string, unknown>, redactors: Map<string, Redactor>, depth: number): Record<string, unknown> {
  if (depth > 16) return steps;
  return Object.fromEntries(Object.entries(steps).map(([name, raw]) => {
    if (!object(raw)) return [name, raw];
    const redact = redactors.get(name);
    // The worker handler stores `{ output: StepOutput }`; the engine's own
    // state and older rows hold the StepOutput itself.
    const enveloped = Object.keys(raw).length === 1 && object(raw.output) && typeof raw.type !== 'string';
    if (enveloped) return [name, { output: redactStepOutput(raw.output as Record<string, unknown>, redact, redactors, depth) }];
    return [name, redactStepOutput(raw, redact, redactors, depth)];
  }));
}

/**
 * A run's recorded steps with the inline credentials of its HTTP and GraphQL
 * steps redacted, found by step name in the graph the run ran. Idempotent.
 */
export function redactRunSteps<S extends Record<string, unknown> | null | undefined>(steps: S, trigger: FlowTriggerNode | null | undefined): S {
  if (!object(steps)) return steps;
  const redactors = redactorsByStep(trigger);
  if (redactors.size === 0) return steps;
  return redactStepMap(steps, redactors, 0) as S;
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
 * input overrides redacted.
 */
export function redactVersionCredentials<V extends { trigger?: unknown; sampleData?: unknown; sampleInput?: unknown }>(version: V): V {
  const trigger = version.trigger as FlowTriggerNode | undefined;
  if (!trigger || typeof trigger !== 'object') return version;
  const redactors = redactorsByStep(trigger);
  if (redactors.size === 0) return version;
  const out: V = { ...version, trigger: redactGraphCredentials(trigger) };
  if (object(version.sampleData)) (out as { sampleData: unknown }).sampleData = redactStepMap(version.sampleData, redactors, 0);
  if (object(version.sampleInput)) {
    (out as { sampleInput: unknown }).sampleInput = Object.fromEntries(Object.entries(version.sampleInput).map(([name, input]) => {
      const redact = redactors.get(name);
      return [name, redact && object(input) ? redact(input) : input];
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
  if (depth > 32) return edited;
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

const markers = (value: unknown): number => (JSON.stringify(value ?? null).match(/\[redacted\]/gu) ?? []).length;

/**
 * The step a draft edit would leave holding the redaction marker where the
 * saved draft held a credential (an edit that kept `[redacted]` inside a
 * changed URL or header value), or null. Such an edit would replace the
 * credential with the marker, so it is refused rather than saved.
 */
export function strandedRedaction(saved: FlowTriggerNode, restored: FlowTriggerNode): string | null {
  const before = new Map<string, FlowTriggerNode>();
  for (const node of walkFlowNodes(saved)) before.set(node.name, node);
  for (const node of walkFlowNodes(restored)) {
    if (!credentialRedactor(node.settings?.pieceName)) continue;
    if (markers(node.settings?.input) > markers(before.get(node.name)?.settings?.input)) return node.name;
  }
  return null;
}
