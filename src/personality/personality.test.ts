import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import {
  getPersonality,
  savePersonality,
  updatePersonality,
  type PersonalityModel,
} from './model.ts';
import {
  extractSignals,
  applySignals,
  recordInteraction,
} from './learner.ts';
import {
  getChannelPersonality,
  personalityToPrompt,
} from './adapter.ts';

describe('Personality Engine', () => {
  beforeEach(() => {
    // Initialize in-memory database for each test
    initDatabase(':memory:');
  });

  afterEach(() => {
    // Close database connection after each test
    closeDb();
  });

  describe('Model', () => {
    test('should get default personality', () => {
      const personality = getPersonality();

      expect(personality.core_traits).toEqual(['direct', 'strategic', 'resourceful']);
      expect(personality.learned_preferences.verbosity).toBe(5);
      expect(personality.learned_preferences.formality).toBe(5);
      expect(personality.relationship.message_count).toBe(0);
    });

    test('default personality is not shared across calls', () => {
      const first = getPersonality();
      first.relationship.message_count = 99;
      first.core_traits.push('mutated');

      const second = getPersonality();
      expect(second.relationship.message_count).toBe(0);
      expect(second.core_traits).toEqual(['direct', 'strategic', 'resourceful']);
    });

    test('should save and load personality', () => {
      const personality = getPersonality();
      personality.learned_preferences.verbosity = 8;
      personality.relationship.message_count = 42;

      savePersonality(personality);

      const loaded = getPersonality();
      expect(loaded.learned_preferences.verbosity).toBe(8);
      expect(loaded.relationship.message_count).toBe(42);
    });

    test('should update personality with deep merge', () => {
      const updated = updatePersonality({
        learned_preferences: {
          verbosity: 7,
        },
      });

      expect(updated.learned_preferences.verbosity).toBe(7);
      expect(updated.learned_preferences.formality).toBe(5); // unchanged
      expect(updated.core_traits).toEqual(['direct', 'strategic', 'resourceful']); // unchanged
    });
  });

  describe('Learner', () => {
    test('should extract verbosity signals', () => {
      const signals = extractSignals('Please keep it brief and concise', 'Here is a long response...');

      expect(signals.length).toBeGreaterThan(0);
      const verbositySignal = signals.find((s) => s.data.preference === 'verbosity');
      expect(verbositySignal).toBeDefined();
      expect(verbositySignal?.data.direction).toBe(-1);
    });

    test('should extract formality signals', () => {
      const signals = extractSignals('Be more casual please', 'Understood.');

      const formalitySignal = signals.find((s) => s.data.preference === 'formality');
      expect(formalitySignal).toBeDefined();
      expect(formalitySignal?.data.direction).toBe(-1);
    });

    test('should extract emoji usage signals', () => {
      const signals = extractSignals('Great work! 🎉✨', 'Thank you!');

      const emojiSignal = signals.find((s) => s.data.preference === 'emoji_usage');
      expect(emojiSignal).toBeDefined();
      expect(emojiSignal?.data.value).toBe(true);
    });

    test('should extract format preference signals', () => {
      const signals = extractSignals('Can you show this as a table?', 'Sure!');

      const formatSignal = signals.find((s) => s.data.preference === 'preferred_format');
      expect(formatSignal).toBeDefined();
      expect(formatSignal?.data.value).toBe('tables');
    });

    test('should apply signals to personality', () => {
      const personality = getPersonality();
      const initialVerbosity = personality.learned_preferences.verbosity;
      const initialFormality = personality.learned_preferences.formality;

      const signals = [
        { type: 'user_feedback' as const, data: { preference: 'verbosity', direction: 2 } },
        { type: 'explicit_preference' as const, data: { preference: 'formality', direction: -1 } },
      ];

      const updated = applySignals(personality, signals);

      expect(updated.learned_preferences.verbosity).toBe(initialVerbosity + 2);
      expect(updated.learned_preferences.formality).toBe(initialFormality - 1);
    });

    test('should clamp values to 0-10 range', () => {
      let personality = getPersonality();
      personality.learned_preferences.verbosity = 9;

      const signals = [
        { type: 'user_feedback' as const, data: { preference: 'verbosity', direction: 5 } },
      ];

      personality = applySignals(personality, signals);

      expect(personality.learned_preferences.verbosity).toBe(10); // clamped
    });

    test('should record interactions and increase trust', () => {
      let personality = getPersonality();
      const initialCount = personality.relationship.message_count;

      // Simulate 50 interactions
      for (let i = 0; i < 50; i++) {
        personality = recordInteraction(personality);
      }

      expect(personality.relationship.message_count).toBe(initialCount + 50);
      // Trust should increase based on message count
      expect(personality.relationship.trust_level).toBeGreaterThan(3);
    });
  });

  describe('Adapter', () => {
    test('should adapt personality for WhatsApp', () => {
      const base = getPersonality();
      const adapted = getChannelPersonality(base, 'whatsapp');

      expect(adapted.learned_preferences.emoji_usage).toBe(true);
      expect(adapted.learned_preferences.verbosity).toBe(4);
      expect(adapted.learned_preferences.formality).toBe(3);
    });

    test('should adapt personality for email', () => {
      const base = getPersonality();
      const adapted = getChannelPersonality(base, 'email');

      expect(adapted.learned_preferences.emoji_usage).toBe(false);
      expect(adapted.learned_preferences.verbosity).toBe(7);
      expect(adapted.learned_preferences.formality).toBe(8);
    });

    test('should use stored channel overrides', () => {
      const personality = getPersonality();
      personality.channel_overrides.custom_channel = {
        learned_preferences: {
          verbosity: 10,
          formality: 0,
          humor_level: 10,
          emoji_usage: true,
          preferred_format: 'lists',
        },
      };

      const adapted = getChannelPersonality(personality, 'custom_channel');

      expect(adapted.learned_preferences.verbosity).toBe(10);
      expect(adapted.learned_preferences.formality).toBe(0);
    });

    test('should generate personality prompt', () => {
      const personality = getPersonality();
      personality.relationship.message_count = 25;
      personality.relationship.shared_references = ['Project X', 'Anna'];

      const prompt = personalityToPrompt(personality);

      expect(prompt).toContain('Personality');
      expect(prompt).toContain('direct, strategic, resourceful');
      expect(prompt).toContain('25 interactions');
      expect(prompt).toContain('Project X, Anna');
    });
  });

  describe('Integration', () => {
    test('should handle full learning cycle', () => {
      // Start with default personality
      let personality = getPersonality();
      const initialVerbosity = personality.learned_preferences.verbosity;

      // User sends multiple messages asking for brevity
      const userMessages = [
        'Keep it short please',
        'TLDR version?',
        'Too long, can you summarize?',
      ];

      userMessages.forEach((msg) => {
        const signals = extractSignals(msg, 'Response');
        personality = applySignals(personality, signals);
        personality = recordInteraction(personality);
      });

      // Save the learned personality
      savePersonality(personality);

      // Reload and verify
      const loaded = getPersonality();
      // Verbosity should have decreased from initial value
      expect(loaded.learned_preferences.verbosity).toBeLessThan(initialVerbosity);
      // Message count should have increased by 3
      expect(loaded.relationship.message_count).toBeGreaterThanOrEqual(3);
    });

    test('should adapt for channel and generate prompt', () => {
      let personality = getPersonality();
      personality.relationship.message_count = 100;

      const whatsappPersonality = getChannelPersonality(personality, 'whatsapp');
      const prompt = personalityToPrompt(whatsappPersonality);

      expect(prompt).toContain('Personality');
      expect(prompt).toContain('100 interactions');
      expect(whatsappPersonality.learned_preferences.emoji_usage).toBe(true);
    });
  });
});
