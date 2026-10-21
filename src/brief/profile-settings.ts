import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types';
import { mergeTTSConfig } from '../daemon/config-merge';
import { effectiveTtsForBinding, hasUsejarvisAi, isHostedInstall } from '../daemon/usejarvis-ai';
import { injectSectionSecrets } from '../daemon/section-secrets';
import { persistUserPatch } from '../daemon/user-settings';
import { EDGE_VOICES, UJ_VOICES } from '../comms/voice-options';
import { USER_PROFILE_QUESTIONS } from '../user/profile';
import { interviewSourceWithheld } from '../vault/memory-suppression';
import { getDb } from '../vault/schema';
import { getSetting } from '../vault/settings';
import { patchUserProfile, readEditableProfile } from '../vault/profile-edit';
import { PROFILE_FIELD_MAPPING, type EditableProfile, type ProfileSettingsSnapshot, type VoicePreference, type VoiceSaveResult } from './profile-settings-contracts';

export class ProfileSettingsError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ProfileSettings {
  constructor(private readonly config: JarvisConfig, private readonly applyVoice?: () => Promise<unknown>) {}
  readiness(): 'ready' | 'unavailable' {
    return process.env.JARVIS_BRIEF_PROFILE_SETTINGS === '1' ? 'ready' : 'unavailable';
  }
  private requireReady() { if (this.readiness() !== 'ready') throw new ProfileSettingsError('unavailable', 503); }
  profile(): EditableProfile {
    const { revision, profile } = readEditableProfile();
    return { revision, answers: profile?.answers ?? {}, interviewFacts: (profile?.interview_facts ?? [])
      .filter(fact => !interviewSourceWithheld(getDb(), fact))
      .map(({ theme, summary }) => ({ theme, summary })) };
  }
  read(): ProfileSettingsSnapshot {
    this.requireReady();
    const hosted = isHostedInstall(this.config);
    return { contractVersion: 1, fields: PROFILE_FIELD_MAPPING, questions: USER_PROFILE_QUESTIONS,
      profile: this.profile(),
      account: { state: hosted ? 'external' : 'unavailable', readPath: hosted ? '/api/billing' : null, reason: hosted ? null : 'self_hosted' },
      checkIn: { state: 'unavailable', reason: 'check_in_not_supported', choices: [] },
      voice: this.voice(), setup: { deployment: hosted ? 'hosted' : 'self_hosted', providerSetup: hosted ? 'managed' : 'settings', settingsTab: 'channels' },
      replay: ['profile', 'tutorial'] };
  }
  saveProfile(revision: unknown, answers: unknown): EditableProfile {
    this.requireReady();
    patchUserProfile(revision, answers);
    return this.profile();
  }
  voice(): VoicePreference {
    const raw = getSetting('cfg.tts');
    let stored: Record<string, unknown> = {};
    try {
      if (raw !== null && raw.length > 64_000) throw new Error();
      const parsed = raw === null ? null : JSON.parse(raw);
      if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error();
      stored = parsed ?? {};
      if (stored.provider !== undefined && (typeof stored.provider !== 'string' || stored.provider.length > 100)
        || stored.voice !== undefined && (typeof stored.voice !== 'string' || stored.voice.length > 200)
        || stored.enabled !== undefined && typeof stored.enabled !== 'boolean') throw new Error();
    } catch {
      return { revision: hash(raw), state: 'unavailable', reason: 'settings_unreadable', pipeline: 'standard_tts', provider: null, voice: null, enabled: false, choices: [] };
    }
    // Reconstruct from the canonical row, not a possibly stale live config after a legacy save.
    const tts = effectiveTtsForBinding({ ...this.config, tts: mergeTTSConfig(DEFAULT_CONFIG.tts, stored) }, () => stored)!;
    const provider = tts.provider ?? 'edge';
    const voice = provider === 'usejarvis' ? (!tts.voice || /Neural$/i.test(tts.voice) ? 'alloy' : tts.voice)
      : provider === 'edge' ? tts.voice ?? 'en-US-AriaNeural' : null;
    const supported = provider === 'edge' || provider === 'usejarvis' && hasUsejarvisAi(this.config);
    return { revision: hash([raw, provider, isHostedInstall(this.config), hasUsejarvisAi(this.config)]),
      state: supported ? 'editable' : 'unavailable',
      reason: supported ? null : provider === 'usejarvis' ? 'provider_setup_required' : 'use_existing_voice_settings',
      pipeline: 'standard_tts', provider, voice, enabled: tts.enabled === true,
      choices: supported ? provider === 'edge' ? EDGE_VOICES : UJ_VOICES.map(id => ({ id, label: id })) : [] };
  }
  async saveVoice(revision: unknown, voice: unknown): Promise<VoiceSaveResult> {
    this.requireReady();
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) || typeof voice !== 'string') throw new ProfileSettingsError('invalid_patch');
    const stored = getDb().transaction(() => {
      const current = this.voice();
      if (current.revision !== revision) throw new ProfileSettingsError('revision_conflict', 409);
      if (current.state !== 'editable') throw new ProfileSettingsError(current.reason!, 422);
      if (!current.choices.some(choice => choice.id === voice)) throw new ProfileSettingsError('unsupported_voice', 422);
      // Never persist defaults, a provider choice, credentials or enabled state.
      persistUserPatch('tts', { voice });
      return JSON.parse(getSetting('cfg.tts')!);
    }).immediate();
    let application: VoiceSaveResult['application'] = 'restart_required';
    try {
      this.config.tts = injectSectionSecrets('tts', mergeTTSConfig(DEFAULT_CONFIG.tts, stored));
      if (this.applyVoice) application = await this.applyVoice() ? 'failed' : 'applied';
    } catch { application = 'failed'; }
    // Persistence already succeeded. Never imply a retry is necessary if binding failed.
    return { saved: true, application, voice: this.voice() };
  }
}
