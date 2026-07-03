// Config types
export type { JarvisConfig, UserOwnedSection } from './types.ts';
export { DEFAULT_CONFIG, USER_OWNED_SECTIONS } from './types.ts';

// Config loader. There is no saveConfig: config.yaml is read-only system
// configuration; user-owned settings persist to the vault DB instead
// (daemon/user-settings.ts).
export { loadConfig, readRawConfigFile, applyEnvOverrides, deepMerge } from './loader.ts';
