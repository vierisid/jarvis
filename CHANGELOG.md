# Changelog

All notable changes to JARVIS are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Vector similarity search — `findSimilar()` with in-memory cosine similarity,
  `findSimilarByRef()` convenience wrapper (#279)
- WindowsAppController — sidecar-first + PowerShell fallback with Win32 P/Invoke
  window enumeration, SendKeys input, and .NET screen capture (#279)
- MacAppController — sidecar-first + AppleScript/screencapture fallback (#279)
- CONTRIBUTING.md — development setup, coding conventions, PR workflow (#TBD)
- CHANGELOG.md — this file (#TBD)
- ROADMAP.md — project vision and planned features (#TBD)
- CODE_OF_CONDUCT.md — Contributor Covenant (#TBD)

## [0.8.2] — 2026-07-21

### Added
- Graceful drain: bounded quiesce → drain → teardown on SIGTERM (#271)
- feat(workflows): tool-driven NL composer with library install suggestions (#266)
- Prompt caching: Anthropic `cache_control`, OpenAI cached-token telemetry,
  OpenRouter, Gemini, and Groq support (#265, #267)
- Self-hosting guide — single machine, LAN, VPS behind reverse proxy (#264)

### Fixed
- Chat composer silently fails on non-secure-context origins (`crypto.randomUUID`) (#263)

### Changed
- Config split, Unix-socket listener, JWT-only auth, enrollment CLIs, timezone
  crons, and hosted sidecar onboarding (#262)

## [0.8.1] — 2026-07-14

### Fixed
- Remove millisecond-boundary flakiness in job-queue failJob tests (#258)
- Quote sync-pieces-catalog PR title to fix YAML syntax error (#257)
- Fail fast on native Windows and document the platform limit (#256)
- Prevent background poll from overwriting in-progress profile edits (#255)
- Harden pieces-catalog sync: npm retry, analyzed PR body, skip no-op PRs (#254)
- Bump sidecar/VERSION to 0.8.0 so release assets attach again (#251)

## [0.8.0] — 2026-07-07

### Added
- Ambient "Pebble" mode — dashboard-less native desktop experience (#249)
- FABLE5 design system: full UI re-skin across all rooms (Workflows, Goals,
  Agents, Memory, Authority, Settings, Workspaces)

### Fixed
- Observers: allow scoping file-watcher roots to avoid boot hang (#246)
- UI: don't crash dashboard on non-secure origins (guard `navigator.mediaDevices`) (#248)
- Browser: fall back to headless Chrome when no `$DISPLAY` (#244)
- LLM: omit temperature for OpenAI reasoning models (#241)
- Contain scroll inside chat thread so nested scrollables don't move the page (#235)

## [0.7.0] — 2026-06-28

### Added
- Goals: ring constellation, Gantt timeline, 6 metric cards
- Workflows: drop-corner nodes, ink selection, blue run pips
- Agents: status remap to blue-active, 2-letter avatars, blue pips/orbs
- Sidecar: macOS native tray with NSMenu (appearance-aware brand-drop icon)
- Notifications: inline Approve/Deny on desktop toasts (Windows + macOS)
- Voice: typing indicator during streaming responses
- LLM Providers: NVIDIA NIM support

### Fixed
- Goals: circular completion percentage display
- Sidecar: reconnection on network interruption
- WebSocket: heartbeat timeout handling
- Browser: element selector for dynamically-rendered content

### Changed
- FABLE5 Phase 4-6: full re-skin for Workspaces, Goals, Workflows (Phase 4),
  Pebble (Phase 5), legacy alias flattening (Phase 6)
- Flattened 14 legacy `--j-*` CSS aliases to Monochrome Lab tokens
- Removed dead v1 (chat/office) and dead onboarding cluster

## [0.6.1] — 2026-06-14

### Fixed
- Goals: save and restore OKR progress across daemon restart
- Workflows: fix credential schema validation for OAuth2 flows
- Comms: Websocket ping/pong timeout reconnection
- UI: chat thread scroll position preservation on resize

## [0.6.0] — 2026-06-07

### Added
- Multi-agent goal system with drill-sergeant accountability
- Visual workflow builder (n8n-style) with 50+ node types
- Agent-to-agent messaging subsystem
- Sidecar: Windows tray with Pause/Mute toggles, Waiting/Recent/footer
- Voice wake-word (openwakeword) integration
- Dark mode / light mode toggle

### Fixed
- Process lock manager: cross-platform PID lock for Windows/WSL (#82)
- Daemon boot: replace POSIX flock with cross-platform mechanism on Windows (#80)

## [0.5.5] — 2026-05-24

### Added
- Authority engine: runtime enforcement + approval gating + audit trail
- Desktop awareness: screen capture every 5-10s via sidecar, activity sessions
- LLM: Groq provider support
- Vault: entity extraction and storage
- CLI versions: `jarvis --version`, `jarvis version`, `jarvis -v`

### Fixed
- Sidecar: auto-discovery across WSL2 networking modes
- Config: graceful fallback when config file is missing

## [0.5.0] — 2026-05-10

### Added
- Agent orchestration: 9 specialist roles with hierarchy and delegation
- LLM tier system (fast, medium, quality) with fallback chaining
- Sidecar architecture: brain ↔ sidecar RPC protocol
- Content pipeline: blog, YouTube, social media post management
- Vault: entities, facts, relationships, and vector embeddings storage

### Fixed
- Cross-platform file locking for daemon single-instance enforcement
- OAuth token storage with secure file permissions

## [0.4.x] — 2026-04

### Added
- Multiple LLM providers: Anthropic, OpenAI, Gemini, Ollama
- Real-time voice streaming with TTS
- WebSocket-based daemon communication
- CLI autostart and lifecycle management
- Sidecar enrollment and key management
- Telemetry system with anonymous IDs

## [0.3.x] — 2026-03

### Added
- Bun runtime migration from Node.js
- Database schema (SQLite via `bun:sqlite`)
- Knowledge graph: entities, facts, relationships
- Commitments and task management
- Personality engine and role-based prompting

## [0.2.x] — 2026-02

### Added
- Desktop awareness integration
- Browser automation tools
- Terminal command execution
- File system operations
- Initial role system

## [0.1.x] — 2026-01

### Added
- Initial proof of concept
- Core daemon architecture
- Basic LLM integration
- CLI bootstrap

---

## Note on Versioning

Releases follow SemVer. Pre-1.0 (0.x) means:
- **Patch** (0.0.x): bug fixes, small improvements, no breaking changes
- **Minor** (0.x.0): new features, non-breaking additions, UI changes
- **Major**: no 1.0 yet — project is under active development

The sidecar has its own version at `sidecar/VERSION`, currently at 0.1.0.
