/**
 * Manual test file for LLM providers
 *
 * Run with: bun run src/llm/test.ts
 */

import { LLMManager, AnthropicProvider, OpenAIProvider, LiteLLMProvider, OllamaProvider } from './index.ts';
import { loadConfig } from '../config/index.ts';

async function testProviders() {
  console.log('Loading config...');
  const config = await loadConfig();

  const manager = new LLMManager();

  // Register providers based on config
  if (config.llm.anthropic?.api_key) {
    const anthropic = new AnthropicProvider(
      config.llm.anthropic.api_key,
      config.llm.anthropic.model
    );
    manager.registerProvider(anthropic);
    console.log('Registered Anthropic provider');
  }

  if (config.llm.openai?.api_key) {
    const openai = new OpenAIProvider(
      config.llm.openai.api_key,
      config.llm.openai.model
    );
    manager.registerProvider(openai);
    console.log('Registered OpenAI provider');
  }

  if (config.llm.litellm?.base_url) {
    const litellm = new LiteLLMProvider(
      config.llm.litellm.base_url,
      config.llm.litellm.model,
      config.llm.litellm.api_key ?? ''
    );
    manager.registerProvider(litellm);
    console.log('Registered LiteLLM provider');
  }

  if (config.llm.ollama) {
    const ollama = new OllamaProvider(
      config.llm.ollama.base_url,
      config.llm.ollama.model
    );
    manager.registerProvider(ollama);
    console.log('Registered Ollama provider');
  }

  // Set primary and fallbacks
  manager.setPrimary(config.llm.primary);
  manager.setFallbackChain(config.llm.fallback);

  console.log(`\nPrimary provider: ${config.llm.primary}`);
  console.log(`Fallback chain: ${config.llm.fallback.join(', ')}\n`);

  // Test basic chat
  console.log('Testing chat...');
  const messages = [
    { role: 'system' as const, content: 'You are a helpful assistant.' },
    { role: 'user' as const, content: 'Say hello in exactly 5 words.' },
  ];

  try {
    const response = await manager.chat(messages);
    console.log('Response:', response.content);
    console.log('Model:', response.model);
    console.log('Usage:', response.usage);
    console.log('Finish reason:', response.finish_reason);
  } catch (err) {
    console.error('Chat failed:', err);
  }

  // Test streaming
  console.log('\n\nTesting streaming...');
  try {
    for await (const event of manager.stream(messages)) {
      if (event.type === 'text') {
        process.stdout.write(event.text);
      } else if (event.type === 'done') {
        console.log('\n\nStream completed!');
        console.log('Model:', event.response.model);
        console.log('Usage:', event.response.usage);
      } else if (event.type === 'error') {
        console.error('Stream error:', event.error);
      }
    }
  } catch (err) {
    console.error('Stream failed:', err);
  }
}

testProviders().catch(console.error);
