# Ambient UX — Phase 2 Plan

**Branch:** `refractor/UI_UX_phase2`
**Status:** Drafted 2026-05-02 · awaiting alignment
**Codename:** "Pebble" (cursor-following ambient JARVIS)

---

## 1. Vision

Replace the dashboard at `localhost:3142` with an **ambient, dashboardless desktop experience**. JARVIS lives on the desktop as a small cursor-following pebble. Every existing dashboard page becomes a **native OS window** spawned and managed by the Go sidecar. No browser tab. No `localhost`.

The user never opens a "dashboard." They talk, type, or hit a hotkey, and JARVIS materializes — as the pebble itself, an in-place thread bubble, or a real native window for whichever feature they invoked.

> "Hey JARVIS, open workflows" → a real Windows-11 window appears with the workflows editor inside, exactly like opening any other app.

**Critically, no JARVIS feature is dropped.** Every room (workflows, memory, tools, agents, authority, logs, calendar, goals, tasks, content, workspaces, settings) survives — they just live as native windows instead of dashboard routes.

---

## 2. Principles

1. **Sidecar-as-window-service.** The Go sidecar already owns desktop ops (Win32, OCR, mouse/keyboard control). It also becomes the broker that spawns and manages every JARVIS native window.
2. **Reuse, don't rewrite.** Existing React room components stay. We change *how they're delivered* (native window webview), not *what they do*.
3. **Voice-first, but not voice-only.** Keyboard, mouse, hotkey, click on pebble — every input modality keeps working.
4. **Persistence on top.** Always-on-top pebble, but never blocking — click-through when idle, expand on summon.
5. **Discoverability survives ambient-ness.** A taskbar dock + visible agent strip ensures the user knows what's running even when most UI is hidden.
6. **Backend is unchanged.** Daemon, Vault, Authority, Awareness, Workflows engine, Goals — all stay. This is a UI/UX change only.

---

## 3. Architecture

### 3.1 Today (single React SPA)

```
┌──────────────────────┐    ┌──────────────────────┐
│ Browser localhost:   │ ←→ │ Daemon (Bun)         │
│ 3142 (React SPA)     │ WS │ + Vault, Workflows…  │
│ - 12 rooms in tabs   │    │                      │
└──────────────────────┘    └──────┬───────────────┘
                                   │ JWT WS (RPC)
                                   ▼
                            ┌──────────────────────┐
                            │ Go sidecar           │
                            │ - Win32, OCR, input  │
                            └──────────────────────┘
```

### 3.2 Tomorrow (sidecar window service)

```
┌─────────────────────────────────────────────────────────────────┐
│                   Native Desktop (Win11 / macOS)                │
│                                                                 │
│   ┌──────┐      ┌──────────────┐     ┌──────────────────┐      │
│   │Pebble│      │ Workflows    │     │ Vault            │      │
│   │(WV2) │      │ window (WV2) │     │ window (WV2)     │      │
│   └──────┘      └──────────────┘     └──────────────────┘      │
│        ▲              ▲                       ▲                 │
│        │              │                       │                 │
│        └──────────────┴───── spawned by ──────┘                 │
└────────────────────────────│────────────────────────────────────┘
                             ▼
                ┌────────────────────────────┐
                │ Go sidecar                 │
                │ + window service           │  ◄── new
                │ + existing desktop ops     │
                └──────────┬─────────────────┘
                           │ JWT WS (RPC)
                           ▼
                ┌────────────────────────────┐
                │ Daemon (Bun) — unchanged   │
                └────────────────────────────┘
```

### 3.3 New sidecar surface: window service

The sidecar gains a new responsibility. New RPC handlers:

| Handler | Purpose |
|---|---|
| `window.spawn` | Open a native window hosting a panel route. Args: `panel_id`, `bounds?`, `multi?`. |
| `window.close` | Close a native window by id. |
| `window.focus` | Bring window to foreground. |
| `window.list` | Enumerate currently-open JARVIS windows. |
| `window.move` / `window.resize` | Geometry control (also driven by user dragging natively). |
| `pebble.set_state` | Set pebble visual state (idle/listening/thinking/speaking/working). |
| `pebble.attach_thread` | Show an in-place thread bubble above the pebble. |
| `pebble.set_position` | Override or release cursor-follow (e.g. anchor near a specific window). |

Each spawned window is a **frameless or chromed WebView2 window** loading a route from the existing dashboard build, e.g. `app://panels/workflows`. The dashboard React app gets refactored so each room can be loaded standalone (one entry point per panel).

### 3.4 Tech stack — decided

**Cross-platform from day one** via [`webview/webview_go`](https://github.com/webview/webview), a single Go API that maps to:
- **Windows** → WebView2 (Edge Chromium runtime, pre-installed on Win11)
- **macOS** → WKWebView (system-provided)
- **Linux** → WebKitGTK (apt/dnf-installable)

Each spawned panel is a frameless or chromed webview window managed by the sidecar, loading a route from the existing dashboard build (e.g. `app://panels/workflows`).

**Why webview/webview_go over Wails / Electron:**
- Same Go binary already powers the sidecar; we extend it, no second runtime.
- ~5 MB per window vs Electron's ~150 MB.
- True cross-platform — same RPC works on Win/mac/Linux with platform-specific shims for window chrome (always-on-top, frameless, click-through).

**Platform-specific Go files we'll add** (mirroring existing `desktop_windows.go` etc.):
- `windows_windows.go` — Win32 layered window flags (WS_EX_TOPMOST, WS_EX_LAYERED, WS_EX_TRANSPARENT)
- `windows_darwin.go` — NSPanel with NSWindowStyleMaskNonactivatingPanel
- `windows_linux.go` — X11/Wayland always-on-top hints

**Fallback if webview_go hits a wall:** Tauri (Rust) wrapper invoked by the Go sidecar via subprocess. Decided only if a blocker emerges in Week 1.

---

## 4. UX spec — the pebble

### 4.1 Behavior

| State | Visual | When |
|---|---|---|
| **Idle** | 36×36 white pill, faint shadow, just a dot inside | No active conversation, nothing pending |
| **Listening** | Pill widens to ~170px showing "listening…", blue dot heartbeating | Wake-word fired or hotkey pressed |
| **Thinking** | Same width, dot pulses grey | LLM call in flight |
| **Speaking** | Pill goes dark, white text "speaking", soft glow | TTS playing |
| **Working** | Amber dot with halo, label shows agent count ("3 agents") | One or more background agents running |
| **Eye on/off** | Tiny eye glyph appears in pill when awareness is actively reading screen | Awareness firing |

### 4.2 Position & lock-on-summon

- **Default (idle / working):** follows cursor with eased physics (~0.10 follow factor) so it never feels glued to the pointer.
- **On summon (listening / thinking / speaking):** pebble **locks** at the cursor's current position and stays still until dismissed. This is critical — if the pebble keeps moving while the thread bubble is open, the bubble's buttons fly out from under the user's mouse.
- **Locked indicator:** subtle dashed ring around the pebble while locked, so the user knows it isn't broken.
- **On window hover:** pebble sticks to a corner of the hovered window so it doesn't obscure UI.
- **On idle for >30s with no mouse movement:** pebble parks bottom-left and dims to 50% opacity.
- **Click-through when idle**: platform layered-window flag so it doesn't intercept clicks unless hovered.

### 4.3 Summon

- **Wake word:** "Hey JARVIS" (existing) — locks pebble at current cursor pos, opens listening state.
- **Global hotkey:** `Ctrl+Space` push-to-talk (same lock behavior).
- **Click on pebble:** opens the inline thread bubble for typed input.
- **`Cmd+K` / `Ctrl+K` (room palette):** opens a Spotlight-style searchable list of all rooms anchored at the cursor. Same shortcut as today's dashboard command palette so muscle memory carries over.

### 4.4 Cmd+K room palette

A 380px popup that appears at the cursor when the user hits `Cmd+K` (mac) or `Ctrl+K` (win/linux). Behavior:
- Search input at the top filters the room list live (fuzzy matches name + description).
- Each row: glyph + room name + short description + destination hint ("window" / "background").
- `↵` opens the selected room as a native window.
- `⌘B` / `Ctrl+B` spawns it as a background agent instead.
- `⌘V` / `Ctrl+V` triggers a voice reply on that room ("read me the latest from logs").
- `Esc` dismisses; clicking outside dismisses.
- Palette also serves as a generic command runner — typing arbitrary text falls through to the LLM if no room matches ("give me today's brief").
- Palette is **not** cursor-following; it stays where it spawned so the user can mouse over it.

### 4.5 Dismiss

- `Esc` collapses the thread bubble; pebble unlocks and returns to idle/follow.
- Clicking outside the bubble for >300ms dismisses (avoid accidental drops while gesturing).
- Auto-collapse after 8s of silence post-response.

### 4.6 Expand-in-place thread

Above the (now-locked) pebble, a 340px bubble appears for short interactions: ask + answer + 2–3 quick action buttons (e.g. "Open window", "Speak it", "Send to vault"). Because the pebble is locked, the bubble's buttons stay clickable. For anything substantive ("show me workflow X", "open vault"), a full native window spawns and the bubble dismisses.

---

## 5. Window catalog — every dashboard room → native window

| Today's room (route) | Native window | Default size | Multi-instance? |
|---|---|---|---|
| Home (Thread + Rail + Composer) | Thread window | 380 × 600 | No (1 active) |
| Workflows | Workflow editor | 900 × 600 | Yes (per workflow) |
| Memory (Vault) | Vault browser | 480 × 700 | No |
| Tools | Tool catalogue | 560 × 600 | No |
| Agents | Agent monitor | 600 × 600 | No |
| Authority | Approvals queue | 480 × 600 | No |
| Logs | Live log stream | 700 × 500 | No |
| Calendar | Calendar view | 720 × 600 | No |
| Goals | OKR tracker | 480 × 600 | No |
| Tasks | Task list | 420 × 600 | No |
| Content | Content/notes | 600 × 700 | Yes (per doc) |
| Workspaces | Workspace switcher | 500 × 500 | No |
| Settings | Settings (sub-panes) | 560 × 600 | No |
| Primitives showcase | Dev panel | 1000 × 700 | No (debug only) |

Each window:
- Has Win11-style chrome (titlebar with traffic-light buttons in top-right; rounded corners; Mica blur).
- Persists position + size in `~/.jarvis/window-state.json`.
- Can be Alt-Tabbed like any other app.
- Multi-monitor aware (remember which display).

---

## 6. Background agents — the "Clicky moment"

A floating **Agent Activity panel** (bottom-right, ~290px wide, Mica/glass aesthetic) is the **only persistent JARVIS chrome on screen**. No taskbar, no dock, no chip strip — just one panel that shows everything currently running.

Layout:
- **Header:** "Agents" title with pulsing indicator + active count badge.
- **Rows:** one per agent, with status dot (amber=running, violet=running variant, emerald=done, red=failed), name, short context line ("comparing 18 routes · Lisbon, Sat–Sun"), thin progress bar for in-progress agents, and elapsed time / percent on the right.
- **Footer:** "Last update Xs ago" + "Open all →" link to the full Agents room as a native window.

Behavior:
- Always-on-top, click-through-to-rows (each row is interactive).
- Auto-collapses to header-only when no agents have run in last 60s.
- On agent completion: row briefly highlights green + OS notification + pebble pulse.
- Click a row → opens that agent's log + output as its own native window.
- Right-click a row → cancel / pause / send to vault.

Spawn methods:
1. Voice: "JARVIS, in the background, find me 25 micro-influencers."
2. From the thread bubble: "Send to background" button on long-running tasks.
3. From the Cmd+K palette: `⌘B` modifier instead of `↵`.
4. Programmatic: from Workflows or Goals as scheduled jobs.

Cap: soft limit of 8 simultaneous agents (UX clarity); hard limit configurable.

**No system-style taskbar/dock for JARVIS itself.** The OS has its own taskbar — JARVIS doesn't compete. The Agent Activity panel + the floating pebble are the entirety of JARVIS's persistent on-screen presence; everything else appears on demand as native windows.

---

## 7. Awareness — first-class but quiet

- Pebble shows a subtle eye glyph when OCR/awareness is firing.
- One-click privacy toggle in pebble (long-press or right-click): blinds JARVIS instantly.
- Mouse-control visualization: when JARVIS moves the cursor, the pebble briefly shows a "controlling" state with a connector line.
- "Where's my mouse?" / "What's on my screen?" answered inline in the bubble (no window needed).

---

## 8. Migration strategy

### 8.1 Coexistence

The current dashboard at `localhost:3142` **stays operational** through the entire transition as a fallback / debug surface. The ambient UX is shipped behind a flag (`JARVIS_AMBIENT_UI=1`). Both can run simultaneously during dogfood.

### 8.2 Sequence of wins

We migrate in priority order — least dependency first, highest demo value last:

1. **Pebble idle + listen + thread bubble** (no windows yet) — proves the loop.
2. **Settings window** as the first native panel — small, low-stakes panel to validate the pipeline.
3. **Workflows window** — biggest, most valuable, hardest. Once this works, the model is proven.
4. **Remaining 10 rooms** in batches.
5. **Agent strip + background agents UX.**
6. **Awareness eye + privacy toggle.**
7. **Polish + multi-monitor + state persistence.**

### 8.3 What dies, what survives

| Element | Fate |
|---|---|
| `localhost:3142` dashboard | **Lives** as fallback / debug, but not the default user experience |
| AppShellV2 (Thread + Rail + Composer single-window layout) | Becomes the "Thread window" — same component, native window host |
| Hash-based v2 router | Replaced by sidecar-driven panel routing |
| All 12 room components | **Live unchanged** — re-hosted in native windows |
| Onboarding flow | **Lives unchanged** — runs once in a spawned window on first launch |
| Voice / Rail / Composer | **Live** as the pebble's expand-in-place bubble + spawned thread window |
| Personality engine, Vault, Authority, Workflows engine, Goals, Awareness, Sidecar everything else | **Untouched** |

---

## 9. Multi-week milestones

> Each week ends with a demoable artifact. Milestones are **vertical slices**, not horizontal layers.

### Week 1 — Architecture spike + pebble v0 (in progress, see [AMBIENT_UX_WEEK1.md](./AMBIENT_UX_WEEK1.md))
- ✅ webview/webview_go on Win/mac/Linux
- ✅ Sidecar panel service: cross-platform interface, registry, RPC handlers (`panel.spawn/close/focus/list`)
- ✅ Platform shims: Win32 / Cocoa / GTK3 (frameless, always-on-top, click-through, transparent)
- ✅ Multi-entry bundle: dashboard + standalone pebble
- ✅ Pebble component in riso style (Inter Tight + Fraunces + JetBrains Mono, vermilion accent, paper-toned, hard offset shadows)
- ✅ Cursor-follower physics with lock-on-summon (listening + speaking lock; thinking follows)
- ✅ Summon: Ctrl/Cmd+click chord; dismiss: Esc; design matches dashboard
- ✅ Daemon spawn behind `JARVIS_AMBIENT_UI=1` — `src/sidecar/manager.ts` exposes `onSidecarConnected/Disconnected`; `src/daemon/index.ts` calls `panel.spawn` on any sidecar with the `windows` capability
- ✅ Cross-platform smoke test on Win11 (native window, frameless, always-on-top, paper background, pebble follows cursor inside window) — macOS/Linux verification pending physical access to those OSes

**Week 1 demo achieved:** `JARVIS_AMBIENT_UI=1 bun run start` produces a small frameless always-on-top floating pebble window at (100, 100) — paper-coloured, riso aesthetic, pebble follows cursor when cursor is inside the window, Ctrl+click summons the bubble.

**Week 1 limitations explicitly carried into W2:**
- Pebble doesn't follow cursor *across the whole screen* yet — it only tracks cursor while the cursor is inside the small window. True ambient behaviour needs native cursor polling + `SetWindowPos` per frame in the sidecar panel runtime.
- No transparent background — WebView2's controller-level `DefaultBackgroundColor` API isn't exposed by `webview_go`; needs custom binding or upstream PR.
- No click-through — once enabled, the OS strips mouse events from the window entirely, so the in-page pebble can't react. W2 will solve this with region-based click-through (bubble grabs clicks, rest of window passes them through) or with native cursor polling that moves a tiny click-grabbing window directly under the cursor.
- No global hotkey — Ctrl+click only works inside the window. W2 needs OS `RegisterHotKey` / `NSEvent global monitor` / xcb hotkey for true ambient summon.

### Week 2 — Voice loop + thread bubble + lock-on-summon
- Wire wake-word + hotkey to pebble state changes
- **Lock-on-summon**: pebble stops following cursor while in listening/thinking/speaking states; resumes on dismiss
- Streaming LLM call from daemon → pebble (text appears live in bubble)
- TTS streaming → pebble shows speaking state
- `Esc` to dismiss; click-outside-300ms to dismiss
- Cross-platform validation: tested on Win11, macOS, one Linux distro (Ubuntu/GNOME)

**Demo:** "Hey JARVIS, what time is it?" → bubble shows answer with clickable buttons that stay put, TTS speaks it.

### Week 3 — Window service + first panel (Settings)
- Sidecar adds `window.spawn` / `window.close` / `window.focus` RPC
- Refactor dashboard router so `/_room_settings` is a standalone entry
- WebView2 loads the Settings panel in its own window
- Window has Win11 chrome (drag, traffic lights)
- Position/size persistence

**Demo:** "Hey JARVIS, open settings" → real Windows window appears with Settings inside.

### Week 4 — All rooms spawnable + Cmd+K palette
- Refactor every room to standalone-mountable
- Window catalogue with metadata (default bounds, multi-instance)
- Voice command "open X" wired to the right panel_id
- **Cmd+K / Ctrl+K palette** appears at cursor with searchable room list (carries muscle memory from current dashboard)
- Multi-monitor handling

**Demo:** Hit `Cmd+K`, type "work", hit Enter → Workflows window appears at cursor. Voice-spawn vault, goals, logs back-to-back. Drag, resize, close.

### Week 5 — Background agents ✅ done (see [AMBIENT_UX_WEEK5.md](./AMBIENT_UX_WEEK5.md))

**Pivot from the original "agent strip" plan to Clicky-style per-agent pebbles on a right-edge rail.** Each background sub-agent gets its own colored native overlay docked to the right of the cursor's spawn monitor. Click to expand a paper-card bubble; "open full ↗" spawns a dedicated result panel. Voice "close the X one" / "close all" dismisses. Smart keyword routing picks the right specialist per task.

Ships (Phases A → B → B+ → C):
- ✅ Multi-overlay native Win32 renderer (one HWND per sub-agent, color-coded ring + center dot)
- ✅ Right-edge rail anchoring per spawn monitor (`MonitorFromPoint`)
- ✅ TaskManager lifecycle subscription → spawn/state/close hooks
- ✅ "In the background, X" voice intent → `taskManager.launch()` (skips LLM, ~2s end-to-end)
- ✅ Disc-only `WM_NCHITTEST` click-through (rest of window passes clicks)
- ✅ Click-to-expand paper-card bubble (agent name + task + elapsed + result preview)
- ✅ Vermilion recolor for failed tasks
- ✅ Voice close intent ("close all background agents", "close the amber one", "close the research one")
- ✅ One-shot LLM summary on completion (skipped for <240 char responses)
- ✅ "Open full ↗" button → spawns a dedicated 540×640 `#/_task_<id>` result panel
- ✅ Spawn fly-out animation (sub-pebble eases from cursor → slot)
- ✅ Slot reflow on close (sub-pebbles below the closed one slide up)
- ✅ Keyword-based specialist routing (research/legal/finance/code/etc.)

The original [`AgentStripRoom`](../ui/src/v2/rooms/agentStrip/AgentStripRoom.tsx) survives as a secondary "all-agents" surface but the rail is the daily-driver UX.

**Demo:** "Hey Jarvis, in the background, research three ergonomic keyboards" → colored sub-pebble flies from cursor to right-rail slot 0, pulses while researching, settles when done. Click it → bubble shows the summary. Click "open full ↗" → dedicated panel with the full markdown response. Voice "close all background agents" → all pebbles dismiss.

### Week 6 — Awareness eye + privacy toggle ✅ done

Ships (all four pieces in one slice):
- ✅ **T1 — Eye glyph** next to the disc, pulses vermilion for 800 ms whenever sidecar emits a `screen_capture` event. Debounced — bursts keep it lit continuously. `pebble.set_eye` RPC.
- ✅ **T2 — Long-press blind toggle**. Main pebble drops `WS_EX_TRANSPARENT`; `WM_NCHITTEST` gates clicks to the disc area (~18 px hit radius). `WM_LBUTTONDOWN`/`UP` timestamps: < 500 ms = short-click summon, ≥ 500 ms = long-press → emits `pebble.blind_toggle`. Daemon flips `awareness.enabled` in config (persists), calls `awarenessService.toggle()` in place, dispatches `pebble.set_blinded`, speaks confirmation. Pebble shows struck-through eye when blinded, dims pebble color. State pushed on sidecar reconnect.
- ✅ **T3 — "What's on my screen?" inline Q&A** — extended T9's `NEEDS_SCREENSHOT` regex to catch "what's on my screen", "what am I looking at", "what do you see", "describe my screen", "read my screen". Existing auto-screenshot + `streamMessageWithImage` path delivers the answer to the bubble — no panel spawned.
- ✅ **T4 — Controlling halo** — when the pebble is in `pointing` mode (active during agent-driven `desktop_click` via `point_at`), a vermilion double-ring halo pulses around the disc. Reads as "JARVIS is reaching out" rather than ambient drift.

**Cursor-on-disc freeze bug fix**: when the cursor moves onto the disc, the pebble freezes so the user can click. Originally relied on `WM_NCHITTEST` to clear the freeze, but the OS stops sending hit-test messages once the cursor leaves the window entirely — pebble stayed frozen forever. Paint loop now re-verifies freshness from the live cursor position every frame.

Out of scope for ship (W7 polish candidates):
- Full screen-spanning connector line for mouse control (current halo is enough)
- macOS / Linux ports of long-press detection + eye glyph rendering

**Demo:** JARVIS narrates what user is looking at; long-press the pebble to instantly blind it; eye glyph pulses every awareness tick.

### Week 7 — Polish + dogfood prep
- Animation polish (state transitions, expand-in-place spring)
- Edge cases: dual monitors, DPI scaling, Win + macOS
- State persistence (window positions remembered across restarts)
- Coexistence flag with old dashboard
- Update docs (this file + `architecture.md`)

**Demo:** Daily-driveable build behind `JARVIS_AMBIENT_UI=1`.

### Week 8 (buffer) — Bugfix + cut
- Use it for a week, fix worst issues
- Cut from `refractor/UI_UX_phase2` into demo + PR

---

## 10. Open questions (need decisions)

**Resolved (2026-05-02):**
- ✅ **Tech stack:** webview/webview_go, cross-platform from Week 1.
- ✅ **macOS / Linux scope:** all three platforms from Week 1 (validated each week).
- ✅ **Lock-on-summon:** pebble locks at cursor position while listening/thinking/speaking so bubble buttons stay clickable.
- ✅ **Cmd+K palette:** full searchable room palette anchored at cursor, same shortcut as current dashboard.

**Still open:**

1. **Pebble at idle for >30s:** park bottom-left (current default), follow cursor always, or hide entirely with a hotkey-only summon?
2. **Old dashboard fate:** keep at `localhost:3142` indefinitely as debug surface, or full sunset by end of Phase 2?
3. **Agent count cap:** soft limit 8 OK, or unlimited?
4. **Onboarding flow:** spawn as one big window on first launch, or break into a guided sequence of small windows?
5. **Pebble in fullscreen apps (games, video):** should it auto-hide? Pause awareness? User-configurable?
6. **Multi-instance windows (workflows, content):** allow N copies, or always reuse the existing window?
7. **Linux desktop fragmentation:** which compositors do we test/support? GNOME + KDE only, or also Sway/i3/Hyprland?

---

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| WebView2 + transparent + click-through is flaky on Win10 (vs Win11) | Medium | Drop Win10 support for ambient UI; keep dashboard fallback for Win10 users |
| Pebble follow-cursor latency feels off / nausea-inducing | Medium | A/B test follow-factor; offer "static bottom-left" mode |
| Refactoring 12 rooms to standalone breaks something | Medium-high | One room per week, regression test each, dashboard fallback stays |
| Cross-platform WebView abstraction balloons in scope | High | Ship Win11-only week 1–4; mac in week 5+; Linux defer |
| Voice latency >1.5s makes ambient feel laggy | Medium | Streaming TTS + faster STT; this may need its own spike |
| Sidecar process memory grows with N WebView2 windows | Medium | Cap windows or share WebView2 environment across them |
| Other contributor disagrees with cursor-follower model | Unknown | Sync on this doc before any code lands |

---

## 12. Definition of done (Phase 2)

Phase 2 ships when:
- [ ] Pebble lives on the desktop and survives reboot _(W7 polish — needs a launch-on-startup item; the binary itself is stable)_
- [x] All 12 rooms spawn as native windows via voice or hotkey _(W4 + T18)_
- [x] Background agents work end-to-end _(W5 — rail surpasses the original strip plan)_
- [x] Awareness eye + privacy toggle visible and functional _(W6)_
- [ ] User can complete every flow they could in the old dashboard, without ever opening `localhost:3142` _(W7 verify)_
- [ ] Daily-driven by the contributors for at least 5 consecutive days without falling back to dashboard _(W7/W8)_
- [ ] Documentation updated (`architecture.md`, this file, README) _(W7)_

---

## 13. Glossary

- **Pebble** — the cursor-following ambient orb. The single visible JARVIS surface at idle.
- **Bubble** — the small expand-in-place thread shown above the pebble for short Q/A.
- **Panel** — a JARVIS feature surface (workflows, vault, etc.) hosted in a native window.
- **Window service** — the new sidecar subsystem that spawns and manages panel windows.
- **Agent strip** — the floating row of background-agent chips above the taskbar.
