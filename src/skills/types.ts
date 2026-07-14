/**
 * Skills — parameterized, verified, replayable procedures.
 *
 * The structural-runtime replacement for markdown webapp_templates. A skill is
 * a sequence of steps that address elements by durable SemanticRef and carry
 * postconditions, so the runtime executes and verifies each step (the model is
 * out of the per-click loop). Recorded by demonstration or hand-authored;
 * stored in the vault `skills` table.
 */

import type { SemanticRef } from '../structural/types.ts';
import type { Postcondition } from '../structural/verifier.ts';

export type SkillAction =
  | 'click'
  | 'set_value'
  | 'select'
  | 'toggle'
  | 'expand'
  | 'collapse'
  | 'focus'
  | 'press_keys'
  | 'navigate'
  | 'launch_app'
  | 'wait';

export type SkillStep = {
  action: SkillAction;
  /** Durable target for element actions (resolved at run time). */
  ref?: SemanticRef;
  /** Literal or {{param}}-templated value (set_value / press_keys / navigate / launch_app). */
  value?: string;
  /** Postcondition checked after the step; on failure the runtime self-heals. */
  postcondition?: SerializablePostcondition;
  /** What to do if the step can't be verified: fall back to vision, ask, or skip. */
  fallback?: 'vision' | 'ask' | 'skip';
  /** wait only: milliseconds. */
  ms?: number;
  /** Human-readable label for logs/UI. */
  note?: string;
};

/**
 * Postcondition as stored (refs are already in the step, so element-scoped
 * postconditions reference "this step's ref" implicitly via kind).
 */
export type SerializablePostcondition =
  | { kind: 'element_gone' }
  | { kind: 'element_present' }
  | { kind: 'value_equals'; value: string }
  | { kind: 'title_changed'; from?: string }
  | { kind: 'focus_moved' }
  | { kind: 'window_appeared' };

export type SkillParam = {
  name: string;
  type: 'string' | 'number' | 'enum';
  description: string;
  required: boolean;
  /** enum only. */
  options?: string[];
};

export type SkillMatch = {
  domains?: string[];
  processNames?: string[];
  keywords?: string[];
};

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
  /** Reliability signal surfaced in the index + marketplace. */
  successCount: number;
  runCount: number;
  verifiedAt?: number;
  createdAt: number;
  updatedAt: number;
};

/** Realize a stored postcondition against a concrete ref for the verifier. */
export function toRuntimePostcondition(
  pc: SerializablePostcondition,
  ref: SemanticRef | undefined,
): Postcondition | null {
  switch (pc.kind) {
    case 'window_appeared':
      return { kind: 'window_appeared' };
    case 'title_changed':
      return { kind: 'title_changed', from: pc.from ?? '' };
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
  return `- ${s.name}(${params}) — ${s.description}${rate}`;
}
