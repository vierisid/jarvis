/**
 * Structural Runtime - postcondition verifier + self-heal ladder.
 *
 * The reliability fix. Every mutating ui_act may carry a postcondition; after
 * acting, the runtime re-snapshots and checks it against ground-truth
 * structure. An 8-step skill that verifies each step does not decay to ~66%
 * the way fire-and-forget clicking does - error stops compounding silently.
 *
 * Self-heal NEVER re-dispatches the action. An unconfirmed click may well
 * have landed: the page can be slow, a button can legitimately survive its
 * own click, and a postcondition can fail because the surface changed for an
 * unrelated reason. Firing again to "heal" turns one Send into two. So the
 * ladder only re-observes - re-capture, then settle and re-capture - and if
 * the postcondition still does not hold it says so and hands the decision to
 * the model, which can see the diff and choose. A genuinely lost click stays
 * lost, which is the right trade for an action with real-world effect.
 *
 * This module is pure (no I/O): it evaluates a postcondition against a
 * before/after surface pair and decides the next rung. The tool layer (ui.ts)
 * owns the re-capture calls and the settle delay.
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

/** Identity used to diff one surface against another. */
function nodeKey(n: SemanticNode): string {
  return `${n.role}|${n.name}`;
}

export function verifyPostcondition(pc: Postcondition, ctx: VerifyContext): VerifyResult {
  switch (pc.kind) {
    case 'window_appeared': {
      // "The surface still has nodes" is not evidence: ui_act re-captures the
      // SAME window it acted on, and that window was already there. A dialog
      // or a new window shows up as content that was not on the before
      // surface, or as a changed window title. Anything weaker reports
      // success every time, including when the click did nothing at all.
      if (!ctx.surfacePresent) return fail('no window/surface is present after the action');
      // Needs a baseline: without beforeTitle there is nothing to have
      // changed from, and treating that as a change is a false pass.
      const titleChanged = ctx.beforeTitle !== undefined
        && !!ctx.afterTitle && ctx.afterTitle !== ctx.beforeTitle;
      if (titleChanged) return ok(`the window title changed to "${ctx.afterTitle}"`);
      const beforeKeys = new Set(ctx.before.map(nodeKey));
      const fresh = ctx.after.filter((n) => n.name.trim().length > 0 && !beforeKeys.has(nodeKey(n)));
      if (fresh.length === 0) {
        return fail('no new window, dialog or content appeared - the surface is unchanged');
      }
      const shown = fresh.slice(0, 3).map((n) => `${n.role} "${n.name}"`).join(', ');
      return ok(`new content appeared: ${shown}${fresh.length > 3 ? ` (+${fresh.length - 3} more)` : ''}`);
    }

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

/**
 * Rungs, in order. None of them re-runs the action:
 *   re_resolve - re-capture at once and re-resolve the ref against fresh ids
 *                (the surface may have been mid-update when we first looked)
 *   settle     - wait a beat, re-capture, re-check (async UI)
 *   report     - terminal: say plainly that the outcome is unconfirmed and
 *                name the fallbacks (screenshot, or ask the user)
 */
export type HealRung = 're_resolve' | 'settle' | 'report';

export type HealState = {
  /** Rungs already attempted this action, in order. */
  attempted: HealRung[];
};

/** The rungs the ladder climbs, in order. */
export const HEAL_LADDER: readonly HealRung[] = ['re_resolve', 'settle', 'report'];

/**
 * The next rung to attempt, or null when the ladder is exhausted. Kept pure
 * so ui.ts can drive it and log each transition.
 */
export function nextHealRung(state: HealState): HealRung | null {
  for (const rung of HEAL_LADDER) {
    if (!state.attempted.includes(rung)) return rung;
  }
  return null;
}
