import { expect, test } from 'bun:test';
import { assertNoDraftRecovery } from './recovery';

const cases = [
  { mode: 'cancel-before-save', outcome: 'cancelled', cancellation: 'acknowledged', safeError: undefined },
  { mode: 'model-failure', outcome: 'failed', cancellation: 'not_requested', safeError: 'The workflow could not be composed. Review the request before starting a new build.' },
  { mode: 'timeout', outcome: 'failed', cancellation: 'not_requested', safeError: 'The build timed out before a draft was saved. Review the request before starting a new build.' },
  { mode: 'unsupported-node', outcome: 'failed', cancellation: 'not_requested', safeError: 'The workflow could not be composed. Review the request before starting a new build.' },
] as const;

for (const { mode, ...terminal } of cases) {
  const job = { ...terminal, jobId: 'job', requestId: 'request', revision: 10,
    resolution: 'none', artifact: null, journeySync: 'settled', missingInputs: [] };
  const result = { availability: 'ready', state: 'no_draft', jobId: 'job', requestId: 'request', revision: 10,
    outcome: terminal.outcome, cancellation: terminal.cancellation };
  test(`${mode} rejects a different terminal outcome even when both providers agree`, () => {
    expect(() => assertNoDraftRecovery(mode, job, result)).not.toThrow();
    for (const outcome of ['queued', 'working', 'succeeded', 'cancelled', 'failed', 'needs_input'].filter(v => v !== terminal.outcome))
      expect(() => assertNoDraftRecovery(mode, { ...job, outcome }, { ...result, outcome })).toThrow(`${mode}: job outcome`);
  });
  test(`${mode} rejects incomplete cancellation, wrong failure reason and contradictory result recovery`, () => {
    for (const change of [
      { cancellation: 'requested' }, { safeError: 'A different failure occurred.' },
      { resolution: 'unknown' }, { artifact: { flowId: 'unexpected-draft' } },
      { journeySync: 'pending' }, { missingInputs: ['unexpected-input'] },
    ]) expect(() => assertNoDraftRecovery(mode, { ...job, ...change }, result)).toThrow();
    for (const change of [
      { availability: 'unavailable' }, { state: 'pending' }, { state: 'saved' },
      { outcome: 'needs_input' }, { cancellation: 'requested' },
      { jobId: 'other-job' }, { requestId: 'other-request' }, { revision: 9 },
    ]) expect(() => assertNoDraftRecovery(mode, job, { ...result, ...change })).toThrow();
  });
}
