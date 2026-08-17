/**
 * Keychain location + durability.
 *
 * The legacy dir is `~/.jarvis` and cannot be redirected (homedir() is fixed
 * for the process), so the location rules take their dirs as arguments and are
 * exercised against throwaway paths. Everything that writes goes through
 * JARVIS_SECRETS_DIR, which never touches the developer's real store.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  getSecret,
  setSecret,
  setSecrets,
  keychainDir,
  keychainPaths,
  migrateKeychain,
  resolveKeychainDir,
} from './keychain.ts';

const KEY_FILE = '.secrets.key';
const SECRETS_FILE = '.secrets.enc';

describe('keychain', () => {
  let root: string;
  let prevSecretsDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jarvis-keychain-'));
    prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
    prevHome = process.env.JARVIS_HOME;
  });

  afterEach(() => {
    if (prevSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
    else process.env.JARVIS_SECRETS_DIR = prevSecretsDir;
    if (prevHome === undefined) delete process.env.JARVIS_HOME;
    else process.env.JARVIS_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  });

  /** Populate `dir` with a real keychain holding `entries`. */
  function seed(dir: string, entries: Record<string, string>): void {
    mkdirSync(dir, { recursive: true });
    process.env.JARVIS_SECRETS_DIR = dir;
    setSecrets(entries);
    delete process.env.JARVIS_SECRETS_DIR;
  }

  // ── location ────────────────────────────────────────────────────────────

  // keychainDir() consults the REAL ~/.jarvis as the legacy dir — homedir() is
  // fixed for the process, per the note at the top of this file. On a machine
  // with an actual install, the documented relocate-at-boot rule CORRECTLY
  // prefers that existing pair, so an unguarded `keychainDir() === dataDir`
  // assertion fails for every developer who runs Jarvis and passes only on a
  // clean runner. Split in two: the location rule is skipped where a real
  // keychain exists, and the write path is pinned so it always runs.
  const realLegacyHasKeychain =
    existsSync(join(homedir(), '.jarvis', KEY_FILE)) ||
    existsSync(join(homedir(), '.jarvis', SECRETS_FILE));

  test.skipIf(realLegacyHasKeychain)(
    'JARVIS_HOME is where a fresh install stores its keychain',
    () => {
      const dataDir = join(root, 'data');
      process.env.JARVIS_HOME = dataDir;
      expect(keychainDir()).toBe(dataDir);
    },
  );

  test('a fresh install writes and reads its keychain under the configured dir', () => {
    const dataDir = join(root, 'data');
    process.env.JARVIS_HOME = dataDir;
    // JARVIS_SECRETS_DIR pins the location, so this exercises the read/write
    // round-trip without depending on the legacy fallback — and, as the header
    // says, never touches the developer's real store.
    process.env.JARVIS_SECRETS_DIR = dataDir;
    try {
      setSecret('llm.provider.openai.api_key', 'sk-1');
      expect(existsSync(join(dataDir, SECRETS_FILE))).toBe(true);
      expect(getSecret('llm.provider.openai.api_key')).toBe('sk-1');
    } finally {
      delete process.env.JARVIS_SECRETS_DIR;
    }
  });

  test('an un-migrated install keeps using the legacy pair, both halves together', () => {
    const legacy = join(root, 'legacy');
    const dataDir = join(root, 'data');
    seed(legacy, { 'a.b.api_key': 'v' });
    mkdirSync(dataDir, { recursive: true });

    // The data dir has no keychain yet: the legacy one stays authoritative,
    // rather than the key being read from one dir and the ciphertext another.
    expect(resolveKeychainDir(dataDir, legacy)).toBe(legacy);

    // Once it has one, it wins.
    seed(dataDir, { 'a.b.api_key': 'v2' });
    expect(resolveKeychainDir(dataDir, legacy)).toBe(dataDir);
  });

  test('a fresh install with neither pair resolves to the configured dir', () => {
    expect(resolveKeychainDir(join(root, 'data'), join(root, 'legacy'))).toBe(join(root, 'data'));
  });

  test('JARVIS_SECRETS_DIR overrides JARVIS_HOME and skips the fallback', () => {
    process.env.JARVIS_HOME = join(root, 'data');
    process.env.JARVIS_SECRETS_DIR = join(root, 'override');

    expect(keychainDir()).toBe(join(root, 'override'));
    setSecret('x', '1');
    expect(keychainPaths().secretsPath).toBe(join(root, 'override', SECRETS_FILE));
    expect(existsSync(join(root, 'data', SECRETS_FILE))).toBe(false);
  });

  // ── migration ───────────────────────────────────────────────────────────

  test('migrate moves the pair and the secrets survive', () => {
    const legacy = join(root, 'legacy');
    const dataDir = join(root, 'data');
    seed(legacy, { 'llm.provider.openai.api_key': 'sk-1', 'stt.groq.api_key': 'gk-1' });

    expect(migrateKeychain(legacy, dataDir)).toBe(true);

    expect(existsSync(join(legacy, SECRETS_FILE))).toBe(false);
    expect(existsSync(join(legacy, KEY_FILE))).toBe(false);
    process.env.JARVIS_SECRETS_DIR = dataDir;
    expect(getSecret('llm.provider.openai.api_key')).toBe('sk-1');
    expect(getSecret('stt.groq.api_key')).toBe('gk-1');
  });

  test('migrate is a no-op when the destination already has a keychain', () => {
    const legacy = join(root, 'legacy');
    const dataDir = join(root, 'data');
    seed(legacy, { k: 'legacy-value' });
    seed(dataDir, { k: 'data-value' });

    expect(migrateKeychain(legacy, dataDir)).toBe(false);

    process.env.JARVIS_SECRETS_DIR = dataDir;
    expect(getSecret('k')).toBe('data-value');
    expect(existsSync(join(legacy, SECRETS_FILE))).toBe(true);
  });

  test('migrate is a no-op when there is nothing to move', () => {
    expect(migrateKeychain(join(root, 'legacy'), join(root, 'data'))).toBe(false);
  });

  test('a broken source pair aborts the move instead of destroying it', () => {
    const legacy = join(root, 'legacy');
    const dataDir = join(root, 'data');
    seed(legacy, { k: 'v' });
    // Key replaced with an unrelated one: the ciphertext no longer decrypts.
    writeFileSync(join(legacy, KEY_FILE), 'ab'.repeat(32));

    expect(() => migrateKeychain(legacy, dataDir)).toThrow();

    // Nothing was removed, and no half-written copy was left behind.
    expect(existsSync(join(legacy, SECRETS_FILE))).toBe(true);
    expect(existsSync(join(dataDir, SECRETS_FILE))).toBe(false);
  });

  // ── durability ──────────────────────────────────────────────────────────

  test('a save leaves no temp file behind', () => {
    const dir = join(root, 'data');
    process.env.JARVIS_SECRETS_DIR = dir;
    setSecret('a', '1');
    setSecrets({ b: '2', a: null });

    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(getSecret('b')).toBe('2');
    expect(getSecret('a')).toBeNull();
  });

  test('an unreadable store is never overwritten: reads degrade, writes refuse', () => {
    const dir = join(root, 'data');
    process.env.JARVIS_SECRETS_DIR = dir;
    setSecret('llm.provider.openai.api_key', 'sk-1');
    const enc = join(dir, SECRETS_FILE);
    const original = readFileSync(enc);

    // A restored-from-elsewhere or half-written file: authentication fails.
    writeFileSync(enc, original.subarray(0, 20));

    // A read must not be fatal — the daemon still boots, just without keys.
    expect(getSecret('llm.provider.openai.api_key')).toBeNull();

    // A write must refuse: encrypting a fresh store over it would turn a
    // recoverable problem (restore the matching key) into total loss.
    expect(() => setSecret('stt.groq.api_key', 'gk-1')).toThrow(/could not be read/);
    expect(() => setSecrets({ 'tts.elevenlabs.api_key': 'el-1' })).toThrow(/could not be read/);
    expect(readFileSync(enc)).toEqual(original.subarray(0, 20));

    // Putting the real file back makes everything work again, untouched.
    writeFileSync(enc, original);
    expect(getSecret('llm.provider.openai.api_key')).toBe('sk-1');
  });
});
