import { getWorkflowDb } from '../../workflows/db';
import type { JourneyPort } from './types';
const journeyPath = '../journey/index.ts';
export async function realJourney(owner: { actorId: string; projectId: string }) {
  const { createJourneyProvider, createSettingsJourneyPersistence } = await import(journeyPath);
  getWorkflowDb().exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const journey = createJourneyProvider({ authorize: () => owner, persistence: createSettingsJourneyPersistence({
    databaseForScope: () => getWorkflowDb(), readLegacy: () => ({ setup_completed: true, setup_skipped_profile: false,
      profile_completed: true, tutorial_completed: false, tutorial_dismissed: false, tutorial_progress_step: null }),
  }) });
  const initial = await journey.read();
  if (initial.availability !== 'ready') throw new Error('journey unavailable');
  if (initial.snapshot.stepId === 'tour') await journey.acknowledge({ journeyId: initial.snapshot.journeyId,
    expectedRevision: initial.snapshot.revision, requestId: 'complete-tour', command: { type: 'tour_finished', state: 'done' } });
  return journey as JourneyPort;
}
