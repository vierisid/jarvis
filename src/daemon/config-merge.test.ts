import { test, expect, describe } from 'bun:test';
import { mergeSTTConfig, mergeTTSConfig } from './config-merge.ts';
import type { STTConfig, TTSConfig } from '../config/types.ts';

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
