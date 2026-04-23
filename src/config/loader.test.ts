import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { loadConfig, saveConfig } from './loader.ts';
import { DEFAULT_CONFIG } from './types.ts';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

const TEST_CONFIG_PATH = '/tmp/jarvis-test-config.yaml';

describe('Config Loader', () => {
  afterEach(async () => {
    // Clean up test config file
    if (existsSync(TEST_CONFIG_PATH)) {
      await unlink(TEST_CONFIG_PATH);
    }
  });

  test('returns default config when file does not exist', async () => {
    const config = await loadConfig('/tmp/nonexistent-config.yaml');
    // Paths should be tilde-expanded, but all other fields match defaults
    expect(config.daemon.port).toBe(DEFAULT_CONFIG.daemon.port);
    expect(config.daemon.data_dir).not.toContain('~');
    expect(config.daemon.db_path).not.toContain('~');
    expect(config.llm).toEqual(DEFAULT_CONFIG.llm);
    expect(config.personality).toEqual(DEFAULT_CONFIG.personality);
    expect(config.authority).toEqual(DEFAULT_CONFIG.authority);
    expect(config.active_role).toBe(DEFAULT_CONFIG.active_role);
  });

  test('can save and load config', async () => {
    const testConfig = structuredClone(DEFAULT_CONFIG);
    testConfig.daemon.port = 9999;
    testConfig.llm.primary = 'openai';

    await saveConfig(testConfig, TEST_CONFIG_PATH);
    expect(existsSync(TEST_CONFIG_PATH)).toBe(true);

    const loaded = await loadConfig(TEST_CONFIG_PATH);
    expect(loaded.daemon.port).toBe(9999);
    expect(loaded.llm.primary).toBe('openai');
  });

  test('deep merges partial config with defaults', async () => {
    // Save a partial config (only some fields)
    const partialYaml = `
daemon:
  port: 8888

llm:
  primary: "openai"
`;

    await Bun.write(TEST_CONFIG_PATH, partialYaml);

    const loaded = await loadConfig(TEST_CONFIG_PATH);

    // Should have our custom values
    expect(loaded.daemon.port).toBe(8888);
    expect(loaded.llm.primary).toBe('openai');

    // Should have defaults for missing values (paths are tilde-expanded)
    expect(loaded.daemon.data_dir).not.toContain('~');
    expect(loaded.personality.core_traits).toEqual(DEFAULT_CONFIG.personality.core_traits);
    expect(loaded.authority.default_level).toBe(DEFAULT_CONFIG.authority.default_level);
  });

  test('preserves all config sections', async () => {
    await saveConfig(DEFAULT_CONFIG, TEST_CONFIG_PATH);
    const loaded = await loadConfig(TEST_CONFIG_PATH);

    expect(loaded.daemon).toBeDefined();
    expect(loaded.llm).toBeDefined();
    expect(loaded.personality).toBeDefined();
    expect(loaded.authority).toBeDefined();
    expect(loaded.active_role).toBeDefined();
  });

  test('saves YAML without forcing quoted keys', async () => {
    await saveConfig(DEFAULT_CONFIG, TEST_CONFIG_PATH);
    const text = await Bun.file(TEST_CONFIG_PATH).text();

    expect(text).toContain('daemon:');
    expect(text).toContain('channels:');
    expect(text).not.toContain('"daemon":');
    expect(text).not.toContain('"channels":');
  });

  test('round-trips channel config and multi-provider fallbacks', async () => {
    const testConfig = structuredClone(DEFAULT_CONFIG);
    testConfig.channels = {
      telegram: {
        enabled: true,
        bot_token: 'telegram-token',
        allowed_users: [12345],
      },
      discord: {
        enabled: true,
        bot_token: 'discord-token',
        allowed_users: ['user-1'],
        guild_id: 'guild-123',
      },
    };
    testConfig.llm.primary = 'ollama';
    testConfig.llm.fallback = ['gemini', 'openai'];
    testConfig.llm.gemini = {
      api_key: 'gemini-key',
      model: 'gemini-3-flash-preview',
    };
    testConfig.llm.ollama = {
      base_url: 'http://localhost:11434',
      model: 'llama3.1',
    };

    await saveConfig(testConfig, TEST_CONFIG_PATH);
    const loaded = await loadConfig(TEST_CONFIG_PATH);

    expect(loaded.channels?.discord?.enabled).toBe(true);
    expect(loaded.channels?.discord?.guild_id).toBe('guild-123');
    expect(loaded.llm.primary).toBe('ollama');
    expect(loaded.llm.fallback).toEqual(['gemini', 'openai']);
    expect(loaded.llm.gemini?.model).toBe('gemini-3-flash-preview');
    expect(loaded.llm.ollama?.model).toBe('llama3.1');
  });
});

describe('Default Config', () => {
  test('has all required fields', () => {
    expect(DEFAULT_CONFIG.daemon).toBeDefined();
    expect(DEFAULT_CONFIG.daemon.port).toBe(3142);
    expect(DEFAULT_CONFIG.daemon.data_dir).toBe('~/.jarvis');
    expect(DEFAULT_CONFIG.daemon.db_path).toBe('~/.jarvis/jarvis.db');

    expect(DEFAULT_CONFIG.llm).toBeDefined();
    expect(DEFAULT_CONFIG.llm.primary).toBe('anthropic');
    expect(DEFAULT_CONFIG.llm.fallback).toEqual(['openai', 'ollama']);

    expect(DEFAULT_CONFIG.personality).toBeDefined();
    expect(DEFAULT_CONFIG.personality.core_traits).toBeInstanceOf(Array);

    expect(DEFAULT_CONFIG.authority).toBeDefined();
    expect(DEFAULT_CONFIG.authority.default_level).toBe(3);

    expect(DEFAULT_CONFIG.active_role).toBe('personal-assistant');
  });

  test('has correct personality traits', () => {
    const traits = DEFAULT_CONFIG.personality.core_traits;
    expect(traits).toContain('loyal');
    expect(traits).toContain('efficient');
    expect(traits).toContain('proactive');
    expect(traits).toContain('respectful');
    expect(traits).toContain('adaptive');
  });

  test('has correct LLM defaults', () => {
    expect(DEFAULT_CONFIG.llm.anthropic?.model).toBe('claude-sonnet-4-6');
    expect(DEFAULT_CONFIG.llm.openai?.model).toBe('gpt-5.4');
    expect(DEFAULT_CONFIG.llm.gemini?.model).toBe('gemini-3-flash-preview');
    expect(DEFAULT_CONFIG.llm.ollama?.model).toBe('llama3');
    expect(DEFAULT_CONFIG.llm.ollama?.base_url).toBe('http://localhost:11434');
  });
});

describe('Config Parse Errors', () => {
  afterEach(async () => {
    if (existsSync(TEST_CONFIG_PATH)) {
      await unlink(TEST_CONFIG_PATH);
    }
  });

  test('throws on malformed YAML when file exists', async () => {
    const badYaml = `
daemon:
  port: 3142
    bad_indent: true
  this is: not: valid
`;
    await Bun.write(TEST_CONFIG_PATH, badYaml);

    expect(loadConfig(TEST_CONFIG_PATH)).rejects.toThrow();
  });

  test('uses defaults when file does not exist (no throw)', async () => {
    const config = await loadConfig('/tmp/jarvis-definitely-not-here.yaml');
    expect(config.daemon.port).toBe(DEFAULT_CONFIG.daemon.port);
    expect(config.daemon.data_dir).not.toContain('~');
    expect(config.daemon.db_path).not.toContain('~');
  });

  test('expands tildes in parsed config', async () => {
    const yamlWithTilde = `
daemon:
  data_dir: "~/.jarvis"
  db_path: "~/.jarvis/jarvis.db"
`;
    await Bun.write(TEST_CONFIG_PATH, yamlWithTilde);

    const config = await loadConfig(TEST_CONFIG_PATH);
    expect(config.daemon.data_dir).not.toContain('~');
    expect(config.daemon.db_path).not.toContain('~');
    expect(isAbsolute(config.daemon.data_dir)).toBe(true);
    expect(isAbsolute(config.daemon.db_path)).toBe(true);
  });
});

describe('Voice Config', () => {
  afterEach(async () => {
    delete process.env.JARVIS_WAKE_ENGINE;
    if (existsSync(TEST_CONFIG_PATH)) {
      await unlink(TEST_CONFIG_PATH);
    }
  });

  test('defaults wake_engine to openwakeword (privacy-preserving local path)', async () => {
    const config = await loadConfig('/tmp/jarvis-voice-defaults.yaml');
    expect(config.voice?.wake_engine).toBe('openwakeword');
  });

  test('round-trips user-supplied wake_engine', async () => {
    const yaml = `
voice:
  wake_engine: webspeech
`;
    await Bun.write(TEST_CONFIG_PATH, yaml);
    const config = await loadConfig(TEST_CONFIG_PATH);
    expect(config.voice?.wake_engine).toBe('webspeech');
  });

  test('JARVIS_WAKE_ENGINE env override wins over YAML', async () => {
    const yaml = `
voice:
  wake_engine: openwakeword
`;
    await Bun.write(TEST_CONFIG_PATH, yaml);
    process.env.JARVIS_WAKE_ENGINE = 'auto';
    const config = await loadConfig(TEST_CONFIG_PATH);
    expect(config.voice?.wake_engine).toBe('auto');
  });

  test('invalid JARVIS_WAKE_ENGINE is ignored, default is preserved', async () => {
    process.env.JARVIS_WAKE_ENGINE = 'siri';
    const config = await loadConfig('/tmp/jarvis-voice-invalid-env.yaml');
    expect(config.voice?.wake_engine).toBe('openwakeword');
  });
});

describe('Path Expansion', () => {
  test('expands tilde in paths', async () => {
    const config = await loadConfig();

    // Should expand ~ to home directory
    expect(config.daemon.data_dir).not.toContain('~');
    expect(config.daemon.db_path).not.toContain('~');
  });

  test('preserves non-tilde paths', async () => {
    const testConfig = { ...DEFAULT_CONFIG };
    testConfig.daemon.data_dir = '/absolute/path';
    testConfig.daemon.db_path = '/absolute/db.db';

    await saveConfig(testConfig, TEST_CONFIG_PATH);
    const loaded = await loadConfig(TEST_CONFIG_PATH);

    expect(loaded.daemon.data_dir).toBe('/absolute/path');
    expect(loaded.daemon.db_path).toBe('/absolute/db.db');
  });
});
