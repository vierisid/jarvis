/**
 * The fixed test items are made beside the notch only while the demo gate is open (./dev.ts).
 */
import { describe, expect, test } from 'bun:test';
import { ApprovalManager } from '../authority/approval.ts';
import type { NotchDemoGateState } from './demo-gate.ts';
import { notchDevFor, type NotchDevGiven } from './dev.ts';

const real = {
  inbox: { showing: () => null },
  approvals: { itemId: (id: string) => `approval:${id}` },
  news: { sync() {} },
} as never;

describe('the test items', () => {
  test('are made only with the gate open and a notch there; otherwise what they are made from is not asked for', () => {
    const asked: string[] = [];
    const given = (gate: string) => (): NotchDevGiven => { asked.push(gate); return { approvalManager: new ApprovalManager() }; };
    for (const gate of ['off', 'too-short', 'refused-hosted', 'notch-off'] as NotchDemoGateState[]) {
      expect([gate, notchDevFor(gate, real, given(gate))]).toEqual([gate, null]);
    }
    expect(notchDevFor('open', null, given('open, no notch'))).toBeNull();
    expect(asked).toEqual([]);
    const made = notchDevFor('open', real, given('open'));
    expect(made?.kinds()).toEqual(['approval', 'payment']);
    expect(asked).toEqual(['open']);
  });
});
