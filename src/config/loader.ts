import YAML from 'yaml';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { JarvisConfig } from './types.ts';
import { DEFAULT_CONFIG } from './types.ts';

function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

function deepMerge(target: any, source: any): any {
  if (!source || typeof source !== 'object') {
    return source !== undefined ? source : target;
  }

  if (Array.isArray(source)) {
    return source;
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

  if (env.JARVIS_API_KEY) {
    if (!config.llm.anthropic) config.llm.anthropic = { api_key: '', model: 'claude-sonnet-4-5-20250929' };
    config.llm.anthropic.api_key = env.JARVIS_API_KEY;
  }

  if (env.JARVIS_OPENAI_KEY) {
    if (!config.llm.openai) config.llm.openai = { api_key: '', model: 'gpt-4o' };
    config.llm.openai.api_key = env.JARVIS_OPENAI_KEY;
  }

  if (env.JARVIS_OLLAMA_URL) {
    if (!config.llm.ollama) config.llm.ollama = { base_url: '', model: 'llama3' };
    config.llm.ollama.base_url = env.JARVIS_OLLAMA_URL;
  }

  if (env.JARVIS_OPENROUTER_KEY) {
    if (!config.llm.openrouter) config.llm.openrouter = { api_key: '', model: 'anthropic/claude-sonnet-4' };
    config.llm.openrouter.api_key = env.JARVIS_OPENROUTER_KEY;
  }

  if (env.JARVIS_BRAIN_DOMAIN) {
    config.daemon.brain_domain = env.JARVIS_BRAIN_DOMAIN;
  }

  if (env.JARVIS_AUTH_TOKEN) {
    if (!config.auth) config.auth = {};
    config.auth.token = env.JARVIS_AUTH_TOKEN;
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

  // File exists — parse errors should be fatal
  const text = await file.text();
  const parsed = YAML.parse(text);  // throws YAMLParseError on bad syntax

  // Deep merge with defaults to ensure all required fields exist
  const config = deepMerge(DEFAULT_CONFIG, parsed) as JarvisConfig;

  // Expand tilde in paths
  config.daemon.data_dir = expandTilde(config.daemon.data_dir);
  config.daemon.db_path = expandTilde(config.daemon.db_path);

  // Apply environment variable overrides
  applyEnvOverrides(config);

  return config;
}

export async function saveConfig(
  config: JarvisConfig,
  configPath?: string
): Promise<void> {
  const path = configPath || expandTilde('~/.jarvis/config.yaml');

  try {
    const yaml = YAML.stringify(config, {
      indent: 2,
      lineWidth: 100,
      defaultStringType: 'QUOTE_DOUBLE',
    });

    await Bun.write(path, yaml);
    console.log(`Config saved to ${path}`);
  } catch (err) {
    throw new Error(`Failed to save config to ${path}: ${err}`);
  }
}
