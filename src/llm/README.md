# J.A.R.V.I.S. LLM Provider System

A unified abstraction layer for multiple LLM providers with automatic fallback support.

## Features

- **Unified Interface**: Single API for Anthropic Claude, OpenAI GPT, and Ollama (local models)
- **Automatic Fallback**: Seamlessly switches to backup providers if primary fails
- **Streaming Support**: Real-time response streaming for all providers
- **Tool Calling**: Unified tool/function calling across providers
- **Zero Dependencies**: Uses native `fetch` API (no SDKs required)
- **Type-Safe**: Full TypeScript types for all operations

## Supported Providers

### 1. Anthropic Claude
- **Models**: Claude Opus 4.6, Sonnet 4.5, Claude 3.5, Claude 3
- **Default**: `claude-sonnet-4-5-20250929`
- **Features**: Text generation, streaming, tool use
- **API**: https://api.anthropic.com/v1/messages

Anthropic providers can also use a Claude-compatible gateway. In onboarding or **Settings > LLM**, enable **Use a custom Anthropic endpoint**, enter the gateway origin, and put the value normally used for `ANTHROPIC_AUTH_TOKEN` in the credential field. Jarvis appends `/v1/messages`, sends the token as `Authorization: Bearer …`, and reads available models from `/v1/models` when the gateway supports it.

Leaving the base URL blank keeps the standard Anthropic endpoint and `x-api-key` authentication.

### 2. OpenAI GPT
- **Models**: GPT-4o, GPT-4 Turbo, GPT-3.5 Turbo
- **Default**: `gpt-4o`
- **Features**: Text generation, streaming, function calling
- **API**: https://api.openai.com/v1/chat/completions

### 3. Ollama (Local)
- **Models**: Llama 3, Llama 2, Mistral, Mixtral, CodeLlama, etc.
- **Default**: `llama3`
- **Features**: Local inference, streaming, tool use
- **API**: http://localhost:11434/api/chat

### 4. OmniRoute
- **Routes**: Every model, free route, automatic route, and combo returned by the configured gateway
- **Default route**: `auto`
- **Features**: Text and multimodal messages, streaming, function/tool calling, live route discovery
- **Default API**: http://localhost:20128/v1

Jarvis also includes first-class adapters for Groq, Gemini, OpenRouter, NVIDIA NIM, LiteLLM, and generic OpenAI-compatible endpoints.

## Usage

### Basic Setup

```typescript
import { LLMManager, AnthropicProvider, OpenAIProvider, OllamaProvider } from './llm/index.ts';

const manager = new LLMManager();

// Register providers
const anthropic = new AnthropicProvider('sk-ant-...', 'claude-sonnet-4-5-20250929');
manager.registerProvider(anthropic);

const openai = new OpenAIProvider('sk-...', 'gpt-4o');
manager.registerProvider(openai);

const ollama = new OllamaProvider('http://localhost:11434', 'llama3');
manager.registerProvider(ollama);

// Set primary and fallbacks
manager.setPrimary('anthropic');
manager.setFallbackChain(['openai', 'ollama']);
```

### Simple Chat

```typescript
const messages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is TypeScript?' },
];

const response = await manager.chat(messages);
console.log(response.content);
console.log('Tokens:', response.usage);
console.log('Model:', response.model);
```

### Streaming Responses

```typescript
for await (const event of manager.stream(messages)) {
  if (event.type === 'text') {
    process.stdout.write(event.text);
  } else if (event.type === 'done') {
    console.log('\nCompleted!');
    console.log('Total tokens:', event.response.usage);
  } else if (event.type === 'error') {
    console.error('Error:', event.error);
  }
}
```

### Tool Calling

```typescript
const tools = [
  {
    name: 'get_weather',
    description: 'Get the current weather in a location',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
      },
      required: ['location'],
    },
  },
];

const messages = [
  { role: 'user', content: 'What is the weather in Paris?' },
];

const response = await manager.chat(messages, { tools });

if (response.tool_calls.length > 0) {
  for (const call of response.tool_calls) {
    console.log('Tool:', call.name);
    console.log('Arguments:', call.arguments);
    // Execute tool and continue conversation...
  }
}
```

### Advanced Options

```typescript
const response = await manager.chat(messages, {
  model: 'claude-opus-4-6',      // Override default model
  temperature: 0.7,               // Control randomness (0-1)
  max_tokens: 2000,               // Limit response length
  tools: [...],                   // Tool definitions
});
```

## Configuration

Load from `~/.jarvis/config.yaml`:

```typescript
import { loadConfig } from './config/index.ts';

const config = await loadConfig();

// Auto-configure providers from config
if (config.llm.anthropic?.api_key) {
  const anthropic = new AnthropicProvider(
    config.llm.anthropic.api_key,
    config.llm.anthropic.model
  );
  manager.registerProvider(anthropic);
}

manager.setPrimary(config.llm.primary);
manager.setFallbackChain(config.llm.fallback);
```

## Provider-Specific Usage

### Direct Provider Access

```typescript
const provider = manager.getProvider('anthropic');
if (provider) {
  const response = await provider.chat(messages);
}
```

### List Available Models

```typescript
const anthropic = new AnthropicProvider('sk-ant-...');
const models = await anthropic.listModels();
console.log('Available models:', models);
```

## Response Types

### LLMResponse

```typescript
{
  content: string;                           // Generated text
  tool_calls: LLMToolCall[];                 // Tool calls made (if any)
  usage: {
    input_tokens: number;                    // Prompt tokens
    output_tokens: number;                   // Completion tokens
  };
  model: string;                             // Model used
  finish_reason: 'stop' | 'tool_use' | 'length' | 'error';
}
```

### LLMStreamEvent

```typescript
// Text delta
{ type: 'text'; text: string }

// Tool call completed
{ type: 'tool_call'; tool_call: LLMToolCall }

// Stream finished
{ type: 'done'; response: LLMResponse }

// Error occurred
{ type: 'error'; error: string }
```

## Error Handling

The manager automatically tries fallback providers on failure:

```typescript
try {
  const response = await manager.chat(messages);
} catch (err) {
  // All providers failed
  console.error('All LLM providers failed:', err.message);
}
```

Individual provider errors are logged but don't throw unless all providers fail.

## Testing

Run the test file:

```bash
bun run src/llm/test.ts
```

Make sure you have a valid config at `~/.jarvis/config.yaml` with API keys set.

## Implementation Details

### Message Conversion

Each provider has different message formats:
- **Anthropic**: Separates system message, converts roles
- **OpenAI**: Standard chat format
- **Ollama**: Chat API format

The abstraction layer handles all conversions automatically.

### Tool Calling Formats

- **Anthropic**: `tools` array with `input_schema`
- **OpenAI**: `tools` array with `function` wrapper
- **Ollama**: OpenAI-compatible function calling

All converted to unified `LLMToolCall` format in responses.

### Streaming Implementation

- **Anthropic**: Server-Sent Events (SSE) with `data: {...}` format
- **OpenAI**: SSE with delta chunks
- **Ollama**: Newline-delimited JSON streaming

All providers return the same `LLMStreamEvent` types.

## Architecture

```
LLMManager
├── AnthropicProvider (implements LLMProvider)
├── OpenAIProvider (implements LLMProvider)
└── OllamaProvider (implements LLMProvider)

Each provider:
- Implements chat() for single responses
- Implements stream() for streaming responses
- Implements listModels() for available models
- Handles provider-specific API formats
- Converts to/from unified types
```

## Best Practices

1. **Always use LLMManager**: Don't instantiate providers directly unless needed
2. **Set up fallbacks**: Configure multiple providers for reliability
3. **Handle stream errors**: Check for `error` events in stream loops
4. **Use config system**: Load API keys from config, never hardcode
5. **Monitor usage**: Track token usage from responses for cost control
6. **Test locally first**: Use Ollama for development before hitting paid APIs

## Future Enhancements

- [ ] Response caching
- [ ] Rate limiting
- [ ] Usage tracking/analytics
- [ ] Model capability detection
- [ ] Automatic model selection based on task
- [ ] Retry with exponential backoff
- [ ] Cost estimation per request
- [ ] Multi-turn conversation helpers
