# J.A.R.V.I.S. Configuration System

Type-safe YAML configuration management for Project J.A.R.V.I.S.

## Overview

The configuration system provides:
- **Type-Safe Config**: Full TypeScript types for all configuration options
- **YAML Format**: Human-readable YAML files
- **Deep Merging**: Loaded config merges with defaults for missing values
- **Path Expansion**: Automatic `~` (tilde) expansion for home directory
- **Default Values**: Sensible defaults for all settings

## Configuration File

Default location: `~/.jarvis/config.yaml`

See `config.example.yaml` in the project root for a full example.

## Usage

### Loading Configuration

```typescript
import { loadConfig } from './config/index.ts';

// Load from default location (~/.jarvis/config.yaml)
const config = await loadConfig();

// Load from custom path
const config = await loadConfig('/path/to/config.yaml');

// Config is type-safe
console.log(config.daemon.port);        // number
console.log(config.llm.primary);        // string
console.log(config.personality.core_traits);  // string[]
```

### Saving Configuration

There is intentionally **no `saveConfig`**. `config.yaml` is a read-only
SYSTEM config (daemon.*, auth, google) that the brain never writes; in hosted
mode it is root-owned and managed by the hosting server.

All user-owned sections (personality, voice, stt/tts, authority, channels,
onboarding, ... — see `USER_OWNED_SECTIONS` in `types.ts`) persist to the
vault DB settings store instead:

```typescript
import { saveUserSection } from '../daemon/user-settings.ts';

config.tts = { ...config.tts, enabled: true };
saveUserSection('tts', config.tts);
```

A legacy `config.yaml` that still carries user sections seeds the DB once at
daemon boot (`importLegacyUserSettings`), after which the file's copies are
ignored (`loadConfig` discards them, exactly like the `llm` block).

### Using Default Config

```typescript
import { DEFAULT_CONFIG } from './config/index.ts';

// Get a fresh copy of defaults
const config = { ...DEFAULT_CONFIG };
```

## Configuration Schema

### `daemon`

Daemon server configuration.

```typescript
daemon: {
  port: number;          // WebSocket server port (default: 7777)
  data_dir: string;      // Data directory path (default: ~/.jarvis)
  db_path: string;       // SQLite database path (default: ~/.jarvis/jarvis.db)
  public_url?: string;   // Public HTTPS origin behind a reverse proxy
}
```

### `llm`

LLM provider configuration.

```typescript
llm: {
  primary: string;       // Primary provider name ('anthropic' | 'openai' | 'ollama')
  fallback: string[];    // Fallback providers in order

  // Anthropic (Claude) configuration
  anthropic?: {
    api_key: string;
    model?: string;      // Default: claude-sonnet-4-5-20250929
  };

  // OpenAI (GPT) configuration
  openai?: {
    api_key: string;
    model?: string;      // Default: gpt-4o
  };

  // Ollama (local models) configuration
  ollama?: {
    base_url?: string;   // Default: http://localhost:11434
    model?: string;      // Default: llama3
  };
}
```

### `personality`

Core personality traits that guide J.A.R.V.I.S. behavior.

```typescript
personality: {
  core_traits: string[];  // Array of personality traits
}
```

Default traits:
- `loyal`: Committed to serving the user
- `efficient`: Optimizes for speed and resource usage
- `proactive`: Anticipates needs and suggests improvements
- `respectful`: Maintains professional boundaries
- `adaptive`: Learns from interactions and adjusts behavior

### `authority`

Authority and permission levels.

```typescript
authority: {
  default_level: number;  // Default authority level (0-5)
}
```

Authority levels:
- **0**: No permission - ask for everything
- **1**: Read-only operations
- **2**: Safe modifications (non-destructive)
- **3**: Standard operations (default)
- **4**: System changes (config, settings)
- **5**: Full control (destructive operations)

### `active_role`

Active role configuration file name.

```typescript
active_role: string;  // Role file name (e.g., 'default', 'developer', 'assistant')
```

Roles are loaded from `./roles/` directory.

## Default Configuration

```yaml
daemon:
  port: 7777
  data_dir: "~/.jarvis"
  db_path: "~/.jarvis/jarvis.db"
  # public_url: "https://jarvis.example.com"

llm:
  primary: "anthropic"
  fallback:
    - "openai"
    - "ollama"
  anthropic:
    api_key: ""
    model: "claude-sonnet-4-5-20250929"
  openai:
    api_key: ""
    model: "gpt-4o"
  ollama:
    base_url: "http://localhost:11434"
    model: "llama3"

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

## Example Usage

### Initializing LLM Providers from Config

```typescript
import { loadConfig } from './config/index.ts';
import { LLMManager, AnthropicProvider, OpenAIProvider, OllamaProvider } from './llm/index.ts';

const config = await loadConfig();
const manager = new LLMManager();

// Register providers based on config
if (config.llm.anthropic?.api_key) {
  const anthropic = new AnthropicProvider(
    config.llm.anthropic.api_key,
    config.llm.anthropic.model
  );
  manager.registerProvider(anthropic);
}

if (config.llm.openai?.api_key) {
  const openai = new OpenAIProvider(
    config.llm.openai.api_key,
    config.llm.openai.model
  );
  manager.registerProvider(openai);
}

if (config.llm.ollama) {
  const ollama = new OllamaProvider(
    config.llm.ollama.base_url,
    config.llm.ollama.model
  );
  manager.registerProvider(ollama);
}

manager.setPrimary(config.llm.primary);
manager.setFallbackChain(config.llm.fallback);
```

### Setting Up Data Directory

```typescript
import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config/index.ts';

const config = await loadConfig();

// Ensure data directory exists
await mkdir(config.daemon.data_dir, { recursive: true });

console.log(`Data directory: ${config.daemon.data_dir}`);
console.log(`Database path: ${config.daemon.db_path}`);
```

### Dynamic Configuration Updates

Inside the daemon, mutate the live in-memory config (it is the DB-merged,
authoritative view) and persist the touched section:

```typescript
import { saveUserSection } from '../daemon/user-settings.ts';

ctx.config.personality.core_traits.push('humorous');
saveUserSection('personality', ctx.config.personality);
```

System keys (`daemon.*`) cannot be changed at runtime — edit `config.yaml`
and restart (self-host), or let the hosting server rewrite it (hosted).

## Setup Instructions

1. **Copy Example Config**:
   ```bash
   mkdir -p ~/.jarvis
   cp config.example.yaml ~/.jarvis/config.yaml
   ```

2. **Edit Configuration**:
   ```bash
   nano ~/.jarvis/config.yaml
   ```

3. **Add API Keys**:
   - Get Anthropic API key from: https://console.anthropic.com/
   - Get OpenAI API key from: https://platform.openai.com/
   - Install Ollama from: https://ollama.ai/

4. **Test Configuration**:
   ```typescript
   import { loadConfig } from './config/index.ts';
   const config = await loadConfig();
   console.log('Config loaded:', config);
   ```

## Environment Variables

You can also use environment variables for sensitive values:

```yaml
llm:
  anthropic:
    api_key: "${ANTHROPIC_API_KEY}"
  openai:
    api_key: "${OPENAI_API_KEY}"
```

Then set in your shell:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
```

Note: The loader doesn't currently support env var substitution, but you can implement it with:

```typescript
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] || '');
}
```

## Migration Guide

If you have an existing config and the schema changes:

1. The deep merge ensures new fields get default values
2. Old fields remain unchanged
3. You can manually add new fields from `config.example.yaml`

## Best Practices

1. **Never commit API keys**: Add `~/.jarvis/config.yaml` to `.gitignore`
2. **Use environment variables**: For CI/CD and production deployments
3. **Keep backups**: Copy config before major changes
4. **Validate on load**: Check that required API keys are present
5. **Document custom settings**: Add comments to your config YAML

## Type Safety

The configuration is fully typed:

```typescript
import type { JarvisConfig } from './config/index.ts';

function validateConfig(config: JarvisConfig): boolean {
  // TypeScript ensures all required fields exist
  if (config.daemon.port < 1024 || config.daemon.port > 65535) {
    return false;
  }

  if (config.authority.default_level < 0 || config.authority.default_level > 5) {
    return false;
  }

  return true;
}
```

## Extending Configuration

To add new configuration sections:

1. **Update Types** (`src/config/types.ts`):
   ```typescript
   export type JarvisConfig = {
     // ... existing fields
     new_section: {
       setting1: string;
       setting2: number;
     };
   };

   export const DEFAULT_CONFIG: JarvisConfig = {
     // ... existing defaults
     new_section: {
       setting1: 'default_value',
       setting2: 42,
     },
   };
   ```

2. **Update Example** (`config.example.yaml`):
   ```yaml
   new_section:
     setting1: "default_value"
     setting2: 42
   ```

3. **Use in Code**:
   ```typescript
   const config = await loadConfig();
   console.log(config.new_section.setting1);
   ```

The deep merge ensures existing configs get new defaults automatically.
