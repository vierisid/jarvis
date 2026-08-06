<div align="center">

# JARVIS

**Just A Rather Very Intelligent System**

[![CI](https://github.com/vierisid/jarvis/actions/workflows/test.yml/badge.svg)](https://github.com/vierisid/jarvis/actions/workflows/test.yml)
[![bun](https://img.shields.io/npm/v/@usejarvis/brain?label=bun&logo=bun&color=%23f9f1e1)](https://bun.sh/packages/@usejarvis/brain)
[![License](https://img.shields.io/badge/license-RSALv2-blue)](LICENSE)
[![Runtime](https://img.shields.io/badge/runtime-Bun-%23f9f1e1)](https://bun.sh)
[![Discord](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Fv10%2Finvites%2FytG2PHQ6rW%3Fwith_counts%3Dtrue&query=%24.approximate_member_count&label=Discord&logo=discord&color=5865F2&suffix=%20members)](https://discord.gg/ytG2PHQ6rW)
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
  - [🪨 Ambient mode (recommended)](#-ambient-mode-recommended)
  - [☁️ Managed Hosting](#️-managed-hosting)
  - [💡 Use Cases](#-use-cases)
  - [📋 Requirements](#-requirements)
  - [📦 Installation](#-installation)
    - [bun (recommended)](#bun-recommended)
    - [Docker](#docker)
    - [One-liner](#one-liner)
    - [Manual](#manual)
  - [🚀 Usage](#-usage)
    - [Updating](#updating)
    - [Removing JARVIS](#removing-jarvis)
  - [🖥️ Sidecar Setup](#️-sidecar-setup)
    - [1. Install the sidecar](#1-install-the-sidecar)
    - [2. Enroll in the dashboard](#2-enroll-in-the-dashboard)
    - [3. Run the sidecar](#3-run-the-sidecar)
  - [🧠 Core Capabilities](#-core-capabilities)
  - [⚙️ Configuration](#️-configuration)
  - [🏗️ Architecture](#️-architecture)
  - [🛠️ Development](#️-development)
    - [Stack](#stack)
  - [📖 Documentation](#-documentation)
  - [💬 Community](#-community)
  - [📊 Telemetry](#-telemetry)
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
| LLM provider choice | Usually locked to one | Anthropic, OpenAI, Gemini, Ollama, Groq, OpenRouter, OmniRoute, and more |

---

## ⚡ Quick Start

```bash
bun install -g @usejarvis/brain   # Install the daemon
jarvis start -d                   # Start as background daemon
```

Open `http://localhost:3142` — the dashboard walks you through LLM provider, voice, and a quick conversational profile interview the first time you visit.

---

## 🪨 Ambient mode

JARVIS ships a "dashboard-less" experience built around a small cursor-following pebble — **on by default** after onboarding. Just run:

```bash
bun run start
```

What you get:

- **Pebble** — a small paper-toned disc that follows your cursor. Wake-word ("Hey Jarvis"), `Ctrl+Space`, or click summons it. Long-press the disc to blind awareness instantly (privacy toggle); the eye glyph next to it shows when JARVIS is actively reading your screen.
- **Native windows** — every dashboard room (workflows, memory, settings, …) opens as a real Windows window via voice ("open settings", "show me workflows") or `Ctrl+K`. No browser tab.
- **Sub-pebble rail** — say "in the background, research X" and a colored sub-pebble flies to the right edge of your screen. Click it to see what the agent is doing; "open full ↗" pops a dedicated result panel.
- **Voice-first** — "what's on my screen?", "close all background agents", "open the workflows window", "in the background, summarize today's meeting notes" — all routed inline, no LLM round-trip for the common verbs.

Currently **Windows-only** (cross-platform ports planned). The `localhost:3142` dashboard still works as a fallback / debug surface.

> **Opt out:** set `JARVIS_AMBIENT_UI=0` to disable the pebble + sidecar voice loop (useful for headless servers, CI, or users who only want the web dashboard).

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
- **OS (native daemon install)**: macOS, Linux, or WSL
- **Windows**: native Windows is not supported for the daemon - use WSL2 for the Bun install, or Docker for the daemon
- **LLM API key** — at least one of: Anthropic, OpenAI, Google Gemini, or a local Ollama instance

---

## 📦 Installation

### bun (recommended)

```bash
bun install -g @usejarvis/brain
jarvis start
```

The first time you run `jarvis start`, the daemon boots in setup mode and the dashboard at `http://localhost:3142` guides you through LLM provider, voice (TTS) choice, a conversational profile interview, and a 10-minute spotlight tour.

> **Restart after first-time setup:** The daemon constructs background services (heartbeat, commitments, awareness) at boot, gated on setup having already been completed. Once you finish setup in the dashboard, those services don't activate until the next start — the dashboard shows a banner reminding you. Run `jarvis restart` (or stop/start) to bring them online. This will go away in a follow-up that constructs the services in-process at setup completion.

> **Note:** Native Windows is not a supported platform for the JARVIS daemon. JARVIS is built for Unix-like systems (macOS, Linux, and WSL); supporting native Windows would mean porting to a fundamentally different OS, which is out of scope. On Windows, use WSL2 for the Bun install above, or use the Docker install instead.

### Docker

Run JARVIS on any OS with a single command — no Bun or dependencies required. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows, macOS, Linux) if you don't have Docker yet.

```bash
docker run -d --name jarvis \
  -p 3142:3142 \
  -v jarvis-data:/data \
  ghcr.io/vierisid/jarvis:latest
```

The image is available on [GHCR](https://ghcr.io/vierisid/jarvis). Non-LLM configuration can be provided via environment variables or by mounting a `config.yaml` into the `/data` volume. LLM providers, API keys, and model routing are configured from the settings dashboard (open http://localhost:3142 after first boot) and stored in the database + encrypted keychain - they are not set via env vars or `config.yaml`.

> **Note:** Docker runs in an isolated container, so the daemon inside it cannot access your host desktop, browser, or clipboard directly. You must still install the [sidecar](#️-sidecar-setup) on each machine where you want JARVIS to have desktop awareness and automation capabilities.

### One-liner

```bash
curl -fsSL https://raw.githubusercontent.com/vierisid/jarvis/main/install.sh | bash
```

After opening a new terminal, run:

```bash
jarvis start
```

The install script sets up Bun, clones the repo, and links the `jarvis` CLI. Then finish setup in your browser at `http://localhost:3142`.

> **Note:** The one-liner only supports macOS, Linux, and WSL. Native Windows shells such as PowerShell, Git Bash, and CMD should use WSL2 or the Docker install instead.

### Manual

```bash
git clone https://github.com/vierisid/jarvis.git ~/.jarvis/daemon
cd ~/.jarvis/daemon
bun install
bun run build:ui
bun link
jarvis start
```

Then open `http://localhost:3142` to finish setup in the dashboard.

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
```

The dashboard is available at `http://localhost:3142` once the daemon is running.

### Updating

`jarvis update` detects how you installed JARVIS and runs the right update command. Equivalent manual commands per install method:

| Install method | `jarvis update` dispatches to |
| --- | --- |
| Bun global (`bun install -g @usejarvis/brain`) | `bun update -g @usejarvis/brain` |
| `install.sh` (git clone under `~/.jarvis/daemon`) | `git pull --ff-only` + `bun install` |
| Docker | Refused — run `docker pull <image> && docker rm -f jarvis && docker run ...` on the host |
| Developer checkout | Refused — run `git pull` yourself |

Run `jarvis doctor` to see what was detected and the exact commands for your install.

### Removing JARVIS

`jarvis uninstall` stops the daemon, removes autostart hooks, deletes `~/.jarvis`, and — where applicable — runs the correct package-manager uninstall. It does **not** touch sidecars.

| Install method | `jarvis uninstall` dispatches to |
| --- | --- |
| Bun global | `bun uninstall -g @usejarvis/brain` + side-effect cleanup |
| `install.sh` | `rm -rf ~/.jarvis/daemon` + CLI wrapper + side-effect cleanup |
| Docker | Refused — run `docker rm -f jarvis` (and optionally `docker volume rm jarvis-data`) on the host |
| Developer checkout | Side-effect cleanup only — your checkout is left in place |

> **Tip:** If you already ran `bun uninstall -g @usejarvis/brain` without going through `jarvis uninstall`, your daemon may still be running and `~/.jarvis` is still on disk. Run `jarvis doctor` before uninstalling to see what will be cleaned up, or stop the daemon and remove `~/.jarvis` manually.

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

Just start it:

```bash
jarvis
```

The first time it runs unconfigured, a small **setup window** pops up asking for
the enrollment token — paste the token you copied and click **Connect**. The
sidecar saves it locally (`~/.jarvis/sidecar.yaml`) and connects.

Prefer the terminal / a headless box? Pass the token on the CLI instead (no
window):

```bash
jarvis --token <your-token>
```

Either way, subsequent runs are just `jarvis` (the saved token is reused).

Once connected, the sidecar appears as online in the Settings page where you can configure its capabilities (terminal, filesystem, desktop, browser, clipboard, screenshot, awareness, file watch, processes, notifications). The host-sensing observers (clipboard, file watch, process monitor, desktop notifications) run inside the sidecar on your machine and stream to the brain - the brain no longer observes its own host.

### Versioning & updates

The sidecar is versioned **independently of the brain** (`bun update -g @usejarvis/sidecar`, or grab a newer binary from [GitHub Releases](https://github.com/vierisid/jarvis/releases) -- the `sidecar-vX.Y.Z` releases). Run `jarvis --version` to see what you have.

On connect, the brain checks the sidecar's version against its compatibility floors and surfaces the result in **Settings -> Sidecar**:

- **OK** -- up to date enough; nothing to do.
- **Update available** -- still compatible, but the brain recommends a newer sidecar; update when convenient.
- **Update required** -- too old for this brain; the connection is refused and the sidecar logs an "update required" message. Update the sidecar and restart it.

Local development builds report `dev` and are never blocked.

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

## ⚙️ Configuration

JARVIS stores its system configuration at `~/.jarvis/config.yaml`; user-level settings live in its database and are managed from the dashboard. Access is **JWT-only by default**: run `jarvis enroll "<device-name>"` and paste the printed token into the sidecar (desktop app), which connects and gives you the dashboard. Setting up without a sidecar? Temporarily add `auth:\n  insecure_open_access: true` to config.yaml, open `http://localhost:3142` after `jarvis start` for the guided setup, then **remove the flag** once your device is enrolled. The Settings room lets you tweak channels, personality, and authority later.

Running the brain on another machine — a home server, a LAN box, or a VPS with a domain? Read [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for the reverse-proxy setup, `brain_domain`, device enrollment across machines, and what plain-HTTP access does and doesn't support.

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

## 📖 Documentation

General:

- [config.example.yaml](config.example.yaml) — Full configuration reference
- [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) — Deploying the brain: single machine, LAN, or VPS behind a reverse proxy
- [docs/LLM_PROVIDERS.md](docs/LLM_PROVIDERS.md) — LLM provider configuration and routing
- [docs/VAULT_EXTRACTOR.md](docs/VAULT_EXTRACTOR.md) — Memory and knowledge vault
- [docs/PERSONALITY_ENGINE.md](docs/PERSONALITY_ENGINE.md) — Personality and role system
- [docs/TELEMETRY.md](docs/TELEMETRY.md) — What anonymous metrics are collected, and how to opt out

Workflows (contributor reading order):

- [docs/WORKFLOW_AUTOMATION.md](docs/WORKFLOW_AUTOMATION.md) — Architecture, source-tree map, and runtime walkthrough. Start here.
- [docs/PIECE_VERIFICATION.md](docs/PIECE_VERIFICATION.md) — 8-stage checklist to verify a piece end-to-end. Required before adding or editing any piece.
- [src/workflows/activepieces/UPSTREAM.md](src/workflows/activepieces/UPSTREAM.md) — Pinned Activepieces SHA, license posture, vendored exclusions
- [src/workflows/pieces-library/README.md](src/workflows/pieces-library/README.md) — How community pieces are curated and installed at runtime

---

## 💬 Community

- [Discord](https://discord.gg/ytG2PHQ6rW) — Chat with other users, ask questions, share workflows
- [Website](https://usejarvis.dev) — Project homepage and documentation
- [GitHub Issues](https://github.com/vierisid/jarvis/issues) — Bug reports and feature requests

---

## 📊 Telemetry

JARVIS sends **anonymous** usage metrics so the project can measure its unique
user base and retention. Each ping contains only a hashed machine id (derived
from hostname + username, never reversible to either), the app version, the
install method, and the OS/arch. No personal data, config, content, or feature
usage is ever sent. Pings go out at startup and every hour.

It is on by default (opt-out). Disable it with any of:

```yaml
# ~/.jarvis/config.yaml
telemetry:
  enabled: false
```

```bash
JARVIS_TELEMETRY=0   # or the cross-tool standard: DO_NOT_TRACK=1
```

Full details: [docs/TELEMETRY.md](docs/TELEMETRY.md).

---

## 🔒 Security

JARVIS includes a built-in authority engine that gates every action at runtime. All tool executions are logged in an audit trail, and sensitive operations require explicit approval via the dashboard, Telegram, or Discord. Emergency pause and kill controls are always available.

If you discover a security vulnerability, please report it privately by emailing the maintainer rather than opening a public issue.

---

## 📄 License

Jarvis is distributed under the [Jarvis Source Available License 2.0](LICENSE) (based on RSALv2).

The Jarvis codebase incorporates third-party components under their own licenses. Those components retain their original licenses for any party who extracts them as a standalone work; the combined Jarvis distribution is governed by the Jarvis Source Available License. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the full list and per-component license text.
