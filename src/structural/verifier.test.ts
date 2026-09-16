import { describe, expect, it } from 'bun:test';
import { verifyPostcondition, nextHealRung, HEAL_LADDER, type HealRung, type VerifyContext } from './verifier.ts';
import type { SemanticNode, SemanticRef } from './types.ts';

function node(p: {
  role: string;
  name: string;
  sig?: string;
  value?: string | null;
  focused?: boolean;
  sessionId?: number;
}): SemanticNode {
  return {
    ref: { role: p.role, name: p.name, path: [], ordinal: 0, sig: p.sig ?? '' },
    role: p.role,
    name: p.name,
    value: p.value ?? null,
    state: { enabled: true, focused: p.focused },
    bounds: null,
    actions: ['click'],
    sessionId: p.sessionId ?? 1,
  };
}
function ref(role: string, name: string, sig = ''): SemanticRef {
  return { role, name, path: [], ordinal: 0, sig };
}
function ctx(partial: Partial<VerifyContext>): VerifyContext {
  return { before: [], after: [], surfacePresent: true, ...partial };
}

describe('verifyPostcondition', () => {
  it('window_appeared is NOT satisfied by the same unchanged surface', () => {
    // The regression this guards: ui_act re-captures the window it acted on,
    // so "the surface has nodes" is true before the click as well. Checking
    // only that reported success for every action, including a no-op one.
    const same = [node({ role: 'Button', name: 'File', sig: 'f' })];
    const r = verifyPostcondition(
      { kind: 'window_appeared' },
      ctx({ before: same, after: same, beforeTitle: 'Notepad', afterTitle: 'Notepad' }),
    );
    expect(r.satisfied).toBe(false);
    expect(r.detail).toContain('unchanged');
  });

  it('window_appeared passes when content the before-surface lacked shows up', () => {
    const before = [node({ role: 'Button', name: 'File', sig: 'f' })];
    const after = [...before, node({ role: 'Dialog', name: 'Save changes?', sig: 'd' })];
    const r = verifyPostcondition({ kind: 'window_appeared' }, ctx({ before, after }));
    expect(r.satisfied).toBe(true);
    expect(r.detail).toContain('Save changes?');
  });

  it('window_appeared passes on a title change alone', () => {
    const same = [node({ role: 'Button', name: 'File', sig: 'f' })];
    const r = verifyPostcondition(
      { kind: 'window_appeared' },
      ctx({ before: same, after: same, beforeTitle: 'Untitled - Notepad', afterTitle: 'Open' }),
    );
    expect(r.satisfied).toBe(true);
    expect(r.detail).toContain('Open');
  });

  it('window_appeared fails when no surface is left at all', () => {
    expect(verifyPostcondition({ kind: 'window_appeared' }, ctx({ surfacePresent: false })).satisfied).toBe(false);
  });

  it('element_present passes only when the ref resolves', () => {
    const target = node({ role: 'Button', name: 'Send', sig: 'abc' });
    expect(verifyPostcondition({ kind: 'element_present', ref: ref('Button', 'Send', 'abc') }, ctx({ after: [target] })).satisfied).toBe(true);
    expect(verifyPostcondition({ kind: 'element_present', ref: ref('Button', 'Send', 'abc') }, ctx({ after: [] })).satisfied).toBe(false);
  });

  it('element_gone is the inverse', () => {
    const target = node({ role: 'Dialog', name: 'Save changes?', sig: 'd1' });
    expect(verifyPostcondition({ kind: 'element_gone', ref: ref('Dialog', 'Save changes?', 'd1') }, ctx({ after: [target] })).satisfied).toBe(false);
    expect(verifyPostcondition({ kind: 'element_gone', ref: ref('Dialog', 'Save changes?', 'd1') }, ctx({ after: [] })).satisfied).toBe(true);
  });

  it('value_equals compares trimmed values', () => {
    const field = node({ role: 'Edit', name: 'To', sig: 'to', value: '  nobody@example.com ' });
    const pass = verifyPostcondition({ kind: 'value_equals', ref: ref('Edit', 'To', 'to'), value: 'nobody@example.com' }, ctx({ after: [field] }));
    expect(pass.satisfied).toBe(true);
    const failr = verifyPostcondition({ kind: 'value_equals', ref: ref('Edit', 'To', 'to'), value: 'someone@else.com' }, ctx({ after: [field] }));
    expect(failr.satisfied).toBe(false);
    expect(failr.detail).toContain('nobody@example.com');
  });

  it('title_changed requires a different non-empty title', () => {
    expect(verifyPostcondition({ kind: 'title_changed', from: 'Untitled' }, ctx({ afterTitle: 'doc1' })).satisfied).toBe(true);
    expect(verifyPostcondition({ kind: 'title_changed', from: 'Untitled' }, ctx({ afterTitle: 'Untitled' })).satisfied).toBe(false);
  });

  it('focus_moved passes when focus left the original element', () => {
    const now = node({ role: 'Edit', name: 'Body', sig: 'body', focused: true });
    const moved = verifyPostcondition({ kind: 'focus_moved', fromRef: ref('Edit', 'To', 'to') }, ctx({ after: [now] }));
    expect(moved.satisfied).toBe(true);
    const stuck = verifyPostcondition({ kind: 'focus_moved', fromRef: ref('Edit', 'Body', 'body') }, ctx({ after: [now] }));
    expect(stuck.satisfied).toBe(false);
  });
});

describe('nextHealRung', () => {
  it('climbs the ladder in order, then exhausts', () => {
    expect(nextHealRung({ attempted: [] })).toBe('re_resolve');
    expect(nextHealRung({ attempted: ['re_resolve'] })).toBe('settle');
    expect(nextHealRung({ attempted: ['re_resolve', 'settle'] })).toBe('report');
    expect(nextHealRung({ attempted: ['re_resolve', 'settle', 'report'] })).toBeNull();
  });

  it('every rung the ladder names is one ui_act can actually climb', () => {
    // A rung ui_act cannot reach is a rung that never runs. The ladder used
    // to name `vision` and `ask`, neither of which this layer can perform.
    const climbed: HealRung[] = [];
    for (;;) {
      const rung = nextHealRung({ attempted: climbed });
      if (rung === null) break;
      climbed.push(rung);
    }
    expect(climbed).toEqual([...HEAL_LADDER]);
  });
});
