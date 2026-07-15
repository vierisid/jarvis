/**
 * Skill compiler — turns a recorded interaction sequence into a Skill.
 *
 * Three transformations, per the roadmap:
 *  1. Coalesce — a click that focuses a field immediately followed by typing
 *     into that same field becomes one `set_value` step (the natural unit).
 *  2. Parameterize — typed values become named params so the skill is reusable
 *     (heuristic naming here; an optional LLM pass can rename/describe later).
 *  3. Derive postconditions — a set_value gets a value_equals check; a click
 *     that is the last interaction on a surface gets a light window/title check.
 *
 * Redaction already happened at capture (recorder.ts): a {{REDACTED}} value
 * becomes a required param instead of a hard-coded secret.
 */

import type { RawInteraction } from './recorder.ts';
import type { Skill, SkillParam, SkillStep } from './types.ts';

export type CompileOptions = {
  name: string;
  app?: string;
  description?: string;
};

export type CompiledSkill = {
  name: string;
  app: string;
  description: string;
  match: { keywords?: string[]; domains?: string[]; processNames?: string[] };
  params: SkillParam[];
  steps: SkillStep[];
  provenance: 'recorded';
};

function refFocusesSameField(clickRef: RawInteraction, typeInto: RawInteraction): boolean {
  if (!clickRef.ref || !typeInto.ref) return false;
  return clickRef.ref.sig !== '' && clickRef.ref.sig === typeInto.ref.sig
    ? true
    : clickRef.ref.role === typeInto.ref.role && clickRef.ref.name === typeInto.ref.name;
}

/** Snake-case a field name into a param identifier, deduping collisions. */
function paramNameFor(ref: RawInteraction, used: Set<string>): string {
  const base = (ref.ref?.name || 'value')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'value';
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

export function compileSkill(interactions: RawInteraction[], opts: CompileOptions): CompiledSkill {
  // 1. Coalesce click-then-type on the same field.
  const coalesced: RawInteraction[] = [];
  for (let i = 0; i < interactions.length; i++) {
    const cur = interactions[i]!;
    const next = interactions[i + 1];
    if (cur.action === 'click' && next && next.action === 'set_value' && refFocusesSameField(cur, next)) {
      coalesced.push({ ...next }); // the set_value carries the field ref + value
      i++; // consume the click
    } else {
      coalesced.push(cur);
    }
  }

  // 2 + 3. Build steps, parameterize typed values, derive postconditions.
  const params: SkillParam[] = [];
  const usedNames = new Set<string>();
  const steps: SkillStep[] = [];
  const apps = new Set<string>();
  const domains = new Set<string>();

  for (let i = 0; i < coalesced.length; i++) {
    const it = coalesced[i]!;
    if (it.app) apps.add(it.app);
    if (it.url) {
      try { domains.add(new URL(it.url).hostname); } catch { /* not a url */ }
    }

    if (it.action === 'set_value') {
      const pname = paramNameFor(it, usedNames);
      const wasRedacted = it.value === '{{REDACTED}}';
      params.push({
        name: pname,
        type: 'string',
        description: `Value for ${it.ref?.name || 'field'}${wasRedacted ? ' (was a secret; not stored)' : ''}`,
        required: true,
      });
      steps.push({
        action: 'set_value',
        ref: it.ref,
        value: `{{${pname}}}`,
        // A secret field's value_equals would leak nothing useful and often
        // won't read back (masked), so skip its postcondition.
        postcondition: wasRedacted ? undefined : { kind: 'value_equals', value: `{{${pname}}}` },
        note: `type into ${it.ref?.name || 'field'}`,
      });
    } else if (it.action === 'click') {
      const isLastOnSurface = i === coalesced.length - 1 || coalesced[i + 1]!.surface !== it.surface;
      steps.push({
        action: 'click',
        ref: it.ref,
        // A terminal click (submit/next) usually changes the window/title.
        postcondition: isLastOnSurface ? { kind: 'title_changed' } : undefined,
        note: `click ${it.ref?.name || 'element'}`,
      });
    } else if (it.action === 'launch_app') {
      steps.push({ action: 'launch_app', value: it.value, postcondition: { kind: 'window_appeared' } });
    } else if (it.action === 'navigate') {
      steps.push({ action: 'navigate', value: it.value });
    } else if (it.action === 'press_keys') {
      steps.push({ action: 'press_keys', value: it.value });
    }
  }

  const app = opts.app ?? [...apps][0] ?? '';
  return {
    name: opts.name,
    app,
    description: opts.description ?? `Recorded skill for ${app || 'an app'}`,
    match: {
      keywords: app ? [app.toLowerCase()] : undefined,
      domains: domains.size ? [...domains] : undefined,
    },
    params,
    steps,
    provenance: 'recorded',
  };
}

/** Convenience: compile straight into an upsertable shape. */
export function compiledToUpsert(c: CompiledSkill): Omit<Skill, 'id' | 'version' | 'enabled' | 'successCount' | 'runCount' | 'createdAt' | 'updatedAt'> & { steps: SkillStep[] } {
  return {
    name: c.name,
    app: c.app,
    description: c.description,
    match: c.match,
    params: c.params,
    steps: c.steps,
    provenance: c.provenance,
  };
}
