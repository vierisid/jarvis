/**
 * Skills: parameterized, verified, replayable procedures.
 *
 * The structural-runtime replacement for markdown webapp_templates. A skill is
 * a sequence of steps that address elements by durable SemanticRef and carry
 * postconditions, so the runtime executes and verifies each step (the model is
 * out of the per-click loop). Recorded by demonstration or hand-authored;
 * stored in the vault `skills` table, where every row carries a MAC over its
 * reviewed content (see src/vault/skills.ts).
 */

import type { SemanticRef } from '../structural/types.ts';
import type { Postcondition } from '../structural/verifier.ts';
import type { ActionCategory } from '../roles/authority.ts';

/**
 * Every action here is one the runtime dispatches: click and set_value go to
 * click_element / browser_ax_*, the rest are raw sidecar RPCs. Nothing is
 * advertised that liveDeps cannot carry out.
 */
export type SkillAction =
  | 'click'
  | 'set_value'
  | 'press_keys'
  | 'navigate'
  | 'launch_app'
  | 'wait';

export const SKILL_ACTIONS: readonly SkillAction[] = ['click', 'set_value', 'press_keys', 'navigate', 'launch_app', 'wait'];

export function isSkillAction(v: unknown): v is SkillAction {
  return typeof v === 'string' && (SKILL_ACTIONS as readonly string[]).includes(v);
}

export type SurfaceKind = 'desktop' | 'browser';

export type SkillStep = {
  action: SkillAction;
  /** Which provider the step runs on. Defaults to browser for navigate, desktop otherwise. */
  surface?: SurfaceKind;
  /** Durable target for element actions (resolved at run time). */
  ref?: SemanticRef;
  /** Literal or {{param}}-templated value (set_value / press_keys / navigate / launch_app). */
  value?: string;
  /** Postcondition checked after the step; on failure the runtime re-observes, never re-acts. */
  postcondition?: SerializablePostcondition;
  /**
   * What the step does beyond controlling the app, declared by the author.
   * The authority gate takes the stricter of this and its own classification
   * of the step (src/skills/effects.ts); it can raise a step's category, never
   * lower it below the control_app floor.
   */
  effect?: ActionCategory;
  /** skip: an unverifiable step does not fail the run. The only fallback the runtime honours. */
  fallback?: 'skip';
  /** wait only: milliseconds. */
  ms?: number;
  /** Human-readable label for logs/UI. */
  note?: string;
};

/**
 * Postcondition as stored (refs are already in the step, so element-scoped
 * postconditions reference "this step's ref" implicitly via kind).
 *
 * surface_changed is the compiler's default for a terminal click: it holds
 * when the clicked element is gone, the title changed, or new content
 * appeared, and fails when the surface is exactly as it was, which is the
 * no-op click case.
 */
export type SerializablePostcondition =
  | { kind: 'element_gone' }
  | { kind: 'element_present' }
  | { kind: 'value_equals'; value: string }
  | { kind: 'title_changed'; from?: string }
  | { kind: 'focus_moved' }
  | { kind: 'window_appeared' }
  | { kind: 'surface_changed' };

export type SkillParam = {
  name: string;
  /** enum params are validated against `options`; everything else is free text. */
  type: 'string' | 'enum';
  description: string;
  required: boolean;
  /** enum only. */
  options?: string[];
  /** The recorded value was redacted; approval cards and logs never print it. */
  secret?: boolean;
};

export type SkillMatch = {
  domains?: string[];
  processNames?: string[];
  keywords?: string[];
};

/**
 * ok:       the row's MAC matches its content.
 * unsigned: the row predates signing; it is never run.
 * tampered: the content changed without the signing key; it is never run.
 */
export type SkillIntegrity = 'ok' | 'unsigned' | 'tampered';

export type Skill = {
  id: string;
  name: string;
  app: string;
  description: string;
  match: SkillMatch;
  params: SkillParam[];
  steps: SkillStep[];
  provenance: 'recorded' | 'authored' | 'marketplace';
  version: number;
  enabled: boolean;
  integrity: SkillIntegrity;
  /** Reliability signal surfaced in the index. */
  successCount: number;
  runCount: number;
  verifiedAt?: number;
  createdAt: number;
  updatedAt: number;
};

/**
 * Realize a stored postcondition against a concrete ref for the verifier.
 * title_changed needs a baseline: the stored `from` when the author gave one,
 * else the title captured before the step. Without either there is nothing
 * to have changed from, so the caller must treat it as unverifiable rather
 * than passing on any non-empty title.
 */
export function toRuntimePostcondition(
  pc: SerializablePostcondition,
  ref: SemanticRef | undefined,
  beforeTitle?: string,
): Postcondition | null {
  switch (pc.kind) {
    case 'window_appeared':
      return { kind: 'window_appeared' };
    case 'surface_changed':
      // Composite; evaluated by the skill runtime, not the verifier.
      return null;
    case 'title_changed': {
      const from = pc.from ?? beforeTitle;
      return from === undefined ? null : { kind: 'title_changed', from };
    }
    case 'element_present':
      return ref ? { kind: 'element_present', ref } : null;
    case 'element_gone':
      return ref ? { kind: 'element_gone', ref } : null;
    case 'value_equals':
      return ref ? { kind: 'value_equals', ref, value: pc.value } : null;
    case 'focus_moved':
      return { kind: 'focus_moved', fromRef: ref };
  }
}

/** Substitute {{param}} placeholders in a value using the provided args. */
export function fillParams(value: string, args: Record<string, string>): string {
  return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) =>
    Object.prototype.hasOwnProperty.call(args, name) ? args[name]! : `{{${name}}}`,
  );
}

/** Compact one-line index entry for prompt injection. */
export function skillIndexLine(s: Skill): string {
  const params = s.params.map((p) => (p.required ? p.name : `${p.name}?`)).join(', ');
  const rate = s.runCount > 0 ? ` (${Math.round((100 * s.successCount) / s.runCount)}% over ${s.runCount})` : '';
  return `- ${s.name}(${params}): ${s.description}${rate}`;
}

/** Surface a step runs on; navigate is the only action that implies the browser. */
export function stepSurface(step: SkillStep): SurfaceKind {
  return step.surface ?? (step.action === 'navigate' ? 'browser' : 'desktop');
}
