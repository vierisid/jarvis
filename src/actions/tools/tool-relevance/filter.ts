/**
 * The filter entry point: the one function every call site goes through.
 *
 * #483 defect 5 was that only 3 of 5 call sites were filtered, so the token
 * claim did not hold product-wide. The answer here is not "filter the other
 * two as well" but "route all of them through one gate with one invariant",
 * and let the gate say no where the safety requirements cannot be met
 * (realtime -- see `realtimeToolDecision`).
 *
 * Order matters and is fixed:
 *
 *   policy off / model ineligible  -> full list, unchanged
 *   selection over the conversation
 *   union with the floor and the ledger
 *   normalise (the framing invariant, repaired by union)
 *   append the escape hatch if anything was dropped
 *   verify, and fail open on any doubt
 *
 * Nothing downstream of `normalizeToolSet` reads the conversation, so the
 * repair cannot be steered by the message.
 */

import type { LLMMessage } from '../../../llm/provider.ts';
import type { Tier, TierMap } from '../../../llm/tiers.ts';
import type { LLMProviderEntry } from '../../../config/types.ts';
import type { ToolDefinition } from '../registry.ts';
import { isFloorEligible } from './authority-classes.ts';
import { DISCOVER_TOOLS_DEFINITION } from './discover.ts';
import { normalizeToolSet, type InvariantFailure } from './invariant.ts';
import { DISCOVER_TOOLS, type ToolExposureLedger } from './ledger.ts';
import { isTierEligible } from './model-class.ts';
import { getToolFilterPolicy, type ToolFilterPolicy } from './policy.ts';
import { conversationText, selectRelevantNames } from './selection.ts';

export type FilterContext = {
  /** The tool list the call site would otherwise send. Registry tools only. */
  all: readonly ToolDefinition[];
  /** The conversation so far, for the selection heuristic. */
  messages: readonly LLMMessage[];
  /** Carries monotonicity across turns. See ledger.ts. */
  ledger: ToolExposureLedger;
  /** Which tier will run the call. */
  tier: Tier;
  /**
   * The caller-supplied retry tier, where there is one (`streamMessage`'s
   * 5th argument). It is NOT reachable through TIER_FALLBACK and must be
   * passed, or the gate will clear a small local model and then hand the
   * filtered list to the frontier model this falls back to.
   */
  fallbackTier?: Tier;
  tiers: TierMap;
  providers: Record<string, LLMProviderEntry | undefined> | undefined;
  /** Defaults to the process policy; injected in tests and the benchmark. */
  policy?: ToolFilterPolicy;
};

export type FilterDecision = {
  /** What to send. Never empty when `all` is non-empty. */
  tools: ToolDefinition[];
  /** True when `tools` is a strict subset and the hatch was appended. */
  filtered: boolean;
  /** The names the model can see. Drives the discover_tools catalogue. */
  exposed: ReadonlySet<string>;
  /** Why, for the log line and the benchmark. */
  reason: string;
  failures: InvariantFailure[];
};

/**
 * Violations are counted, not logged once.
 *
 * A fail-open that fires on one turn in ten thousand and one that fires on
 * every turn produce the same single line under a log-once scheme. The
 * counter is read by the benchmark, where a nonzero value is a release
 * blocker for flipping the default.
 */
type FilterFailure = InvariantFailure | { invariant: 'I4'; detail: string };

let violationCount = 0;
let lastLoggedAt = 0;
const LOG_INTERVAL_MS = 60_000;

export function invariantViolationCount(): number {
  return violationCount;
}

export function resetInvariantViolationCount(): void {
  violationCount = 0;
  lastLoggedAt = 0;
}

function noteViolation(failures: readonly FilterFailure[]): void {
  violationCount += 1;
  const now = Date.now();
  if (now - lastLoggedAt < LOG_INTERVAL_MS) return;
  lastLoggedAt = now;
  console.warn(
    `[ToolFilter] invariant violation (${violationCount} total); sending the full tool list. `
    + failures.map((f) => `${f.invariant}: ${f.detail}`).join(' | '),
  );
}

const unfiltered = (all: readonly ToolDefinition[], reason: string): FilterDecision =>
  ({ tools: [...all], filtered: false, exposed: new Set(all.map((t) => t.name)), reason, failures: [] });

/**
 * Decide the tool set for one turn.
 *
 * Call once per turn and hold the result across the tool loop; do NOT call
 * per iteration. Anthropic renders tools -> system -> messages, so the tool
 * list sits at the head of the cached prefix and any change to it
 * invalidates the cached tools and the whole system prompt behind them. A
 * per-iteration recompute against a ledger that grows on every dispatch
 * would mean a full cache miss every iteration. Tools used during a turn are
 * noted into the ledger and take effect on the NEXT turn; only an explicit
 * `discover_tools` admission justifies recomputing mid-turn.
 */
export function decideTools(ctx: FilterContext): FilterDecision {
  const all = ctx.all;
  if (all.length === 0) return unfiltered(all, 'empty tool list');

  const policy = ctx.policy ?? getToolFilterPolicy();
  if (!policy.enabled) return unfiltered(all, 'filter disabled');

  const eligibility = isTierEligible(ctx.tier, ctx.tiers, ctx.providers, policy, ctx.fallbackTier);
  if (!eligibility.eligible) return unfiltered(all, eligibility.reason);

  try {
    const text = conversationText(ctx.messages);
    const wanted = selectRelevantNames(text);
    const ledger = ctx.ledger.snapshot();

    const candidate = all.filter((t) =>
      isFloorEligible(t) || wanted.has(t.name) || ledger.has(t.name));

    const result = normalizeToolSet(all, candidate);
    if (result.failedOpen) {
      noteViolation(result.failures);
      return {
        tools: [...all], filtered: false, exposed: new Set(all.map((t) => t.name)),
        reason: 'invariant violation', failures: result.failures,
      };
    }

    if (result.tools.length >= all.length) {
      // Nothing was actually dropped. Return the input untouched so the
      // request stays byte-identical to an unfiltered one -- no hatch, no
      // cache churn, no behaviour change.
      return unfiltered(all, 'selection kept everything');
    }

    // I4 -- the escape hatch, appended here rather than at the four call
    // sites. A tool was hidden, so the model must have a way to ask for it
    // back; leaving that to each loop to remember is how one of them ends up
    // filtered with no way out. Appending an inert synthetic cannot violate
    // I1, so this is safe after normalisation rather than before it.
    const tools = [...result.tools, DISCOVER_TOOLS_DEFINITION];
    if (!tools.some((t) => t.name === DISCOVER_TOOLS)) {
      noteViolation([{ invariant: 'I4', detail: 'escape hatch missing from a filtered set' }]);
      return {
        tools: [...all], filtered: false, exposed: new Set(all.map((t) => t.name)),
        reason: 'escape hatch missing', failures: [],
      };
    }

    return {
      tools,
      filtered: true,
      // The names the model can actually see. The catalogue renders
      // available-vs-hidden against THIS; handing it the full registry
      // instead marks everything available and quietly breaks the discovery
      // half of the escape hatch.
      exposed: new Set(tools.map((t) => t.name)),
      reason: `${result.tools.length}/${all.length} tools`
        + (result.repaired.length > 0 ? `; framing repair restored ${result.repaired.length}` : ''),
      failures: [],
    };
  } catch (err) {
    // The filter is an optimisation. Its failure mode is "no optimisation".
    noteViolation([{ invariant: 'I5-threw', detail: err instanceof Error ? err.message : String(err) }]);
    return unfiltered(all, 'filter threw');
  }
}

/**
 * Realtime voice is deliberately never filtered.
 *
 * A realtime session's tools are fixed when `buildSessionUpdate` runs. A
 * one-shot filter there would break I2 and I4 at once: no per-turn
 * recompute, and `discover_tools` could not take effect because the
 * session's tool list cannot change -- so the escape hatch would be a dead
 * end, which is worse than no filter at all. Re-sending `session.update`
 * with a grown list is the only shape that could work and it is separate
 * work.
 *
 * This function exists so the realtime call site goes through the same gate
 * as every other one and the decision is testable, rather than realtime
 * simply being forgotten the way it was in #475.
 */
export function realtimeToolDecision(all: readonly ToolDefinition[]): FilterDecision {
  return unfiltered(all, 'realtime sessions have a fixed tool list: no per-turn refilter, no working escape hatch');
}

