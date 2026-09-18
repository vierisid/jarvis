/**
 * Skill runtime: executes a stored Skill over the structural path.
 *
 * Each step is resolved against a fresh surface (by durable SemanticRef, not a
 * dead session id), acted on exactly once, and verified against its
 * postcondition. A failed verification climbs the same ladder ui_act climbs
 * (src/structural/verifier.ts HEAL_LADDER): re-capture at once, settle and
 * re-capture, then report. No rung re-dispatches the action. An unconfirmed
 * click may well have landed, and firing again to "heal" turns one Send into
 * two, so the step is reported as not verified and the run stops there.
 *
 * Every postcondition is evaluated against a before/after surface pair: the
 * surface captured right before the step is the baseline for title_changed,
 * window_appeared and surface_changed, so an unchanged surface never passes.
 *
 * The runtime is provider-agnostic: it captures surfaces and dispatches
 * actions through the same sidecar path ui_act uses. It takes those two
 * capabilities as injected functions so it stays unit-testable without a live
 * sidecar.
 */

import { resolveRef } from '../structural/resolver.ts';
import { nextHealRung, verifyPostcondition, type HealRung, type VerifyContext } from '../structural/verifier.ts';
import type { SemanticNode } from '../structural/types.ts';
import {
  fillParams,
  isSkillAction,
  resolveArgs,
  stepSurface,
  toRuntimePostcondition,
  type SerializablePostcondition,
  type Skill,
  type SkillParam,
  type SkillStep,
  type SurfaceKind,
} from './types.ts';

export { resolveArgs };

export type SkillSurface = { nodes: SemanticNode[]; title?: string };

export type SkillRuntimeDeps = {
  /** Capture the current surface for the given kind. */
  snapshot: (kind: SurfaceKind) => Promise<SkillSurface>;
  /** Perform an action on a resolved session id. */
  act: (kind: SurfaceKind, sessionId: number, action: string, value?: string) => Promise<void>;
  /**
   * Non-element actions (launch_app, navigate, press_keys). Takes the step's
   * surface so a key press on a browser step goes to the browser and not to
   * the machine's foreground window.
   */
  raw: (kind: SurfaceKind, action: string, value?: string) => Promise<void>;
  /** Optional settle delay hook (overridable in tests). */
  sleep?: (ms: number) => Promise<void>;
};

export type StepResult = {
  index: number;
  action: string;
  ok: boolean;
  detail: string;
  /** The postcondition held only after a re-observe rung; the action was still dispatched once. */
  healed?: boolean;
};

export type SkillRunResult = {
  ok: boolean;
  steps: StepResult[];
  failedAt?: number;
};

const CONFIDENCE_FLOOR = 0.55;
/** Pause before the settle re-read, for async UI. Same as ui_act. */
const SETTLE_MS = 400;

function validateArgs(params: SkillParam[], args: Record<string, string>): string | null {
  for (const p of params) {
    if (p.required && !(p.name in args)) return `missing required parameter "${p.name}"`;
    if (p.name in args && typeof args[p.name] !== 'string') return `parameter "${p.name}" must be a string`;
    if (p.type === 'enum' && p.name in args && p.options && !p.options.includes(args[p.name]!)) {
      return `parameter "${p.name}" must be one of: ${p.options.join(', ')}`;
    }
  }
  return null;
}

/** A skill the runtime cannot replay is refused before anything is dispatched. */
export function validateSteps(steps: SkillStep[]): string | null {
  if (steps.length === 0) return 'the skill has no steps';
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (!isSkillAction(s.action)) return `step ${i + 1} has an unknown action "${String(s.action)}"`;
    if ((s.action === 'click' || s.action === 'set_value') && !s.ref) return `step ${i + 1} (${s.action}) has no target ref`;
    if (s.action === 'set_value' && s.value === undefined) return `step ${i + 1} (set_value) has no value`;
    if ((s.action === 'navigate' || s.action === 'launch_app' || s.action === 'press_keys') && !s.value) {
      return `step ${i + 1} (${s.action}) has no value`;
    }
  }
  return null;
}

const EMPTY: SkillSurface = { nodes: [] };

export async function runSkill(
  skill: Skill,
  callerArgs: Record<string, string>,
  deps: SkillRuntimeDeps,
): Promise<SkillRunResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const args = resolveArgs(skill.params, callerArgs);
  const argErr = validateArgs(skill.params, args);
  if (argErr) {
    return { ok: false, steps: [{ index: -1, action: 'validate', ok: false, detail: argErr }], failedAt: -1 };
  }
  const stepErr = validateSteps(skill.steps);
  if (stepErr) {
    return { ok: false, steps: [{ index: -1, action: 'validate', ok: false, detail: stepErr }], failedAt: -1 };
  }

  const results: StepResult[] = [];
  const fail = (i: number, action: string, detail: string): SkillRunResult => {
    results.push({ index: i, action, ok: false, detail });
    return { ok: false, steps: results, failedAt: i };
  };
  const snapshotSafe = async (kind: SurfaceKind): Promise<SkillSurface> => {
    try { return await deps.snapshot(kind); } catch { return EMPTY; }
  };

  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i]!;
    const kind = stepSurface(step);
    const value = step.value !== undefined ? fillParams(step.value, args) : undefined;
    let before: SkillSurface = EMPTY;

    if (step.action === 'wait') {
      await sleep(step.ms ?? 500);
      results.push({ index: i, action: 'wait', ok: true, detail: `waited ${step.ms ?? 500}ms` });
      continue;
    }

    if (step.action === 'launch_app' || step.action === 'navigate' || step.action === 'press_keys') {
      // The baseline for the postcondition is whatever is on screen before
      // the action; there may be no window at all yet (launch_app).
      if (step.postcondition) before = await snapshotSafe(kind);
      try {
        await deps.raw(kind, step.action, value);
      } catch (err) {
        return fail(i, step.action, msg(err));
      }
    } else {
      // Element action: resolve the ref against a fresh surface, then act.
      try {
        before = await deps.snapshot(kind);
      } catch (err) {
        return fail(i, step.action, `could not capture the ${kind} surface: ${msg(err)}`);
      }
      const resolved = resolveRef(step.ref!, before.nodes, CONFIDENCE_FLOOR);
      if (!resolved.node) {
        return fail(i, step.action, `could not locate target "${step.ref!.name || step.ref!.role}" on the current surface (best match ${Math.round(resolved.confidence * 100)}%)`);
      }
      try {
        await deps.act(kind, resolved.node.sessionId, step.action, value);
      } catch (err) {
        return fail(i, step.action, msg(err));
      }
    }

    if (step.postcondition) {
      const stepRes = await verifyStep(step, args, kind, before, snapshotSafe, sleep);
      results.push({ index: i, action: step.action, ...stepRes });
      if (!stepRes.ok) return { ok: false, steps: results, failedAt: i };
    } else {
      results.push({ index: i, action: step.action, ok: true, detail: 'done (no postcondition)' });
    }
  }

  return { ok: true, steps: results };
}

type Verdict = { satisfied: boolean; detail: string };

/** Evaluate a stored postcondition against a before/after pair. */
function evaluate(
  pc: SerializablePostcondition,
  step: SkillStep,
  args: Record<string, string>,
  before: SkillSurface,
  after: SkillSurface,
): Verdict {
  const ctx: VerifyContext = {
    before: before.nodes,
    beforeTitle: before.title,
    after: after.nodes,
    afterTitle: after.title,
    surfacePresent: after.nodes.length > 0,
  };
  if (pc.kind === 'surface_changed') {
    const target = step.ref?.name || step.ref?.role || 'the target';
    const gone = step.ref ? verifyPostcondition({ kind: 'element_gone', ref: step.ref }, ctx) : null;
    if (gone?.satisfied) return gone;
    const appeared = verifyPostcondition({ kind: 'window_appeared' }, ctx);
    if (appeared.satisfied) return appeared;
    return { satisfied: false, detail: `the surface is unchanged: "${target}" is still present and nothing new appeared` };
  }
  const stored = pc.kind === 'value_equals' ? { ...pc, value: fillParams(pc.value, args) } : pc;
  const runtimePc = toRuntimePostcondition(stored, step.ref, before.title);
  if (!runtimePc) {
    return pc.kind === 'title_changed'
      ? { satisfied: false, detail: 'title_changed has no baseline title to compare against' }
      : { satisfied: false, detail: `postcondition ${pc.kind} needs a target ref on the step` };
  }
  return verifyPostcondition(runtimePc, ctx);
}

async function verifyStep(
  step: SkillStep,
  args: Record<string, string>,
  kind: SurfaceKind,
  before: SkillSurface,
  snapshot: (kind: SurfaceKind) => Promise<SkillSurface>,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ok: boolean; detail: string; healed?: boolean }> {
  const pc = step.postcondition!;
  const attempted: HealRung[] = [];
  let last: Verdict = { satisfied: false, detail: 'not checked' };

  // Every rung re-observes; none re-dispatches. See verifier.ts for why.
  for (;;) {
    const after = await snapshot(kind);
    last = evaluate(pc, step, args, before, after);
    if (last.satisfied) {
      return attempted.length > 0
        ? { ok: true, detail: `${last.detail} (after ${attempted.join(' -> ')})`, healed: true }
        : { ok: true, detail: last.detail };
    }
    const rung = nextHealRung({ attempted });
    if (rung === null || rung === 'report') {
      if (rung) attempted.push(rung);
      break;
    }
    attempted.push(rung);
    if (rung === 'settle') await sleep(SETTLE_MS);
  }

  if (step.fallback === 'skip') {
    return { ok: true, detail: `unverified (${last.detail}); skipped per step fallback` };
  }
  return {
    ok: false,
    detail: `not verified: ${last.detail}. The ${step.action} was dispatched once and NOT repeated; it may still have taken effect`,
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
