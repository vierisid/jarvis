/** Synthetic retry identity shared by the build and result projections. */
export const RETRY = { jobId: 'fixture-retry', requestId: 'fixture-request-retry' };
export function retryProjection(name: string, model: any) {
  if (name === 'build') return { ...model, ...RETRY, status: { ...model.status, jobId: RETRY.jobId },
    result: model.result.state === 'ready' ? { ...model.result, reference: { ...model.result.reference, ...RETRY } } : model.result };
  if (name === 'result') return { ...model, ...RETRY, result: { ...model.result, ...RETRY,
    reference: { ...model.result.reference, ...RETRY },
    recovery: { ...model.result.recovery, input: { ...model.result.recovery.input, jobId: RETRY.jobId } },
  } };
  return model;
}
