import { getDb } from '../vault/schema.ts';

export type PersonalityModel = {
  core_traits: string[];
  learned_preferences: {
    verbosity: number;        // 0-10
    formality: number;        // 0-10
    humor_level: number;      // 0-10
    emoji_usage: boolean;
    preferred_format: 'lists' | 'prose' | 'tables' | 'adaptive';
  };
  relationship: {
    first_interaction: number;
    message_count: number;
    trust_level: number;      // 0-10, grows over time
    shared_references: string[];
  };
  channel_overrides: Record<string, Partial<PersonalityModel>>;
};

const DEFAULT_PERSONALITY: PersonalityModel = {
  core_traits: ['direct', 'strategic', 'resourceful'],
  learned_preferences: {
    verbosity: 5,
    formality: 5,
    humor_level: 3,
    emoji_usage: false,
    preferred_format: 'adaptive',
  },
  relationship: {
    first_interaction: Date.now(),
    message_count: 0,
    trust_level: 3,
    shared_references: [],
  },
  channel_overrides: {},
};

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
};

type PersonalityStateRow = {
  id: string;
  data: string;
  updated_at: number;
};

/**
 * Load personality from DB (personality_state table, id='default')
 */
export function loadPersonality(): PersonalityModel {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM personality_state WHERE id = ?');
  const row = stmt.get('default') as PersonalityStateRow | null;

  if (!row) {
    // Clone so callers (e.g. recordInteraction) can't mutate the shared default.
    return structuredClone(DEFAULT_PERSONALITY);
  }

  try {
    return JSON.parse(row.data) as PersonalityModel;
  } catch (error) {
    console.error('Failed to parse personality data:', error);
    return structuredClone(DEFAULT_PERSONALITY);
  }
}

/**
 * Save personality to DB
 */
export function savePersonality(model: PersonalityModel): void {
  const db = getDb();
  const now = Date.now();
  const data = JSON.stringify(model);

  const stmt = db.prepare(`
    INSERT INTO personality_state (id, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = ?, updated_at = ?
  `);

  stmt.run('default', data, now, data, now);
}

/**
 * Get current personality (loads from DB, falls back to default)
 */
export function getPersonality(): PersonalityModel {
  return loadPersonality();
}

/**
 * Deep merge helper for nested objects
 */
function deepMerge<T extends Record<string, any>>(target: T, source: DeepPartial<T>): T {
  const result = { ...target };

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (sourceValue === undefined) {
      continue;
    }

    if (
      sourceValue !== null &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue as any, sourceValue as any);
    } else {
      result[key] = sourceValue as any;
    }
  }

  return result;
}

/**
 * Update specific fields (deep merge)
 */
export function updatePersonality(updates: DeepPartial<PersonalityModel>): PersonalityModel {
  const current = getPersonality();
  const updated = deepMerge(current, updates);
  savePersonality(updated);
  return updated;
}
