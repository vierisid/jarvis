import assert from 'node:assert/strict';

const compositionError = 'The workflow could not be composed. Review the request before starting a new build.';
const expectedRecovery = {
  'cancel-before-save': { outcome: 'cancelled', cancellation: 'acknowledged', safeError: undefined },
  'model-failure': { outcome: 'failed', cancellation: 'not_requested', safeError: compositionError },
  'timeout': { outcome: 'failed', cancellation: 'not_requested', safeError: 'The build timed out before a draft was saved. Review the request before starting a new build.' },
  'unsupported-node': { outcome: 'failed', cancellation: 'not_requested', safeError: compositionError },
} as const;
type NoDraftRecovery = keyof typeof expectedRecovery;
export const isNoDraftRecovery = (mode: string): mode is NoDraftRecovery => Object.hasOwn(expectedRecovery, mode);

// Structural observations keep the verifier independent of optional providers.
interface JobObservation {
  jobId: string; requestId: string; revision: number; outcome: string; cancellation: string;
  resolution: string; artifact: unknown; journeySync: string; safeError?: string; missingInputs: string[];
}
interface ResultObservation {
  availability: string; state: string; jobId: string | null; requestId: string; revision: number;
  outcome: string | null; cancellation: string;
}
export function assertNoDraftRecovery(mode: NoDraftRecovery, job: JobObservation, result: ResultObservation) {
  const expected = expectedRecovery[mode];
  assert.equal(job.outcome, expected.outcome, `${mode}: job outcome`);
  assert.equal(job.cancellation, expected.cancellation, `${mode}: cancellation`);
  assert.equal(job.safeError, expected.safeError, `${mode}: safe error`);
  assert.equal(job.resolution, 'none'); assert.equal(job.artifact, null);
  assert.equal(job.journeySync, 'settled'); assert.deepEqual(job.missingInputs, []);
  assert.equal(result.availability, 'ready'); assert.equal(result.state, 'no_draft');
  assert.equal(result.jobId, job.jobId); assert.equal(result.requestId, job.requestId); assert.equal(result.revision, job.revision);
  assert.equal(result.outcome, expected.outcome); assert.equal(result.cancellation, expected.cancellation);
}
