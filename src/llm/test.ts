/**
 * Manual test file for LLM providers.
 *
 * Run with: bun run src/llm/test.ts
 *
 * Reads ~/.jarvis/config.yaml plus the DB-stored LLM settings (providers +
 * tiers are dashboard-managed and live in the database), instantiates each
 * configured provider, and exercises both non-streaming and streaming chat
 * via the LLMManager.
 */

import { LLMManager } from './index.ts';
import { loadConfig } from '../config/index.ts';
import { initDatabase } from '../vault/schema.ts';
import { mergeLLMSettingsIntoConfig } from '../daemon/llm-settings.ts';
import { registerLLMProviders, configureLLMTiers } from './config-binding.ts';

async function testProviders() {
  console.log('Loading config...');
  const config = await loadConfig();
  // Tiers (and dashboard-saved providers) live in the DB, not config.yaml.
  // Merge them in so this diagnostic exercises the same routing the daemon
  // uses at runtime.
  initDatabase(config.daemon.db_path);
  mergeLLMSettingsIntoConfig(config);

  const manager = new LLMManager();
  const hasProvider = registerLLMProviders(manager, config.llm.providers ?? {});
  if (!hasProvider) {
    console.error('No providers configured.');
    return;
  }
  configureLLMTiers(manager, config.llm);

  console.log(`Active providers: ${manager.getProviderNames().join(', ')}`);
  if (config.llm.default) console.log(`Default: ${config.llm.default}`);

  const messages = [
    { role: 'system' as const, content: 'You are a helpful assistant.' },
    { role: 'user' as const, content: 'Say hello in exactly 5 words.' },
  ];

  console.log('\nTesting chat...');
  try {
    const response = await manager.chatTier('medium', 'manual_test', messages);
    console.log('Response:', response.content);
    console.log('Model:', response.model);
    console.log('Usage:', response.usage);
  } catch (err) {
    console.error('Chat failed:', err);
  }

  console.log('\nTesting streaming...');
  try {
    for await (const event of manager.streamTier('medium', 'manual_test_stream', messages)) {
      if (event.type === 'text') {
        process.stdout.write(event.text);
      } else if (event.type === 'done') {
        console.log('\n\nStream completed!');
        console.log('Model:', event.response.model);
      } else if (event.type === 'error') {
        console.error('Stream error:', event.error);
      }
    }
  } catch (err) {
    console.error('Stream failed:', err);
  }
}

testProviders().catch(console.error);
