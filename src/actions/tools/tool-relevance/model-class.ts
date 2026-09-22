/**
 * Model eligibility: which models may have their tool list filtered.
 *
 * #483 requirement 1 -- frontier models unaffected. `tier` is in scope at the
 * text call sites and is currently ignored; here it is used for what it
 * actually is, a key into the tier map, and the CONCRETE MODEL it resolves to
 * is what gets classified. Tier alone is not a model class: an operator can
 * assign Opus to `low`.
 *
 * The polarity is the whole design. Only a model positively recognised as
 * small/local is eligible; anything unrecognised is treated as frontier. A
 * stale classifier therefore stops the filter HELPING. It never starts it
 * running somewhere it was not measured.
 */

import type { Tier, TierMap } from '../../../llm/tiers.ts';
import { TIER_FALLBACK } from '../../../llm/tiers.ts';
import type { LLMProviderEntry } from '../../../config/types.ts';
import type { ToolFilterPolicy } from './policy.ts';

export type ModelRef = { provider: string; model?: string };

export type EligibilityDecision = {
  eligible: boolean;
  /** Short, loggable reason. Always present, including on the allow path. */
  reason: string;
};

/**
 * Model ids that are never eligible however they were reached.
 *
 * A veto rather than a scoring input: it must be impossible for a positive
 * signal to drag a frontier model in. Matched case-insensitively against the
 * model id and the provider name.
 */
const FRONTIER_VETO = [
  'claude', 'sonnet', 'opus', 'haiku',
  'gpt-4', 'gpt-5', 'gpt4', 'gpt5',
  'o1-', 'o3-', 'o4-',
  'gemini', 'grok', 'usejarvis',
];

/**
 * Anchored parameter tag: `qwen2.5:7b`, `llama3.1-8b`, `phi3_14b`.
 *
 * Anchoring is not cosmetic. An unanchored /(\d+)b/ scan reads `qwen3-30b-a3b`
 * as 3B and `mixtral-8x7b` as 7B -- both in the unsafe direction, both
 * admitting a large model as small. Requiring a separator on each side means
 * an id we cannot parse simply has no tag, and no tag means not eligible.
 */
const PARAM_TAG = /(?:^|[-:_])(\d+(?:\.\d+)?)b(?:$|[-_.:])/i;

export function parseParamsB(modelId: string): number | null {
  const m = PARAM_TAG.exec(modelId);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function vetoed(text: string): boolean {
  const t = text.toLowerCase();
  return FRONTIER_VETO.some((v) => t.includes(v));
}

/**
 * Classify one concrete (provider, model) pair.
 *
 * `providerKind` comes from the post-DB-merge `config.llm.providers[name].kind`
 * (defaulting to the provider name, which is how the rest of the codebase
 * resolves it). It is passed in rather than read here because `LLMProvider`
 * exposes only `name` and the `llm` section is hot-reloadable.
 */
export function classifyModel(
  ref: ModelRef,
  providerKind: string | undefined,
  policy: ToolFilterPolicy,
): EligibilityDecision {
  const kind = (providerKind ?? ref.provider).toLowerCase();
  const model = ref.model ?? '';
  const full = model ? `${ref.provider}:${model}` : ref.provider;

  // 1. Explicit allowlist. Deterministic, cannot go stale, and the only
  //    mechanism the benchmark needs. Checked before the veto so an operator
  //    can benchmark whatever they like on purpose -- but see the note below:
  //    the allowlist is an operator's deliberate act on their own install.
  // A model-less candidate is the provider's own default, and nothing can
  // tell us what that is. Allowlisting the bare provider name is the only
  // way to say "whatever this provider defaults to is fine".
  if (policy.models.some((m) => m.toLowerCase() === full.toLowerCase())) {
    return { eligible: true, reason: `allowlisted (${full})` };
  }
  if (!model) {
    return {
      eligible: false,
      reason: `provider "${ref.provider}" with no model id: its default is unknowable, so it cannot be cleared`,
    };
  }

  if (vetoed(model) || vetoed(ref.provider)) {
    return { eligible: false, reason: `frontier veto (${full})` };
  }

  // 2. Ollama with a parameter cap. `ollama` is the only local runtime in
  //    LLMProviderKind; LM Studio, llama.cpp and vLLM all arrive as
  //    `openai_compatible`, which carries no signal, so those deployments
  //    must use the allowlist. Saying so is better than inventing provider
  //    names that can never match.
  if (kind !== 'ollama') {
    return { eligible: false, reason: `not a recognised local runtime (kind=${kind})` };
  }
  if (!model) {
    return { eligible: false, reason: `ollama provider with no model id; cannot size it` };
  }
  const params = parseParamsB(model);
  if (params === null) {
    return { eligible: false, reason: `no anchored parameter tag in "${model}"` };
  }
  if (params > policy.maxParamsB) {
    return { eligible: false, reason: `${params}B exceeds max_params_b=${policy.maxParamsB}` };
  }
  return { eligible: true, reason: `ollama ${params}B <= ${policy.maxParamsB}` };
}

/**
 * Every (provider, model) a tier call could actually land on.
 *
 * Mirrors `LLMManager.tierCandidates`: the requested tier followed by its
 * fall-up chain, each assignment kept in order. This has to exist because
 * `chatTier` walks the chain on failure and later candidates are a DIFFERENT
 * provider and model.
 */
export function tierCandidateRefs(tier: Tier, tiers: TierMap): ModelRef[] {
  const out: ModelRef[] = [];
  for (const t of [tier, ...TIER_FALLBACK[tier]]) {
    const a = tiers[t];
    if (a) out.push({ provider: a.provider, model: a.model });
  }
  return out;
}

/**
 * Provider kinds whose built-in default model is only a guess, so
 * `LLMManager.tierCandidates` never retries them without an explicit model
 * (`LLMProvider.placeholderDefaultModel`). Mirrored here because the set
 * decides whether a model-less candidate is reachable at all.
 */
const PLACEHOLDER_DEFAULT_KINDS: ReadonlySet<string> = new Set([
  'ollama', 'openai_compatible', 'litellm',
]);

/**
 * Expand an assignment into every ref a call could actually land on.
 *
 * `tierCandidates` appends the same provider with NO model alongside each
 * assignment, to recover the provider's own default before crossing a
 * provider boundary. That candidate is real: when the pinned model 404s,
 * `chatTier` deletes `options.model` and retries, and the provider answers
 * with whatever it defaults to -- which nothing in this codebase can
 * enumerate, since `LLMProvider` exposes only `name`.
 *
 * It is skipped for the placeholder-default kinds, exactly as the manager
 * skips it. That is what keeps an ollama-only tier map eligible while any
 * cloud provider in the chain makes the whole call ineligible.
 */
function expandCandidate(ref: ModelRef, kind: string): ModelRef[] {
  if (!ref.model || PLACEHOLDER_DEFAULT_KINDS.has(kind)) return [ref];
  return [ref, { provider: ref.provider, model: undefined }];
}

/**
 * Every model a call could land on, including the CALLER-SUPPLIED fallback.
 *
 * `TIER_FALLBACK` is not the whole story. `streamTierWithFallback` retries on
 * a tier the caller passes as an argument, and `agent-service` calls
 * `streamMessage(..., 'conversation', ..., 'medium')` -- while
 * `TIER_FALLBACK.conversation` is deliberately empty, because the
 * conversation tier's presence is a mode switch rather than a fall-up. So
 * `tierCandidateRefs('conversation', ...)` never sees `medium`, and a gate
 * built on it alone would filter for a small conversation model and then
 * hand the filtered list to the frontier task model the moment the local one
 * errored before first output. That is requirement 1 violated in exactly the
 * degraded case it is meant to cover.
 */
export function allReachableRefs(tier: Tier, fallbackTier: Tier | undefined, tiers: TierMap): ModelRef[] {
  const refs = tierCandidateRefs(tier, tiers);
  if (!fallbackTier || fallbackTier === tier) return refs;
  const seen = new Set(refs.map((r) => `${r.provider}:${r.model ?? ''}`));
  for (const r of tierCandidateRefs(fallbackTier, tiers)) {
    const key = `${r.provider}:${r.model ?? ''}`;
    if (!seen.has(key)) { seen.add(key); refs.push(r); }
  }
  return refs;
}

/**
 * The gate. Filter only when EVERY candidate the call could land on is
 * eligible.
 *
 * This is the failover hole, and it is not theoretical. With `low` mapped to
 * a small ollama model and `medium` to a frontier one, classifying only the
 * requested tier would hand a FILTERED tool list to the frontier model the
 * moment ollama is rate-limited or down -- violating "frontier models are
 * unaffected" precisely in the degraded case, where reduced capability is
 * least wanted and least likely to be noticed.
 *
 * An empty candidate list is not eligible: no configured tier means no model
 * we can classify.
 */
export function isTierEligible(
  tier: Tier,
  tiers: TierMap,
  providerKinds: Record<string, LLMProviderEntry | undefined> | undefined,
  policy: ToolFilterPolicy,
  fallbackTier?: Tier,
): EligibilityDecision {
  if (!policy.enabled) return { eligible: false, reason: 'filter disabled by policy' };

  const candidates = allReachableRefs(tier, fallbackTier, tiers);
  if (candidates.length === 0) {
    return { eligible: false, reason: `tier "${tier}" resolves to no provider` };
  }

  let checked = 0;
  for (const assignment of candidates) {
    const kind = providerKinds?.[assignment.provider]?.kind ?? assignment.provider;
    for (const ref of expandCandidate(assignment, kind)) {
      checked += 1;
      const decision = classifyModel(ref, kind, policy);
      if (!decision.eligible) {
        // Name the candidate that blocked it, not just the requested tier:
        // the confusing case is the one where the requested tier IS
        // eligible and a fall-up candidate is not.
        return { eligible: false, reason: `failover candidate ineligible: ${decision.reason}` };
      }
    }
  }
  return { eligible: true, reason: `all ${checked} reachable candidate(s) eligible` };
}
