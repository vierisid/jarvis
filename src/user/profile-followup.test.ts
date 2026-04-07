import { afterEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { getUserProfile, saveUserProfile } from '../vault/user-profile.ts';
import {
  clearUserProfileFollowupState,
  maybeCreateUserProfileFollowupPrompt,
  recordUserProfileTurn,
} from './profile-followup.ts';

describe('User Profile Followup', () => {
  afterEach(() => {
    closeDb();
  });

  test('asks an occasional followup for unanswered profile fields', () => {
    initDatabase(':memory:');
    saveUserProfile({
      preferred_name: 'Alex',
      interests: 'AI',
    });

    for (let i = 0; i < 5; i++) {
      recordUserProfileTurn(`message ${i}`);
    }
    expect(maybeCreateUserProfileFollowupPrompt()).toBeNull();

    recordUserProfileTurn('message 5');
    const prompt = maybeCreateUserProfileFollowupPrompt();
    expect(prompt).toContain('One quick question so I can personalize better:');
  });

  test('captures a pending followup answer into the profile', () => {
    initDatabase(':memory:');
    saveUserProfile({
      preferred_name: 'Alex',
      interests: 'AI',
    });

    for (let i = 0; i < 6; i++) {
      recordUserProfileTurn(`message ${i}`);
    }
    const prompt = maybeCreateUserProfileFollowupPrompt();
    expect(prompt).toBeString();

    const result = recordUserProfileTurn('Blunt, concise, and actionable.');
    expect(result.answeredQuestion).toBeDefined();

    const profile = getUserProfile();
    expect(profile?.answers.communication_preferences).toBe('Blunt, concise, and actionable.');
  });

  test('skip clears the pending followup without writing an answer', () => {
    initDatabase(':memory:');
    saveUserProfile({
      preferred_name: 'Alex',
      interests: 'AI',
    });

    for (let i = 0; i < 6; i++) {
      recordUserProfileTurn(`message ${i}`);
    }
    maybeCreateUserProfileFollowupPrompt();

    const result = recordUserProfileTurn('skip');
    expect(result.skippedQuestion).toBeDefined();
    expect(getUserProfile()?.answers.communication_preferences).toBeUndefined();
  });

  test('clear resets followup state', () => {
    initDatabase(':memory:');
    saveUserProfile({
      preferred_name: 'Alex',
      interests: 'AI',
    });

    for (let i = 0; i < 6; i++) {
      recordUserProfileTurn(`message ${i}`);
    }
    expect(maybeCreateUserProfileFollowupPrompt()).toBeString();

    clearUserProfileFollowupState();
    expect(maybeCreateUserProfileFollowupPrompt()).toBeNull();
  });
});
