/** Safe local quick check: synthetic acknowledgements, no daemon, accounts,
 * credentials, models, workflow writes, network calls or release enablement. */
import { createDiagnosticsProvider, observeOperation, type Completion, type EventMetadata } from './index.ts';

export async function exerciseFixture(failed: boolean, brokenLogger = false) {
  const scope = { actorId: 'fixture-owner', projectId: 'fixture-project' };
  const sink = createDiagnosticsProvider({ enabled: true, authorize: () => scope,
    logger: () => { if (brokenLogger) throw new Error('fixture logger failure'); } });
  const journeyId = failed ? 'fixture-failed' : 'fixture-success';
  const base = { schemaVersion: 1, correlation: { journeyId, operationId: 'fixture-operation' } } as const;
  const observations: EventMetadata[] = [
    { ...base, eventId: 'step', kind: 'step_transition', stage: 'welcome', from: 'welcome', to: 'explain' },
    { ...base, eventId: 'connection', kind: 'connection_attempt', stage: 'google' },
    { ...base, eventId: 'interview', kind: 'interview_turn', stage: 'interview', model: { provider: 'local', profileId: 'fixture-profile' } },
    { ...base, eventId: 'build', kind: 'build_phase', stage: 'build', phase: 'saving' },
    { ...base, eventId: 'recovery', kind: 'recovery', stage: 'build', recovery: 'reconcile' },
    { ...base, eventId: 'handoff', kind: 'result_handoff', stage: 'result' },
  ];
  try {
    for (const metadata of observations) {
      const ack = await observeOperation(sink, {}, metadata, async (): Promise<Completion> => {
        await Bun.sleep(1); // Simulated operation; elapsed time is actually measured.
        return failed && metadata.kind === 'interview_turn'
          ? { outcome: 'failed', failureCode: 'model_timeout' } : { outcome: 'succeeded', failureCode: 'none' };
      }, { result: result => result });
      if (ack.outcome === 'failed') break;
    }
    // Let this fixture's synchronous logger acknowledgements settle before
    // taking the snapshot. Real operation wrappers never wait for delivery.
    await Promise.resolve();
    return sink.receipt({}, journeyId)!;
  } finally { sink.dispose(); }
}

if (import.meta.main) {
  console.log(JSON.stringify({ evidence: 'synthetic fixture, not live provider or release evidence',
    success: await exerciseFixture(false), failed: await exerciseFixture(true), failedLogger: await exerciseFixture(false, true),
  }, null, 2));
}
