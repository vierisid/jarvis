import type { UserProfileQuestion, UserProfileQuestionId } from '../user/profile';

export type ProfileAnswers = Partial<Record<UserProfileQuestionId, string>>;
export type ProfilePatch = Partial<Record<UserProfileQuestionId, string | null>>;
/** Native Profile form; never derive account identity from assistant context. */
export const PROFILE_FIELD_MAPPING = [
  { id: 'full_name', label: 'Full name', owner: 'account', questionId: null, state: 'unavailable', reason: 'account_name_not_exposed' },
  { id: 'preferred_name', label: 'What should Jarvis call you?', owner: 'assistant_context', questionId: 'preferred_name', state: 'editable', reason: null },
  { id: 'company', label: 'Company', owner: 'assistant_context', questionId: 'company', state: 'editable', reason: null },
  { id: 'role', label: 'Role', owner: 'assistant_context', questionId: 'work_role', state: 'editable', reason: null },
  { id: 'projects', label: 'What are you building?', owner: 'assistant_context', questionId: 'current_projects', state: 'editable', reason: null },
  { id: 'working_style', label: 'How you like to work', owner: 'assistant_context', questionId: 'communication_preferences', state: 'editable', reason: null },
] as const;

export interface EditableProfile { revision: string; answers: ProfileAnswers; interviewFacts?: Array<{ theme: string; summary: string }> }
export interface VoicePreference {
  revision: string;
  state: 'editable' | 'unavailable';
  reason: 'provider_setup_required' | 'use_existing_voice_settings' | 'settings_unreadable' | null;
  pipeline: 'standard_tts';
  provider: string | null;
  voice: string | null;
  enabled: boolean;
  choices: { id: string; label: string }[];
}
export interface ProfileSettingsSnapshot {
  contractVersion: 1;
  fields: typeof PROFILE_FIELD_MAPPING;
  questions: UserProfileQuestion[];
  profile: EditableProfile;
  account: { state: 'external' | 'unavailable'; readPath: '/api/billing' | null; reason: 'self_hosted' | null };
  checkIn: { state: 'unavailable'; reason: 'check_in_not_supported'; choices: [] };
  voice: VoicePreference;
  setup: { deployment: 'hosted' | 'self_hosted'; providerSetup: 'managed' | 'settings'; settingsTab: 'channels' };
  replay: readonly ['profile', 'tutorial'];
}
export interface VoiceSaveResult { saved: true; application: 'applied' | 'restart_required' | 'failed'; voice: VoicePreference }
