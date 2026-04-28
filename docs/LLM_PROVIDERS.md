# J.A.R.V.I.S. LLM Providers Documentation

Complete guide to the LLM provider abstraction layer for Project J.A.R.V.I.S.

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Architecture](#architecture)
4. [Providers](#providers)
5. [Configuration](#configuration)
6. [Usage Examples](#usage-examples)
7. [API Reference](#api-reference)
8. [Testing](#testing)
9. [Troubleshooting](#troubleshooting)
10. [Advanced Topics](#advanced-topics)

## Overview

The J.A.R.V.I.S. LLM provider system provides a unified abstraction layer for multiple Large Language Model providers, enabling seamless switching between Anthropic, OpenAI, Groq, Gemini, OpenRouter, Ollama, and NVIDIA models with automatic fallback support.

### Key Features

- **Unified Interface**: Single API for all providers
- **Automatic Fallback**: Seamless provider switching on failure
- **Streaming Support**: Real-time response streaming
- **Tool Calling**: Cross-provider function calling
- **Type-Safe**: Full TypeScript type coverage
- **Zero Dependencies**: Uses native `fetch` API only

### Supported Providers

| Provider | Config key | Example default model | Notes |
|----------|------------|-----------------------|-------|
| **Anthropic** | `llm.anthropic` | `claude-sonnet-4-6` | Recommended default |
| **OpenAI** | `llm.openai` | `gpt-5.4` | GPT family, tools, streaming |
| **Groq** | `llm.groq` | `llama-3.3-70b-versatile` | Fast OpenAI-compatible inference |
| **Gemini** | `llm.gemini` | `gemini-3-flash-preview` | Google models |
| **OpenRouter** | `llm.openrouter` | `anthropic/claude-sonnet-4` | Broker for multi-vendor model access |
| **Ollama** | `llm.ollama` | `llama3` | Local models via `base_url` |
| **NVIDIA** | `llm.nvidia` | `mistral-nemo-minitron-8b-base` | Runtime/config supported; use YAML or env configuration |

## Quick Start

See [QUICKSTART.md](~/jarvis/QUICKSTART.md) for detailed setup instructions.

### 1. Install

```bash
cd ~/jarvis
bun install
```

### 2. Configure

```bash
bun run setup
```

This will:
- Create `~/.jarvis/` directory
- Copy example config
- Test provider connections

### 3. Use

```typescript
import { loadConfig } from './src/config/loader.ts';
import { LLMManager } from './src/llm/manager.ts';
import { AnthropicProvider } from './src/llm/anthropic.ts';

const config = await loadConfig();
const manager = new LLMManager();
const registeredProviders: string[] = [];

if (config.llm.anthropic?.api_key) {
  manager.registerProvider(
    new AnthropicProvider(
      config.llm.anthropic.api_key,
      config.llm.anthropic.model
    )
  );
  registeredProviders.push('anthropic');
}

if (registeredProviders.length === 0) {
  throw new Error('No LLM providers are configured');
}

const primaryProvider = registeredProviders.includes(config.llm.primary)
  ? config.llm.primary
  : registeredProviders[0];
const fallbackProviders = config.llm.fallback.filter((provider) =>
  registeredProviders.includes(provider)
);

manager.setPrimary(primaryProvider);
manager.setFallbackChain(fallbackProviders);

const response = await manager.chat([
  { role: 'user', content: 'Hello!' }
]);

console.log(response.content);
```

## Architecture

### System Diagram

```
┌──────────────────────────────────────────────┐
│           Application Layer                  │
│  (Daemon, Agents, Roles, Observers)         │
└─────────────────┬────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────┐
│              LLMManager                      │
│  • Provider Registration                    │
│  • Fallback Chain Management                │
│  • Unified chat() / stream() APIs           │
└──────┬────────┬────────┬──────────────────────┘
       │        │        │
       ▼        ▼        ▼
┌──────────┐ ┌─────────┐ ┌─────────┐
│Anthropic │ │ OpenAI  │ │  Groq   │
│Provider  │ │ Provider│ │ Provider│
└────┬─────┘ └────┬────┘ └────┬────┘
     │            │            │
     ▼            ▼            ▼
┌─────────┐ ┌──────────┐ ┌──────────┐
│Claude   │ │ OpenAI   │ │  Groq    │
│API      │ │ API      │ │  API     │
└─────────┘ └──────────┘ └──────────┘

...plus Gemini, OpenRouter, NVIDIA, and local Ollama providers registered through the same `LLMManager`.
```

### Component Overview

**LLMManager**: Central orchestrator that manages multiple providers and handles fallback logic.

**Provider Implementations**: Adapter classes that convert between provider-specific APIs and our unified interface.

**Type System**: Shared types (`LLMMessage`, `LLMResponse`, etc.) used across all providers.

**Configuration**: YAML-based config system with type-safe loading and defaults.

## Providers

The runtime currently registers providers from `src/daemon/agent-service.ts` when the corresponding config block is populated. The dashboard settings flow covers the common hosted providers plus Ollama/OpenRouter; NVIDIA is also supported by the runtime and config loader.

### Anthropic (Claude)

**Implementation**: `~/jarvis/src/llm/anthropic.ts`

```typescript
import { AnthropicProvider } from './llm/index.ts';

const provider = new AnthropicProvider(
  'sk-ant-...',                        // API key
  'claude-sonnet-4-5-20250929'         // Model (optional)
);
```

**Available Models**:
- `claude-opus-4-6` - Most capable, highest cost
- `claude-sonnet-4-5-20250929` - Balanced (default)
- `claude-3-5-sonnet-20241022` - Fast and capable
- `claude-3-haiku-20240307` - Fastest, lowest cost

**API Endpoint**: `https://api.anthropic.com/v1/messages`

**Special Features**:
- Separate system message handling
- Rich content blocks
- Native tool use support

### OpenAI (GPT)

**Implementation**: `~/jarvis/src/llm/openai.ts`

```typescript
import { OpenAIProvider } from './llm/index.ts';

const provider = new OpenAIProvider(
  'sk-...',           // API key
  'gpt-4o'            // Model (optional)
);
```

**Available Models**:
- `gpt-4o` - Latest GPT-4 optimized (default)
- `gpt-4-turbo` - Fast GPT-4
- `gpt-4` - Original GPT-4
- `gpt-3.5-turbo` - Fastest, cheapest

**API Endpoint**: `https://api.openai.com/v1/chat/completions`

**Special Features**:
- Function calling
- JSON mode
- Vision capabilities (gpt-4o)

### Ollama (Local Models)

**Implementation**: `~/jarvis/src/llm/ollama.ts`

```typescript
import { OllamaProvider } from './llm/index.ts';

const provider = new OllamaProvider(
  'http://localhost:11434',  // Base URL (optional)
  'llama3'                   // Model (optional)
);
```

**Popular Models**:
- `llama3` - Meta's Llama 3 (default)
- `mistral` - Mistral 7B
- `mixtral` - Mixtral 8x7B
- `codellama` - Code-specialized Llama

**API Endpoint**: `http://localhost:11434/api/chat`

**Setup**:
```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a model
ollama pull llama3

# Start server
ollama serve
```

## Configuration

### Configuration File

Location: `~/.jarvis/config.yaml`

```yaml
daemon:
  port: 3142
  data_dir: "~/.jarvis"
  db_path: "~/.jarvis/jarvis.db"
  brain_domain: "https://brain.example.com"

llm:
  primary: "anthropic"
  fallback: ["openai", "gemini", "openrouter", "ollama"]

  anthropic:
    api_key: "sk-ant-..."
    model: "claude-sonnet-4-6"

  openai:
    api_key: "sk-..."
    model: "gpt-5.4"

  groq:
    api_key: "gsk_..."
    model: "llama-3.3-70b-versatile"

  gemini:
    api_key: "AIza..."
    model: "gemini-3-flash-preview"

  openrouter:
    api_key: "sk-or-..."
    model: "anthropic/claude-sonnet-4"

  ollama:
    base_url: "http://localhost:11434"
    model: "llama3"

  nvidia:
    api_key: "nvapi-..."
    model: "mistral-nemo-minitron-8b-base"

personality:
  core_traits:
    - "loyal"
    - "efficient"
    - "proactive"
    - "respectful"
    - "adaptive"

authority:
  default_level: 3

active_role: "default"
```

### Environment Overrides

The config loader also supports direct env overrides for common provider secrets and runtime routing:

```bash
JARVIS_API_KEY=...            # Anthropic
JARVIS_OPENAI_KEY=...
JARVIS_GROQ_KEY=...
JARVIS_OPENROUTER_KEY=...
NVIDIA_API_KEY=...
JARVIS_OLLAMA_URL=http://localhost:11434
JARVIS_BRAIN_DOMAIN=https://brain.example.com
```

### Loading Configuration

```typescript
import { loadConfig } from './src/config/index.ts';

const config = await loadConfig();
// OR with custom path
const config = await loadConfig('/path/to/config.yaml');
```

### Saving Configuration

```typescript
import { saveConfig } from './src/config/index.ts';

config.daemon.port = 8888;
await saveConfig(config);
```

See [~/jarvis/src/config/README.md](~/jarvis/src/config/README.md) for complete config documentation.

## Usage Examples

### Basic Chat

```typescript
import { LLMManager, AnthropicProvider } from './src/llm/index.ts';

const manager = new LLMManager();
manager.registerProvider(new AnthropicProvider('sk-ant-...'));
manager.setPrimary('anthropic');

const response = await manager.chat([
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is TypeScript?' },
]);

console.log(response.content);
```

### Streaming Responses

```typescript
for await (const event of manager.stream(messages)) {
  if (event.type === 'text') {
    process.stdout.write(event.text);
  } else if (event.type === 'done') {
    console.log('\nDone!');
    console.log('Tokens:', event.response.usage);
  } else if (event.type === 'error') {
    console.error('Error:', event.error);
  }
}
```

### Tool/Function Calling

```typescript
const tools = [
  {
    name: 'get_weather',
    description: 'Get weather for a location',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string' },
        unit: { type: 'string', enum: ['C', 'F'] },
      },
      required: ['location'],
    },
  },
];

const response = await manager.chat(
  [{ role: 'user', content: 'What is the weather in Paris?' }],
  { tools }
);

if (response.tool_calls.length > 0) {
  for (const call of response.tool_calls) {
    console.log(`Call ${call.name} with`, call.arguments);
    // Execute tool and continue conversation
  }
}
```

### Multi-Provider with Fallback

```typescript
const manager = new LLMManager();

// Register multiple providers
manager.registerProvider(new AnthropicProvider('sk-ant-...'));
manager.registerProvider(new OpenAIProvider('sk-...'));
manager.registerProvider(new OllamaProvider());

// Configure fallback chain
manager.setPrimary('anthropic');
manager.setFallbackChain(['openai', 'ollama']);

// Will automatically try fallbacks if primary fails
const response = await manager.chat(messages);
```

### Provider-Specific Options

```typescript
const response = await manager.chat(messages, {
  model: 'claude-opus-4-6',    // Override default model
  temperature: 0.7,             // Creativity (0-1)
  max_tokens: 2000,             // Limit response length
});
```

## API Reference

### Types

#### LLMMessage
```typescript
type LLMMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};
```

#### LLMResponse
```typescript
type LLMResponse = {
  content: string;                           // Generated text
  tool_calls: LLMToolCall[];                 // Tool calls (if any)
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  model: string;                             // Model used
  finish_reason: 'stop' | 'tool_use' | 'length' | 'error';
};
```

#### LLMStreamEvent
```typescript
type LLMStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; tool_call: LLMToolCall }
  | { type: 'done'; response: LLMResponse }
  | { type: 'error'; error: string };
```

### LLMManager Methods

#### `registerProvider(provider: LLMProvider): void`
Register a new provider.

#### `setPrimary(name: string): void`
Set the primary provider to use.

#### `setFallbackChain(names: string[]): void`
Set ordered list of fallback providers.

#### `chat(messages, options?): Promise<LLMResponse>`
Get a single completion response.

#### `stream(messages, options?): AsyncIterable<LLMStreamEvent>`
Stream a response in real-time.

#### `getProvider(name: string): LLMProvider | undefined`
Get a specific registered provider.

### Provider Interface

All providers implement:

```typescript
interface LLMProvider {
  name: string;
  chat(messages, options?): Promise<LLMResponse>;
  stream(messages, options?): AsyncIterable<LLMStreamEvent>;
  listModels(): Promise<string[]>;
}
```

## Testing

### Run All Tests

```bash
bun test
```

### Test Specific Files

```bash
bun test src/llm/provider.test.ts
bun test src/config/loader.test.ts
```

### Manual Testing

```bash
# Setup config and test providers
bun run setup

# Test LLM functionality
bun run test:llm

# Run integration examples
bun run examples
```

## Troubleshooting

### Common Issues

**"No LLM providers configured"**
- Add at least one API key to `~/.jarvis/config.yaml`

**"Provider 'X' not registered"**
- Ensure provider is registered before setting as primary
- Check API key is present in config

**"Ollama not available"**
- Start Ollama: `ollama serve`
- Check it's running: `curl http://localhost:11434/api/tags`

**"Invalid API key"**
- Verify key in config file
- Check account has credits (for paid APIs)
- Ensure no extra spaces or quotes

**Streaming hangs**
- Check network connection
- Verify API endpoint is accessible
- Look for errors in console

### Debug Mode

Enable detailed logging:

```typescript
// In provider implementations, errors are logged to console.error
// Check browser/terminal console for detailed error messages
```

### Testing Providers Independently

```typescript
// Test just Anthropic
const anthropic = new AnthropicProvider('sk-ant-...');
const models = await anthropic.listModels();
console.log('Available:', models);

const response = await anthropic.chat([
  { role: 'user', content: 'test' }
]);
console.log('Response:', response);
```

## Advanced Topics

### Custom Provider Implementation

Create your own provider:

```typescript
import type { LLMProvider, LLMMessage, LLMResponse } from './provider.ts';

export class CustomProvider implements LLMProvider {
  name = 'custom';

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    // Your implementation
  }

  async *stream(messages: LLMMessage[]) {
    // Your streaming implementation
  }

  async listModels(): Promise<string[]> {
    return ['model1', 'model2'];
  }
}
```

### Response Caching

Implement caching to reduce API costs:

```typescript
const cache = new Map<string, LLMResponse>();

async function cachedChat(manager, messages) {
  const key = JSON.stringify(messages);
  if (cache.has(key)) return cache.get(key);

  const response = await manager.chat(messages);
  cache.set(key, response);
  return response;
}
```

### Usage Tracking

Track token usage across requests:

```typescript
let totalTokens = { input: 0, output: 0 };

const response = await manager.chat(messages);
totalTokens.input += response.usage.input_tokens;
totalTokens.output += response.usage.output_tokens;

console.log('Total usage:', totalTokens);
```

### Rate Limiting

Implement rate limiting:

```typescript
class RateLimitedManager extends LLMManager {
  private lastRequest = 0;
  private minInterval = 1000; // 1 second

  async chat(messages, options?) {
    const now = Date.now();
    const wait = this.minInterval - (now - this.lastRequest);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    this.lastRequest = Date.now();
    return super.chat(messages, options);
  }
}
```

### Multi-Turn Conversations

Manage conversation history:

```typescript
class Conversation {
  private messages: LLMMessage[] = [];

  constructor(private manager: LLMManager, systemPrompt?: string) {
    if (systemPrompt) {
      this.messages.push({ role: 'system', content: systemPrompt });
    }
  }

  async send(userMessage: string): Promise<string> {
    this.messages.push({ role: 'user', content: userMessage });

    const response = await this.manager.chat(this.messages);

    this.messages.push({
      role: 'assistant',
      content: response.content,
    });

    return response.content;
  }

  getHistory() {
    return [...this.messages];
  }
}
```

## Resources

### Documentation

- [LLM Provider README](~/jarvis/src/llm/README.md)
- [Config System README](~/jarvis/src/config/README.md)
- [Quick Start Guide](~/jarvis/QUICKSTART.md)
- [Implementation Summary](~/jarvis/IMPLEMENTATION_SUMMARY.md)

### Examples

- [Integration Example](~/jarvis/examples/llm-integration.ts)
- [Test Suite](~/jarvis/src/llm/test.ts)
- [Setup Script](~/jarvis/scripts/setup-config.ts)

### External Resources

- **Anthropic**: https://docs.anthropic.com/
- **OpenAI**: https://platform.openai.com/docs
- **Ollama**: https://github.com/ollama/ollama
- **Bun**: https://bun.sh/docs

---

Built for Project J.A.R.V.I.S. with ❤️
