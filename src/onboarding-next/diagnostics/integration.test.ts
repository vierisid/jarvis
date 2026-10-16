import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createDiagnosticsProvider, observeOperation, type Completion, type DiagnosticInput } from './index.ts';

// Optional real owners are discovered only by this test, never by the module.
const runtimePath = join(import.meta.dir, '../runtime/runtime.ts');
const journeyPath = join(import.meta.dir, '../journey/index.ts');
const combined = existsSync(runtimePath) && existsSync(journeyPath);
const owner = { actorId: 'fixture-owner', projectId: 'fixture-project' };

for (const mode of ['present', 'absent', 'disabled', 'throw', 'hang'] as const) {
  test.skipIf(!combined)(`real SQLite journey transitions preserve results with diagnostics ${mode}`, async () => {
    const { createOnboardingRuntime } = await import(runtimePath);
    const { fixtureOptions, request } = await import(join(import.meta.dir, '../runtime/test-fixture.ts'));
    const { createOnboardingRoutes } = await import(join(import.meta.dir, '../runtime/routes.ts'));
    const { createJourneyProvider, createSettingsJourneyPersistence } = await import(journeyPath);
    const db = new Database(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');
    let logs = 0;
    const sink = createDiagnosticsProvider({ enabled: mode !== 'disabled', authorize: () => owner, deliveryTimeoutMs: 5,
      logger: () => { logs++; if (mode === 'throw') throw new Error('private logger error'); if (mode === 'hang') return new Promise<void>(() => {}); } });
    try {
      const journey = createJourneyProvider({ authorize: () => owner, persistence: createSettingsJourneyPersistence({
        databaseForScope: () => db, readLegacy: () => ({ setup_completed: false, setup_skipped_profile: false,
          profile_completed: false, tutorial_completed: false, tutorial_dismissed: false, tutorial_progress_step: null }),
      }) });
      const o = fixtureOptions();
      // Real journey + diagnostics; the remaining closure and release decision are
      // explicit test doubles. This never claims a production-ready full journey.
      if (mode === 'absent') o.modules = o.modules.filter((m: { manifest: { id: string } }) => m.manifest.id !== 'ON-B-12');
      o.bindings['diagnostics.v1'] = () => sink;
      o.bindings['journey.v1'] = () => ({ probe: () => ({ ready: true, reason: 'ready' }), operations: {
        'journey.read': () => journey.read(),
        'journey.transition': (input: { journeyId: string; requestId: string }) => observeOperation(mode === 'absent' ? null : sink, {}, {
          schemaVersion: 1, eventId: input.requestId, kind: 'step_transition', stage: 'welcome', from: 'welcome', to: 'explain',
          correlation: { journeyId: input.journeyId, operationId: input.requestId, requestId: input.requestId },
        }, () => journey.transition(input), { result: (r: { availability: string; reason?: string }): Completion => r.availability === 'ready'
          ? { outcome: 'succeeded', failureCode: 'none' } : { outcome: 'failed', failureCode: r.reason === 'revision_conflict' ? 'conflict' : 'unknown' } }),
      } });
      const runtime = createOnboardingRuntime(o);
      expect((await runtime.status(request())).ready).toBe(true);
      expect(db.query('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 0 });
      const first = await runtime.execute(request(), 'journey.read', {});
      expect(first).toMatchObject({ availability: 'ready', snapshot: { stepId: 'welcome', revision: 0 } });
      const input = { journeyId: first.snapshot.journeyId, expectedRevision: 0, requestId: 'first', command: { type: 'navigate', stepId: 'explain' } };
      expect(await runtime.execute(request(), 'journey.transition', input)).toMatchObject({ availability: 'ready', snapshot: { stepId: 'explain', revision: 1 } });
      const saved = db.query('SELECT value FROM settings').get();
      expect(await runtime.execute(request(), 'journey.transition', { ...input, requestId: 'stale' })).toMatchObject({ availability: 'unavailable', reason: 'revision_conflict' });
      expect(db.query('SELECT value FROM settings').get()).toEqual(saved);
      if (mode === 'absent' || mode === 'disabled') {
        expect(sink.receipt({}, input.journeyId)).toBeNull(); expect(logs).toBe(0);
      } else {
        const receipt = sink.receipt({}, input.journeyId)!;
        expect(receipt.events.map(e => [e.stage, e.outcome, e.failureCode])).toEqual([
          ['welcome', 'succeeded', 'none'], ['welcome', 'failed', 'conflict'],
        ]);
        expect(receipt.events.every(e => e.durationMs !== null && e.durationMs >= 0)).toBe(true);
        expect(JSON.stringify(receipt)).not.toContain(input.journeyId);
      }
      if (mode === 'throw' || mode === 'hang') {
        await Bun.sleep(15);
        expect(sink.receipt({}, input.journeyId)!.delivery).toBe(mode === 'throw' ? 'failed' : 'timed_out');
        expect(logs).toBe(1);
      }
      expect((await runtime.status(request())).ready).toBe(true);
      expect(Object.keys(createOnboardingRoutes(runtime)).some(path => path.includes('diagnostic'))).toBe(false);
    } finally { sink.dispose(); db.close(); }
  });
}

test('duration excludes diagnostic classification work, including on thrown operations', async () => {
  let now = 0; const inputs: DiagnosticInput[] = [];
  const sink = { record(_context: unknown, input: unknown) { inputs.push(input as DiagnosticInput); } };
  const metadata = { schemaVersion: 1, eventId: 'timing', kind: 'interview_turn', stage: 'interview', correlation: { journeyId: 'j', operationId: 'op' } } as const;
  await observeOperation(sink, {}, metadata, () => { now = 10; return true; }, {
    now: () => now, result: () => { now = 100; return { outcome: 'succeeded', failureCode: 'none' }; },
  });
  const error = new Error('private');
  await expect(observeOperation(sink, {}, metadata, () => { now = 120; throw error; }, {
    now: () => now, error: () => { now = 300; return { outcome: 'failed', failureCode: 'model_timeout' }; },
  })).rejects.toBe(error);
  expect(inputs.map(e => e.durationMs)).toEqual([10, 20]);
});
