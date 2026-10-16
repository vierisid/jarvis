import { describe, expect, test } from 'bun:test';
import { InterruptionGate, ScreenAlerts, screenIssueKey } from './interruptions';

describe('one urgent interruption per issue, then quiet (Q-19)', () => {
  test('the first claim interrupts; repeats within the window are quiet; after it, one more', () => {
    let now = 0;
    const gate = new InterruptionGate(1000, () => now);
    expect(gate.claim('a')).toBe(true);
    expect(gate.claim('a')).toBe(false);
    expect(gate.claim('b')).toBe(true);
    now = 999;
    expect(gate.claim('a')).toBe(false);
    now = 1000;
    expect(gate.claim('a')).toBe(true);
  });

  test('the same screen error keys the same, whatever its spacing or case; other apps and errors differ', () => {
    const key = screenIssueKey('error', 'Code', 'TypeError: x is undefined');
    expect(screenIssueKey('error', ' code ', 'typeerror:  x is   undefined')).toBe(key);
    expect(screenIssueKey('error', 'Terminal', 'TypeError: x is undefined')).not.toBe(key);
    expect(screenIssueKey('error', 'Code', 'ReferenceError: y')).not.toBe(key);
    expect(screenIssueKey('struggle', 'Code', 'anything')).toBe(screenIssueKey('struggle', 'code'));
    expect(screenIssueKey('struggle', 'Code')).not.toBe(screenIssueKey('error', 'Code'));
  });
});

// Review C3, owner decision: the researched fix is the one interruption.
describe('screen alerts: the fix interrupts, the heads-up does not', () => {
  test('with research under way the heads-up is quiet and the fix interrupts once', () => {
    const alerts = new ScreenAlerts();
    alerts.researchStarted('k');
    expect(alerts.headsUp('k')).toBe('quiet');
    expect(alerts.fix('k')).toBe('interrupt');
    // A second fix, or a later heads-up, about the same issue is quiet.
    expect(alerts.fix('k')).toBe('quiet');
    expect(alerts.headsUp('k')).toBe('quiet');
  });

  test('with no research the heads-up interrupts once', () => {
    const alerts = new ScreenAlerts();
    expect(alerts.headsUp('k')).toBe('interrupt');
    expect(alerts.headsUp('k')).toBe('quiet');
    expect(alerts.headsUp(null)).toBe('interrupt');
  });

  test('research that found nothing lets a later heads-up interrupt', () => {
    const alerts = new ScreenAlerts();
    alerts.researchStarted('k');
    expect(alerts.headsUp('k')).toBe('quiet');
    alerts.researchEnded('k');
    expect(alerts.headsUp('k')).toBe('interrupt');
  });

  test('research that never finishes stops holding the heads-up back after the window', () => {
    let now = 0;
    const alerts = new ScreenAlerts(new InterruptionGate(1000, () => now), () => now, 1000);
    alerts.researchStarted('k');
    expect(alerts.headsUp('k')).toBe('quiet');
    now = 1000;
    expect(alerts.headsUp('k')).toBe('interrupt');
  });
});
