import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { loadConfig, readRawConfigFile } from './loader.ts';
import { DEFAULT_CONFIG, USER_OWNED_SECTIONS } from './types.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

let TEST_CONFIG_DIR: string;
let TEST_CONFIG_PATH: string;

async function createTestConfigPath(): Promise<void> {
  TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'jarvis-test-config-'));
  TEST_CONFIG_PATH = join(TEST_CONFIG_DIR, 'config.yaml');
}

describe('Config Loader', () => {
  beforeEach(async () => {
    await createTestConfigPath();
  });

  afterEach(async () => {
    await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  test('workflows SYSTEM path keys survive the user-section discard; user fields do not', async () => {
    // A hosted/system config carries only the ready-made artifact paths;
    // any user-tunable workflow fields in the FILE have no authority (they
    // live in the DB) — but the paths are file-owned and must survive.
    const yaml = `
workflows:
  enabled: false
  engine_dir: /opt/jarvis-engine/\${version}
  pieces_dir: /srv/pieces
  piece_metadata_cache: /srv/piece-metadata.json
`;
    await Bun.write(TEST_CONFIG_PATH, yaml);
    const loaded = await loadConfig(TEST_CONFIG_PATH);
    expect(loaded.workflows?.engine_dir).toBe('/opt/jarvis-engine/\${version}');
    expect(loaded.workflows?.pieces_dir).toBe('/srv/pieces');
    expect(loaded.workflows?.piece_metadata_cache).toBe('/srv/piece-metadata.json');
    // The file's `enabled: false` was discarded with the user section.
    expect(loaded.workflows?.enabled).toBeUndefined();
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

  test('deep merges partial config with defaults; any llm block is discarded', async () => {
    // The llm block is legacy and must be ignored entirely - LLM config
    // comes only from the DB.
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
    // The llm block has no authority and is discarded back to the empty default.
    expect(loaded.llm).toEqual(DEFAULT_CONFIG.llm);

    // Should have defaults for missing values (paths are tilde-expanded)
    expect(loaded.daemon.data_dir).not.toContain('~');
    expect(loaded.personality.core_traits).toEqual(DEFAULT_CONFIG.personality.core_traits);
    expect(loaded.authority.default_level).toBe(DEFAULT_CONFIG.authority.default_level);
  });

  test('user-owned sections in the file have no authority (discarded like llm)', async () => {
    // config.yaml is a SYSTEM config. User sections live in the vault DB
    // settings store; a file that still carries them (legacy) contributes
    // nothing to loadConfig - they are imported into the DB once at daemon
    // boot and merged from there.
    const legacyYaml = `
daemon:
  port: 7777
personality:
  core_traits: ["sarcastic"]
  assistant_name: "HAL"
active_role: "villain"
stt:
  provider: groq
channels:
  telegram:
    enabled: true
    bot_token: "legacy-token"
authority:
  default_level: 1
`;
    await Bun.write(TEST_CONFIG_PATH, legacyYaml);
    const loaded = await loadConfig(TEST_CONFIG_PATH);

    // System keys stick...
    expect(loaded.daemon.port).toBe(7777);
    // ...user sections do not.
    expect(loaded.personality).toEqual(DEFAULT_CONFIG.personality);
    expect(loaded.active_role).toBe(DEFAULT_CONFIG.active_role);
    expect(loaded.stt).toEqual(DEFAULT_CONFIG.stt);
    expect(loaded.channels).toEqual(DEFAULT_CONFIG.channels);
    expect(loaded.authority.default_level).toBe(DEFAULT_CONFIG.authority.default_level);
  });

  test('system-owned sections survive: daemon, auth, google', async () => {
    const systemYaml = `
daemon:
  port: 9090
  brain_domain: "u1.vps1.usejarvis.host"
  public_url: "https://jarvis.example.com"
auth:
  insecure_open_access: true
google:
  client_id: "company-client.apps.googleusercontent.com"
  client_secret: "company-secret"
`;
    await Bun.write(TEST_CONFIG_PATH, systemYaml);
    const loaded = await loadConfig(TEST_CONFIG_PATH);
    expect(loaded.daemon.brain_domain).toBe('u1.vps1.usejarvis.host');
    expect(loaded.daemon.public_url).toBe('https://jarvis.example.com');
    expect(loaded.auth?.insecure_open_access).toBe(true);
    // google is system-owned when the file provides it (hosted: the shared
    // company OAuth client). The DB fallback only applies when absent here.
    expect(loaded.google?.client_id).toBe('company-client.apps.googleusercontent.com');
  });

  test('loadConfig does not mutate DEFAULT_CONFIG', async () => {
    // Regression test: a previous implementation of deepMerge returned
    // DEFAULT_CONFIG by reference when the parsed YAML was empty/null, so
    // subsequent tilde-expansion mutated the shared defaults.
    const snapshot = structuredClone(DEFAULT_CONFIG);

    // 1) Empty / comment-only file — exercises the `doc.toJS() ?? {}` branch.
    await Bun.write(TEST_CONFIG_PATH, '# empty config\n');
    await loadConfig(TEST_CONFIG_PATH);
    expect(DEFAULT_CONFIG).toEqual(snapshot);

    // 2) Partial config — exercises deepMerge with nested overlap.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 12345\n');
    const loaded = await loadConfig(TEST_CONFIG_PATH);
    expect(loaded.daemon.port).toBe(12345);
    expect(DEFAULT_CONFIG).toEqual(snapshot);

    // 3) User-section discard clones defaults — mutating the loaded config
    // must never leak back into DEFAULT_CONFIG.
    loaded.personality.core_traits.push('mutated');
    (loaded.authority as { default_level: number }).default_level = 99;
    expect(DEFAULT_CONFIG).toEqual(snapshot);

    // 4) Missing config file — the "defaults only" path.
    await loadConfig('/tmp/jarvis-loader-mutation-absent.yaml');
    expect(DEFAULT_CONFIG).toEqual(snapshot);
  });

  test('returns defaults cleanly for an empty config file', async () => {
    await Bun.write(TEST_CONFIG_PATH, '');
    const loaded = await loadConfig(TEST_CONFIG_PATH);
    expect(loaded.daemon.port).toBe(DEFAULT_CONFIG.daemon.port);
    expect(loaded.llm).toEqual(DEFAULT_CONFIG.llm);
    expect(loaded.daemon.data_dir).not.toContain('~');
  });

  test('returns defaults cleanly for a comment-only config file', async () => {
    await Bun.write(TEST_CONFIG_PATH, '# just a header\n# no content yet\n');
    const loaded = await loadConfig(TEST_CONFIG_PATH);
    expect(loaded.daemon.port).toBe(DEFAULT_CONFIG.daemon.port);
    expect(loaded.personality.core_traits).toEqual(DEFAULT_CONFIG.personality.core_traits);
  });

  test('parse errors include line:column diagnostics', async () => {
    const badYaml = 'daemon:\n  port: 3142\n    bad_indent: true\n';
    await Bun.write(TEST_CONFIG_PATH, badYaml);

    try {
      await loadConfig(TEST_CONFIG_PATH);
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain(TEST_CONFIG_PATH);
      // The `yaml` library embeds "at line X, column Y:" in each error message.
      expect(msg).toMatch(/line \d+, column \d+/);
    }
  });
});

describe('readRawConfigFile', () => {
  beforeEach(async () => {
    await createTestConfigPath();
  });

  afterEach(async () => {
    await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  test('returns the raw sections loadConfig would discard (for the legacy import)', async () => {
    await Bun.write(
      TEST_CONFIG_PATH,
      'daemon:\n  port: 7777\nstt:\n  provider: groq\nactive_role: "villain"\n',
    );
    const raw = await readRawConfigFile(TEST_CONFIG_PATH);
    expect(raw).not.toBeNull();
    expect((raw!.stt as { provider: string }).provider).toBe('groq');
    expect(raw!.active_role).toBe('villain');
    // No defaults are merged in: absent sections stay absent.
    expect(raw!.personality).toBeUndefined();
  });

  test('returns null for a missing file and throws on bad YAML', async () => {
    expect(await readRawConfigFile('/tmp/jarvis-definitely-not-here.yaml')).toBeNull();
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 3142\n    bad: true\n');
    await expect(readRawConfigFile(TEST_CONFIG_PATH)).rejects.toThrow();
  });
});

describe('Default Config', () => {
  test('has all required fields', () => {
    expect(DEFAULT_CONFIG.daemon).toBeDefined();
    expect(DEFAULT_CONFIG.daemon.port).toBe(3142);
    expect(DEFAULT_CONFIG.daemon.data_dir).toBe('~/.jarvis');
    expect(DEFAULT_CONFIG.daemon.db_path).toBe('~/.jarvis/jarvis.db');

    expect(DEFAULT_CONFIG.llm).toBeDefined();
    expect(DEFAULT_CONFIG.llm.providers).toBeDefined();
    expect(DEFAULT_CONFIG.llm.tiers).toBeDefined();

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
    // Default config ships empty providers + tiers. Users configure their
    // own providers via the dashboard.
    expect(DEFAULT_CONFIG.llm.providers).toEqual({});
    expect(DEFAULT_CONFIG.llm.tiers).toEqual({});
    expect(DEFAULT_CONFIG.llm.default).toBeUndefined();
  });

  test('every user-owned section is a real JarvisConfig key', () => {
    // Guards the registry against typos: a misspelled section would silently
    // never discard/import/merge.
    const knownKeys = new Set(Object.keys(DEFAULT_CONFIG));
    // Sections without a default (optional in JarvisConfig) are still valid;
    // list them explicitly so a typo can't hide behind "optional".
    const optionalWithoutDefault = new Set(['cron', 'desktop', 'sites', 'goals', 'workflows', 'onboarding']);
    for (const section of USER_OWNED_SECTIONS) {
      expect(knownKeys.has(section) || optionalWithoutDefault.has(section)).toBe(true);
    }
  });
});

describe('Config Parse Errors', () => {
  beforeEach(async () => {
    await createTestConfigPath();
  });

  afterEach(async () => {
    await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  test('throws on malformed YAML when file exists', async () => {
    const badYaml = `
daemon:
  port: 3142
    bad_indent: true
  this is: not: valid
`;
    await Bun.write(TEST_CONFIG_PATH, badYaml);

    await expect(loadConfig(TEST_CONFIG_PATH)).rejects.toThrow();
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
  beforeEach(async () => {
    await createTestConfigPath();
  });

  afterEach(async () => {
    delete process.env.JARVIS_WAKE_ENGINE;
    await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  test('defaults wake_engine to openwakeword (privacy-preserving local path)', async () => {
    const config = await loadConfig('/tmp/jarvis-voice-defaults.yaml');
    expect(config.voice?.wake_engine).toBe('openwakeword');
  });

  test('file-provided voice config is discarded (user-owned, DB is authoritative)', async () => {
    const yaml = `
voice:
  wake_engine: webspeech
`;
    await Bun.write(TEST_CONFIG_PATH, yaml);
    const config = await loadConfig(TEST_CONFIG_PATH);
    expect(config.voice?.wake_engine).toBe('openwakeword');
  });

  test('JARVIS_WAKE_ENGINE env override wins over YAML and the discard', async () => {
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
  beforeEach(async () => {
    await createTestConfigPath();
  });

  afterEach(async () => {
    await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  test('expands tilde in paths', async () => {
    const config = await loadConfig();

    // Should expand ~ to home directory
    expect(config.daemon.data_dir).not.toContain('~');
    expect(config.daemon.db_path).not.toContain('~');
  });

  test('preserves non-tilde paths', async () => {
    await Bun.write(
      TEST_CONFIG_PATH,
      'daemon:\n  data_dir: "/absolute/path"\n  db_path: "/absolute/db.db"\n',
    );
    const loaded = await loadConfig(TEST_CONFIG_PATH);

    expect(loaded.daemon.data_dir).toBe('/absolute/path');
    expect(loaded.daemon.db_path).toBe('/absolute/db.db');
  });
});
