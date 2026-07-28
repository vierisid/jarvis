# Contributing to JARVIS

First off, thank you for considering contributing to JARVIS! 🎉

JARVIS is an always-on autonomous AI daemon — a complex beast spanning TypeScript (Bun), Go (sidecar), UI dashboards, and cross-platform desktop automation. This guide should help you navigate it.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Conventions](#coding-conventions)
- [Testing](#testing)
- [Pre-commit Hooks](#pre-commit-hooks)
- [Pull Request Workflow](#pull-request-workflow)
- [Release Process](#release-process)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be excellent to each other.

## Getting Started

### Prerequisites

- **[Bun](https://bun.sh)** ≥ 1.0.0 (JavaScript runtime, package manager, test runner)

  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

- **[Go](https://go.dev)** (for the sidecar) — optional, only needed for sidecar work

- **One LLM provider key** (for running the daemon):
  - Anthropic (Claude) — recommended
  - OpenAI
  - Ollama (local)

### Clone & Install

```bash
git clone https://github.com/vierisid/jarvis.git
cd jarvis
bun install
```

### Quick Dev Test

```bash
# Run the full test suite
bun test

# Type-check everything
bunx tsc --noEmit

# Run specific tests
bun test src/vault/
bun test src/agents/orchestrator.test.ts

# Watch mode during development
bun test --watch
```

## Development Setup

### Configuration

```bash
mkdir -p ~/.jarvis
cp config.example.yaml ~/.jarvis/config.yaml
# Edit with your API keys
```

### Running the Daemon

```bash
# In development with hot reload
bun run dev

# Start as a foreground daemon
bun run src/daemon/index.ts
```

### Sidecar (Desktop Automation)

The Go sidecar provides cross-platform desktop automation (window management, screen capture, UI element interaction).

```bash
# Build the sidecar
cd sidecar
go build -o desktop-bridge .

# Or use the provided script
bun run scripts/build-sidecar
```

## Project Structure

```
jarvis/
├── src/                    # TypeScript source
│   ├── actions/            # Tool implementations (browser, desktop, terminal, etc.)
│   │   └── app-control/    # Platform-specific app controllers (linux, windows, macos)
│   ├── agents/             # Multi-agent system (orchestrator, sub-agent runner, task manager)
│   ├── authority/          # Authority gating & audit trail
│   ├── awareness/          # Desktop awareness (screen capture, OCR, suggestions)
│   ├── cli/                # CLI commands (start, stop, install, uninstall, update)
│   ├── comms/              # Communication channels (voice, websocket, notifications)
│   ├── config/             # Configuration loading & real-time updates
│   ├── daemon/             # Core daemon (API routes, agent service, channel service)
│   ├── goals/              # Goal tracking & OKR system
│   ├── integrations/       # External integrations (Google, etc.)
│   ├── lib/                # Shared utilities (cron, etc.)
│   ├── llm/                # LLM provider abstraction (Anthropic, OpenAI, Gemini, Groq, Ollama)
│   ├── observers/          # Observation layer
│   ├── personality/        # Personality engine
│   ├── roles/              # Role definitions & prompt building
│   ├── scripts/            # Build & maintenance scripts
│   ├── sidecar/            # Sidecar protocol & management
│   ├── sites/              # Project manager for site-scoped contexts
│   ├── telemetry/          # Telemetry & analytics
│   ├── user/               # User profile management
│   ├── util/               # General utilities (secure file I/O, path helpers)
│   ├── vault/              # Knowledge graph (entities, facts, vectors, commitments)
│   ├── voice/              # Voice & wake word processing
│   └── workflows/          # Visual workflow engine (activepieces-based)
├── sidecar/                # Go sidecar (desktop bridge)
│   ├── desktop_windows.go  # Windows desktop automation
│   ├── desktop_darwin.go   # macOS desktop automation
│   ├── desktop_linux.go    # Linux desktop automation
│   └── uia_windows.go      # Windows UI Automation
├── ui/                     # Web dashboard (React, Codemirror, XYFlow)
└── docs/                   # Documentation
```

## Coding Conventions

### TypeScript

- **Runtime**: Bun (not Node.js). Use `bun:sqlite`, `Bun.file()`, `Bun.sleep()` etc.
- **Module system**: ESM (`import`/`export`, not `require`). Use `.ts` extensions in imports.
- **TypeScript**: Strict mode enabled. Avoid `any` where possible; prefer `unknown`.
- **Formatting**: The project does not enforce a formatter — match the style of surrounding code.
- **Nullability**: Use `??` over `||` for default values, and `?.` for optional chaining.
- **Error handling**: Throw typed errors with descriptive messages. Don't silently swallow errors in production paths (test setup is the exception).

### Architecture

- **Platform controllers** (`src/actions/app-control/`): Each platform has its own implementation file with a two-layer strategy — sidecar first, native fallback second.
- **Agent system**: Agents are spawned via `orchestrator.spawnSubAgent()` and terminated in `finally` blocks. Each `delegate()` call = one sub-agent.
- **LLM providers**: New providers go in `src/llm/` implementing the `LLMProvider` interface.
- **Database**: Uses `bun:sqlite`. All schema changes must be expand/contract (backward-compatible ALTER TABLE, not destructive migrations).

### Conventions

- **File naming**: `kebab-case.ts` for source files. Test files use `.test.ts` suffix.
- **Commit messages**: Conventional Commits — `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `ci:`, `chore:`.
- **Exports**: Export types and functions individually from each module; re-export from `index.ts`.

## Testing

### Running Tests

```bash
# Full suite
bun test

# Specific area
bun test src/vault/
bun test src/agents/ src/llm/

# Single test file
bun test src/vault/vectors.test.ts

# Bail on first failure (useful during development)
bun test --bail

# With timeout (tests can hang if a child process isn't reaped)
timeout 240s bun test --bail
```

### Writing Tests

- Tests live next to their source files (e.g., `src/foo.ts` → `src/foo.test.ts`).
- Use `bun:test` (`describe`, `test`, `expect`, `mock`).
- Database-dependent tests use `:memory:` database via `initDatabase()`.
- For LLM-dependent code, inject stubs rather than hitting real providers.
- Test files with dynamic `import()` may need the `./` prefix to avoid Bun's filter matching:
  ```bash
  bun test ./src/my-file.test.ts
  ```

### Test Requirements

| Check | Command | When |
|:---|---|:---|
| Unit tests | `bun test` | Every commit |
| Type check | `bunx tsc --noEmit` | Before PR |
| EE-license check | `bun run scripts/check-no-ee-imports.ts` | Pre-commit hook |
| Migration check | `bun run scripts/check-migrations.ts` | Pre-commit hook |
| Sidecar build | `cd sidecar && go build ./...` | Sidecar changes |

## Pre-commit Hooks

The project ships a pre-commit hook (`.husky/pre-commit`) that runs:

1. **EE-license check** — ensures no Activepieces Enterprise-licensed code is imported
2. **Migration check** — validates database migrations are expand/contract (rollback-safe)
3. **Tests** — `bun test --bail` with a 240-second timeout
4. **Type check** — `bunx tsc --noEmit`

To skip the hook for a commit (e.g., WIP), use `git commit --no-verify`.

## Pull Request Workflow

1. **Branch**: Create from `main`. Name with a conventional prefix:
   - `feat/description` — new features
   - `fix/description` — bug fixes
   - `refactor/description` — code restructuring
   - `docs/description` — documentation
   - `ci/description` — CI/CD
   - `chore/description` — maintenance

2. **Commit**: Use conventional commit messages:
   ```
   feat(vault): implement vector similarity search
   
   Add in-memory cosine similarity scan with dedup on insert.
   ```

3. **Push & PR**:
   ```bash
   git push -u origin HEAD
   gh pr create \
     --title "feat: your feature title" \
     --body "## Summary\n\nWhat this does and why."
   ```

4. **CI**: The test workflow runs automatically. All checks must pass before merge.

5. **Review**: At least one maintainer review required. Address feedback with additional commits.

6. **Merge**: Squash merge, delete the branch.

> **Note**: This project uses a fork-to-upstream PR model. If you're contributing from a fork, set the `--head` and `--repo` flags:
> ```bash
> gh pr create --repo vierisid/jarvis --head yourfork:branch --base main
> ```

## Release Process

Releases are cut via a GitHub Actions workflow (`release.yml`):

1. A maintainer triggers the **Release** workflow with a version bump keyword (`patch`, `minor`, `major`).
2. The workflow bumps `package.json`, opens a release PR, merges it, tags the merge commit.
3. The **Release Executor** workflow (`release-exec.yml`) builds and publishes the package + sidecar binaries to npm and GitHub Releases.

The sidecar has its own version (`sidecar/VERSION`) and release workflow (`sidecar-release.yml`).

## Reporting Issues

Open an issue on [GitHub](https://github.com/vierisid/jarvis/issues). Include:

- Your platform (Windows/macOS/Linux + WSL2?)
- Bun version (`bun --version`)
- Steps to reproduce
- Relevant logs or error output
- Configuration snippets (redact API keys)
