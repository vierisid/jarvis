#!/usr/bin/env bun

/**
 * Setup script for J.A.R.V.I.S. configuration
 *
 * This script helps you:
 * 1. Create the ~/.jarvis directory
 * 2. Copy the example config if needed
 * 3. Validate your configuration
 * 4. Test the LLM providers saved in the dashboard
 */

import { existsSync } from 'node:fs';
import { mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config/index.ts';
import type { JarvisConfig } from '../src/config/types.ts';
import { initDatabase, closeDb } from '../src/vault/schema.ts';
import { mergeLLMSettingsIntoConfig, testLLMProvider } from '../src/daemon/llm-settings.ts';
import { USEJARVIS_PROVIDER_NAME, effectiveLlmForBinding, hasUsejarvisAi } from '../src/daemon/usejarvis-ai.ts';
import { redactSecrets } from '../src/util/redact.ts';

const CONFIG_DIR = join(homedir(), '.jarvis');
const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');
const EXAMPLE_CONFIG = join(process.cwd(), 'config.example.yaml');

async function ensureConfigDir(): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    console.log(`Creating config directory: ${CONFIG_DIR}`);
    await mkdir(CONFIG_DIR, { recursive: true });
    console.log('✓ Config directory created\n');
  } else {
    console.log(`✓ Config directory exists: ${CONFIG_DIR}\n`);
  }
}

async function ensureConfigFile(): Promise<void> {
  if (!existsSync(CONFIG_PATH)) {
    console.log('Config file not found. Creating from example...');

    if (!existsSync(EXAMPLE_CONFIG)) {
      console.error('Error: config.example.yaml not found in project root');
      process.exit(1);
    }

    await copyFile(EXAMPLE_CONFIG, CONFIG_PATH);
    console.log(`✓ Config file created: ${CONFIG_PATH}`);
    console.log('\nAI providers and API keys are not set in this file.');
    console.log('Start Jarvis (jarvis start -d), enroll a device (jarvis enroll "my-desktop") and choose a provider in the dashboard setup screen.\n');
  } else {
    console.log(`✓ Config file exists: ${CONFIG_PATH}\n`);
  }
}

async function validateConfig(): Promise<JarvisConfig> {
  console.log('Loading configuration...');
  try {
    const config = await loadConfig();
    console.log('✓ Config loaded successfully\n');

    // LLM settings are not in config.yaml: loadConfig discards any `llm`
    // block, so they are reported by testProviders after the DB merge.
    console.log('Configuration Summary:');
    console.log(`  Daemon port: ${config.daemon.port}`);
    console.log(`  Data directory: ${config.daemon.data_dir}`);
    console.log(`  Database: ${config.daemon.db_path}`);
    console.log(`  Active role: ${config.active_role}`);
    console.log('');

    return config;
  } catch (err) {
    console.error('✗ Failed to load config:', err);
    process.exit(1);
  }
}

export type ProviderCheck = {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
};

/**
 * Test the LLM providers saved in the dashboard.
 *
 * Providers, keys, the default model and tiers live in the database and the
 * encrypted keychain, never in config.yaml, so this loads them the way the
 * daemon does (mergeLLMSettingsIntoConfig, without persisting migrations) and
 * runs each one through the same check as the dashboard's Test button.
 *
 * A missing database is reported, not created: the daemon creates and
 * migrates it on first start.
 */
export async function testProviders(
  config: JarvisConfig,
  log: (line: string) => void = console.log,
): Promise<ProviderCheck[]> {
  log('Testing LLM providers...\n');

  const dbPath = config.daemon.db_path;
  if (!existsSync(dbPath)) {
    log(`○ No database yet at ${dbPath}`);
    log('   Start Jarvis once, then add a provider in the dashboard (Settings > LLM).\n');
    return [];
  }

  // Not fully read-only: initDatabase runs the schema migrations, and the
  // merge still moves a pre-rework install's legacy keys into the keychain.
  // Both are what the daemon does at boot. persistMigrations:false keeps the
  // retired-model and orphaned-ref repairs in memory only.
  initDatabase(dbPath, { quiet: true });
  mergeLLMSettingsIntoConfig(config, { persistMigrations: false });

  const names = Object.keys(config.llm.providers ?? {});
  log(`  Default LLM: ${config.llm.default ?? '(not set)'}`);
  // The routing view, as jarvis doctor shows it: on a hosted install the plan
  // tier defaults exist only here, never in config.llm.tiers.
  const tiers = Object.entries(effectiveLlmForBinding(config).tiers ?? {}).filter(([, v]) => v);
  log(`  Tiers: ${tiers.length > 0 ? tiers.map(([k, v]) => `${k}=${v}`).join(', ') : '(none)'}`);
  log(`  Providers: ${names.join(', ') || '(none)'}`);
  log('');

  const results: ProviderCheck[] = [];
  for (const name of names) {
    if (name === USEJARVIS_PROVIDER_NAME && hasUsejarvisAi(config)) {
      results.push({ name, status: 'skipped', detail: 'managed by your hosted plan, not tested here' });
      log(`○ ${name}: managed by your hosted plan, not tested here`);
      continue;
    }
    const result = await testLLMProvider({ name }, config);
    if (result.ok) {
      const detail = result.model ? `model ${result.model}` : 'connected';
      results.push({ name, status: 'ok', detail });
      log(`✓ ${name}: Connected (${detail})`);
    } else {
      // A provider error can echo the credential it was sent, and setup
      // output gets pasted into bug reports: drop the saved key itself (it
      // may have no recognizable prefix) and anything else key-shaped.
      const key = config.llm.providers?.[name]?.api_key;
      const raw = result.error ?? 'unknown error';
      const detail = redactSecrets(key ? raw.split(key).join('***redacted***') : raw);
      results.push({ name, status: 'failed', detail });
      log(`✗ ${name}: ${detail}`);
    }
  }

  log('');
  if (!results.some((r) => r.status === 'ok' || r.status === 'skipped')) {
    log('⚠️  No working providers found!');
    log('   Add or fix a provider in the dashboard (Settings > LLM). Keys in config.yaml are ignored.\n');
  }
  return results;
}

async function main() {
  console.log('J.A.R.V.I.S. Configuration Setup\n');
  console.log('================================\n');

  await ensureConfigDir();
  await ensureConfigFile();
  const config = await validateConfig();
  try {
    await testProviders(config);
  } finally {
    closeDb();
  }

  console.log('Setup complete! 🚀\n');
  console.log('Next steps:');
  console.log('  1. Start Jarvis: jarvis start -d');
  console.log('  2. Enroll this device: jarvis enroll "my-desktop"');
  console.log('  3. Choose your AI provider in the dashboard setup screen');
  console.log('');
}

if (import.meta.main) {
  main().catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
  });
}
