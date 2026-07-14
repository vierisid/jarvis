/**
 * Skill runtime — executes a stored Skill over the structural path.
 *
 * Each step is resolved against a fresh surface (by durable SemanticRef, not a
 * dead session id), acted, and verified against its postcondition; a failed
 * verify climbs the self-heal ladder before the step — and the run — is
 * declared failed. This is what keeps an 8-step skill from decaying to ~66%.
 *
 * The runtime is provider-agnostic: it captures surfaces and dispatches
 * actions through the same sidecar path ui_act uses. It takes those two
 * capabilities as injected functions so it stays unit-testable without a live
 * sidecar.
 */

import { resolveRef } from '../structural/resolver.ts';
import { verifyPostcondition } from '../structural/verifier.ts';
import type { SemanticNode } from '../structural/types.ts';
import {
  fillParams,
  toRuntimePostcondition,
  type Skill,
  type SkillParam,
  type SkillStep,
} from './types.ts';

export type SkillSurface = { nodes: SemanticNode[]; title?: string };

export type SkillRuntimeDeps = {
  /** Capture the current surface for the given kind. */
  snapshot: (kind: 'desktop' | 'browser') => Promise<SkillSurface>;
  /** Perform an action on a resolved session id. */
  act: (kind: 'desktop' | 'browser', sessionId: number, action: string, value?: string) => Promise<void>;
  /** Non-element actions (launch_app, navigate, press_keys). */
  raw: (action: string, value?: string) => Promise<void>;
  /** Optional settle delay hook (overridable in tests). */
  sleep?: (ms: number) => Promise<void>;
};

export type StepResult = {
  index: number;
  action: string;
  ok: boolean;
  detail: string;
  healed?: boolean;
};

export type SkillRunResult = {
  ok: boolean;
  steps: StepResult[];
  failedAt?: number;
};

const CONFIDENCE_FLOOR = 0.55;

function validateArgs(params: SkillParam[], args: Record<string, string>): string | null {
  for (const p of params) {
    if (p.required && !(p.name in args)) return `missing required parameter "${p.name}"`;
    if (p.type === 'enum' && p.name in args && p.options && !p.options.includes(args[p.name]!)) {
      return `parameter "${p.name}" must be one of: ${p.options.join(', ')}`;
    }
  }
  return null;
}

function surfaceKindOf(step: SkillStep): 'desktop' | 'browser' {
  return step.action === 'navigate' ? 'browser' : 'desktop';
}

export async function runSkill(
  skill: Skill,
  args: Record<string, string>,
  deps: SkillRuntimeDeps,
): Promise<SkillRunResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const argErr = validateArgs(skill.params, args);
  if (argErr) {
    return { ok: false, steps: [{ index: -1, action: 'validate', ok: false, detail: argErr }], failedAt: -1 };
  }

  const results: StepResult[] = [];

  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i]!;
    const kind = surfaceKindOf(step);
    const value = step.value !== undefined ? fillParams(step.value, args) : undefined;

    // Non-element actions run directly.
    if (step.action === 'launch_app' || step.action === 'navigate' || step.action === 'press_keys') {
      try {
        await deps.raw(step.action, value);
      } catch (err) {
        results.push({ index: i, action: step.action, ok: false, detail: msg(err) });
        return { ok: false, steps: results, failedAt: i };
      }
    } else if (step.action === 'wait') {
      await sleep(step.ms ?? 500);
      results.push({ index: i, action: 'wait', ok: true, detail: `waited ${step.ms ?? 500}ms` });
      continue;
    } else {
      // Element action: resolve the ref against a fresh surface, then act.
      const before = await deps.snapshot(kind);
      const resolved = step.ref ? resolveRef(step.ref, before.nodes, CONFIDENCE_FLOOR) : { node: null, confidence: 0, method: 'none' as const };
      if (!resolved.node) {
        results.push({ index: i, action: step.action, ok: false, detail: `could not locate target "${step.ref?.name ?? '?'}" on the current surface` });
        return { ok: false, steps: results, failedAt: i };
      }
      try {
        await deps.act(kind, resolved.node.sessionId, step.action, value);
      } catch (err) {
        results.push({ index: i, action: step.action, ok: false, detail: msg(err) });
        return { ok: false, steps: results, failedAt: i };
      }
    }

    // Verify the postcondition, self-healing once with a settle delay.
    if (step.postcondition) {
      const stepRes = await verifyStep(step, args, kind, deps, sleep);
      results.push({ index: i, action: step.action, ...stepRes });
      if (!stepRes.ok) {
        return { ok: false, steps: results, failedAt: i };
      }
    } else {
      results.push({ index: i, action: step.action, ok: true, detail: 'done (no postcondition)' });
    }
  }

  return { ok: true, steps: results };
}

async function verifyStep(
  step: SkillStep,
  args: Record<string, string>,
  kind: 'desktop' | 'browser',
  deps: SkillRuntimeDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ok: boolean; detail: string; healed?: boolean }> {
  const pcRef = step.ref;
  // Fill {{param}} placeholders in the postcondition's expected value so a
  // value_equals check compares against the same filled text the step set.
  const storedPc =
    step.postcondition!.kind === 'value_equals'
      ? { ...step.postcondition!, value: fillParams(step.postcondition!.value, args) }
      : step.postcondition!;
  const runtimePc = toRuntimePostcondition(storedPc, pcRef);
  if (!runtimePc) return { ok: true, detail: 'postcondition not applicable' };

  const check = async (): Promise<{ ok: boolean; detail: string }> => {
    const after = await deps.snapshot(kind);
    const v = verifyPostcondition(runtimePc, {
      before: [], after: after.nodes, afterTitle: after.title, surfacePresent: after.nodes.length > 0,
    });
    return { ok: v.satisfied, detail: v.detail };
  };

  const first = await check();
  if (first.ok) return first;

  // Self-heal: settle + retry the action once, then re-check.
  await sleep(400);
  const kindRef = step.ref;
  if (kindRef && step.action !== 'launch_app' && step.action !== 'navigate' && step.action !== 'press_keys') {
    const s = await deps.snapshot(kind);
    const r = resolveRef(kindRef, s.nodes, CONFIDENCE_FLOOR);
    if (r.node) {
      try {
        await deps.act(kind, r.node.sessionId, step.action, step.value !== undefined ? fillParams(step.value, args) : undefined);
      } catch { /* fall through to re-check */ }
    }
  }
  const second = await check();
  if (second.ok) return { ok: true, detail: second.detail, healed: true };

  if (step.fallback === 'skip') return { ok: true, detail: `unverified (${second.detail}) — skipped per step fallback`, healed: false };
  return { ok: false, detail: `postcondition failed after self-heal: ${second.detail}` };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
