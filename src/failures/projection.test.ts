import { describe, expect, test } from 'bun:test';
import { ActionOutcomeError } from '../actions/action-outcome';
import { LLMProviderError } from '../llm/provider';
import { HostedProxyError } from '../util/hosted-error';
import { SidecarRPCError } from '../sidecar/rpc';
import { WorkflowReadinessError } from '../workflows/db/repos/flow-readiness';
import { WorkflowCancellationError } from '../workflows/runtime/cancellation-error';
import { failureEvidence, providerOutcome } from './evidence';
import { BackgroundThrottled } from '../llm/background-budget';
import { DIAGNOSIS_FIXTURES } from './fixtures';
import { projectFailure, type FailureEvidence } from './projection';

describe('diagnosis fixtures (Q-19)', () => {
  for (const fixture of DIAGNOSIS_FIXTURES) {
    test(fixture.name, () => {
      const failure = projectFailure(fixture.evidence, fixture.subject, { runId: 'run-1', stepName: 'send' });
      expect({ category: failure.category, effect: failure.effect, next: failure.next.map(n => n.step) }).toEqual(fixture.expect);
      expect(failure.headline.startsWith(fixture.subject.label)).toBe(true);
      expect(failure.links).toEqual({ runId: 'run-1', stepName: 'send' });
      // Never claims nothing happened when it may have.
      if (failure.effect !== 'none') expect(failure.outcome).not.toContain('Nothing was done');
    });
  }
});

describe('the projection reads typed evidence, never wording', () => {
  test('the same typed evidence with different wording reads the same', () => {
    const subject = { label: 'The step', sideEffects: true };
    const a = projectFailure({ source: 'action', outcome: { status: 'blocked', code: 'WORKFLOW_MACHINE_OFFLINE', message: 'offline', effect: 'not_started' } }, subject);
    const b = projectFailure({ source: 'action', outcome: { status: 'blocked', code: 'WORKFLOW_MACHINE_OFFLINE', message: 'quota exceeded, approval denied, timed out', effect: 'not_started' } }, subject);
    expect([a.category, a.headline, a.outcome, a.key]).toEqual([b.category, b.headline, b.outcome, b.key]);
  });

  test('an untyped error is internal whatever it says', () => {
    for (const message of ['429 rate limit', 'approval denied', 'ECONNREFUSED', 'timed out']) {
      expect(projectFailure(failureEvidence(new Error(message)), { label: 'The step', sideEffects: true }).category).toBe('internal');
    }
  });

  test('typed errors become typed evidence', () => {
    const outcome = { status: 'unknown' as const, code: 'LOST_REPLY', message: 'lost', effect: 'may_have_occurred' as const };
    expect(failureEvidence(new ActionOutcomeError(outcome))).toEqual({ source: 'action', outcome });
    expect(failureEvidence(new LLMProviderError('slow down', 'rate_limit'))).toMatchObject({ source: 'provider', code: 'rate_limit' });
    expect(failureEvidence(new HostedProxyError('used up', 'quota_exhausted', 402))).toMatchObject({ source: 'provider', code: 'quota_exhausted' });
    expect(failureEvidence(new HostedProxyError('no', 'model_not_in_plan', 403))).toMatchObject({ source: 'provider', code: 'forbidden' });
    expect(failureEvidence(new WorkflowReadinessError({ ready: false, issues: [{ node: 'a', path: 'p', code: 'TOOL_BINDING', message: 'm' }], runtimeChecks: [] })))
      .toEqual({ source: 'readiness', issues: [{ code: 'TOOL_BINDING', message: 'm' }] });
    expect(failureEvidence(new WorkflowCancellationError('run-1'))).toMatchObject({ source: 'cancellation', dispatched: true });
    expect(failureEvidence(new SidecarRPCError('METHOD_NOT_FOUND', 'no handler'))).toMatchObject({ outcome: { status: 'blocked', effect: 'not_started' } });
    expect(failureEvidence(new SidecarRPCError('HANDLER_PANIC', 'crashed'))).toMatchObject({ outcome: { status: 'unknown', effect: 'may_have_occurred' } });
  });

  // Q-20 #1064: Jarvis's own background budget refused it before any provider
  // call. A pause with its wait, never a provider failure, and an AI step that
  // was refused this way processed nothing.
  test('a background throttle is a resource pause with its wait, not a provider failure', () => {
    const throttled = new BackgroundThrottled('daily_budget', Date.now() + 9 * 60_000);
    const evidence = failureEvidence(throttled);
    expect(evidence).toMatchObject({ source: 'provider', code: 'background_throttled' });
    const failure = projectFailure(evidence, { label: 'The step "Summarize"', sideEffects: false });
    expect(failure).toMatchObject({ category: 'resource_paused', effect: 'none', outcome: 'Nothing was done.' });
    expect(failure.headline).toMatch(/^The step "Summarize" was paused: Jarvis is holding back background AI work for now, for about (9|10) minutes\.$/);
    expect(failure.headline).not.toContain('failed');
    expect(providerOutcome(throttled)).toMatchObject({ code: 'PROVIDER_BACKGROUND_THROTTLED', effect: 'not_started' });
    expect(projectFailure(failureEvidence(new BackgroundThrottled('foreground_busy', null)), { label: 'Your request', sideEffects: false }).headline)
      .toBe('Your request was paused: Jarvis is holding back background AI work for now.');
  });
});

describe('detail and identity', () => {
  test('credentials are redacted from the detail, and the original is not altered', () => {
    const message = 'POST https://api.telegram.org/bot123456789:AAFakeTokenFakeTokenFakeToken12/sendMessage failed with sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
    const evidence: FailureEvidence = { source: 'unknown', message };
    const failure = projectFailure(evidence, { label: 'The message', sideEffects: true });
    expect(failure.detail).not.toContain('AAFakeToken');
    expect(failure.detail).not.toContain('sk-ant-api03-abcdef');
    expect(failure.detail).toContain('***redacted***');
    expect(evidence.message).toBe(message);
  });

  test('the detail is bounded', () => {
    expect(projectFailure({ source: 'unknown', message: 'x'.repeat(10_000) }, { label: 'The step', sideEffects: false }).detail.length).toBeLessThanOrEqual(1200);
  });

  test('one failure has one key; another run or step has another', () => {
    const evidence: FailureEvidence = { source: 'action', outcome: { status: 'blocked', code: 'APPROVAL_DENIED', message: 'denied', effect: 'not_started' } };
    const subject = { label: 'The step', sideEffects: true };
    const key = (links: Record<string, string>) => projectFailure(evidence, subject, links).key;
    expect(key({ runId: 'r1', stepName: 's' })).toBe(key({ runId: 'r1', stepName: 's' }));
    expect(key({ runId: 'r1', stepName: 's' })).not.toBe(key({ runId: 'r2', stepName: 's' }));
    expect(key({ runId: 'r1', stepName: 's' })).not.toBe(key({ runId: 'r1', stepName: 't' }));
  });

  test('every recovery step is advice the person starts, and details are always offered', () => {
    for (const fixture of DIAGNOSIS_FIXTURES) {
      const failure = projectFailure(fixture.evidence, fixture.subject);
      expect(failure.next.at(-1)!.step).toBe('open_details');
      for (const step of failure.next) expect(step.label.length).toBeGreaterThan(0);
    }
  });
});


test('browser sign-in failure keeps the setup instruction without claiming no earlier effect', () => {
  const failure = projectFailure({ source: 'action', outcome: { status: 'blocked', code: 'BROWSER_SIGN_IN_REQUIRED',
    effect: 'may_have_occurred', message: 'Private account details' } }, { label: 'Calendar step', sideEffects: true });
  expect(failure.headline).toContain('sign-in is required in the Jarvis browser');
  expect(failure.effect).toBe('unknown'); expect(failure.outcome).not.toContain('Nothing was done');
  expect(failure.headline).not.toContain('Private account');
});
