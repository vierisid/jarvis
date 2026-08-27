/**
 * What the Voice tab says about realtime, as data.
 *
 * Extracted from the JSX for the reason `LLMTab.models.test.ts` exists: this
 * suite has no DOM, so a decision left inside a component is a decision nothing
 * checks — and these particular decisions are the ones that tell a user who
 * pays for their voice sessions. Five rounds of review on this feature turned
 * up three separate surfaces asserting the wrong billing model; each was a
 * ternary in the JSX.
 *
 * The governing distinction is `servedByPlan` — whether a session would run on
 * the platform proxy under the tenant's plan — NOT whether the install is
 * hosted, and NOT whether realtime is currently switched on. See
 * `realtimeServedByPlan` in src/config/realtime.ts.
 */

export interface RealtimeCopyInput {
  /** Realtime is switched on (by the user, the env, or the hosted default). */
  enabled: boolean;
  /** A session would resolve, and the plan gate has not said no. */
  available: boolean;
  /** The plan would serve it — the user's own OpenAI key is never read. */
  servedByPlan: boolean;
  /** On because the plan may include it, rather than because anyone asked. */
  enabledDefault: boolean;
}

export type ChipTone = "ok" | "warn" | undefined;

/**
 * Unavailable means two different things, and the chip used to name only one:
 * on a plan-served install there is no key for the user to add, so "No OpenAI
 * key" both misdiagnosed the problem and implied a bill they do not pay.
 */
export function realtimeChip(rt: RealtimeCopyInput | null): { label: string; tone: ChipTone } {
  if (!rt?.enabled) return { label: "Off", tone: undefined };
  if (rt.available) return { label: "Active", tone: "ok" };
  return rt.servedByPlan
    ? { label: "Not in your plan", tone: "warn" }
    : { label: "No OpenAI key", tone: "warn" };
}

/**
 * The billing sentence, shown beside the toggle — i.e. to someone deciding
 * whether to switch realtime ON. It must therefore be true independently of
 * the current toggle state, which is why it reads `servedByPlan` (a property of
 * the install) rather than anything derived from the live resolution.
 */
export function realtimeBillingCopy(rt: RealtimeCopyInput | null): "plan" | "byo" {
  return rt?.servedByPlan ? "plan" : "byo";
}

/** Why realtime is enabled but not working. */
export function realtimeUnavailableReason(rt: RealtimeCopyInput): "plan" | "no-key" {
  return rt.servedByPlan ? "plan" : "no-key";
}

/**
 * Whether to claim the plan includes realtime.
 *
 * "may include", never "includes": `available` is true for an UNKNOWN plan
 * verdict too — the gate defaults open until the catalog answers — so a
 * definite claim is wrong for the first seconds after a restart.
 */
export function showsPlanDefaultHint(rt: RealtimeCopyInput): boolean {
  return rt.available && rt.enabledDefault;
}
