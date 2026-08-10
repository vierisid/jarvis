import YAML from 'yaml';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { JarvisConfig } from './types.ts';
import { DEFAULT_CONFIG, USER_OWNED_SECTIONS, WORKFLOW_SYSTEM_KEYS } from './types.ts';

function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

export function deepMerge(target: any, source: any): any {
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
 * Env vars take highest precedence (over YAML, defaults, and DB-owned
 * sections; the daemon re-applies this after merging user settings from
 * the DB, so JARVIS_* stays a working self-host/dev convenience).
 */
export function applyEnvOverrides(config: JarvisConfig): void {
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

  if (env.JARVIS_PUBLIC_URL) {
    config.daemon.public_url = env.JARVIS_PUBLIC_URL;
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

  // The same rule now covers every USER-OWNED section (personality, voice,
  // authority, ...): they live in the vault DB settings store and the file
  // has no authority over them. config.yaml is a SYSTEM config: daemon.*,
  // auth, google. Legacy files that still carry user sections get a one-time
  // import into the DB at daemon boot (daemon/user-settings.ts) before this
  // discard makes them invisible; env overrides are re-applied on top by the
  // daemon after the DB merge.
  for (const section of USER_OWNED_SECTIONS) {
    const def = (DEFAULT_CONFIG as Record<string, unknown>)[section];
    // `workflows` is user-owned EXCEPT its system path keys (ready-made
    // artifact locations a deployment writes into the file): those survive
    // the discard, and user-settings' merge keeps them file-authoritative.
    let preserved: Record<string, unknown> | null = null;
    if (section === "workflows") {
      const current = (config as Record<string, unknown>)[section];
      if (current && typeof current === "object") {
        for (const key of WORKFLOW_SYSTEM_KEYS) {
          const v = (current as Record<string, unknown>)[key];
          if (typeof v === "string" && v.trim()) {
            (preserved ??= {})[key] = v;
          }
        }
      }
    }
    if (def === undefined) {
      delete (config as Record<string, unknown>)[section];
    } else {
      (config as Record<string, unknown>)[section] = structuredClone(def);
    }
    if (preserved) {
      (config as Record<string, unknown>)[section] = {
        ...((config as Record<string, unknown>)[section] as object | undefined),
        ...preserved,
      };
    }
  }
  applyEnvOverrides(config); // env wins over the discard (e.g. JARVIS_WAKE_ENGINE)

  return config;
}

/**
 * Read and parse the raw config.yaml WITHOUT defaults, env overrides, or the
 * user-section discard. Used exactly once per boot by the legacy-settings
 * import (daemon/user-settings.ts) to see what an old file still carries.
 * Returns null when the file doesn't exist; throws on YAML parse errors
 * (same as loadConfig).
 */
export async function readRawConfigFile(
  configPath?: string,
): Promise<Record<string, unknown> | null> {
  const path = configPath || expandTilde('~/.jarvis/config.yaml');
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const doc = YAML.parseDocument(await file.text(), { merge: true });
  if (doc.errors.length > 0) {
    const formatted = doc.errors.map((entry) => entry.message);
    throw new Error(`Failed to parse YAML config at ${path}:\n  ${formatted.join('\n  ')}`);
  }
  return (doc.toJS() ?? {}) as Record<string, unknown>;
}


// NOTE: there is intentionally no saveConfig here. The brain treats
// config.yaml as READ-ONLY system configuration (network/hosting keys,
// root-owned in hosted mode). All user-chosen settings persist to the vault
// DB settings store instead; see daemon/user-settings.ts.

// ── Listen address ──────────────────────────────────────────────────────────

export type ListenSpec =
  | { kind: 'tcp'; port: number }
  | { kind: 'unix'; path: string };

/**
 * Resolve where the daemon should listen. `daemon.listen: unix:/abs/path.sock`
 * selects a unix-domain socket (no TCP port is bound at all - hosted mode,
 * where Caddy fronts the socket); anything else falls back to TCP on
 * `daemon.port`. Malformed unix specs are fatal: silently falling back to a
 * TCP port on a shared host would expose the brain to other tenants.
 */
export function resolveListen(daemon: { port: number; listen?: string }): ListenSpec {
  const listen = daemon.listen?.trim();
  if (!listen) return { kind: 'tcp', port: daemon.port };
  if (listen.startsWith('unix:')) {
    const path = listen.slice('unix:'.length);
    if (!path.startsWith('/')) {
      throw new Error(`daemon.listen unix socket path must be absolute, got: ${listen}`);
    }
    return { kind: 'unix', path };
  }
  throw new Error(`Unsupported daemon.listen value: ${listen} (expected "unix:/abs/path.sock")`);
}
