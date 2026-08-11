import type { LearnedPreferenceKey, PersonalityModel } from './model.ts';

/**
 * Channel-specific personality defaults
 */
const CHANNEL_DEFAULTS: Record<string, Partial<PersonalityModel>> = {
  whatsapp: {
    learned_preferences: {
      verbosity: 4,
      formality: 3,
      humor_level: 5,
      emoji_usage: true,
      preferred_format: 'lists',
    },
  },
  telegram: {
    learned_preferences: {
      verbosity: 4,
      formality: 3,
      humor_level: 5,
      emoji_usage: true,
      preferred_format: 'lists',
    },
  },
  email: {
    learned_preferences: {
      verbosity: 7,
      formality: 8,
      humor_level: 2,
      emoji_usage: false,
      preferred_format: 'prose',
    },
  },
  terminal: {
    learned_preferences: {
      verbosity: 5,
      formality: 5,
      humor_level: 3,
      emoji_usage: false,
      preferred_format: 'adaptive',
    },
  },
  websocket: {
    learned_preferences: {
      verbosity: 5,
      formality: 5,
      humor_level: 3,
      emoji_usage: false,
      preferred_format: 'adaptive',
    },
  },
  discord: {
    learned_preferences: {
      verbosity: 4,
      formality: 3,
      humor_level: 5,
      emoji_usage: true,
      preferred_format: 'lists',
    },
  },
};

/**
 * What mergePersonality actually accepts. Partial<PersonalityModel> is shallow,
 * so it would type a half-filled learned_preferences as a complete one.
 */
type PersonalityOverride = Omit<
  Partial<PersonalityModel>,
  'learned_preferences' | 'relationship'
> & {
  learned_preferences?: Partial<PersonalityModel['learned_preferences']>;
  relationship?: Partial<PersonalityModel['relationship']>;
};

/**
 * Deep merge helper for personality overrides
 */
function mergePersonality(
  base: PersonalityModel,
  override: PersonalityOverride
): PersonalityModel {
  return {
    ...base,
    core_traits: override.core_traits ?? base.core_traits,
    learned_preferences: {
      ...base.learned_preferences,
      ...override.learned_preferences,
    },
    relationship: {
      ...base.relationship,
      ...override.relationship,
    },
    channel_overrides: {
      ...base.channel_overrides,
      ...override.channel_overrides,
    },
  };
}

/**
 * Drop the preferences the learner has explicitly moved from a channel preset.
 *
 * A preset is a floor, not a ceiling: it fills in preferences the user has
 * never expressed an opinion about, and stays out of the way of the ones they
 * have. Without this filter the preset overwrites every learned value, because
 * learned_preferences is always fully populated.
 */
function presetForUnlearnedKeys(
  preset: Partial<PersonalityModel>,
  learnedKeys: LearnedPreferenceKey[] | undefined
): PersonalityOverride {
  const presetPreferences = preset.learned_preferences;
  if (!presetPreferences || !learnedKeys?.length) return preset;

  const remaining: Partial<PersonalityModel['learned_preferences']> = {};
  for (const [key, value] of Object.entries(presetPreferences)) {
    if (learnedKeys.includes(key as LearnedPreferenceKey)) continue;
    (remaining as Record<string, unknown>)[key] = value;
  }

  return { ...preset, learned_preferences: remaining };
}

/**
 * Get personality adapted for a specific channel
 */
export function getChannelPersonality(personality: PersonalityModel, channel: string): PersonalityModel {
  // First, apply channel-specific overrides from stored personality. These are
  // set deliberately for one channel, so they outrank both the learner and the
  // preset.
  let adapted = personality;
  if (personality.channel_overrides[channel]) {
    adapted = mergePersonality(personality, personality.channel_overrides[channel]);
  }

  // Then, apply default channel adaptations if no stored override exists -
  // but only for preferences the learner has not already moved.
  if (!personality.channel_overrides[channel] && CHANNEL_DEFAULTS[channel]) {
    adapted = mergePersonality(
      adapted,
      presetForUnlearnedKeys(CHANNEL_DEFAULTS[channel], personality.learned_keys)
    );
  }

  return adapted;
}

/**
 * Generate personality instructions for the LLM system prompt
 */
export function personalityToPrompt(personality: PersonalityModel): string {
  const { core_traits, learned_preferences, relationship } = personality;

  const lines: string[] = ['## Personality'];

  // Core traits
  if (core_traits.length > 0) {
    lines.push(`Core traits: ${core_traits.join(', ')}`);
  }

  // Communication style
  const verbosityDesc = getVerbosityDescription(learned_preferences.verbosity);
  const formalityDesc = getFormalityDescription(learned_preferences.formality);
  const humorDesc = getHumorDescription(learned_preferences.humor_level);

  lines.push(
    `Communication: ${verbosityDesc} verbosity (${learned_preferences.verbosity}/10), ${formalityDesc} formality (${learned_preferences.formality}/10), ${humorDesc} humor`
  );

  // Format preference
  lines.push(`Format preference: ${learned_preferences.preferred_format}`);

  // Emoji usage
  if (learned_preferences.emoji_usage) {
    lines.push('Emoji usage: Enabled');
  }

  // Relationship context
  const daysSinceFirst = Math.floor(
    (Date.now() - relationship.first_interaction) / (1000 * 60 * 60 * 24)
  );
  const trustDesc = getTrustDescription(relationship.trust_level);

  lines.push(
    `Relationship: ${relationship.message_count} interactions over ${daysSinceFirst} days, ${trustDesc} trust level (${relationship.trust_level}/10)`
  );

  // Shared references
  if (relationship.shared_references.length > 0) {
    lines.push(`Shared references: ${relationship.shared_references.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Helper: Convert verbosity number to description
 */
function getVerbosityDescription(level: number): string {
  if (level <= 2) return 'Very brief';
  if (level <= 4) return 'Concise';
  if (level <= 6) return 'Moderate';
  if (level <= 8) return 'Detailed';
  return 'Very detailed';
}

/**
 * Helper: Convert formality number to description
 */
function getFormalityDescription(level: number): string {
  if (level <= 2) return 'Very casual';
  if (level <= 4) return 'Casual';
  if (level <= 6) return 'Moderate';
  if (level <= 8) return 'Formal';
  return 'Very formal';
}

/**
 * Helper: Convert humor level to description
 */
function getHumorDescription(level: number): string {
  if (level <= 2) return 'minimal';
  if (level <= 4) return 'light';
  if (level <= 6) return 'moderate';
  if (level <= 8) return 'frequent';
  return 'heavy';
}

/**
 * Helper: Convert trust level to description
 */
function getTrustDescription(level: number): string {
  if (level <= 2) return 'low';
  if (level <= 4) return 'developing';
  if (level <= 6) return 'moderate';
  if (level <= 8) return 'high';
  return 'very high';
}
