<div align="center">

# JARVIS

**Just A Rather Very Intelligent System**

[![CI](https://github.com/vierisid/jarvis/actions/workflows/test.yml/badge.svg)](https://github.com/vierisid/jarvis/actions/workflows/test.yml)
[![bun](https://img.shields.io/npm/v/@usejarvis/brain?label=bun&logo=bun&color=%23f9f1e1)](https://bun.sh/packages/@usejarvis/brain)
[![License](https://img.shields.io/badge/license-RSALv2-blue)](LICENSE)
[![Runtime](https://img.shields.io/badge/runtime-Bun-%23f9f1e1)](https://bun.sh)
[![Discord](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Fv10%2Finvites%2FzfmXvE586Q%3Fwith_counts%3Dtrue&query=%24.approximate_member_count&label=Discord&logo=discord&color=5865F2&suffix=%20members)](https://discord.gg/zfmXvE586Q)
[![Website](https://img.shields.io/badge/website-usejarvis.dev-black)](https://usejarvis.dev)

*An always-on autonomous AI daemon with desktop awareness, multi-agent hierarchy, visual workflows, and goal pursuit.*

JARVIS is not a chatbot with tools. It is a persistent daemon that sees your screen, understands what you're doing, and acts — within the authority limits you define. Run it on a server for 24/7 availability, then connect sidecars on your laptop, desktop, or any other machine to give it eyes and hands everywhere.

</div>

<!-- TODO: add dashboard screenshot or demo GIF here -->

---

## Table of Contents

- [JARVIS](#jarvis)
  - [Table of Contents](#table-of-contents)
  - [🔍 What Makes JARVIS Different](#-what-makes-jarvis-different)
  - [⚡ Quick Start](#-quick-start)
  - [☁️ Managed Hosting](#️-managed-hosting)
  - [💡 Use Cases](#-use-cases)
  - [📋 Requirements](#-requirements)
  - [📦 Installation](#-installation)
    - [bun (recommended)](#bun-recommended)
    - [Docker](#docker)
    - [One-liner](#one-liner)
    - [Manual](#manual)
  - [🚀 Usage](#-usage)
  - [🖥️ Sidecar Setup](#️-sidecar-setup)
    - [1. Install the sidecar](#1-install-the-sidecar)
    - [2. Enroll in the dashboard](#2-enroll-in-the-dashboard)
    - [3. Run the sidecar](#3-run-the-sidecar)
  - [🧠 Core Capabilities](#-core-capabilities)
  - [🎛️ Dashboard](#️-dashboard)
  - [⚙️ Configuration](#️-configuration)
  - [🏗️ Architecture](#️-architecture)
  - [🛠️ Development](#️-development)
    - [Stack](#stack)
  - [🗺️ Roadmap](#️-roadmap)
    - [Upcoming](#upcoming)
  - [📖 Documentation](#-documentation)
  - [💬 Community](#-community)
  - [🔒 Security](#-security)
  - [📄 License](#-license)

---

## 🔍 What Makes JARVIS Different

| Feature | Typical AI Assistant | JARVIS |
|---|---|---|
| Always-on | No — request/response only | Yes — persistent daemon, runs 24/7 on a server or locally |
| Reach across machines | No — single machine only | Yes — one daemon, unlimited sidecars on any machine |
| Desktop awareness | No | Yes — screen capture every 5-10s via sidecar |
| Native app control | No | Yes — Go sidecar with Win32/X11/macOS automation |
| Multi-agent delegation | No | Yes — 9 specialist roles |
| Visual workflow builder | No | Yes — 50+ nodes, n8n-style |
| Voice with wake word | No | Yes — streaming TTS + openwakeword |
| Goal pursuit (OKRs) | No | Yes — drill sergeant accountability |
| Authority gating | No | Yes — runtime enforcement + audit trail |
| LLM provider choice | Usually locked to one | 4 providers: Anthropic, OpenAI, Gemini, Ollama |

---

## ⚡ Quick Start

```bash
bun install -g @usejarvis/brain   # Install the daemon
jarvis onboard                    # Interactive setup wizard
jarvis start -d                   # Start as background daemon
```

Open `http://localhost:3142` — your dashboard is ready.

---

## ☁️ Managed Hosting

Don't want to deal with servers, DNS, or TLS certificates? We've partnered with **[opencove.host](https://opencove.host)** — a managed hosting platform built specifically for JARVIS.

- **No self-hosting hassle** — no server to provision, no dependencies to install
- **Dedicated domain included** — no need to buy a domain or configure DNS and TLS
- **Up and running in under 5 minutes** — spin up your JARVIS instance and start using it immediately

Visit [opencove.host](https://opencove.host) to get started.

---

## 💡 Use Cases

**Research while you work** — Ask JARVIS to deep-dive a topic. It runs browser searches, reads pages, and compiles a summary in the background while you focus on other things.

**Automate across machines** — Run the daemon on your home server. Connect sidecars on your work laptop and your desktop. JARVIS can move files between them, run scripts on your server, and open apps on your laptop — all from one conversation.

**Inbox triage** — Set up a workflow that monitors your Gmail, categorizes incoming messages, drafts replies for your review, and schedules follow-ups on your calendar.

**Desktop co-pilot** — JARVIS watches your screen via the sidecar. If it sees you struggling with an error message or a complex form, it proactively offers help or fills in fields for you.

**Goal accountability** — Define OKRs in the Goals dashboard. JARVIS plans your day each morning, checks in during the evening, and escalates if you're falling behind — like a personal drill sergeant.

**Multi-step workflows** — Build visual automations with 50+ node types: "when a file appears in this folder, OCR it, extract key data, update the spreadsheet, and notify me on Telegram."

---

## 📋 Requirements

- **Bun** >= 1.0 (installed automatically if missing)
- **OS**: Windows, macOS, or Linux
- **LLM API key** — at least one of: Anthropic, OpenAI, Google Gemini, or a local Ollama instance
- Google OAuth credentials (optional — Calendar and Gmail integration)
- Telegram bot token (optional — notification channel)
- Discord bot token (optional — notification channel)
- ElevenLabs API key (optional — premium TTS)

---

## 📦 Installation

### bun (recommended)

```bash
bun install -g @usejarvis/brain
jarvis onboard
```

### Docker

Run JARVIS on any OS with a single command — no Bun or dependencies required. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows, macOS, Linux) if you don't have Docker yet.

```bash
docker run -d --name jarvis \
  -p 3142:3142 \
  -v jarvis-data:/data \
  -e JARVIS_API_KEY=sk-ant-your-key \
  ghcr.io/vierisid/jarvis:latest
```

The image is available on [GHCR](https://ghcr.io/vierisid/jarvis). Configuration can be provided via environment variables or by mounting a `config.yaml` into the `/data` volume.

> **Note:** Docker runs in an isolated container, so the daemon inside it cannot access your host desktop, browser, or clipboard directly. You must still install the [sidecar](#️-sidecar-setup) on each machine where you want JARVIS to have desktop awareness and automation capabilities.

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
bun run build:ui
jarvis onboard
```

---

## 🚀 Usage

```bash
jarvis start            # Start in foreground
jarvis start -d         # Start as background daemon
jarvis start --port 3142 # Start on a specific port
jarvis stop             # Stop the daemon
jarvis status           # Check if running
jarvis doctor           # Verify environment & connectivity
jarvis logs -f          # Follow live logs
jarvis update           # Update to latest version
```

The dashboard is available at `http://localhost:3142` once the daemon is running.

---

## 🖥️ Sidecar Setup

The sidecar is what gives JARVIS physical reach beyond the machine it runs on. It is a lightweight agent that you install on any machine — your laptop, a dev server, a home PC — and it connects back to the central daemon over an authenticated WebSocket. Each sidecar gives JARVIS access to that machine's desktop, browser, terminal, filesystem, clipboard, and screenshots.

This means you can run the daemon on an always-on server and still interact with your desktop machines as if JARVIS were running locally. Enroll as many sidecars as you want.

### 1. Install the sidecar

**Via bun:**

```bash
bun install -g @usejarvis/sidecar
```

**Or download the binary** from [GitHub Releases](https://github.com/vierisid/jarvis/releases) for your platform (macOS, Linux, Windows).

### 2. Enroll in the dashboard

1. Open the JARVIS dashboard at `http://localhost:3142`
2. Go to **Settings** → **Sidecar**
3. Enter a friendly name for this machine (e.g. "work laptop") and click **Enroll**
4. Click **Copy** to copy the token command

### 3. Run the sidecar

Paste and run the copied command on the machine where you installed the sidecar:

```bash
jarvis-sidecar --token <your-token>
```

The sidecar saves the token locally, so on subsequent runs you just need:

```bash
jarvis-sidecar
```

Once connected, the sidecar appears as online in the Settings page where you can configure its capabilities (terminal, filesystem, desktop, browser, clipboard, screenshot, awareness).

---

## 🧠 Core Capabilities

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

## 🎛️ Dashboard

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

## ⚙️ Configuration

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

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     JARVIS Daemon                           │
│                  (server or local machine)                  │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌───────────┐   │
│  │ LLM      │  │ Vault    │  │ Agent     │  │ Workflow  │   │
│  │ Router   │  │ Memory   │  │ Manager   │  │ Engine    │   │
│  └──────────┘  └──────────┘  └───────────┘  └───────────┘   │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌───────────┐   │ 
│  │ Tool     │  │ Authority│  │ Goal      │  │ Awareness │   │
│  │ Executor │  │ Engine   │  │ Tracker   │  │ Pipeline  │   │
│  └──────────┘  └──────────┘  └───────────┘  └───────────┘   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Bun.serve() — HTTP + WebSocket + Dashboard (React)   │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────┬──────────────────────┬───────────────────────┘
               │ JWT-auth WebSocket   │
       ┌───────┴───────┐       ┌──────┴────────┐
       │  Sidecar #1   │       │  Sidecar #2   │      ...
       │  (laptop)     │       │  (dev server) │
       │               │       │               │
       │  desktop      │       │  terminal     │
       │  browser      │       │  filesystem   │
       │  terminal     │       │  screenshots  │
       │  clipboard    │       │               │
       └───────────────┘       └───────────────┘
```

The **daemon** is the brain — it holds the LLM connections, memory vault, agent hierarchy, and all decision-making. It can run on a home server, a VPS, or your local machine.

**Sidecars** are the hands. Each sidecar is a lightweight Go binary that connects to the daemon and exposes its host machine's capabilities. The daemon can orchestrate actions across all connected sidecars simultaneously. Sidecars authenticate via JWT and communicate over a binary WebSocket protocol.

This separation means JARVIS stays reachable 24/7 on a server while still being able to see your screen, type in your apps, and manage files on any machine where a sidecar is running.

---

## 🛠️ Development

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
- **Package**: `@usejarvis/brain` (published to npm registry, installable via bun)

---

## 🗺️ Roadmap

16 milestones completed — LLM conversations, tool execution, memory vault, browser control, proactive agent, dashboard UI, multi-agent hierarchy, communication channels, native app control, voice interface, authority & autonomy, distribution & onboarding, continuous awareness, workflow automation, plugin ecosystem, and autonomous goal pursuit.

**379 tests passing across 22 test files. ~65,000 lines of TypeScript + Go.**

### Upcoming

| Milestone | Description |
|---|---|
| Smart Home | Home Assistant integration |
| Financial Intelligence | Plaid, portfolio tracking |
| Mobile Companion | React Native dashboard |
| Self-Improvement | Autonomous prompt evolution |
| Multi-Modal | DALL-E 3, full video/image processing |
| Swarm Intelligence | Multi-device coordination |

See [VISION.md](VISION.md) for the full roadmap with detailed specifications.

---

## 📖 Documentation

- [VISION.md](VISION.md) — Full roadmap and milestone specifications
- [docs/LLM_PROVIDERS.md](docs/LLM_PROVIDERS.md) — LLM provider configuration
- [docs/WORKFLOW_AUTOMATION.md](docs/WORKFLOW_AUTOMATION.md) — Workflow engine guide
- [docs/VAULT_EXTRACTOR.md](docs/VAULT_EXTRACTOR.md) — Memory and knowledge vault
- [docs/PERSONALITY_ENGINE.md](docs/PERSONALITY_ENGINE.md) — Personality and role system
- [config.example.yaml](config.example.yaml) — Full configuration reference

---

## 💬 Community

- [Discord](https://discord.gg/nE3hcaFYZP) — Chat with other users, ask questions, share workflows
- [Website](https://usejarvis.dev) — Project homepage and documentation
- [GitHub Issues](https://github.com/vierisid/jarvis/issues) — Bug reports and feature requests

---

## 🔒 Security

JARVIS includes a built-in authority engine that gates every action at runtime. All tool executions are logged in an audit trail, and sensitive operations require explicit approval via the dashboard, Telegram, or Discord. Emergency pause and kill controls are always available.

If you discover a security vulnerability, please report it privately by emailing the maintainer rather than opening a public issue.

---

## 📄 License

[Jarvis Source Available License 2.0](LICENSE) (based on RSALv2)
