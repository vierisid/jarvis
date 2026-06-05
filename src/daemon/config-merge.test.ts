import { test, expect, describe } from 'bun:test';
import { mergeSTTConfig, mergeTTSConfig, mergeVoiceConfig, validateVoicePatch } from './config-merge.ts';
import type { STTConfig, TTSConfig, VoiceConfig } from '../config/types.ts';

describe('mergeSTTConfig', () => {
  test('preserves a different provider key when patching only one provider', () => {
    // This is the core invariant the onboarding/setup endpoint relies on:
    // POSTing a Groq key must not wipe an existing OpenAI key (and vice
    // versa). The endpoint was previously a verbatim copy of the dedicated
    // STT POST handler — extracting the helper means this guarantee lives
    // in one place and is tested once.
    const existing: STTConfig = {
      provider: 'openai',
      openai: { api_key: 'sk-existing-openai' },
    };
    const merged = mergeSTTConfig(existing, {
      provider: 'groq',
      groq: { api_key: 'gsk-new-groq' },
    });

    expect(merged.openai?.api_key).toBe('sk-existing-openai');
    expect(merged.groq?.api_key).toBe('gsk-new-groq');
    expect(merged.provider).toBe('groq');
  });

  test('preserves api_key on the same provider when patch omits it', () => {
    // GET /api/config/stt redacts api_keys, so a UI round-trip never sees
    // the real value. Merging must treat an omitted key as "keep existing".
    const existing: STTConfig = {
      provider: 'openai',
      openai: { api_key: 'sk-existing', model: 'whisper-1' },
    };
    const merged = mergeSTTConfig(existing, {
      openai: { model: 'whisper-large-v3' },
    });

    expect(merged.openai?.api_key).toBe('sk-existing');
    expect(merged.openai?.model).toBe('whisper-large-v3');
  });

  test('treats an empty-string api_key in the patch as "keep existing"', () => {
    const existing: STTConfig = {
      provider: 'openai',
      openai: { api_key: 'sk-existing' },
    };
    const merged = mergeSTTConfig(existing, {
      openai: { api_key: '', model: 'whisper-1' },
    });

    expect(merged.openai?.api_key).toBe('sk-existing');
  });

  test('deep-merges the local sub-block so partial updates keep model', () => {
    // The pre-helper code shallow-merged `local` (it was not in the
    // preserved-provider loop), so updating just the endpoint would have
    // wiped `model` and `server_type`. The helper deep-merges it.
    const existing: STTConfig = {
      provider: 'local',
      local: {
        endpoint: 'http://localhost:8080',
        model: 'base.en',
        server_type: 'whisper_cpp',
      },
    };
    const merged = mergeSTTConfig(existing, {
      local: { endpoint: 'http://localhost:9000' },
    });

    expect(merged.local?.endpoint).toBe('http://localhost:9000');
    expect(merged.local?.model).toBe('base.en');
    expect(merged.local?.server_type).toBe('whisper_cpp');
  });

  test('handles a missing existing config (first-run onboarding case)', () => {
    const merged = mergeSTTConfig(undefined, {
      provider: 'openai',
      openai: { api_key: 'sk-fresh' },
    });

    expect(merged.provider).toBe('openai');
    expect(merged.openai?.api_key).toBe('sk-fresh');
  });

  test('shallow-merges top-level fields like provider', () => {
    const existing: STTConfig = {
      provider: 'openai',
      openai: { api_key: 'sk-x' },
      groq: { api_key: 'gsk-y' },
    };
    const merged = mergeSTTConfig(existing, { provider: 'groq' });

    expect(merged.provider).toBe('groq');
    expect(merged.openai?.api_key).toBe('sk-x');
    expect(merged.groq?.api_key).toBe('gsk-y');
  });
});

describe('mergeTTSConfig', () => {
  test('preserves elevenlabs api_key when toggling enabled', () => {
    const existing: TTSConfig = {
      enabled: true,
      provider: 'elevenlabs',
      elevenlabs: { api_key: 'el-existing', voice_id: 'rachel' },
    };
    const merged = mergeTTSConfig(existing, { enabled: false });

    expect(merged.enabled).toBe(false);
    expect(merged.elevenlabs?.api_key).toBe('el-existing');
    expect(merged.elevenlabs?.voice_id).toBe('rachel');
  });

  test('preserves a different provider key when patching only one provider', () => {
    const existing: TTSConfig = {
      enabled: true,
      provider: 'elevenlabs',
      elevenlabs: { api_key: 'el-key' },
    };
    const merged = mergeTTSConfig(existing, {
      provider: 'sarvam',
      sarvam: { api_key: 'sv-key' },
    });

    expect(merged.elevenlabs?.api_key).toBe('el-key');
    expect(merged.sarvam?.api_key).toBe('sv-key');
  });

  test('handles a missing existing config', () => {
    const merged = mergeTTSConfig(undefined, {
      enabled: true,
      provider: 'edge',
      voice: 'en-US-AriaNeural',
    });

    expect(merged.enabled).toBe(true);
    expect(merged.provider).toBe('edge');
    expect(merged.voice).toBe('en-US-AriaNeural');
  });
});

describe('mergeVoiceConfig', () => {
  test('preserves realtime api_key when patch omits it', () => {
    const existing: VoiceConfig = {
      wake_engine: 'openwakeword',
      realtime: { enabled: true, api_key: 'sk-secret', model: 'gpt-realtime-2', reasoning_effort: 'low' },
    };
    const merged = mergeVoiceConfig(existing, { realtime: { reasoning_effort: 'high' } });
    expect(merged.realtime?.api_key).toBe('sk-secret');     // preserved
    expect(merged.realtime?.reasoning_effort).toBe('high');  // updated
    expect(merged.realtime?.model).toBe('gpt-realtime-2');   // sibling intact
  });

  test('empty api_key string does not wipe the stored key', () => {
    const existing: VoiceConfig = {
      wake_engine: 'openwakeword',
      realtime: { enabled: true, api_key: 'sk-secret' },
    };
    const merged = mergeVoiceConfig(existing, { realtime: { enabled: false, api_key: '' } });
    expect(merged.realtime?.api_key).toBe('sk-secret');
    expect(merged.realtime?.enabled).toBe(false);
  });

  test('accepts a new api_key when provided', () => {
    const existing: VoiceConfig = { wake_engine: 'openwakeword', realtime: { enabled: false, api_key: 'old' } };
    const merged = mergeVoiceConfig(existing, { realtime: { enabled: true, api_key: 'new' } });
    expect(merged.realtime?.api_key).toBe('new');
  });

  test('shallow-merges wake_engine without touching realtime', () => {
    const existing: VoiceConfig = { wake_engine: 'openwakeword', realtime: { enabled: true, api_key: 'k' } };
    const merged = mergeVoiceConfig(existing, { wake_engine: 'webspeech' });
    expect(merged.wake_engine).toBe('webspeech');
    expect(merged.realtime?.enabled).toBe(true);
  });

  test('initializes from undefined', () => {
    const merged = mergeVoiceConfig(undefined, { realtime: { enabled: true, api_key: 'k', voice: 'marin' } });
    expect(merged.wake_engine).toBe('openwakeword');
    expect(merged.realtime?.voice).toBe('marin');
  });
});

describe('validateVoicePatch', () => {
  test('accepts a well-formed patch', () => {
    const res = validateVoicePatch({
      wake_engine: 'webspeech',
      realtime: {
        enabled: true,
        reasoning_effort: 'high',
        max_session_minutes: 30,
        monthly_budget_usd: 25,
        blocked_categories: ['make_payment'],
      },
    });
    expect(res.ok).toBe(true);
  });

  test('accepts null monthly_budget_usd (UI "no cap")', () => {
    expect(validateVoicePatch({ realtime: { monthly_budget_usd: null } }).ok).toBe(true);
  });

  test('rejects non-object bodies', () => {
    expect(validateVoicePatch(null).ok).toBe(false);
    expect(validateVoicePatch([]).ok).toBe(false);
    expect(validateVoicePatch('nope').ok).toBe(false);
  });

  test('rejects unknown top-level fields', () => {
    const res = validateVoicePatch({ haxx: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Unknown');
  });

  test('rejects an invalid wake_engine', () => {
    expect(validateVoicePatch({ wake_engine: 'bogus' }).ok).toBe(false);
  });

  test('rejects an invalid reasoning_effort', () => {
    expect(validateVoicePatch({ realtime: { reasoning_effort: 'ludicrous' } }).ok).toBe(false);
  });

  test('rejects out-of-range or non-numeric max_session_minutes', () => {
    expect(validateVoicePatch({ realtime: { max_session_minutes: -1 } }).ok).toBe(false);
    expect(validateVoicePatch({ realtime: { max_session_minutes: 0 } }).ok).toBe(false);
    expect(validateVoicePatch({ realtime: { max_session_minutes: 99999 } }).ok).toBe(false);
    expect(validateVoicePatch({ realtime: { max_session_minutes: 'ten' } }).ok).toBe(false);
  });

  test('rejects a negative budget and non-array blocked_categories', () => {
    expect(validateVoicePatch({ realtime: { monthly_budget_usd: -5 } }).ok).toBe(false);
    expect(validateVoicePatch({ realtime: { blocked_categories: 'notanarray' } }).ok).toBe(false);
    expect(validateVoicePatch({ realtime: { blocked_categories: [1, 2] } }).ok).toBe(false);
  });

  test('rejects unknown action categories but accepts known ones', () => {
    expect(validateVoicePatch({ realtime: { blocked_categories: ['make_payment', 'delete_data'] } }).ok).toBe(true);
    const res = validateVoicePatch({ realtime: { blocked_categories: ['make_payment', 'file_delete'] } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('file_delete');
    // An explicit empty array (disable the backstop) is still allowed.
    expect(validateVoicePatch({ realtime: { blocked_categories: [] } }).ok).toBe(true);
  });

  test('rejects wrong-typed enabled / realtime', () => {
    expect(validateVoicePatch({ realtime: { enabled: 'yes' } }).ok).toBe(false);
    expect(validateVoicePatch({ realtime: 'nope' }).ok).toBe(false);
  });
});
