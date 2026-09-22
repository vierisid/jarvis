/**
 * Tool-relevance filter policy and the kill switch.
 *
 * #483 defect 3: #475's `toolFilterEnabled` was a private field with no
 * setter, no config key and no env var -- `{ enabled: false }` was reachable
 * only from its own test. There was no way to turn the filter off in a
 * running product. This module is the answer, and it has three properties
 * that matter more than its size:
 *
 *   1. The hard-coded initial value is OFF. Every path that is not wired to
 *      the daemon -- tests, scripts, a standalone sub-agent runner -- is
 *      unfiltered unless it deliberately opts in.
 *   2. `JARVIS_TOOL_FILTER=off` beats everything, including the config file.
 *      That is the switch an operator reaches for at 3am.
 *   3. Only the POLICY is frozen at boot. Model eligibility is resolved per
 *      call (see model-class.ts), because the `llm` section is hot-reloadable
 *      and a boot-time snapshot of which model a tier points at goes stale
 *      the moment someone remaps a tier in the dashboard.
 */

import type { JarvisConfig } from '../../../config/types.ts';

export type ToolFilterPolicy = {
  enabled: boolean;
  /** Parameter ceiling in billions for the ollama auto-eligibility rule. */
  maxParamsB: number;
  /** Explicit "provider:model" refs that are always eligible. */
  models: readonly string[];
};

export const DEFAULT_MAX_PARAMS_B = 20;

/** Off. Not a placeholder -- this is the shipped default (#483 requirement 6). */
export const DISABLED_POLICY: ToolFilterPolicy = Object.freeze({
  enabled: false,
  maxParamsB: DEFAULT_MAX_PARAMS_B,
  models: Object.freeze([]) as readonly string[],
});

let current: ToolFilterPolicy = DISABLED_POLICY;

export function getToolFilterPolicy(): ToolFilterPolicy {
  return current;
}

/** Set at daemon boot. Tests use this and must restore the previous value. */
export function setToolFilterPolicy(policy: ToolFilterPolicy): void {
  current = policy;
}

export function resetToolFilterPolicy(): void {
  current = DISABLED_POLICY;
}

/**
 * Read the env kill switch. `off` wins over everything; `on` forces the
 * filter on without a config file, which is what the benchmark harness uses.
 * Anything unrecognised is ignored rather than guessed at.
 */
export function envOverride(env: Record<string, string | undefined> = process.env): boolean | null {
  const raw = env.JARVIS_TOOL_FILTER;
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false;
  if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return true;
  console.warn(`[ToolFilter] Ignoring JARVIS_TOOL_FILTER="${raw}"; expected on|off.`);
  return null;
}

/**
 * Resolve the policy from config plus the environment.
 *
 * A malformed value disables rather than guesses: this switch decides whether
 * a security-relevant transformation runs, so "I could not read the config"
 * must mean off, never "probably they meant on".
 */
export function toolFilterPolicyFromConfig(
  config: Pick<JarvisConfig, 'tools'> | undefined,
  env: Record<string, string | undefined> = process.env,
): ToolFilterPolicy {
  const raw = config?.tools?.relevance_filter;
  const override = envOverride(env);

  // `off` short-circuits before anything else is read.
  if (override === false) return DISABLED_POLICY;

  const enabled = override === true || raw?.enabled === true;
  if (!enabled) return DISABLED_POLICY;

  const declared = raw?.max_params_b;
  const maxParamsB = typeof declared === 'number' && Number.isFinite(declared) && declared > 0
    ? declared
    : DEFAULT_MAX_PARAMS_B;

  const models = Array.isArray(raw?.models)
    ? raw.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim())
    : [];

  return { enabled: true, maxParamsB, models };
}
