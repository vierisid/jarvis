import { describe, expect, it } from 'bun:test';
import { verifyPostcondition, nextHealRung, type VerifyContext } from './verifier.ts';
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
  it('window_appeared reflects surface presence', () => {
    expect(verifyPostcondition({ kind: 'window_appeared' }, ctx({ surfacePresent: true })).satisfied).toBe(true);
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
  it('climbs the ladder in order then reports done', () => {
    expect(nextHealRung({ attempted: [] })).toBe('re_resolve');
    expect(nextHealRung({ attempted: ['re_resolve'] })).toBe('retry');
    expect(nextHealRung({ attempted: ['re_resolve', 'retry'] })).toBe('vision');
    expect(nextHealRung({ attempted: ['re_resolve', 'retry', 'vision'] })).toBe('ask');
    expect(nextHealRung({ attempted: ['re_resolve', 'retry', 'vision', 'ask'] })).toBe('done');
  });
});
