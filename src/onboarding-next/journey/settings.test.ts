import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, initDatabase } from '../../vault/schema.ts';
import { getSetting } from '../../vault/settings.ts';
import { getUserProfile, saveUserProfile } from '../../vault/user-profile.ts';
import { hasUserProfile } from '../../user/profile.ts';
import { loadUserSectionStrict, saveUserSection } from '../../daemon/user-settings.ts';
import type { OnboardingConfig } from '../../config/types.ts';
import { createJourneyProvider, createSettingsJourneyPersistence } from './index.ts';

let dir: string | undefined;
afterEach(() => { closeDb(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

test('real vault/user-settings/profile services remain readable after provider restart and rollback', async () => {
  dir = mkdtempSync(join(tmpdir(), 'on-b-01-vault-'));
  const path = join(dir, 'vault.sqlite');
  initDatabase(path, { quiet: true });
  saveUserSection('onboarding', { setup_completed_at: 123, tutorial_completed_at: 456 });
  saveUserProfile({ preferred_name: 'Isolated fixture' });
  const legacyRow = getSetting('cfg.onboarding');
  const profile = getUserProfile();
  const make = () => createJourneyProvider({
    authorize: () => ({ actorId: 'fixture-user', projectId: 'fixture-project' }),
    persistence: createSettingsJourneyPersistence({
      databaseForScope: () => getDb(),
      readLegacy: () => {
        const o = loadUserSectionStrict('onboarding') as OnboardingConfig | undefined;
        return {
          setup_completed: o?.setup_completed_at != null,
          setup_skipped_profile: !!o?.setup_skipped_profile,
          profile_completed: hasUserProfile(getUserProfile()),
          tutorial_completed: o?.tutorial_completed_at != null,
          tutorial_dismissed: o?.tutorial_dismissed_at != null,
          tutorial_progress_step: o?.tutorial_progress_step ?? null,
        };
      },
    }),
  });
  const first = await make().read();
  expect(first).toMatchObject({ availability: 'ready', snapshot: { completion: 'legacy_completed' } });
  if (first.availability !== 'ready') throw new Error('No journey');
  const replay = await make().transition({ journeyId: first.snapshot.journeyId, expectedRevision: 0, requestId: 'replay', command: { type: 'replay_tutorial' } });
  expect(replay).toMatchObject({ availability: 'ready', snapshot: { stepId: 'tour', completion: 'legacy_completed' } });
  closeDb(); initDatabase(path, { quiet: true });
  expect((await make().read()).snapshot).toEqual(replay.snapshot);
  // An old user-settings writer does not know the journey row and cannot erase it.
  saveUserSection('onboarding', { setup_completed_at: 123, tutorial_completed_at: 456 });
  expect((await make().read()).snapshot).toEqual(replay.snapshot);
  expect(getSetting('cfg.onboarding')).toBe(legacyRow);
  expect(getUserProfile()).toEqual(profile);
});
