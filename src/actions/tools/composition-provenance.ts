import { createHash } from 'node:crypto';
import { PieceCatalog, type PieceCatalogEntry } from '../../workflows/runtime/piece-catalog';
import type { ComposeDeps } from './workflow-composer';

export type PlanningPolicy = 'baseline-v1' | 'deterministic-first-v1';
export const COMPOSER_PROMPT_VERSION = 'w8-1';
// Production keeps the baseline prompt until a hosted comparison measures
// deterministic-first against it; the evaluation passes a policy explicitly.
export const DEFAULT_PLANNING_POLICY: PlanningPolicy = 'baseline-v1';

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
  const planningPolicy = deps.planningPolicy ?? DEFAULT_PLANNING_POLICY;
  return {
    deps: { ...deps, ...environment, pieceRegistry: new PieceCatalog(entries), planningPolicy },
    provenance: { schemaVersion: 1, promptVersion: COMPOSER_PROMPT_VERSION, planningPolicy,
      catalogSha256: fingerprint(entries), environmentSha256: fingerprint(environment) },
  };
}

export function planningPrompt(system: string, policy: PlanningPolicy = DEFAULT_PLANNING_POLICY): string {
  if (policy === 'baseline-v1') return system;
  return system + '\n\n## Deterministic-first planning\n'
    + 'Use installed typed actions, templates, conditions, loops and deterministic transformations whenever they satisfy the job. '
    + 'Do not add an LLM or delegated-agent step for literal formatting, copying, arithmetic, filtering, routing or fixed messages. '
    + 'Use AI only where the request needs interpretation, classification, extraction from unstructured language or summarization; keep that step narrowly scoped. '
    + 'Preserve the specified trigger, output, destination and negative constraints. Do not invent bindings, recipients or missing business rules. '
    + 'When required information or a supported capability is absent, report the blocker rather than substituting an unrelated routine.';
}
