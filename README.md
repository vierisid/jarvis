# JARVIS

**Just A Rather Very Intelligent System**

> An always-on autonomous AI daemon with desktop awareness, multi-agent hierarchy, visual workflows, and goal pursuit.

JARVIS is not a chatbot with tools. It is a persistent daemon that sees your desktop, thinks about what you're doing, and acts — within the authority limits you define.

---

## What Makes JARVIS Different

| Feature | Typical AI Assistant | JARVIS |
|---|---|---|
| Always-on | No — request/response only | Yes — persistent daemon |
| Desktop awareness | No | Yes — screen capture every 5-10s |
| Native app control | No | Yes — Go sidecar with Win32/X11 automation |
| Multi-agent delegation | No | Yes — 9 specialist roles |
| Visual workflow builder | No | Yes — 50+ nodes, n8n-style |
| Voice with wake word | No | Yes — streaming TTS + openwakeword |
| Goal pursuit (OKRs) | No | Yes — drill sergeant accountability |
| Authority gating | No | Yes — runtime enforcement + audit trail |
| LLM provider choice | Usually locked to one | 4 providers: Anthropic, OpenAI, Gemini, Ollama |

---

## Install

### npm (recommended)

```bash
bun add -g @usejarvis/brain
jarvis onboard
```

### One-liner

```bash
curl -fsSL https://raw.githubusercontent.com/vierisid/jarvis/main/install.sh | bash
jarvis onboard
```

The install script sets up Bun, clones the repo, and links the `jarvis` CLI. Then run `jarvis onboard` to configure your assistant interactively.

### Manual

```bash
git clone https://github.com/vierisid/jarvis.git ~/.jarvis/daemon
cd ~/.jarvis/daemon
bun install
jarvis onboard
```

### Run

```bash
jarvis start            # Start in foreground
jarvis start -d         # Start as background daemon
jarvis stop             # Stop the daemon
jarvis status           # Check if running
jarvis doctor           # Verify environment & connectivity
jarvis logs -f          # Follow live logs
jarvis update           # Update to latest version
```

The dashboard is available at `http://localhost:3142` once the daemon is running.

---

## Sidecar Setup

The sidecar is a lightweight agent that runs on your desktop machine and gives JARVIS access to desktop automation, browser control, terminal, filesystem, screenshots, and more.

### 1. Install the sidecar

**Via npm:**

```bash
npm install -g @usejarvis/sidecar
```

**Or download the binary** from [GitHub Releases](https://github.com/vierisid/jarvis/releases) for your platform (macOS, Linux, Windows).

### 2. Enroll in the dashboard

1. Open the JARVIS dashboard at `http://localhost:3142`
2. Go to **Settings** → **Sidecar**
3. Enter a name for this machine (e.g. "work-laptop") and click **Enroll**
4. Click **Copy** to copy the token command

### 3. Run the sidecar

Paste and run the copied command on the machine where you installed the sidecar:

```bash
jarvis-sidecar --token <your-jwt-token>
```

The sidecar saves the token locally, so on subsequent runs you just need:

```bash
jarvis-sidecar
```

Once connected, the sidecar appears as online in the Settings page where you can configure its capabilities (terminal, filesystem, desktop, browser, clipboard, screenshot, awareness).

---

## Core Capabilities

**Conversations** — Multi-provider LLM routing (Anthropic Claude, OpenAI GPT, Google Gemini, Ollama). Streaming responses, personality engine, vault-injected memory context on every message.

**Tool Execution** — 14+ builtin tools with up to 200 iterations per turn. The agent loop runs until the task is complete, not until the response looks done.

**Memory & Knowledge** — Vault knowledge graph (entities, facts, relationships) stored in SQLite. Extracted automatically after each response. Injected into the system prompt so JARVIS always remembers what matters.

**Browser Control** — Auto-launches Chromium via CDP. 7 browser tools handle navigation, interaction, extraction, and form filling.

**Desktop Automation** — Go sidecar with JWT-authenticated WebSocket, RPC protocol, and binary streaming. Win32 API automation (EnumWindows, UIAutomation, SendKeys) on Windows, X11 tools on Linux.

**Multi-Agent Hierarchy** — `delegate_task` and `manage_agents` tools. An AgentTaskManager coordinates 9 specialist roles. Sub-agents are denied governed actions — authority stays with the top-level agent.

**Voice Interface** — Edge TTS or ElevenLabs with streaming sentence-by-sentence playback. Binary WebSocket protocol carries mic audio (WebM) and TTS audio (MP3) on the same connection. Wake word via openwakeword (ONNX, runs in-browser).

**Continuous Awareness** — Full desktop capture at 5-10 second intervals. Hybrid OCR (Tesseract.js) + Cloud Vision. Struggle detection, activity session inference, entity-linked context graph. Proactive suggestions and an overlay widget.

**Workflow Automation** — Visual builder powered by `@xyflow/react`. 50+ nodes across 5 categories. Triggers: cron, webhook, file watch, screen events, polling, clipboard, process, git, email, calendar. NL chat creation, YAML export/import, retry + fallback + AI-powered self-heal.

**Goal Pursuit** — OKR hierarchy (objective → key result → daily action). Google-style 0.0-1.0 scoring. Morning planning, evening review, drill sergeant escalation. Awareness pipeline auto-advances progress. Three dashboard views: kanban, timeline, metrics.

**Authority & Autonomy** — Runtime enforcement with soft-gate approvals. Multi-channel approval delivery (chat, Telegram, Discord). Full audit trail. Emergency pause/kill controls. Consecutive-approval learning suggests auto-approve rules.

---

## Dashboard (13 Pages)

Built with React 19 and Tailwind CSS 4. Served by the daemon at `http://localhost:3142`.

| Page | Purpose |
|---|---|
| Chat | Primary conversation interface with streaming |
| Tasks | Active commitments and background work queue |
| Content Pipeline | Multi-step content generation and review |
| Knowledge Graph | Visual vault explorer — entities, facts, relationships |
| Memory | Raw vault search and inspection |
| Calendar | Google Calendar integration with scheduling tools |
| Agent Office | Multi-agent delegation status and role management |
| Command Center | Tool history, execution logs, proactive notifications |
| Authority | Approval queue, permission rules, audit trail |
| Awareness | Live desktop feed, activity timeline, suggestions |
| Workflows | Visual builder, execution monitor, version history |
| Goals | OKR dashboard — kanban, timeline, and metrics views |
| Settings | LLM providers, TTS/STT, channels, behavior config |

---

## Configuration

JARVIS stores its configuration at `~/.jarvis/config.yaml`. Run `jarvis onboard` for interactive setup — it walks through LLM provider, voice, channels, personality, and authority settings.

```yaml
daemon:
  port: 3142
  data_dir: "~/.jarvis"
  db_path: "~/.jarvis/jarvis.db"

llm:
  primary: "anthropic"
  fallback: ["openai", "gemini", "ollama"]
  anthropic:
    api_key: "sk-ant-..."
    model: "claude-sonnet-4-6"

personality:
  core_traits: ["loyal", "efficient", "proactive"]
  assistant_name: "Jarvis"

authority:
  default_level: 3

active_role: "personal-assistant"
```

See [config.example.yaml](config.example.yaml) for the full reference including Google OAuth, Telegram, Discord, ElevenLabs, and voice settings.

---

## Development

```bash
bun test                # Run all tests (379 tests across 22 files)
bun run dev             # Hot-reload daemon
bun run build:ui        # Rebuild dashboard
bun run db:init         # Initialize or reset the database
```

### Stack

- **Runtime**: Bun (not Node.js)
- **Language**: TypeScript (ESM)
- **Database**: SQLite via `bun:sqlite`
- **UI**: React 19, Tailwind CSS 4, `@xyflow/react`
- **LLM**: Anthropic Claude, OpenAI GPT, Google Gemini, Ollama
- **Desktop sidecar**: Go (JWT auth, WebSocket RPC, platform-specific automation)
- **Voice**: openwakeword (ONNX), Edge TTS / ElevenLabs
- **Package**: [`@usejarvis/brain`](https://www.npmjs.com/package/@usejarvis/brain) on npm

---

## Development Status

### Completed Milestones

| # | Milestone | Summary |
|---|---|---|
| 1 | LLM Conversations | Multi-provider streaming, personality engine |
| 2 | Tool Execution Loop | 14+ builtin tools, 200-iteration agent loop |
| 3 | Memory Retrieval | Vault knowledge graph injected per message |
| 4 | Browser Control | Chromium auto-launch, CDP, 7 browser tools |
| 5 | Proactive Agent | CommitmentExecutor, Gmail/Calendar observers, research queue |
| 6 | Dashboard UI | 13-page React 19 dashboard, Google integrations |
| 7 | Multi-Agent Hierarchy | `delegate_task`, AgentTaskManager, 9 specialist roles |
| 8 | Communication Channels | Telegram, Discord, pluggable STT, voice transcription |
| 9 | Native App Control | Go sidecar, platform-specific automation, 7 desktop tools |
| 10 | Voice Interface | Edge TTS / ElevenLabs, binary WS, wake word, streaming playback |
| 11 | Authority & Autonomy | Runtime enforcement, soft-gate approvals, audit trail, emergency controls |
| 12 | Distribution & Onboarding | `jarvis` CLI, install.sh, npm package, interactive wizard |
| 13 | Continuous Awareness | Desktop capture, OCR+Vision, proactive suggestions, overlay widget |
| 14 | Workflow Automation | Visual builder, 50+ nodes, NL creation, self-healing execution |
| 15 | Plugin Ecosystem | TypeScript SDK, tiered permissions, official plugin registry |
| 16 | Autonomous Goal Pursuit | OKR hierarchy, 0.0-1.0 scoring, daily rhythm, accountability |

**379 tests passing across 22 test files. ~65,000 lines of TypeScript + Go.**

### Upcoming

| # | Milestone |
|---|---|
| 17 | Smart Home — Home Assistant integration |
| 18 | Financial Intelligence — Plaid, portfolio tracking |
| 19 | Mobile Companion — React Native dashboard |
| 20 | Self-Improvement — Autonomous prompt evolution |
| 21 | Multi-Modal — DALL-E 3, full video/image processing |
| 22 | Swarm Intelligence — Multi-device coordination |

See [VISION.md](VISION.md) for the full roadmap with detailed specifications.

---

## Documentation

- [VISION.md](VISION.md) — Full roadmap and milestone specifications
- [docs/LLM_PROVIDERS.md](docs/LLM_PROVIDERS.md) — LLM provider configuration
- [docs/WORKFLOW_AUTOMATION.md](docs/WORKFLOW_AUTOMATION.md) — Workflow engine guide
- [docs/VAULT_EXTRACTOR.md](docs/VAULT_EXTRACTOR.md) — Memory and knowledge vault
- [docs/PERSONALITY_ENGINE.md](docs/PERSONALITY_ENGINE.md) — Personality and role system
- [config.example.yaml](config.example.yaml) — Full configuration reference

---

## Requirements

- **Bun** >= 1.0
- **OS**: macOS, Linux, or Windows (WSL2)
- **LLM API key** — at least one of: Anthropic, OpenAI, Google Gemini, or a local Ollama instance
- Google OAuth credentials (optional — Calendar and Gmail integration)
- Telegram bot token (optional — notification channel)
- Discord bot token (optional — notification channel)
- ElevenLabs API key (optional — premium TTS)

---

## License

[Jarvis Source Available License 2.0](LICENSE) (based on RSALv2)
