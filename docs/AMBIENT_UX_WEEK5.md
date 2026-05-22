# Ambient UX — Week 5: Background Agents (Sub-Pebble Rail)

**Branch:** `refractor/UI_UX_phase2`
**Status:** ✅ feature-complete (Phases A → B → B+ → C)
**Pivot date:** 2026-05-20 — switched from a single dashboard "agent strip" panel to Clicky-style per-agent pebbles on a right-edge rail.

---

## TL;DR

When the user says "in the background, X", a colored pebble flies from the cursor to a vertical slot on the right edge of the current monitor. It pulses while the agent works, settles when done. Click the disc → paper-card bubble shows agent name, task, elapsed, and an LLM-generated summary of the response. Click "open full ↗" → dedicated 540×640 panel renders the full result. Voice "close the X one" / "close all background agents" dismisses.

Each sub-pebble is its own native always-on-top layered window with per-pixel alpha (GDI+ + `UpdateLayeredWindow`). The OS keeps them above every other app including fullscreen browsers. Multi-monitor anchoring: each pebble stays on its spawn monitor for life.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Daemon (Bun)                                                        │
│  • taskManager.subscribeLifecycle(fn) ──┐                           │
│  • tryHandleBackgroundIntent (voice fast-path)                      │
│  • tryHandleSubPebbleCloseIntent (voice fast-path)                  │
│  • summarizeTaskAsync (one-shot LLM on complete)                    │
│  • sub_pebble.clicked / .open_full event handlers                   │
│  • /api/agents/tasks/:id endpoint                                   │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ RPC (sub_pebble.spawn/set_state/set_color/
                          │      set_expanded/close/close_all)
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Sidecar (Go, Windows-only for now)                                  │
│  • SubPebbleService — multi-overlay registry by id                  │
│  • One goroutine per sub-pebble, 60 fps paint loop                  │
│  • Per-pixel ARGB DIB → UpdateLayeredWindow                         │
│  • WM_NCHITTEST returns HTTRANSPARENT outside disc/button           │
│  • OnClick / OnOpenFull → SidecarEvents back to daemon              │
│  • MonitorFromPoint → multi-monitor anchor at spawn                 │
└─────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Dashboard (React)                                                   │
│  • TaskResultRoom — #/_task_<id> standalone panel                   │
│  • AgentStripRoom — secondary "all agents" surface                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Ticket log

| # | Ticket | Status |
|---|---|---|
| **Phase A — Foundation** | | |
| A1 | Cross-platform `SubPebbleService` interface + color palette | ✅ done |
| A2 | Win32 multi-overlay renderer (one HWND per sub-pebble, color-tinted disc) | ✅ done |
| A3 | RPCs: `sub_pebble.spawn/set_state/set_label/close/close_all` + `CapSubPebble` | ✅ done |
| A4 | `taskManager.subscribeLifecycle` → spawn/state hooks | ✅ done |
| A5 | "In the background, X" voice intent → `taskManager.launch` | ✅ done |
| A6 | Sub-pebble lifecycle subscription **timing fix** — defer attach until taskManager exists (poll up to 20s) | ✅ done |
| A7 | Sidecar manager **event allowlist** — added `sub_pebble.clicked` then `sub_pebble.open_full` (same gotcha that bit `pebble.palette` + `panel.bounds_changed`) | ✅ done |
| **Phase B — Click to inspect** | | |
| B1 | Disc-only click hit-test via `WM_NCHITTEST` (drop `WS_EX_TRANSPARENT`, return `HTTRANSPARENT` for non-disc pixels) | ✅ done |
| B2 | `WM_LBUTTONUP` → callback → `sub_pebble.clicked` SidecarEvent | ✅ done |
| B3 | Paper-card bubble rendering to the LEFT of disc (riso treatment, hairline tinted border) | ✅ done |
| B4 | `sub_pebble.set_expanded(id, expanded, agent, task, result, elapsed_s)` RPC | ✅ done |
| B5 | GDI DrawText for agent name eyebrow + task body + result preview + alpha repair | ✅ done |
| B6 | Vermilion recolor on task failure (`sub_pebble.set_color` RPC) | ✅ done |
| B7 | Voice close intent — "close all background agents", "close the amber one", "close the research one", "close this/that" | ✅ done |
| **Phase B+ — Summary + full result** | | |
| B+1 | `AsyncTask.summary` field + `TaskManager.setSummary(id, text)` accessor | ✅ done |
| B+2 | `summarizeTaskAsync` — one-shot LLM call on `complete` (skipped for <240 char responses), re-dispatches `set_expanded` if bubble open | ✅ done |
| B+3 | "Open full ↗" button rendered in bubble bottom-right (color-tinted pill) | ✅ done |
| B+4 | Button hit-test (separate from disc) → `sub_pebble.open_full` event | ✅ done |
| B+5 | `#/_task_<id>` dashboard route + `AppShellV2` panel-mode short-circuit + `TaskResultRoom` component | ✅ done |
| B+6 | `GET /api/agents/tasks/:id` endpoint (full task record) | ✅ done |
| B+7 | Daemon spawns `540×640` panel on `sub_pebble.open_full` | ✅ done |
| **Phase C — Visual polish** | | |
| C1 | Spawn fly-out animation — `curX/curY` seeded from cursor, ease toward slot at 0.18 follow factor | ✅ done |
| C2 | Slot reflow on close — both sidecar & daemon decrement slots above the closed one; paint loop auto-animates | ✅ done |
| C3 | Multi-monitor anchor — `MonitorFromPoint` at spawn, stored on entry; each sub-pebble stays on its spawn monitor | ✅ done |
| **Routing** | | |
| R1 | Keyword-based specialist routing table — 11 specialists scored by phrase hits; fallback to `research-analyst`, then first available | ✅ done |

---

## Out-of-scope follow-ups (not blocking ship)

| Item | Why deferred |
|---|---|
| LLM-based specialist routing (fallback when keyword table doesn't match) | Keyword table covers ~95% of real cases; add only if user hits edge cases |
| Route summary call through cheap provider (Haiku/Groq) regardless of primary | Cost is ~$0.005/task, negligible at current usage |
| Real markdown rendering in `TaskResultRoom` (tables, bold, links) | Raw text in `<pre>` is fine for current dogfood; add `react-markdown` if needed |
| Split-from-main-pebble spawn effect (main pebble briefly brightens as sub flies out) | Pure visual cherry; current fly-out reads well enough |
| macOS / Linux ports of sub-pebble overlay | Only matters when onboarding non-Windows users |

---

## Lessons learned

1. **Webview transparency is a dead end** — confirmed again here. Native Win32 layered windows with `UpdateLayeredWindow` give us true per-pixel alpha for free. ~316 KB per overlay (DIB size), trivially cheap for ≤8 sub-pebbles.

2. **`WS_EX_TRANSPARENT` is all-or-nothing** — once set, the OS strips ALL mouse events from the window. The right pattern is to drop it and use `WM_NCHITTEST` to return `HTTRANSPARENT` per-pixel-region, keeping click-through everywhere except the interactive hot zones (disc + button).

3. **Subscribe-on-startup vs. subscribe-on-ready** — the daemon's `agentService.start()` runs late in boot sequence. Hooks that depend on it must either run AFTER startup or poll until ready. Polling up to 20s (200 ms intervals) is the right pattern for ambient setup code that can't be deferred to a later phase.

4. **GUI subsystem (`-H windowsgui`) breaks subprocess inheritance** — flag turns the binary into a GUI app, which means every shelled-out child (PowerShell, etc.) allocates its own console window. Either skip the flag (sidecar shows its own console) or set `CREATE_NO_WINDOW` on every `exec.Cmd` (which we now do in `subprocess_windows.go`).

5. **Event allowlist in sidecar manager** — third time this gotcha has bitten us (`pebble.palette`, `panel.bounds_changed`, now `sub_pebble.clicked` + `sub_pebble.open_full`). Worth a future refactor where event types auto-register from the events themselves rather than a hardcoded list.

6. **`CREATE TABLE IF NOT EXISTS` ≠ migration** — adding a column to the schema doesn't retro-add it to existing databases. The codebase pattern of `try { db.run('ALTER TABLE … ADD COLUMN …'); } catch {}` is the right answer; same fix applied to `screen_captures.thumbnail_path`.

---

## What W5 explicitly does NOT do

Pushed to W6+:
- Awareness eye glyph on main pebble (W6)
- "What's on my screen?" inline answer (W6)
- macOS / Linux ports of sub-pebble overlay (W7+)
- Real markdown rendering in `TaskResultRoom` (nice-to-have polish)
- LLM router fallback for unrouted tasks (only when keyword table fails)
