import { createHash } from 'node:crypto';
import { PieceCatalog, type PieceCatalogEntry } from '../../workflows/runtime/piece-catalog';
import type { ComposeDeps } from './workflow-composer';

export type PlanningPolicy = 'baseline-v1' | 'deterministic-first-v1';
export const PLANNING_POLICIES: readonly PlanningPolicy[] = ['baseline-v1', 'deterministic-first-v1'];
/** Bump with any change to the composer's own prompt text; a test pins the text to this version. */
export const COMPOSER_PROMPT_VERSION = 'w8-2';
// Production keeps the baseline prompt until a hosted comparison promotes
// deterministic-first (Q-03); the evaluation passes a policy explicitly.
export const DEFAULT_PLANNING_POLICY: PlanningPolicy = 'baseline-v1';

/**
 * What each policy adds to both composer prompts. A policy id names exactly
 * this text, so a changed instruction is a new id, never an edit: rollback
 * must select the prompt that was measured. A test pins each one.
 */
const POLICY_INSTRUCTIONS: Record<PlanningPolicy, string> = {
  'baseline-v1': '',
  'deterministic-first-v1': '\n\n## Deterministic-first planning\n'
    + 'Use installed typed actions, templates, conditions, loops and deterministic transformations whenever they satisfy the job. '
    + 'Do not add an LLM or delegated-agent step for literal formatting, copying, arithmetic, filtering, routing or fixed messages. '
    + 'Use AI only where the request needs interpretation, classification, extraction from unstructured language or summarization; keep that step narrowly scoped. '
    + 'Preserve the specified trigger, output, destination and negative constraints. Do not invent bindings, recipients or missing business rules. '
    + 'When required information or a supported capability is absent, report the blocker rather than substituting an unrelated routine.',
};

export const isPlanningPolicy = (value: unknown): value is PlanningPolicy => PLANNING_POLICIES.includes(value as PlanningPolicy);

let selectPolicy: () => PlanningPolicy = () => DEFAULT_PLANNING_POLICY;
/**
 * Install how production picks its policy. The daemon reads
 * JARVIS_PLANNING_POLICY, else the `workflows.planningPolicy` setting, at each
 * composition, so opting in or rolling back to the prior policy is a
 * configuration change, not a deploy. Null restores the default.
 */
export function configurePlanningPolicy(select: (() => PlanningPolicy) | null): void {
  selectPolicy = select ?? (() => DEFAULT_PLANNING_POLICY);
}
/** The policy a composition without an explicit one runs, read now. */
export function activePlanningPolicy(): PlanningPolicy {
  return selectPolicy();
}

/** Object key order is not a version change; array order is. */
export function fingerprint(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'null').digest('hex');
}

export interface CompositionProvenance {
  schemaVersion: 1;
  promptVersion: string;
  planningPolicy: PlanningPolicy;
  catalogSha256: string;
  environmentSha256: string;
}

/** Capture contracts once, so a catalog refresh cannot change a repair's world. */
export function snapshotComposition(deps: ComposeDeps): { deps: ComposeDeps; provenance: CompositionProvenance } {
  // PieceLookup also accepts the legacy executable registry. Its run/parse
  // handlers cannot be cloned. Copy the JSON metadata used by composer
  // prompts, keeping additional contract fields introduced by other PRs
  // (such as W3 requireAuth) instead of projecting a frozen list of keys.
  const entries = JSON.parse(JSON.stringify(deps.pieceRegistry.list())) as PieceCatalogEntry[];

  const environment = structuredClone({ tools: deps.tools, toolNames: deps.toolNames,
    specialistRoles: deps.specialistRoles, executionTargets: deps.executionTargets, library: deps.library });
  // Read once: every attempt and repair of this composition runs, and records, the same policy.
  const planningPolicy = deps.planningPolicy ?? activePlanningPolicy();
  return {
    deps: { ...deps, ...environment, pieceRegistry: new PieceCatalog(entries), planningPolicy },
    provenance: { schemaVersion: 1, promptVersion: COMPOSER_PROMPT_VERSION, planningPolicy,
      catalogSha256: fingerprint(entries), environmentSha256: fingerprint(environment) },
  };
}

/** Without an explicit policy, the active one: a direct caller of the composer still follows the selector. */
export function planningPrompt(system: string, policy: PlanningPolicy = activePlanningPolicy()): string {
  return system + POLICY_INSTRUCTIONS[policy];
}

/** Each policy's instruction text, for the test that pins it to its id. */
export function policyInstructions(): Readonly<Record<PlanningPolicy, string>> {
  return POLICY_INSTRUCTIONS;
}
