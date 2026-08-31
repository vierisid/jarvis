# JARVIS Roadmap

*Last updated: July 2026*

This document outlines the planned direction for JARVIS. It's a living document — priorities shift based on community feedback and real-world usage.

## Vision

JARVIS aims to be the most capable open-source AI daemon: always-on, cross-machine, deeply integrated with your desktop, and safely gated by your authority rules. Not a chatbot, but an autonomous agent that sees your screen, understands context, and acts within the boundaries you define.

## How to Read This

- **🏗️ Building** — actively in progress
- **🎯 Planned** — next up
- **💡 Future** — would love contributions
- **✅ Done** — shipped in a recent release

---

## v0.9 — "Platform Parity & Reliability"

The goal for v0.9 is to close the biggest gaps between platforms and harden the core.

### 🏗️ In Progress

#### Platform App Controllers
- **WindowsAppController** now implemented — sidecar-first + PowerShell fallback
- **MacAppController** now implemented — sidecar-first + AppleScript/screencapture fallback
- Goal: parity with the Linux controller for basic operations (window list, focus, screen capture, input)

#### Project Infrastructure
- CONTRIBUTING.md ✅
- CHANGELOG.md ✅
- ROADMAP.md ✅
- CODE_OF_CONDUCT.md ✅

### 🎯 Planned

#### Fix 45 Platform-Specific Test Failures
The test suite has 45 pre-existing failures, almost all platform-specific:
- **Process Lock Manager** (15 failures) — Windows file-lock semantics need cross-platform handling
- **rotate-encryption-key** (7 failures) — file permission differences
- **CLI version resolver** (5 failures) — `git describe` in detached HEAD
- **Unix-domain sockets** (4 failures) — Windows compatibility
- **secureWriteFile/secureDirectory** (3 failures) — `chmod` on Windows
- **SidecarManager/enrollment** (3 failures) — file permission handling

**Effort**: Medium. Many have known workarounds.

#### Dependency Updates
18 packages are outdated, including:
- TypeScript 5.9 → 7.0
- `discord.js` 14.25 → 14.27
- `tailwindcss` 4.2 → 4.3
- `onnxruntime-web` 1.24 → 1.27

**Effort**: Low-Medium. Needs a careful PR with `bun update` and verification.

#### Vector Search: sqlite-vec Integration
The current `findSimilar()` uses in-memory cosine similarity (O(n) scan per query). For production use with large vector stores:
- Integrate [sqlite-vec](https://github.com/asg017/sqlite-vec) extension
- HNSW indexing for sub-linear search
- Hybrid search (vector + keyword)

**Effort**: Medium. Requires bun:sqlite extension loading or native addon.

---

## v0.10 — "Metrics & Memory"

### 🎯 Planned

#### Memory & Knowledge Graph Improvements
- Entity extraction pipeline refinement
- Relationship inference from conversation context
- Memory consolidation (age-based pruning + summarization)
- Cross-session recall improvements

#### Goals & OKR Enhancements
- Goal decomposition (auto-break large goals into sub-goals)
- Progress estimation from natural language
- Rhythm check-ins with configurable schedules
- Integration with external calendars

#### Telemetry & Usage Dashboard
- Token usage visualization per provider
- Agent activity timeline
- Authority audit trail explorer
- Performance metrics (response times, cache hit rates)

---

## v1.0 — "Stable Foundation"

### 🎯 Planned

#### Cross-Platform Stability
- All tests pass on Linux, Windows, macOS
- CI matrix for all three platforms
- Sidecar auto-build and auto-update
- Error recovery: daemon auto-restart on crash

#### LLM Provider Maturity
- Streaming everywhere (all providers)
- Prompt caching optimization
- Tool-use reliability improvements
- Structured output (JSON mode for all providers)

#### Security & Authority
- Approval patterns with auto-learning
- Time-based authority escalation/de-escalation
- Encrypted vault with key rotation
- Audit trail export (JSON, CSV)

#### Documentation
- Full API reference
- Architecture deep-dive
- Self-hosting guide with Docker Compose
- Sidecar development guide

---

## 💡 Future Ideas (Community Welcome!)

These are larger initiatives that would benefit from community contributions:

### Native Windows & macOS Desktop Automation (Without Sidecar)
- **Windows**: Full Win32 API via `bun:ffi`, UI Automation tree traversal, SendInput
- **macOS**: AXUIElement via FFI or Swift bridge, Accessibility API tree traversal
- Goal: sidecar-independent desktop automation on all platforms

### Plugin System
- Extend JARVIS with community plugins
- Plugin marketplace in the dashboard
- Versioned API for plugin authors

### Advanced Multi-Agent Patterns
- Agent swarms for complex research tasks
- Debate/consensus between agents
- Meta-agent that manages agent lifecycle
- Agent memory sharing with privacy controls

### Mobile Companion
- Sidecar for iOS/Android
- Voice-first interface
- Push notifications from daemon
- Screen awareness on mobile

### Third-Party Integrations
- Jira, Linear, GitHub project management
- Slack, Teams, Discord deep integration
- Email: send, read, organize
- Calendar: schedule, reschedule, conflicts
- Browser: bookmarks, history, tabs

### Performance
- WASM-based vector search (faster than sqlite-vec for small datasets)
- Response caching with TTL
- Lazy agent loading
- Connection pooling for LLM providers
- Database connection pooling

---

## How to Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get started. If you want to work on something from this roadmap, open an issue or comment on an existing one — we'll help you get oriented.

Priorities we especially welcome:
- **Bite-sized**: Fix a single test failure, update a dependency, add a test
- **Medium**: Implement a TODO, add platform fallback, improve error handling
- **Large**: New LLM provider, new integration, plugin system

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for what's shipped.
