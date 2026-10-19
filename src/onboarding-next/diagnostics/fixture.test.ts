import { expect, test } from 'bun:test';
import { exerciseFixture } from './fixture.ts';

test('quick check shows a completed fixture and a specific failure without private content', async () => {
  const success = await exerciseFixture(false), failed = await exerciseFixture(true), broken = await exerciseFixture(false, true);
  expect(success.events.map(e => e.kind)).toEqual(['step_transition', 'connection_attempt', 'interview_turn', 'build_phase', 'recovery', 'result_handoff']);
  expect(success.events.every(e => e.outcome === 'succeeded' && e.durationMs !== null)).toBe(true);
  expect(success.delivery).toBe('idle'); expect(failed.delivery).toBe('idle');
  expect(failed.events.at(-1)).toMatchObject({ stage: 'interview', outcome: 'failed', failureCode: 'model_timeout' });
  expect(failed.events.some(e => e.kind === 'result_handoff')).toBe(false);
  expect(broken.events.at(-1)).toMatchObject({ kind: 'result_handoff', outcome: 'succeeded' });
  expect(broken.delivery).toBe('failed');
  for (const value of ['fixture-owner', 'fixture-project', 'fixture-success', 'fixture-failed', 'fixture-profile', 'fixture logger failure']) {
    expect(JSON.stringify({ success, failed, broken })).not.toContain(value);
  }
});
