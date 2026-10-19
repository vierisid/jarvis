import { previewConfiguration } from '../host/preview/fixture.tsx';
import { RETRY, retryProjection } from './retry-fixture';

/** U10's full preview assembly, extended for one named journey: a connected Google
 * account (unless the journey skips it), a failed build with an explicit retry, and
 * a tour replay control. Synthetic only; these are not production retry/replay paths. */
export function journeyAssembly(name: string, onCommand: (entry: string) => void = () => {}) {
  const full = previewConfiguration({ mode: 'full' });
  let failed = name === 'failed-build-retry', retry = 0;
  const observers = new Set<() => void>();
  const notifyFixture = () => observers.forEach(fn => fn());
  for (const [key, binding] of Object.entries(full.config.adapters)) {
    const create = binding.create;
    binding.create = () => {
      const adapter = create(), read = adapter.read, command = adapter.command, subscribe = adapter.subscribe;
      adapter.subscribe = notify => { observers.add(notify); const dispose = subscribe?.(notify); return () => { observers.delete(notify); dispose?.(); }; };
      adapter.read = async context => {
        const result: any = await read(context);
        if (key === 'google' && name !== 'skip-connection-interview') result.model.connection = { state: 'connected', attemptId: 'fixture-attempt', accountLabel: 'demo@example.test', grantedAccessSummary: 'Fixture verification only.' };
        if (key === 'build' && failed) result.model = { ...result.model, status: { jobId: result.model.jobId, revision: 100, outcome: 'failed', safeError: 'Fixture build failed before saving.' }, result: { state: 'pending' }, actions: { retry: true, explore: true } };
        if (retry) result.model = retryProjection(key, result.model);
        return result;
      };
      adapter.command = async (context, action, payload) => {
        onCommand(`${key}:${action}`);
        if (key === 'build' && action === 'retry') { failed = false; retry++; full.setJourney({ revision: full.journey().revision + 1, jobId: RETRY.jobId, buildRequestId: RETRY.requestId }); notifyFixture(); return; }
        return command(context, action, payload);
      };
      return adapter;
    };
  }
  return { ...full, replayTour() {
    full.setJourney({ revision: full.journey().revision + 1, stepId: 'tour', tourState: 'in_progress', tourStepId: 'today' });
    notifyFixture(); onCommand('fixture:replay');
  } };
}
