/**
 * Structural Runtime — postcondition verifier + self-heal ladder.
 *
 * The reliability fix. Every mutating ui_act may carry a postcondition; after
 * acting, the runtime re-snapshots and checks it against ground-truth
 * structure. An 8-step skill that verifies each step does not decay to ~66%
 * the way fire-and-forget clicking does — error stops compounding silently.
 *
 * This module is pure (no I/O): it evaluates a postcondition against a
 * before/after surface pair and decides the next rung of the self-heal ladder.
 * The tool layer (ui.ts) owns the actual re-snapshot/retry/vision/ask calls.
 */

import { resolveRef } from './resolver.ts';
import type { SemanticNode, SemanticRef } from './types.ts';

export type Postcondition =
  | { kind: 'element_gone'; ref: SemanticRef }
  | { kind: 'element_present'; ref: SemanticRef }
  | { kind: 'value_equals'; ref: SemanticRef; value: string }
  | { kind: 'title_changed'; from: string }
  | { kind: 'focus_moved'; fromRef?: SemanticRef }
  | { kind: 'window_appeared' };

export type VerifyContext = {
  /** Surface captured immediately before the action (for diffs). */
  before: SemanticNode[];
  beforeTitle?: string;
  /** Surface captured after the action. */
  after: SemanticNode[];
  afterTitle?: string;
  /** True if a window/surface exists at all after the action. */
  surfacePresent: boolean;
};

export type VerifyResult = {
  satisfied: boolean;
  /** Human/LLM-readable explanation, always set. */
  detail: string;
};

const FLOOR = 0.55;

export function verifyPostcondition(pc: Postcondition, ctx: VerifyContext): VerifyResult {
  switch (pc.kind) {
    case 'window_appeared':
      return ctx.surfacePresent
        ? ok('a window/surface is present')
        : fail('no window/surface appeared');

    case 'element_present': {
      const r = resolveRef(pc.ref, ctx.after, FLOOR);
      return r.node
        ? ok(`element "${pc.ref.name}" is present (matched by ${r.method})`)
        : fail(`element "${pc.ref.name}" not found after the action`);
    }

    case 'element_gone': {
      const r = resolveRef(pc.ref, ctx.after, FLOOR);
      return r.node
        ? fail(`element "${pc.ref.name}" is still present (expected it to be gone)`)
        : ok(`element "${pc.ref.name}" is gone`);
    }

    case 'value_equals': {
      const r = resolveRef(pc.ref, ctx.after, FLOOR);
      if (!r.node) return fail(`element "${pc.ref.name}" not found to read its value`);
      const actual = (r.node.value ?? '').trim();
      return actual === pc.value.trim()
        ? ok(`value equals "${pc.value}"`)
        : fail(`value is "${actual}", expected "${pc.value}"`);
    }

    case 'title_changed': {
      const now = ctx.afterTitle ?? '';
      return now && now !== pc.from
        ? ok(`title changed to "${now}"`)
        : fail(`title is still "${now || pc.from}"`);
    }

    case 'focus_moved': {
      const nowFocused = ctx.after.find((n) => n.state.focused);
      if (!nowFocused) return fail('nothing is focused after the action');
      if (pc.fromRef) {
        const same = resolveRef(pc.fromRef, [nowFocused], FLOOR);
        return same.node
          ? fail(`focus is still on "${pc.fromRef.name}"`)
          : ok(`focus moved to "${nowFocused.name}"`);
      }
      return ok(`focus is on "${nowFocused.name}"`);
    }
  }
}

function ok(detail: string): VerifyResult {
  return { satisfied: true, detail };
}
function fail(detail: string): VerifyResult {
  return { satisfied: false, detail };
}

// ── Self-heal ladder ─────────────────────────────────────────────────

export type HealRung = 're_resolve' | 'retry' | 'vision' | 'ask' | 'done';

export type HealState = {
  /** Rungs already attempted this action, in order. */
  attempted: HealRung[];
};

/**
 * Given the rungs already tried, return the next one to attempt. The ladder:
 *   re_resolve (ref against a fresh surface — handles id churn)
 *   → retry    (settle delay + redo — handles async UI)
 *   → vision   (screenshot + coordinate action, logged)
 *   → ask      (surface to the user via Authority)
 *   → done     (ladder exhausted)
 * Kept pure so ui.ts can drive it and log each transition.
 */
export function nextHealRung(state: HealState): HealRung {
  const order: HealRung[] = ['re_resolve', 'retry', 'vision', 'ask'];
  for (const rung of order) {
    if (!state.attempted.includes(rung)) return rung;
  }
  return 'done';
}
