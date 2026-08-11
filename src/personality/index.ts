// Re-export all personality engine modules
export type { LearnedPreferenceKey, LearnedPreferences, PersonalityModel } from './model.ts';
export {
  loadPersonality,
  savePersonality,
  getPersonality,
  updatePersonality,
} from './model.ts';

export type { InteractionSignal } from './learner.ts';
export {
  extractSignals,
  applySignals,
  recordInteraction,
} from './learner.ts';

export {
  getChannelPersonality,
  personalityToPrompt,
} from './adapter.ts';
