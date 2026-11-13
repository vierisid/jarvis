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

The J.A.R.V.I.S. LLM provider system puts every supported model API behind one interface (`LLMProvider`) and routes requests through one `LLMManager`. The daemon picks a provider and model per tier (conversation, high, medium, low) from the settings saved in the dashboard.

### Key Features

- **Unified Interface**: one `chat()` / `stream()` / `listModels()` contract for every provider kind
- **Tier Routing**: requests name a tier; an unassigned task tier falls up (low to medium to high, medium to high, high to medium), the conversation tier never does
- **Retries and Failover**: up to 3 attempts per provider (non-streaming attempts time out after 90 seconds); rate limits, exhausted quota and missing models fail over to the next provider mapped to the tier or its fall-up chain
- **Streaming Support**: real-time response streaming
- **Tool Calling**: cross-provider function calling
- **Usage Recording**: tier calls record tokens per subsystem in the `llm_usage` table (the Usage room)
- **No vendor SDKs**: every provider talks to its API with `fetch`

### Supported Providers

Add and configure providers in the dashboard: onboarding on first run, or **Settings > LLM** later. Keys and URLs are stored in the database and encrypted keychain. See [QUICKSTART.md](../QUICKSTART.md) for the first-run path.

| Provider | What it needs | Notes |
|----------|---------------|-------|
| **Anthropic** | API key | Optional custom endpoint URL (and auth token) for a gateway |
| **OpenAI** | API key | |
| **Gemini** | API key | |
| **Groq** | API key | Model list is loaded from Groq |
| **OpenRouter** | API key | One key, many vendors' models |
| **NVIDIA NIM** | API key | Catalog includes non-chat models; the connection test checks chat support |
| **Ollama** | Base URL (default `http://localhost:11434`) | Local, no key. Pull a model first (`ollama pull <model>`) and keep `ollama serve` running |
| **OpenAI-compatible** | Base URL, key optional | Any server that speaks `/v1/chat/completions` (LM Studio, llama.cpp, vLLM) |
| **LiteLLM** | Proxy URL, key optional | The model name must match an alias on your proxy |
| **OmniRoute** | API URL, key optional | Loads routes and combos from your instance |

Local and compatible providers have in-dashboard [setup guides](provider-guides/README.md). The model picker loads a live catalog for Groq, NVIDIA NIM, Ollama and OmniRoute; for Anthropic, OpenAI, Gemini and OpenRouter it suggests the curated list in `src/llm/model-catalog.ts`, and **Settings > LLM** also offers **Custom...** for another model id. OpenAI-compatible and LiteLLM take a model name you enter.

On hosted installs a system-managed Usejarvis AI provider is added for you; it is not user-creatable.

## Quick Start

### 1. Install and start

```bash
curl -fsSL https://raw.githubusercontent.com/vierisid/jarvis/main/install.sh | bash
jarvis start -d --no-open
```

### 2. Open the dashboard

Run `jarvis enroll "my-laptop"` and use the token in the desktop app, or follow [QUICKSTART.md](../QUICKSTART.md#3-get-into-the-dashboard) for the browser-only path. The dashboard is on port 3142 by default.

### 3. Choose a provider

Pick one in the setup screen, enter its key or URL, and test the connection. `config.yaml` has no LLM settings: an `llm:` block is ignored, and the old provider-key environment variables are not read.

### 4. Use the layer from code

For contributors. Inside the daemon, providers come from the saved configuration. A standalone script constructs them directly:

```typescript
import { LLMManager, AnthropicProvider } from './src/llm/index.ts';

const manager = new LLMManager();
manager.registerProvider(new AnthropicProvider(process.env.MY_SCRIPT_KEY!));

const response = await manager.chat([
  { role: 'user', content: 'Hello!' }
]);

console.log(response.content);
```

## Architecture

### System Diagram

```
+------------------------------------------------------+
| Application layer                                    |
| (daemon agents, voice, channels, workflows, goals)   |
+---------------------------+--------------------------+
                            | chatTier / streamTier (tier, subsystem)
                            v
+------------------------------------------------------+
| LLMManager                                           |
|  - tier map: conversation / high / medium / low      |
|  - fall-up, retries, Retry-After, failover           |
|  - usage recording (llm_usage)                       |
+---------------------------+--------------------------+
                            | one provider per candidate
                            v
+------------------------------------------------------+
| LLMProvider implementations (src/llm/*.ts)           |
| anthropic, openai, gemini, groq, openrouter, nvidia, |
| ollama, openai_compatible, litellm, omniroute,       |
| usejarvis_ai (hosted)                                |
+------------------------------------------------------+
```

### Component Overview

**LLMManager** (`src/llm/manager.ts`): holds the registered providers and the tier map, resolves a tier to a provider and model, and retries and fails over.

**Provider Implementations**: adapter classes that convert between each API and the shared types.

**Type System** (`src/llm/provider.ts`): shared types (`LLMMessage`, `LLMResponse`, `LLMStreamEvent`, ...) used by every provider.

**Configuration binding** (`src/llm/config-binding.ts`): turns the saved settings into providers and a tier map. `mergeLLMSettingsIntoConfig` (`src/daemon/llm-settings.ts`) loads providers, the default model and tiers from the database and keychain; `registerLLMProviders` instantiates each entry under its saved name; `configureLLMTiers` builds the tier map from `llm.default` and `llm.tiers` (model refs are `name:model` strings).

## Providers

### Anthropic (Claude)

**Implementation**: `../src/llm/anthropic.ts`

```typescript
import { AnthropicProvider } from './src/llm/index.ts';

const provider = new AnthropicProvider(
  'sk-ant-...',                        // API key
  'claude-sonnet-5-5'                  // Model (optional)
);
```

**Available Models**:
Suggested models are listed in `src/llm/model-catalog.ts` and shown in the dashboard model picker. With a custom endpoint URL, the connection test reads the endpoint's own model list.

**API Endpoint**: `https://api.anthropic.com/v1/messages`

**Special Features**:
- Separate system message handling
- Rich content blocks
- Native tool use support

### OpenAI (GPT)

**Implementation**: `../src/llm/openai.ts`

```typescript
import { OpenAIProvider } from './src/llm/index.ts';

const provider = new OpenAIProvider(
  'sk-...',           // API key
  'gpt-4o'            // Model (optional)
);
```

**Available Models**: see `src/llm/model-catalog.ts` and the dashboard model picker.

**API Endpoint**: `https://api.openai.com/v1/chat/completions` (`/v1/responses` for `gpt-6` models on the official endpoint)

**Special Features**:
- Function calling
- Image input (`ContentBlock` images)

### Ollama (Local Models)

**Implementation**: `../src/llm/ollama.ts`

```typescript
import { OllamaProvider } from './src/llm/index.ts';

const provider = new OllamaProvider(
  'http://localhost:11434',  // Base URL (optional)
  'llama3'                   // Model (optional)
);
```

**Models**: whatever your Ollama install has pulled. The dashboard loads that list from `/api/tags`. The constructor's `llama3` default is only a placeholder, so pick a model you have pulled.

**API Endpoint**: `http://localhost:11434/api/chat`

**Setup**:
```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a model
ollama pull llama3.2

# Start server
ollama serve
```

## Configuration

Providers, credentials, the default model, and per-tier routing are set in the dashboard (onboarding or **Settings > LLM**). They live in the database and encrypted keychain.

`~/.jarvis/config.yaml` holds system settings only (port, public URL, timezone, logging). It has no LLM settings: an `llm:` block is ignored on load (the brain never writes this file), and the old provider-key environment variables are not read. See [config.example.yaml](../config.example.yaml) and [the config README](../src/config/README.md).

The daemon listens on port 3142 by default (`daemon.port`).

## Usage Examples

These are for contributors writing standalone scripts. Inside the daemon the providers and tier map come from the saved settings (see Architecture). `src/llm/test.ts` shows the full load-and-bind sequence against your saved settings.

### Basic Chat

```typescript
import { LLMManager, AnthropicProvider } from './src/llm/index.ts';

const manager = new LLMManager();
manager.registerProvider(new AnthropicProvider(process.env.MY_SCRIPT_KEY!));
// Route the medium tier (and, by fall-up, low and high) to that provider.
manager.setTierMap({ medium: { provider: 'anthropic', model: 'claude-sonnet-5-5' } });

const messages = [
  { role: 'system' as const, content: 'You are a helpful assistant.' },
  { role: 'user' as const, content: 'What is TypeScript?' },
];

// The second argument labels the call in usage records.
const response = await manager.chatTier('medium', 'my_script', messages);
console.log(response.content);
```

### Streaming Responses

```typescript
for await (const event of manager.streamTier('medium', 'my_script', messages)) {
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

const response = await manager.chatTier(
  'medium',
  'my_script',
  [{ role: 'user', content: 'What is the weather in Paris?' }],
  { tools },
);

if (response.tool_calls.length > 0) {
  for (const call of response.tool_calls) {
    console.log(`Call ${call.name} with`, call.arguments);
    // Run the tool, then send its result back as a { role: 'tool', tool_call_id: call.id } message
  }
}
```

### Several Providers

```typescript
const manager = new LLMManager();
manager.registerProvider(new AnthropicProvider(process.env.MY_SCRIPT_KEY!));
manager.registerProvider(new OllamaProvider('http://localhost:11434', 'llama3.2'));

manager.setTierMap({
  high: { provider: 'anthropic', model: 'claude-opus-5-5' },
  low: { provider: 'ollama', model: 'llama3.2' },
});

// medium is unassigned, so it falls up to high (Anthropic). Failover only
// reaches providers mapped to the tier or its fall-up chain, so medium never
// reaches Ollama: a missing model retries Anthropic's own default model, and
// a rate limit or exhausted quota fails the call. Ollama serves only low.
const response = await manager.chatTier('medium', 'my_script', messages);
```

`setPrimary` / `setFallbackChain` and the tier-less `chat()` / `stream()` still exist for older callers: `chat()` and `stream()` route through the medium tier when medium resolves (medium or high is assigned), and otherwise use the primary plus fallback chain.

### Per-Call Options

```typescript
const response = await manager.chatTier('medium', 'my_script', messages, {
  model: 'claude-opus-5-5',    // Override the tier's model for this call
  temperature: 0.7,
  max_tokens: 2000,
});
```

## API Reference

### Types

All in `src/llm/provider.ts`.

#### LLMMessage
```typescript
type LLMMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];   // text, or text and base64 image blocks
  tool_calls?: LLMToolCall[];         // assistant messages that called tools
  tool_call_id?: string;              // tool result messages
  cache?: boolean;                    // stable prompt-cache boundary (system messages)
};
```

#### LLMResponse
```typescript
type LLMResponse = {
  content: string;
  tool_calls: LLMToolCall[];
  usage: {
    input_tokens: number;                  // uncached prompt tokens only
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  model: string;
  finish_reason: 'stop' | 'tool_use' | 'length' | 'error';
};
```

#### LLMStreamEvent
```typescript
type LLMStreamEvent =
  | { type: 'text'; text: string; segmentEnd?: boolean }
  | { type: 'tool_call'; tool_call: LLMToolCall }
  | { type: 'done'; response: LLMResponse }
  | { type: 'error'; error: string; code?: LLMErrorCode; retry_after_ms?: number; usage?: LLMUsage; hosted_detail?: string };
```

### LLMManager Methods

#### `registerProvider(provider: LLMProvider): void`
Register a provider under its `name`.

#### `setTierMap(tiers: TierMap): void`
Replace the tier map (`{ conversation?, high?, medium?, low? }`, each `{ provider, model? }`). Throws if a tier names an unregistered provider.

#### `chatTier(tier, subsystem, messages, options?): Promise<LLMResponse>`
One completion on the provider resolved for `tier`, with fall-up, retries and failover. `subsystem` labels the usage record.

#### `streamTier(tier, subsystem, messages, options?): AsyncIterable<LLMStreamEvent>`
The streaming form of `chatTier`.

#### `getProvider(name: string): LLMProvider | undefined`
Get a registered provider.

#### Legacy: `chat()`, `stream()`, `setPrimary()`, `setFallbackChain()`
Kept for older callers; see "Several Providers" above.

### Provider Interface

All providers implement:

```typescript
interface LLMProvider {
  name: string;
  readonly placeholderDefaultModel?: boolean;  // default model is a guess (local servers, gateways)
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

Add a provider in **Settings > LLM** and use its connection test, then send a message in chat.

From a source checkout, `bun run setup` runs every saved provider through the same check as the dashboard's connection test, and `bun run test:llm` (`src/llm/test.ts`) loads the providers and tiers saved in the dashboard from the same database and runs a chat, a streaming and a prompt-cache check on the medium tier.

## Troubleshooting

### Common Issues

**"No LLM providers configured"**
- Add a provider in the dashboard (Settings > LLM). Keys in `config.yaml` are ignored

**"No provider configured for tier '...' or its fall-up chain"**
- No default model and no model for that tier (or the tiers it falls up to). Choose a default model or assign the tier in Settings > LLM
- A saved ref to a provider that was deleted is dropped at startup with `[LLM] Dropped model refs for providers that no longer exist: ...` in the daemon log, so its tier needs a new model
- `[LLM] Tier '...' references unregistered provider '...' - skipping.` means the provider is saved but could not be built, usually because its key is missing: re-enter it in Settings > LLM

**"Provider 'X' not registered"**
- Only from scripts: register the provider before `setTierMap` (or `setPrimary` / `setFallbackChain`)
- Check the provider is added and its key saved in Settings > LLM

**Ollama connection fails**
- Start Ollama: `ollama serve`
- Check it's running: `curl http://localhost:11434/api/tags`
- Pull the model the tier uses: `ollama pull <model>`

**"Invalid API key"**
- Re-enter the key in Settings > LLM and test the connection
- Check account has credits (for paid APIs)
- Ensure no extra spaces or quotes

**Streaming hangs**
- Check network connection
- Verify API endpoint is accessible
- Look for errors in the daemon log

### Debug Mode

Every failed attempt is always logged to the daemon log. `JARVIS_LOG_LEVEL=debug` (or `DEBUG_LLM=true`) also logs which retry attempt succeeded, and `jarvis doctor` reports the saved providers and a test chat.

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

### Prompt Caching

Provider-side prompt caching is enabled by default and controlled by the `llm.prompt_cache` setting, stored in the database like the tier map. The dashboard has no control for it: send `{"prompt_cache": false}` to `POST /api/config/llm` to disable it. Only an explicit `false` disables it.

How it works per provider:

- **Anthropic**: system prompts are sent as a block array with `cache_control` breakpoints. One breakpoint sits on the cache-marked static system block (caching tools + static prompt), a second on the last message of conversational requests (incremental caching across ReAct loop iterations and chat turns). Cache reads bill at ~0.1x input price, writes at 1.25x, with a 5-minute TTL. One-shot requests (no assistant turn) get no message breakpoint, so they never pay the write premium. Prefixes below the model's minimum cacheable size (1024-4096 tokens) silently don't cache and cost nothing extra.
- **OpenAI**: caching is automatic server-side (~50% discount on cached prefixes over 1024 tokens); Jarvis just keeps stable content first in the prompt. Reported `cached_tokens` are surfaced in telemetry.
- **OpenRouter**: most routed upstreams (OpenAI, Gemini 2.5, DeepSeek, Groq, Grok, Moonshot) cache automatically. For `anthropic/*` models Jarvis sends OpenRouter's top-level `cache_control: {type: "ephemeral"}` and OpenRouter places the breakpoints itself; it also sticky-routes follow-up requests to the same upstream endpoint to maximize hit rates. (`qwen/*` also needs explicit caching but only supports per-content-block breakpoints - not emitted yet.) Cached reads and writes come back in `prompt_tokens_details` and are surfaced in telemetry (both chat and streaming).
- **Gemini**: implicit caching is automatic on 2.5+ models (2048-4096 token minimum); `cachedContentTokenCount` is surfaced in telemetry.
- **Groq**: automatic prefix caching on supported models (50% discount, 2h TTL); `prompt_tokens_details.cached_tokens` is surfaced in telemetry.
- **LiteLLM / OpenAI-compatible**: inherit the OpenAI client, so `cached_tokens` reported by the proxied backend is surfaced automatically.
- **Usejarvis AI (hosted)**: explicit Anthropic-style breakpoints in OpenAI wire format -- `cache_control` riding on content parts, since LiteLLM drops the top-level field OpenRouter accepts. **OFF by default**: emission is gated on the SYSTEM `usejarvis_ai.prompt_cache: true` opt-in (config.yaml, provisioner-written) *and* the user-level `llm.prompt_cache` switch. See "Usejarvis AI prompt caching" below for what the opt-in requires -- as of 2026-08-19 it is HARD-BLOCKED on platform-side per-tenant upstream credentials (shared cache namespace). Streamed requests set `stream_options: {include_usage: true}` so cache telemetry is real on the conversational path.
- **Ollama**: local KV-cache reuse is automatic and free; nothing is reported or billed.
- **Other providers**: the cache markers are ignored; no behavior change.

#### Usejarvis AI errors, retries and request origin

- A 429 or 5xx from the proxy carries the server's `Retry-After` into the manager, which waits it out (within its 60s budget) instead of retrying at once.
- Three hosted outcomes are never retried: `quota_exhausted` (the plan's included usage is used up for the window), `content_policy` (the platform's safety gate blocked the request; the error body carries `usejarvis_content_policy`) and `restricted` (hosted AI is restricted on the account; the copy comes from the usage meter's `restricted` field and names where to appeal). The first and last may still fail over to a provider of the user's own on another tier; a content-policy block never does.
- A timed-out request is aborted, so it stops holding a slot at the proxy once the manager has given up on it.
- Hosted STT and TTS keep the plain "an active plan is required" copy on a restricted account; the chat and the usage meter are where the restriction and the appeal contact appear.
- Every hosted chat, STT and TTS request carries `x-jarvis-origin: user | background | workflow` (src/llm/origin.ts), set at the entry points: chat, voice and channel turns are `user`; the background agent, goals, awareness, the post-turn extractor and the compactor are `background`; the workflow sandbox is `workflow`. The platform only counts policy strikes against `user` traffic, and a request with no origin omits the header and is treated as the person's own. A `manage_agents` task inherits the origin of the turn that started it, so a task a person asked for runs as `user` even though most of what it sends is tool output, the same as tool output inside the turn itself.
- Fan-out caps that keep ordinary use under a per-key limit: at most 5 running `manage_agents` tasks, at most 4 Pebble sentences synthesized at once, and workflow agent delegation capped at 200 iterations.

#### Usejarvis AI prompt caching -- verification record and enablement conditions

Initial live verification against the hosted proxy (previously cited as "docs/LLM.md, POC case 3"; recorded here since that file was never committed): a `cache_control` marker on a **system** content part and on a **user** content part both reached the Anthropic upstream intact through LiteLLM; the second identical call billed the marked prefix at the cache-read rate (~0.1x the platform's resale input price).

**Platform-team measurements, 2026-08-19** -- the three previously-open conditions are now verified, with one hard blocker:

1. **Non-Anthropic upstreams -- FAILED (per-provider forwarding).** The marker's fate depends on the upstream route: `openai/` upstreams receive `cache_control` **verbatim** (the 400 on real OpenAI -- unknown content-part property -- stands as the expected outcome), `gemini/` translation to generateContent drops it, `anthropic/` translation keeps it. The proxy does NOT strip globally, so the client-side `prompt_cache` gate is **required**, not provisional; enabling it on a plan whose aliases map to an `openai/` route would break that tier. Vendor-aware emission (per-alias vendor metadata in the catalog) would be needed to enable on mixed-vendor plans.
2. **Tool-role translation -- VERIFIED OK.** A marker on a `tool` message's content part is accepted, translated onto the inner text block inside `tool_result.content`, and Anthropic caches at that depth (measured write->read round trip: `cache_write=6193` then `cache_read=6193`). The client's rolling breakpoint anchors on the last **user** message, which is therefore correct; anchoring on the true last message (the tool result) is an available optimization -- deliberately not taken, to keep behavior independent of this LiteLLM translation detail.
3. **Cache scoping -- FAILED, HARD BLOCKER.** The prompt cache namespace follows the upstream credential, and the proxy holds ONE upstream api_key shared by every tenant; per-tenant virtual keys, user_ids, and LiteLLM users do NOT scope it. Measured: tenant B received `cache_read=7002` on a prefix only tenant A had ever sent. This is a working cross-tenant confirmation oracle (byte-level prefix guessing via `cache_read_input_tokens`) plus a billing asymmetry (A pays the 1.25x write premium, B reads at 0.1x for free). **`usejarvis_ai.prompt_cache` must remain `false` fleet-wide until the platform ships per-tenant upstream credentials.** The fix is platform-side; no client mitigation exists.

Streaming telemetry note (also platform-verified 2026-08-19): the proxy honours `stream_options: {include_usage: true}` and includes `cache_read_input_tokens` / `prompt_tokens_details.cached_tokens`, but the usage rides on the **last content chunk** (`choices` length 1) -- there is no empty-choices terminal chunk. The parser reads usage from whichever chunk carries it, handling both this shape and OpenAI's empty-choices terminal shape.

Internals for callers: `LLMMessage.cache: true` marks a system message as a stable cache boundary. System prompts are built split into a static (byte-stable per role/channel) prefix and a dynamic per-turn suffix (`buildSystemPromptParts` in `src/roles/prompt-builder.ts`); volatile content (current time, observations, goals) must stay in the dynamic half or it invalidates the cache every turn. History trimming (`compactHistory`) uses page-aligned eviction so the retained prefix stays byte-stable between eviction events.

Note: as part of this work, the rendered system prompt's section order changed slightly - the channel personality block now renders before `# Current Context` (previously after), and the conversation tier's task-state sections moved after its static instructions. Content is unchanged.

Telemetry: `usage` on every response (and the `llm_usage` table / `/api/usage` route / Usage room) reports `cache_read_input_tokens` and `cache_creation_input_tokens`. `input_tokens` is normalized across providers to count only uncached, full-price tokens - the full prompt size is `input + cache_read + cache_creation`.

### Custom Provider Implementation

A provider implements `LLMProvider`:

```typescript
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse, LLMStreamEvent } from './provider.ts';

export class CustomProvider implements LLMProvider {
  name = 'custom';

  async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    throw new Error('not implemented'); // Your implementation
  }

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<LLMStreamEvent> {
    yield { type: 'error', error: 'not implemented' }; // Your streaming implementation
  }

  async listModels(): Promise<string[]> {
    return ['model1', 'model2'];
  }
}
```

To make it selectable in the dashboard it also needs a kind in `LLMProviderKind` (`src/config/types.ts`), a case in `instantiateProvider` (`src/llm/config-binding.ts`) and an entry in the dashboard's provider list.

### Usage Tracking

`chatTier` and `streamTier` record each call (tier, resolved tier, subsystem, provider, model, tokens including cache reads and writes) in the `llm_usage` table once `setUsageDatabase` is wired, which the daemon does at startup. `/api/usage` and the Usage room read it. A script that wants the same can pass the database returned by `initDatabase` (`src/vault/schema.ts`, which creates the `llm_usage` table) to `setUsageDatabase(() => db)` from `src/llm/usage.ts`, as `src/llm/test.ts` does.

### Rate Limits

The manager already handles them. A 429 fails over at once when the tier (or its fall-up chain) has another provider. Otherwise the manager retries, waiting out a `Retry-After` the provider reports within a 60 second budget per provider. The Anthropic provider does not pass `Retry-After` through, so an Anthropic 429 is retried without that wait.

### Multi-Turn Conversations

Keep the history yourself and send it every call:

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

    const response = await this.manager.chatTier('medium', 'my_script', this.messages);

    this.messages.push({
      role: 'assistant',
      content: response.content,
    });

    return response.content;
  }
}
```

The daemon trims long histories with `compactHistory` (`src/llm/history.ts`) so the kept prefix stays cache-friendly.

## Resources

### Documentation

- [LLM Provider README](../src/llm/README.md)
- [Config System README](../src/config/README.md)
- [Quick Start Guide](../QUICKSTART.md)

### Examples

- [Provider tests](../src/llm/provider.test.ts)

### External Resources

- **Anthropic**: https://docs.anthropic.com/
- **OpenAI**: https://platform.openai.com/docs
- **Ollama**: https://github.com/ollama/ollama
- **Bun**: https://bun.sh/docs

