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
SYSTEM config (daemon.*, auth, google, usejarvis_ai) that the brain never
writes; in hosted mode it is root-owned and managed by the hosting server.

### The `usejarvis_ai` block (hosted installs only)

Written exclusively by the hosting provisioner — never by the daemon, the
dashboard, or the user:

```yaml
usejarvis_ai:
  base_url: "https://llm.usejarvis.host/v1"   # quote both values: unquoted
  api_key: "sk-uj-..."                        # scalars parse as non-strings
```

Ownership and semantics:

- **File-authoritative.** The block is re-read on SIGHUP and
  `POST /api/config/reload` (`reloadUsejarvisAiBlock`), so a key rotation
  takes effect without a restart. Removing the block un-hosts the install on
  the next reload/boot; a corrupt file keeps the current in-memory value.
- **File mode.** The block carries a per-account API key: the file should be
  root-owned and not world-readable (`0600`, owner the daemon's service
  account or root with a read grant).
- **Never persisted.** The injected `usejarvis_ai` provider entry is excluded
  from every DB write (`stripSecretsFromProviders`) and the dashboard cannot
  edit or delete it (`saveLLMSettings` refuses the reserved name on hosted
  installs).
- **Malformed values** (non-string `base_url`/`api_key`, e.g. unquoted
  scalars) are warned about and treated as an absent block — the daemon still
  boots.

All user-owned sections (personality, voice, stt/tts, authority, channels,
onboarding, ... — see `USER_OWNED_SECTIONS` in `types.ts`) persist to the
vault DB settings store instead:

```typescript
import { saveUserSection, persistUserPatch } from '../daemon/user-settings.ts';

// Most sections: mutate in memory, then persist the section.
config.personality = { ...config.personality, humor: 'dry' };
saveUserSection('personality', config.personality);

// stt/tts are the exception: persist the PATCH, never the merged in-memory
// section — the in-memory value carries DEFAULT_CONFIG fills (provider
// 'openai'/'edge'), and saving those records a provider choice the user never
// made, which defeats the hosted "silent user gets the included voice"
// default. persistUserPatch merges the patch over the stored row (hydrated
// with keychain credentials) and saves that.
config.tts = { ...config.tts, enabled: true };
persistUserPatch('tts', { enabled: true });
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
  log_file_path?: string;      // Mirror stdout/stderr to this file (unset = none)
  log_file_max_bytes?: number; // Ring size for that file (default: 1 MiB)
}
```

#### `log_file_path`

Jarvis only ever wrote a log file under `jarvis start -d` (the CLI redirects the
detached child's file descriptors) and under launchd. Under systemd - how hosted
instances run - and under Docker there is no file at all, so the only record is
journald or the container runtime. Setting `log_file_path` installs an
in-process sink (`src/util/log-file.ts`) that gives every launch mode the same
file:

- `~` is expanded on load; the parent directory is created if missing.
- Every line is stripped of ANSI escapes, passed through `src/util/redact.ts`,
  and prefixed with an ISO-8601 timestamp, so the file carries no credentials
  and is safe for an operator to read.
- The file is a ring capped at `log_file_max_bytes` (default 1 MiB, clamped to
  4 KiB..64 MiB - `.inf` and other non-finite values fall back to the default).
  Past the cap the oldest lines are dropped from the top on line boundaries; the
  rewrite is atomic (temp file + `rename`), which is why `jarvis logs -f` uses
  `tail -F` - and why a follower sees the whole window reprinted on every
  compaction.
- The ring lives in the daemon's heap, so the cap is an RSS budget as much as a
  disk budget. The window is seeded from the tail of the existing file at
  startup, so a restart (or a crash loop) does not throw away the previous run.
- A single line is truncated to a quarter of the cap before it enters the ring,
  so one huge payload cannot evict the whole window.
- A path that cannot be opened or written degrades to "no file sink" with one
  warning, and a file lost at runtime is retried and rebuilt from the ring. The
  daemon never dies over its log file.
- A FIFO or a symlink at the path is refused: `open(2)` on a FIFO with no reader
  blocks forever, and the sink runs before anything else boots.
- If the launcher already has the daemon's stdout/stderr open on that same file
  (`jarvis start -d`, launchd's `StandardOutPath`, a `StandardOutput=append:`),
  the daemon fstats fds 1/2 against the path and skips the sink entirely - the
  two together would leave those descriptors writing to an unlinked inode.
- Subprocesses spawned with `stdio: 'inherit'` write to the inherited
  descriptors from another process, so their output reaches the terminal and
  journald but not this file.

Both keys live under `daemon:` rather than in a section of their own because
`loadConfig` discards everything outside the system-owned sections - a
top-level `logging:` block would be dropped on every load. Neither has an entry
in `DEFAULT_CONFIG` (same as `drain_deadline_ms`): absent has to stay
distinguishable from "set to the default", and the fallback is applied where
the value is consumed.

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
