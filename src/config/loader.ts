import YAML from 'yaml';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { lstat, rename, unlink } from 'node:fs/promises';
import type { JarvisConfig } from './types.ts';
import { DEFAULT_CONFIG } from './types.ts';
import { secureParentDirectory, secureWriteFile } from '../util/fs-secure.ts';

function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

function deepMerge(target: any, source: any): any {
  if (!source || typeof source !== 'object') {
    // If source is absent, return a clone of target so callers (or subsequent
    // mutation of the returned value) can never alias shared defaults.
    return source !== undefined ? source : structuredClone(target);
  }

  if (Array.isArray(source)) {
    return [...source];
  }

  const result = { ...target };

  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (
        source[key] &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        target[key] &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        result[key] = deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }

  return result;
}

/**
 * Apply environment variable overrides to config.
 * Env vars take highest precedence (over YAML and defaults).
 */
function applyEnvOverrides(config: JarvisConfig): void {
  const env = process.env;

  if (env.JARVIS_PORT) {
    const port = parseInt(env.JARVIS_PORT, 10);
    if (!isNaN(port)) config.daemon.port = port;
  }

  if (env.JARVIS_HOME) {
    const home = env.JARVIS_HOME;
    config.daemon.data_dir = home;
    config.daemon.db_path = join(home, 'jarvis.db');
  }

  // NOTE: LLM provider configuration is intentionally NOT read from env vars.
  // Providers, credentials, the single-LLM default, and tiers live exclusively
  // in the database + encrypted keychain and are managed from the settings
  // dashboard. There is no env or config.yaml path for LLM config.

  if (env.JARVIS_BRAIN_DOMAIN) {
    config.daemon.brain_domain = env.JARVIS_BRAIN_DOMAIN;
  }

  if (env.JARVIS_AUTH_TOKEN) {
    if (!config.auth) config.auth = {};
    config.auth.token = env.JARVIS_AUTH_TOKEN;
  }

  if (env.JARVIS_WAKE_ENGINE) {
    const engine = env.JARVIS_WAKE_ENGINE;
    if (engine === 'openwakeword' || engine === 'webspeech' || engine === 'auto') {
      if (!config.voice) config.voice = { wake_engine: 'openwakeword' };
      config.voice.wake_engine = engine;
    } else {
      console.warn(`[Config] Invalid JARVIS_WAKE_ENGINE="${engine}" — must be openwakeword|webspeech|auto; ignoring.`);
    }
  }

  // Premium realtime voice (gpt-realtime-2). Truthy values enable; "0"/"false"
  // explicitly disable. See docs/GPT_REALTIME_2_INTEGRATION.md.
  if (env.JARVIS_REALTIME_VOICE !== undefined) {
    if (!config.voice) config.voice = { wake_engine: 'openwakeword' };
    if (!config.voice.realtime) config.voice.realtime = { enabled: false };
    const v = env.JARVIS_REALTIME_VOICE.trim().toLowerCase();
    config.voice.realtime.enabled = v !== '' && v !== '0' && v !== 'false' && v !== 'no';
  }
}

export async function loadConfig(configPath?: string): Promise<JarvisConfig> {
  const path = configPath || expandTilde('~/.jarvis/config.yaml');

  const file = Bun.file(path);
  const exists = await file.exists();

  if (!exists) {
    console.warn(`Config file not found at ${path}, using defaults`);
    const config = structuredClone(DEFAULT_CONFIG);
    config.daemon.data_dir = expandTilde(config.daemon.data_dir);
    config.daemon.db_path = expandTilde(config.daemon.db_path);
    applyEnvOverrides(config);
    return config;
  }

  // File exists — parse errors should be fatal.
  // `merge: true` enables YAML merge keys (`<<: *anchor`) so configs can share
  // blocks across environments. Removing this flag would silently break any
  // config that relies on anchors — keep it unless you're sure.
  const text = await file.text();
  const doc = YAML.parseDocument(text, { merge: true });
  if (doc.errors.length > 0) {
    // `yaml`'s error.message already embeds `at line X, column Y:` and a caret
    // diagram, so no need to prefix our own position info.
    const formatted = doc.errors.map((entry) => entry.message);
    throw new Error(`Failed to parse YAML config at ${path}:\n  ${formatted.join('\n  ')}`);
  }
  // `doc.toJS()` returns null for an empty (or comment-only) file — coerce to
  // an empty object so downstream merges fall back cleanly to defaults.
  const parsed = (doc.toJS() ?? {}) as Partial<JarvisConfig>;

  // Deep merge with defaults to ensure all required fields exist
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), parsed) as JarvisConfig;

  // Expand tilde in paths
  config.daemon.data_dir = expandTilde(config.daemon.data_dir);
  config.daemon.db_path = expandTilde(config.daemon.db_path);

  // Apply environment variable overrides
  applyEnvOverrides(config);

  // LLM configuration is owned exclusively by the DB + keychain (dashboard).
  // config.yaml has NO authority over any LLM setting, so discard anything the
  // file contributed and start from the empty default - the runtime tier map,
  // providers, and default are loaded from the DB by mergeLLMSettingsIntoConfig
  // at daemon startup.
  config.llm = structuredClone(DEFAULT_CONFIG.llm);

  return config;
}

/**
 * Strip the ENTIRE `llm` block before writing config.yaml.
 *
 * LLM configuration (providers, credentials, single-LLM default, tiers) lives
 * exclusively in the database + encrypted keychain and is managed from the
 * settings dashboard. config.yaml has no authority over any LLM setting, so it
 * must never carry one - dropping the block here also self-heals any stale
 * `llm:` section left over from older installs on the next save.
 */
function stripLLMConfigForYAML(config: JarvisConfig): JarvisConfig {
  const clone = structuredClone(config);
  delete (clone as { llm?: unknown }).llm;
  return clone;
}

/** Monotonic per-process counter for unique save temp-file names. */
let saveCounter = 0;

export async function saveConfig(
  config: JarvisConfig,
  configPath?: string
): Promise<void> {
  const path = configPath || expandTilde('~/.jarvis/config.yaml');

  try {
    const canonical = stripLLMConfigForYAML(config);
    const yaml = YAML.stringify(canonical, {
      indent: 2,
      lineWidth: 100,
      defaultStringType: 'PLAIN',
      defaultKeyType: 'PLAIN',
    });

    await secureParentDirectory(path);
    // Write-then-rename so the config is replaced atomically. A direct
    // O_TRUNC write leaves a truncated/empty config.yaml if the daemon is
    // killed mid-write -- on the next boot that parses as defaults and the
    // user loses onboarding state, authority overrides, everything.
    // The tmp name carries pid + a counter so two concurrent saves can
    // never rename each other's half-written file into place.
    const tmpPath = `${path}.${process.pid}.${saveCounter++}.tmp`;
    await secureWriteFile(tmpPath, yaml, 0o600, 'Config');

    // rename() would silently replace a symlinked config.yaml with a
    // regular file (e.g. a link into a dotfiles repo). secureWriteFile
    // refuses symlinks via O_NOFOLLOW; keep that contract here and fail
    // loudly instead of clobbering the link.
    const existing = await lstat(path).catch(() => null);
    if (existing?.isSymbolicLink()) {
      await unlink(tmpPath).catch(() => {});
      throw new Error(`${path} is a symlink; refusing to replace it`);
    }

    try {
      await rename(tmpPath, path);
    } catch {
      // Rename across-the-board works on POSIX; on Windows it can fail
      // transiently (antivirus holding the target). Fall back to the
      // in-place write rather than losing the save entirely.
      await unlink(tmpPath).catch(() => {});
      await secureWriteFile(path, yaml, 0o600, 'Config');
    }
    console.log(`Config saved to ${path}`);
  } catch (err) {
    throw new Error(`Failed to save config to ${path}: ${err}`);
  }
}
