# Ambient UX — Week 1 Tickets

**Goal:** A frameless, always-on-top, cursor-following pebble window appears on the desktop, spawned by the Go sidecar via the new panel service. Clicking it toggles a fake "listening" state. No LLM yet. Cross-platform validated on Windows / macOS / Linux.

**Branch:** `refractor/UI_UX_phase2`
**Estimated effort:** 5 working days
**Definition of done:** see end of doc

## Progress

| # | Ticket | Status |
|---|---|---|
| T1 | webview_go dep + cross-platform prereqs in README | ✅ done |
| T2 | Panel service scaffold (interface + types + registry + CapWindows) | ✅ done |
| T3 | Platform shims (Win32 / Cocoa / X11) for window flags | ✅ done |
| T4 | RPC handlers panel.spawn/close/focus/list + tests | ✅ done |
| T5 | Multi-entry bundle (`pebble.html` + `Pebble.tsx` placeholder) | ✅ done |
| T6 | Port full pebble component from mockup | ✅ done |
| T7 | Daemon spawns pebble at startup behind flag | ✅ done |
| T8 | Cross-platform smoke test | ✅ done (Win11 verified · macOS/Linux pending) |

---

## Prerequisites (do these before T1)

| What | Win11 | macOS | Linux (WSL/Ubuntu) |
|---|---|---|---|
| WebView runtime | WebView2 (pre-installed Win11) | WKWebView (system) | WebKitGTK 4.1 — `apt install libwebkit2gtk-4.1-dev` |
| C compiler | mingw (or MSVC) — Go's CGO | clang (xcode CLT) | gcc — `apt install build-essential pkg-config` |
| Go | 1.23+ ✅ | 1.23+ ✅ | 1.23+ ✅ |
| Bun | 1.3+ ✅ | 1.3+ ✅ | 1.3+ ✅ |

> **WSL note:** WebKitGTK runs but the pebble will appear on the WSL X server, not Windows directly. For real-world dev, build for Windows and test natively on Win11. WSL is fine for unit tests + CI.

---

## T1 — Add webview_go dependency + verify cross-platform prereqs

**Files:** `sidecar/go.mod`, `sidecar/go.sum`, `sidecar/README.md`

```bash
cd sidecar
go get github.com/webview/webview_go@latest
```

Add a "Building the panel service" section to `sidecar/README.md` listing the prereqs above per platform. Smoke test that `go build ./...` still passes (without using webview yet).

**Acceptance:** `go build ./...` passes on at least one platform; README updated.

---

## T2 — Scaffold panel service (cross-platform interface)

**New files:** `sidecar/panels.go`

```go
// sidecar/panels.go
package main

import "sync"

type PanelID string

type PanelBounds struct {
  X, Y, W, H int
}

type PanelSpec struct {
  ID            PanelID      `json:"id"`             // empty → auto-assign UUID
  URL           string       `json:"url"`            // file:// or app:// or http://
  Title         string       `json:"title"`
  Bounds        PanelBounds  `json:"bounds"`
  Frameless     bool         `json:"frameless"`
  AlwaysOnTop   bool         `json:"always_on_top"`
  ClickThrough  bool         `json:"click_through"`
  Transparent   bool         `json:"transparent"`
  Resizable     bool         `json:"resizable"`
  // Multi-instance: if false, spawning a panel with an ID that's already
  // open will focus the existing one instead of creating a new one.
  MultiInstance bool         `json:"multi_instance"`
}

type PanelService interface {
  Spawn(spec PanelSpec) (PanelID, error)
  Close(id PanelID) error
  Focus(id PanelID) error
  List() []PanelID
  Stop()
}

// In-memory registry implementation lives here; platform-specific window
// flag application lives in panels_<os>.go.
```

**Edits:** `sidecar/types.go` — add `CapWindows SidecarCapability = "windows"`.
**Edits:** `sidecar/handlers.go` — register handlers under `caps[CapWindows]` (placeholder until T4).

**Acceptance:** Compiles. New cap registered. No behavior yet.

---

## T3 — Platform shims for window flags

**New files:**
- `sidecar/panels_windows.go` (build tag `//go:build windows`)
- `sidecar/panels_darwin.go` (build tag `//go:build darwin`)
- `sidecar/panels_linux.go` (build tag `//go:build linux`)

Each implements:

```go
// applyPlatformFlags is called after the webview window is created with the
// raw native handle. It sets always-on-top, click-through, transparency, and
// frameless flags using OS-specific APIs.
func applyPlatformFlags(handle uintptr, spec PanelSpec) error
```

| Platform | Always-on-top | Click-through | Transparent | Frameless |
|---|---|---|---|---|
| Win11 | `SetWindowPos(HWND_TOPMOST)` | `SetWindowLong(GWL_EXSTYLE, ...|WS_EX_TRANSPARENT|WS_EX_LAYERED)` | `SetLayeredWindowAttributes(LWA_ALPHA)` | `SetWindowLong(GWL_STYLE, ...&^WS_OVERLAPPEDWINDOW)` |
| macOS | `NSWindow.level = .floating` | `setIgnoresMouseEvents(true)` | `setOpaque(false)` + `backgroundColor=clear` | `NSWindowStyleMaskBorderless` |
| Linux X11 | `_NET_WM_STATE_ABOVE` | `XShapeCombineRectangles(ShapeInput)` empty region | `_NET_WM_BYPASS_COMPOSITOR=2` + alpha visual | `_NET_WM_WINDOW_TYPE_DOCK` |
| Linux Wayland | layer-shell `wlr-layer-shell` (top layer) | layer-shell input region empty | EGL alpha context | layer-shell handles it |

**Acceptance:** Each file compiles on its target. Stub returns no-op error if running on wrong OS.

---

## T4 — RPC handlers: panel.spawn / close / focus / list

**Edits:** `sidecar/handlers.go`, `sidecar/handlers_test.go`

```go
// in NewHandlerRegistry, behind caps[CapWindows]:
registry["panel.spawn"]  = makePanelSpawnHandler(svc)
registry["panel.close"]  = makePanelCloseHandler(svc)
registry["panel.focus"]  = makePanelFocusHandler(svc)
registry["panel.list"]   = makePanelListHandler(svc)
```

Each handler unmarshals `params` into a `PanelSpec` (or just `PanelID`), calls the service, returns `*RPCResult`. Tests:
- `panel.spawn` happy path returns id
- `panel.spawn` with missing url → error
- `panel.close` with unknown id → error
- `panel.list` returns spawned panel ids

Use a fake `PanelService` in tests so we don't actually open windows in CI.

**Acceptance:** All tests pass. Coverage of new handlers ≥80%.

---

## T5 — Multi-entry standalone ambient UI bundle

**Note:** the project uses **Bun's bundler** (not Vite). Multi-entry is just multiple HTML args.

**Edits:** `package.json` build:ui script, new `ui/pebble.html`, new `ui/src/ambient/{Pebble.tsx, pebble.tsx, pebble.css}`.

```jsonc
// package.json
"build:ui": "bun build ui/index.html ui/pebble.html --outdir ui/dist"
```

`ui/pebble.html` is minimal — single root div + `<script type="module" src="./src/ambient/pebble.tsx">`. No router, no AppShell. The pebble bundle should be <100 KB.

**Acceptance:** `bun run build:ui` produces both `dist/index.html` and `dist/pebble.html` with separate JS chunks. Pebble chunk is small (no dashboard code).

---

## T6 — Port pebble component from mockup to React

**New files:**
- `ui/src/ambient/Pebble.tsx` — the pebble component (cursor-follower, state machine, lock-on-summon, expand-in-place bubble)
- `ui/src/ambient/pebble.tsx` — entry point, mounts `<Pebble />` into root
- `ui/src/ambient/pebble.css` — styles ported from mockup

Port from `docs/mockups/ambient-ux/06-pebble-os.html`:
- State machine: `idle | listening | thinking | speaking | working`
- Cursor-follower with eased physics (~0.10 follow factor)
- Lock-on-summon (states `listening | thinking | speaking` lock pebble at cursor pos)
- Thread bubble above pebble when listening/speaking
- Click pebble → toggles listening (placeholder until LLM wiring in W2)
- `Esc` → returns to idle

Connect WebSocket to daemon for state events (skeleton — no events sent yet, just the connection).

**Acceptance:** `bun run dev` → open `/pebble.html` → pebble follows cursor, click toggles state, Esc resets.

---

## T7 — Daemon spawns pebble at startup (behind flag)

**Edits:** `src/daemon/index.ts`

```ts
if (process.env.JARVIS_AMBIENT_UI === '1') {
  await sidecar.rpc('panel.spawn', {
    id:           'pebble',
    url:          `http://localhost:${dashboardPort}/pebble.html`,
    title:        'JARVIS',
    bounds:       { x: -1, y: -1, w: 200, h: 60 },  // -1 = center cursor
    frameless:    true,
    transparent:  true,
    alwaysOnTop:  true,
    clickThrough: true,
    resizable:    false,
  });
}
```

On daemon shutdown, call `panel.close('pebble')` cleanly.

**Acceptance:** `JARVIS_AMBIENT_UI=1 bun run start` → pebble window appears on desktop, follows cursor, clicking toggles state. Existing dashboard at `:3142` still works.

---

## T8 — Cross-platform smoke test

For each of Win11 / macOS / Linux:

| Check | Pass criteria |
|---|---|
| Pebble appears on startup | Within 2s of daemon ready |
| Follows cursor | Smooth (no stutter), max 50ms lag |
| Click toggles listening | Visible state change |
| Esc returns to idle | Pebble unlocks, follows cursor again |
| Click-through when idle | Can click items behind the pebble |
| Always-on-top | Pebble visible over a fullscreened browser window |
| No memory leak | Resident memory stable over 10 min |

Document findings in new file `docs/AMBIENT_UX_PLATFORM_NOTES.md` per OS. Any failures get follow-up tickets in W2.

**Acceptance:** Pass on Win11 + macOS. Linux pass-or-document-known-issues acceptable for W1.

---

## Dependency graph

```
T1 (deps + prereqs)
  └─ T2 (scaffold)
       ├─ T3 (platform shims)
       └─ T4 (RPC handlers + tests)

T5 (vite multi-entry)
  └─ T6 (pebble React)

T3, T4, T6  ──→  T7 (daemon spawn)  ──→  T8 (smoke test)
```

T1, T5 can run in parallel. T2 unblocks T3+T4 (parallel after T2).

---

## Week 1 Definition of Done

- [ ] All 8 tickets `completed`
- [ ] `go build ./... && go test ./...` passes in `sidecar/` on Linux + Win11 + macOS
- [ ] `bun run build` in `ui/` produces both dashboard + pebble bundles
- [ ] `JARVIS_AMBIENT_UI=1 bun run start` produces a working pebble on at least Win11
- [ ] No regressions to existing dashboard (`localhost:3142` still loads)
- [ ] `docs/AMBIENT_UX_PLATFORM_NOTES.md` created with per-OS findings
- [ ] Demo recording (~30s) showing the pebble follow-cursor + click-to-listen on at least one platform

---

## What week 1 explicitly does NOT do

To keep scope tight, the following are deferred to W2+:
- LLM wiring (pebble's listening state is a placeholder)
- TTS / STT / wake-word
- Cmd+K palette (W4)
- Spawning panels other than the pebble (W3+)
- Awareness eye / privacy toggle (W6)
- Background agent strip (W5)

If any of the above sneaks into a W1 ticket, push it back.
