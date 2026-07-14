import { describe, expect, it } from 'bun:test';
import { runSkill, type SkillRuntimeDeps, type SkillSurface } from './runtime.ts';
import type { Skill, SkillStep } from './types.ts';
import type { SemanticNode, SemanticRef } from '../structural/types.ts';

function node(role: string, name: string, sig: string, sessionId: number, focused = false): SemanticNode {
  return {
    ref: { role, name, path: [], ordinal: 0, sig },
    role, name, value: null,
    state: { enabled: true, focused },
    bounds: null, actions: ['click', 'set_value'], sessionId,
  };
}
function ref(role: string, name: string, sig: string): SemanticRef {
  return { role, name, path: [], ordinal: 0, sig };
}

function skill(steps: SkillStep[], params: Skill['params'] = []): Skill {
  return {
    id: 's', name: 'test', app: '', description: '', match: {}, params, steps,
    provenance: 'authored', version: 1, enabled: true, successCount: 0, runCount: 0,
    createdAt: 0, updatedAt: 0,
  };
}

/** Deps whose snapshot returns a scripted sequence of surfaces. */
function scriptedDeps(surfaces: SkillSurface[]): { deps: SkillRuntimeDeps; acts: Array<[number, string, string?]>; raws: Array<[string, string?]> } {
  const acts: Array<[number, string, string?]> = [];
  const raws: Array<[string, string?]> = [];
  let i = 0;
  const deps: SkillRuntimeDeps = {
    snapshot: async () => surfaces[Math.min(i++, surfaces.length - 1)]!,
    act: async (_k, sid, action, value) => { acts.push([sid, action, value]); },
    raw: async (action, value) => { raws.push([action, value]); },
    sleep: async () => {},
  };
  return { deps, acts, raws };
}

describe('runSkill', () => {
  it('fills params and runs an element step verified by postcondition', async () => {
    const target = node('Edit', 'Body', 'body-sig', 7);
    const after = node('Edit', 'Body', 'body-sig', 7);
    after.value = 'hello world';
    const s = skill(
      [{ action: 'set_value', ref: ref('Edit', 'Body', 'body-sig'), value: '{{text}}', postcondition: { kind: 'value_equals', value: '{{text}}' } }],
      [{ name: 'text', type: 'string', description: 't', required: true }],
    );
    // value_equals compares against the *stored* value, so the postcondition
    // template is filled at author-time in the seed; here we assert the acted value.
    const { deps, acts } = scriptedDeps([{ nodes: [target] }, { nodes: [after] }]);
    const res = await runSkill(s, { text: 'hello world' }, deps);
    expect(acts[0]).toEqual([7, 'set_value', 'hello world']);
    expect(res.steps[0]!.ok).toBe(true);
  });

  it('rejects missing required params before doing anything', async () => {
    const s = skill([{ action: 'click', ref: ref('Button', 'Send', 'x') }], [{ name: 'to', type: 'string', description: '', required: true }]);
    const { deps, acts } = scriptedDeps([{ nodes: [] }]);
    const res = await runSkill(s, {}, deps);
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe(-1);
    expect(acts).toHaveLength(0);
  });

  it('fails the step when the ref cannot be resolved', async () => {
    const s = skill([{ action: 'click', ref: ref('Button', 'Send', 'send-sig') }]);
    const { deps } = scriptedDeps([{ nodes: [node('Button', 'Discard', 'other', 1)] }]);
    const res = await runSkill(s, {}, deps);
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe(0);
    expect(res.steps[0]!.detail).toContain('could not locate');
  });

  it('self-heals a failed postcondition on retry', async () => {
    const btn = node('Button', 'Send', 'send-sig', 3);
    const dialogGone = node('Button', 'Send', 'send-sig', 3); // still there first check
    const s = skill([{ action: 'click', ref: ref('Button', 'Send', 'send-sig'), postcondition: { kind: 'element_gone' } }]);
    // snapshots: [pre-act], [verify#1 still present], [re-resolve surface], [verify#2 gone]
    const { deps } = scriptedDeps([
      { nodes: [btn] },
      { nodes: [dialogGone] },
      { nodes: [btn] },
      { nodes: [] },
    ]);
    const res = await runSkill(s, {}, deps);
    expect(res.ok).toBe(true);
    expect(res.steps[0]!.healed).toBe(true);
  });

  it('runs raw actions (launch_app) and wait steps', async () => {
    const s = skill([
      { action: 'launch_app', value: 'notepad.exe' },
      { action: 'wait', ms: 100 },
    ]);
    const { deps, raws } = scriptedDeps([{ nodes: [] }]);
    const res = await runSkill(s, {}, deps);
    expect(res.ok).toBe(true);
    expect(raws[0]).toEqual(['launch_app', 'notepad.exe']);
  });
});
