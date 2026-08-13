#!/usr/bin/env bun

/**
 * Setup script for J.A.R.V.I.S. configuration
 *
 * This script helps you:
 * 1. Create the ~/.jarvis directory
 * 2. Copy the example config if needed
 * 3. Validate your configuration
 * 4. Test LLM provider connectivity
 */

import { existsSync } from 'node:fs';
import { mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config/index.ts';
import {
  LLMManager,
  AnthropicProvider,
  OpenAIProvider,
  OllamaProvider,
} from '../src/llm/index.ts';

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
    console.log('\n⚠️  Please edit the config file and add your API keys:');
    console.log(`   nano ${CONFIG_PATH}\n`);
  } else {
    console.log(`✓ Config file exists: ${CONFIG_PATH}\n`);
  }
}

async function validateConfig(): Promise<any> {
  console.log('Loading configuration...');
  try {
    const config = await loadConfig();
    console.log('✓ Config loaded successfully\n');

    console.log('Configuration Summary:');
    console.log(`  Daemon port: ${config.daemon.port}`);
    console.log(`  Data directory: ${config.daemon.data_dir}`);
    console.log(`  Database: ${config.daemon.db_path}`);
    // `llm.primary` / `llm.fallback` are a schema that no longer exists — the
    // fallback line threw on `undefined.join` every time this ran. The current
    // shape is a single `default` model plus an optional per-tier map.
    console.log(`  Default LLM: ${config.llm.default ?? '(not set)'}`);
    const tiers = Object.entries(config.llm.tiers ?? {}).filter(([, v]) => v);
    console.log(`  Tiers: ${tiers.length > 0 ? tiers.map(([k, v]) => `${k}=${v}`).join(', ') : '(none)'}`);
    console.log(`  Providers: ${Object.keys(config.llm.providers ?? {}).join(', ') || '(none)'}`);
    console.log(`  Active role: ${config.active_role}`);
    console.log('');

    return config;
  } catch (err) {
    console.error('✗ Failed to load config:', err);
    process.exit(1);
  }
}

async function testProviders(config: any): Promise<void> {
  console.log('Testing LLM providers...\n');

  const manager = new LLMManager();
  let hasProvider = false;

  // Test Anthropic
  if (config.llm.anthropic?.api_key) {
    if (config.llm.anthropic.api_key === '') {
      console.log('⚠️  Anthropic: API key not set');
    } else {
      try {
        const provider = new AnthropicProvider(
          config.llm.anthropic.api_key,
          config.llm.anthropic.model
        );
        const models = await provider.listModels();
        manager.registerProvider(provider);
        console.log(`✓ Anthropic: Connected (${models.length} models available)`);
        hasProvider = true;
      } catch (err) {
        console.log(`✗ Anthropic: Connection failed - ${err}`);
      }
    }
  } else {
    console.log('○ Anthropic: Not configured');
  }

  // Test OpenAI
  if (config.llm.openai?.api_key) {
    if (config.llm.openai.api_key === '') {
      console.log('⚠️  OpenAI: API key not set');
    } else {
      try {
        const provider = new OpenAIProvider(
          config.llm.openai.api_key,
          config.llm.openai.model
        );
        const models = await provider.listModels();
        manager.registerProvider(provider);
        console.log(`✓ OpenAI: Connected (${models.length} models available)`);
        hasProvider = true;
      } catch (err) {
        console.log(`✗ OpenAI: Connection failed - ${err}`);
      }
    }
  } else {
    console.log('○ OpenAI: Not configured');
  }

  // Test Ollama
  if (config.llm.ollama) {
    try {
      const provider = new OllamaProvider(
        config.llm.ollama.base_url,
        config.llm.ollama.model
      );
      const models = await provider.listModels();
      manager.registerProvider(provider);
      console.log(`✓ Ollama: Connected (${models.length} models available)`);
      console.log(`  Models: ${models.join(', ')}`);
      hasProvider = true;
    } catch (err) {
      console.log('✗ Ollama: Not running or connection failed');
      console.log('  Tip: Start Ollama with: ollama serve');
    }
  } else {
    console.log('○ Ollama: Not configured');
  }

  console.log('');

  if (!hasProvider) {
    console.log('⚠️  No working providers found!');
    console.log('   Please add at least one API key to your config.\n');
    return;
  }

  // Configure manager
  try {
    manager.setPrimary(config.llm.primary);
    manager.setFallbackChain(config.llm.fallback);
  } catch (err) {
    console.log(`⚠️  Warning: ${err}`);
    console.log('   Check that primary and fallback providers are configured.\n');
    return;
  }

  // Test chat
  console.log('Testing chat completion...');
  try {
    const response = await manager.chat(
      [
        { role: 'system', content: 'You are J.A.R.V.I.S.' },
        { role: 'user', content: 'Say "hello" in exactly 3 words.' },
      ],
      { max_tokens: 50 }
    );

    console.log(`✓ Chat successful!`);
    console.log(`  Model: ${response.model}`);
    console.log(`  Response: ${response.content}`);
    console.log(`  Tokens: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out`);
    console.log('');
  } catch (err) {
    console.log(`✗ Chat failed: ${err}\n`);
  }
}

async function main() {
  console.log('J.A.R.V.I.S. Configuration Setup\n');
  console.log('================================\n');

  await ensureConfigDir();
  await ensureConfigFile();
  const config = await validateConfig();
  await testProviders(config);

  console.log('Setup complete! 🚀\n');
  console.log('Next steps:');
  console.log('  1. Edit config if needed: nano ~/.jarvis/config.yaml');
  console.log('  2. Run tests: bun run src/llm/test.ts');
  console.log('  3. Try examples: bun run examples/llm-integration.ts');
  console.log('');
}

main().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
