# Pebble Review & Refactor — Iteration Hand-off

> **⚠️ DELETE THIS FILE BEFORE MERGE.** It is a working hand-off document for an
> in-progress development iteration on the ambient "pebble" sidecar, not product
> documentation. It captures the review that was performed, the changes that
> were landed, and — in detail — the work that still remains (especially the
> macOS and Linux native renderers) so the iteration can be resumed later with
> full context.

Branch: `fix/pebble-sidecar-auth-binary` (off the ambient-pebble feature branch).
Scope of this iteration: review the pebble sidecar work across four axes
(context, abstraction philosophy, security, correctness), fix what was found,
and begin bringing pebble / sub_pebble / region_select in line with the
`panels` "shared runtime + thin per-OS adapter" pattern.

---

## 1. System context (for whoever resumes this)

- **Brain** = the TypeScript daemon in `src/` (Bun). **Sidecar** = the Go client
  in `sidecar/`. They talk over a single WebSocket authenticated with an **ES256
  JWT** (`docs/sidecar/SIDECAR_AUTHENTICATION.md`). The guiding principle: *all*
  sidecar↔brain traffic rides that authenticated socket; no unauthenticated
  side channels.
- **Ambient pebble feature** (the thing under review) adds:
  - **pebble** — a small cursor-following native overlay (one per machine).
  - **sub_pebble** — a right-edge rail of colored discs, one per background agent
    task.
  - **region_select** — a drag-select screen-capture overlay ("help with this").
  - **panels** — native frameless webview windows for dashboard rooms.
- **Platform split convention** (`sidecar/README.md`): shared business/layout/
  animation logic lives in suffix-less `.go` files; only thin per-OS adapters
  live in `_windows.go` / `_linux.go` / `_darwin.go` / `_other.go`, each exposing
  identical signatures. `panels` is the **reference implementation** of this:
  `panels.go` + `panels_runtime.go` own the shared spawn/follow/lifecycle loop,
  and each `panels_<os>.go` implements a fine-grained `platformXxx()` contract.

### Building & verifying (important — non-obvious)

- **Linux** builds natively: `cd sidecar && go build ./... && go test ./...`
  (needs `webkit2gtk-4.1`, `gtk3` + the `webkit2gtk-4.0.pc` symlink — see
  `sidecar/README.md`).
- **Windows** can be cross-compiled from Linux/WSL with the mingw-w64 toolchain
  (`pacman -S mingw-w64-gcc`) + the bundled `sidecar/include/EventToken.h` shim
  (a WebView2 SDK header mingw lacks). The exact recipe lives in a **gitignored**
  `sidecar/verify-windows.sh` (kept out of the repo on purpose — it's a
  developer-machine dependency). It runs `go vet` + `go build` with:
  ```
  CGO_ENABLED=1 GOOS=windows CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++ \
    CGO_CXXFLAGS=-I$(pwd)/include CGO_CFLAGS=-I$(pwd)/include go build .
  ```
- **macOS** CANNOT be compiled in the Linux/WSL dev environment (no Cocoa SDK,
  not cross-compilable). All macOS changes in this iteration are therefore
  **compile-unverified** and must be checked on a Mac.
- The repo's pre-commit hook runs the **TypeScript** test suite + typecheck only.
  It does **not** run `go test` — that is intentionally left to whoever touches
  sidecar code. Two Go test breakages this iteration were only caught once the Go
  toolchain was wired up locally; **run `go test ./...` (Linux) and the Windows
  cross-build manually** after sidecar changes.

---

## 2. Initial analysis (what the review found)

### 2a. Abstraction philosophy

`panels` follows the philosophy well. **`pebble`, `sub_pebble`, `region_select`
did not**: their suffix-less files were *interface headers only* — 100% of the
geometry / layout / animation / state-machine / color / product-copy logic lived
inside `_windows.go` (and, for pebble, was **re-copied** into hand-written
Objective-C / C inside `_darwin.go` / `_linux.go`). Concrete divergence had
already begun: the `0.18` cursor-follow factor was hardcoded separately in
Windows Go, macOS Obj-C, and Linux C; default cursor offsets had drifted
(`28,32` Windows vs `22,26` mac/linux).

Coverage gaps: **`sub_pebble` and `region_select` are Windows-only** (only
`_windows.go` + `_other.go` no-op stubs). The whole sub-agent rail and the
region-capture flow do nothing on macOS/Linux. The pebble compiles everywhere
but `PointAt`/`SetEye`/`SetBlinded`/`SetAnswerOverflow`/`OnPalette`/
`OnBlindToggle`/`OnAnswerOpen` were nil/no-op stubs off Windows.

Top recommendations (review numbering, referenced throughout):
1. Extract a shared "pebble core" (constants + state + layout/animation policy).
2. Adopt the `panels` `platformXxx()` pattern for pebble + sub_pebble (shared
   loop, thin per-OS draw/window primitives).
3. Move product/UX decisions (copy, palette, formatting, thresholds) to shared.
4. Close platform-coverage gaps (implement linux/darwin for sub_pebble +
   region_select; complete the pebble stubs).
5. Remove single-instance package globals from the pebble adapter.

### 2b. Security

JWT discipline was sound (no new local server; all new traffic on the
authenticated WS; JWT never logged or passed to the webview; audio in-memory, no
temp files / shell / path traversal). Findings:

- **S1**: the panel webview's content endpoints (`/api/pebble/answers/:id`,
  `/api/agents/tasks/:id`) were gated by the *dashboard token*, not the sidecar
  JWT — wrong identity for sidecar-consumed routes; and they 401'd when a
  dashboard token was configured (panels failed closed).
- **S2**: the sidecar webview navigated to **any** URL the brain supplied (only
  checked `url != ""`) — a compromised/misconfigured brain could point it at
  arbitrary origins next to the native JS bridge.
- **MED**: full voice transcripts were `console.log`'d (privacy).
- **LOW**: `MAX_JSON_SIZE` was raised 1MB→16MB to fit inline base64 screenshots,
  widening the inbound-frame DoS ceiling.
- Out of scope (brain territory, per repo owner): the dashboard API binding to
  `0.0.0.0` with auth off by default.

### 2c. Correctness

Confirmed real bugs:
- **H1**: per-sidecar state maps (`panelsBySidecar`, `palettePanelBySidecar`,
  `eyeTimers`, `pendingRegionByPebble`, `subPebbleExpanded`/`subPebbleSidecar`,
  `lastPaletteCloseAt`) were never cleaned on disconnect → unbounded growth +
  stale-id dispatch.
- **H2**: panels closed by the user were never untracked (no `panel.closed`
  event) → phantom panels fed to the LLM; `task_full`/`answer_full` panels
  accumulated forever.
- **H3**: the `audio.wake_segment` handler claimed its `pendingSummons` slot only
  *after* an `await transcribe(...)`, so two wake segments could both run a
  response cycle on one sidecar.
- **M1**: staggered `point_at` timers weren't cancelled on dismissal (pebble flew
  around after returning to idle).
- **M3**: `audio.session_end` with a failed inline-binary decode `return`ed after
  deleting the session → the pebble stuck "working", summon slot stranded.
- **M4**: `region.captured` for an unknown/duplicate pebble could either strand
  `pendingSummons` or (with a naive fix) interrupt an in-flight cycle.
- **M5**: a background task's sub-pebble was fanned out to **every** connected
  sidecar, but the reverse maps (`subPebbleSidecar` = `taskId→sidecarId`,
  `subPebbleExpanded` = `taskId→bool`) assume one sidecar per task — internally
  inconsistent, plus `summarizeTaskAsync` ran once per sidecar (redundant LLM
  calls).
- LOW (not fixed; see §5): `answer-store.latest()` O(n) + FIFO-not-LRU; STT
  voice-switch regex fragility; `panel.bounds_changed` not viewport-clamped on
  read; config read-modify-write without locking; pebble webview loads Google
  Fonts from CDN.

---

## 3. The plan

1. **Security**: reshape S1 to authenticate the sidecar-consumed endpoints via
   the **sidecar JWT** (reuse `SidecarManager.validateToken`), delivered by the
   sidecar appending its JWT to the panel URL; S2 → pin panel URLs to the JWT
   `brain` claim host; redact transcripts; reduce `MAX_JSON_SIZE` by routing
   large binaries through the existing ref protocol.
2. **Correctness**: fix H1/H2/H3 and M1/M3/M4/M5 (M2 == the MAX_JSON_SIZE LOW).
3. **Abstraction**: (a) extract shared policy cores (rec #3, #1); then (b) adopt
   the `panels` shared-runtime pattern for sub_pebble and pebble (rec #2),
   verifying on Windows (cross-build) + Linux.
4. Leave the LOW items, the brain-scope security posture, and the large
   net-new native renderers (rec #4) for follow-up, documented here.

---

## 4. Changes made (by commit, newest-last per area)

### Security
- **`5a89482`** — S1+S2 + binary protocol:
  - `src/comms/websocket.ts`: the auth gate now accepts **either** the dashboard
    token **or** a valid sidecar JWT (`validateToken`) on any route, so the panel
    webview authenticates over its enrollment identity.
  - `sidecar/panel_handlers.go`: `sanitizePanelURL()` rejects any `panel.spawn`
    whose host ≠ the JWT `brain` claim host, then appends the sidecar token. Wired
    via `brainURL`/`sidecarToken` threaded through `NewHandlerRegistry`.
  - `src/daemon/index.ts`: panel URLs derive from `pebblePanelOrigin`
    (`buildEnrollmentUrls(brainDomain)` host) instead of hardcoded
    `localhost:<port>`, so the origin check passes for localhost/127.0.0.1/remote.
  - Binary ref protocol: `RPCResult` gained `BinaryRaw`/`BinaryMime`; Go
    `sendResult`/`sendEvent` route ≥256KB payloads through a separate WS binary
    frame (`attachAndSend`); `src/sidecar/connection.ts` normalizes inbound `ref`
    binaries back to an inline-shaped descriptor so consumers are unchanged;
    `MAX_JSON_SIZE` 16MB→2MB. Handlers (`capture_screen`, `fetch_capture`,
    browser) return `BinaryRaw`. Transcript log lines redacted.

### Correctness
- **`2d5ff1f`** — H1 (disconnect cleanup of all per-sidecar maps + `clearTimeout`
  eye timers), H2 (new `panel.closed` event: Go `panels` `OnClosed` callback →
  sidecar emits → `manager.ts` forwards → daemon `untrackPanel`s), H3
  (synchronous `wakeInFlight` guard before the transcribe await).
- **`2fceb3b`** — M1 (track + cancel point-hop timers on dismiss; guard the
  callback with `ctrl.cancelled`), M3 (fall through with empty PCM so the
  completion path resets state instead of stranding).
- **`28a03f1`** — M4 (`regionCycleActive` marker + keep `pendingRegionByPebble`
  alive through the cycle; a duplicate `region.captured` mid-cycle is a no-op, and
  the no-pending branch deliberately does NOT touch `pendingSummons`).
- **`f44d617`** — M5 (single active machine: `activePebbleSidecar` set at
  `runResponseCycle` start; `pickSubPebbleSidecar()` attaches a task's sub-pebble
  to one machine; lifecycle updates route to the recorded owner;
  `summarizeTaskAsync` runs once).
- **`4f06447`** — fixed two Go tests the TS-only pre-commit hook missed
  (`fakePanelService` needed `OnClosed`; `TestFetchCaptureReadsValidPath` needed
  the `BinaryRaw` assertion).

### Abstraction — shared policy cores (rec #1, #3)
- **`100953f`** — `sub_pebble_core.go`: rail layout constants, the accent palette
  (`subPebbleRGB`), `formatSubPebbleElapsed` (+ unit tests).
- **`c2fae70`** — `region_select.go`: `regionMinDragPx` (6), `normalizeRegionRect`,
  `regionDragTooSmall` (+ tests); `finishDrag` rewired.
- **`2b298db`** — `pebble_core.go`: `pebbleFollowFactor` (0.18),
  `pebblePointFollowFactor` (0.42), `pebbleLongPressMs`, `pebbleDiscHitRadius`,
  `pebbleAnchorX/Y`, `defaultPebbleBodyText` (+ tests); Windows wired to them.

### Abstraction — shared runtime pattern (rec #2)
- **`0251ac5`** — sub_pebble: `sub_pebble_runtime.go` owns `subPebbleEntry`, the
  per-overlay run loop, the eased fly-out (`subPebbleEaseToSlot`, using
  `pebbleFollowFactor`), and the `subPebblePlatform` contract
  (`createOverlayWindow`/`pumpMessages`/`paint`/`slotPosition`/`destroyOverlay`).
  Windows implements the primitives; non-Windows keeps the existing `_other.go`
  no-op stub. (+ runtime tests.)
- **`e01befb`** — pebble (Windows): `pebble_runtime.go` owns `pebbleCore` (all
  state), `advanceFrame()` (cursor-follow ease + `[POINT:..]` override state
  machine + disc-hover follow-freeze + frame tick + window position),
  `runPebbleLoop`, and the `pebblePlatform` contract
  (`createWindow`/`pumpMessages`/`present`/`destroyWindow`).
  `pebbleServiceWindows` now **embeds** `pebbleCore` (existing `s.curX`/`s.state`/…
  references promote unchanged). Fixed a one-frame `(0,0)` spawn flash by calling
  `advanceFrame()` before the initial present.
- **`94a63e3`** — added the full macOS + Linux **migration roadmap as comments**
  in `pebble_overlay_darwin.go` / `pebble_overlay_linux.go` (kept them working;
  did not stub).
- **`ca241e9`** — **Linux pebble migrated** onto the shared runtime. C side:
  removed the GTK `tick` timer + its easing; added
  `jarvisPebblePresent(x,y,state,tick,text)` (g_idle_add → move + state + redraw).
  Go side: `pebbleServiceLinux` embeds `pebbleCore`; `runPebbleLoop` drives;
  thin `pebblePlatform` primitives bridge to GTK. Also moved `SetState`/`SetText`/
  `PointAt`/`SetEye`/`SetBlinded`/`SetAnswerOverflow` onto `pebbleCore` (promoted
  to every embedder; Windows copies deleted). **Linux `PointAt` now works**
  (was a no-op) — only the eye/blinded glyphs remain unrendered.

Net: `+1441 / -766` across 32 files. Windows + Linux compile clean; Go + TS test
suites green.

---

## 5. What remains to be done

### 5.0 Verification owed (no new code)
The Windows pebble + sub_pebble shared-runtime migrations and the Linux pebble
migration are **compile-verified only**. They need **visual/runtime testing**:
- Windows: cursor follow smoothness, `[POINT:..]` fly + restore, disc-hover
  freeze (clicking the disc), summon/palette hotkeys, long-press blind toggle,
  eye glyph, blinded dim, "open full" button, spawn at cursor (no corner flash),
  Close/respawn.
- Linux: same, on a GTK/X11 session (note: WSL shows it on the WSL X server).

### 5.1 macOS pebble migration (rec #2) — **NOT compile-verifiable here**

Mirror what was done for Linux in `ca241e9`. The roadmap is already in
`pebble_overlay_darwin.go` (top-of-file `MIGRATION` block + inline
`// MIGRATION (shared runtime):` markers). Concretely:

**Objective-C / cgo side (`pebble_overlay_darwin.go` C block):**
1. **Remove** `gPebbleTimer` (`NSTimer scheduledTimerWithTimeInterval:1.0/60.0…`)
   and the easing + cursor read inside `jarvisPebbleTick` (the
   `gCurX += (tgtX-gCurX)*0.18` block). Remove globals `gCurX`, `gCurY`,
   `gOffsetX`, `gOffsetY`, `gPebbleTimer`. Keep `gPebbleState`, `gFrameTick`,
   `gPebbleBodyText` (the present handler will set them) and `drawRect:`.
2. **Add** `void jarvisPebblePresent(int x, int y, int state,
   unsigned long long tick, const char* text)` that
   `dispatch_async(dispatch_get_main_queue(), ^{ … })`:
   - set `gPebbleState = state; gFrameTick = tick;`
   - replace `gPebbleBodyText` (free old NSString; `[[NSString alloc]
     initWithUTF8String:text]` when non-NULL/empty);
   - `[gPebbleWindow setFrameOrigin:…]` — **KEEP the bottom-left Y-flip**: the
     old tick did `NSMakePoint(gCurX - kAnchorX, screenH - (gCurY - kAnchorY))`
     then subtracted the window height. The shared `advanceFrame()` publishes
     `renderedX/renderedY` already in the **top-left** space that
     `platformGetCursorPos()` returns; macOS windows use a **bottom-left** origin,
     so `jarvisPebblePresent` must convert `y` exactly as the old tick did, just
     fed from the passed `x,y` instead of `gCurX/gCurY`. **Verify
     `platformGetCursorPos` (panels_darwin.go) and the flip agree** — this is the
     single most likely place to get on-screen position wrong.
   - `[gPebbleView setNeedsDisplay:YES];`
3. **Change** `jarvisPebbleSpawn(int,int)` → `jarvisPebbleSpawn(void)` (offset
   now lives in `pebbleCore.spec`; window creation only, no timer). **Remove**
   `jarvisPebbleSetState` / `jarvisPebbleSetText` and their idle impls (present
   pushes state+text each frame).

**Go side:** copy the Linux adapter from `pebble_overlay_linux.go` verbatim,
renaming `pebbleServiceLinux`→`pebbleServiceDarwin` and the GTK init goroutine to
whatever the macOS C bridge needs (the existing darwin code already runs AppKit
on the main thread via `dispatch_async`; confirm `NewPebbleService` doesn't need
to spin its own run loop — AppKit's main runloop must be running for
`dispatch_async(main_queue,…)` to drain. If the process has no NSApplication run
loop yet, present callbacks won't fire; check how the current darwin code keeps
the runloop alive and preserve it). The adapter is:
- embed `pebbleCore`; `NewPebbleService` sets `state=idle`, `bubbleText=""`;
- `Spawn` seeds `curX/curY` from `platformGetCursorPos`, makes `stopCh/doneCh`,
  `go runPebbleLoop(&s.pebbleCore, s)`;
- `createWindow()`→`C.jarvisPebbleSpawn()`; `pumpMessages(){}`;
  `present()`→`C.jarvisPebblePresent(renderedX, renderedY,
  pebbleStateToInt(state), frameTick, cstr)`; `destroyWindow()`→
  `C.jarvisPebbleClose()`;
- `Close()` closes `stopCh`, waits `doneCh`;
- `SetState`/`SetText`/`PointAt`/`SetEye`/`SetBlinded`/`SetAnswerOverflow` are
  **promoted from `pebbleCore`** — do NOT redefine them;
- `OnSummon`/`OnPalette`/`OnBlindToggle`/`OnAnswerOpen` store callbacks (hotkeys
  still stubbed — see 5.4).

After this, macOS `PointAt` works for free; only the eye/blinded/overflow/point
glyphs remain unrendered (5.3).

### 5.2 sub_pebble + region_select native renderers (rec #4) — **net-new feature work**

These features **do not exist at all** on macOS/Linux today (only Windows GDI +
`_other.go` no-op stubs). This is the largest remaining bucket. The shared
scaffolding already exists, so a new platform only implements the contract:

**sub_pebble (Linux GTK — verifiable; macOS Cocoa — not):**
- The shared `sub_pebble_runtime.go` already provides `subPebbleEntry`,
  `runSubPebbleOverlay`, `subPebbleEaseToSlot`, and the `subPebblePlatform`
  interface. The shared layout/palette/formatting is in `sub_pebble_core.go`.
- Write `sub_pebble_overlay_linux.go` (and `_darwin.go`) with: a
  `subPebbleServiceLinux` (multi-instance — a `map[string]*subPebbleEntry`), and
  the 5 primitives: `createOverlayWindow` (a small transparent always-on-top
  GTK window per entry), `pumpMessages` (no-op under gtk_main),
  `paint` (Cairo: colored disc per `subPebbleRGB(color)` + the optional bubble
  card, mirroring `sub_pebble_draw_windows.go`), `slotPosition` (use the shared
  `subPebbleTopMargin`/`subPebbleSlotSpacing`/`subPebbleAnchor*` + a GTK
  monitor-bounds query for the right edge), `destroyOverlay`. `Spawn` launches
  `go runSubPebbleOverlay(entry, svc)`. Reference: the whole
  `sub_pebble_overlay_windows.go` + `sub_pebble_draw_windows.go`.
- The non-Windows build currently uses `sub_pebble_overlay_other.go`
  (`//go:build !windows`) — when adding linux/darwin files, **narrow that build
  tag** (e.g. `!windows && !linux && !darwin`) so the stub doesn't collide with
  the real impls (mirror how `pebble_overlay_other.go` is tagged).

**region_select (Linux — verifiable; macOS — not):**
- Shared `region_select.go` provides `regionMinDragPx`, `normalizeRegionRect`,
  `regionDragTooSmall`, and the `RegionSelectionService` interface.
- Write `region_select_linux.go` (and `_darwin.go`): a fullscreen translucent
  overlay that (1) snapshots the screen pre-overlay, (2) lets the user drag a
  rect (use `normalizeRegionRect` + `regionDragTooSmall` for the min-drag/cancel
  logic), (3) crops + PNG-encodes the selection, (4) fires `onCapture(png,w,h)`;
  Esc/right-click/zero-area → `onCancel`. Reference: `region_select_windows.go`
  (GTK: a fullscreen `GtkWindow` + Cairo draw of the dim + cut-out; X11/Wayland
  screen grab via gdk). Narrow `region_select_other.go`'s `!windows` tag the same
  way.

### 5.3 Extend the Linux/macOS pebble renderers for the remaining glyphs

After 5.1, macOS + Linux pebbles have the *state* for eye/blinded/answer-overflow/
pointing-label but their renderers don't draw them. Extend `draw_pebble` (GTK
Cairo) and `drawRect:` (Cocoa CG) to match the Windows visual set
(`pebble_draw_windows.go` / `pebble_text_windows.go`):
- the eye glyph (driven by `gPebbleState` is wrong — these need new params: pass
  `eye`/`blinded`/`answerOverflow` flags through `jarvisPebblePresent`, read from
  `pebbleCore` in `present()`);
- the struck-through eye when blinded + the dim;
- the "open full ↗" button for the speaking bubble + its hit-testing (Linux/mac
  also need click routing → `OnAnswerOpen`, currently stubbed);
- the pointing label is already handled (PointAt sets `state=listening` +
  `bubbleText=label`, which the existing bubble renders).

Note: when adding eye/blinded/overflow to `present()`, extend
`jarvisPebblePresent`'s signature on **both** Linux and macOS and the Windows
`present()` reads them straight from `pebbleCore` (no signature change there).

### 5.4 Hotkeys + input on Linux/macOS (pre-existing gap, blocks full parity)

`OnSummon`/`OnPalette`/`OnBlindToggle` store callbacks but **nothing fires them**
off Windows (`hotkeys_linux.go` / `hotkeys_darwin.go` are stubs; there's no
GTK/NSView mouse handler for the long-press blind-toggle or the disc click).
Wiring these is required for the ambient flow (wake/summon/palette) to work on
mac/linux. Out of scope of the runtime migration but needed for parity.

### 5.5 Review rec #5 (pebble Windows singleton globals) — **recommend NOT doing**

`pebbleServiceInstance` + `pebbleBlindToggleCallback` + `pebbleAnswerOpenCallback`
are package globals so the free-function Win32 `WndProc` can find the service +
callbacks. The review flagged this as a portability leak. **Assessment after the
refactor: leave it.** The main pebble is a true singleton (one per process,
enforced at spawn), so the global is a reasonable pattern; making it HWND-keyed
(like `subPebbleByHwnd`) adds a hot-path map lookup for cosmetic gain. Revisit
only if multi-pebble-per-process ever becomes real.

### 5.6 LOW correctness / minor items (deferred)
- `src/daemon/answer-store.ts`: `latest()` is an O(n) scan and it's a FIFO, not
  the LRU the comment claims (cap 25 → harmless; tidy if touched).
- `src/daemon/index.ts` STT-provider voice-switch regex relies on a fragile
  second correction block — prefer a single named group.
- `panel.bounds_changed` persists bounds without viewport-clamping on read
  (`window-state.ts` has `clampBoundsToViewport` but `boundsForRoom` doesn't call
  it) → a saved off-monitor position can reopen off-screen on non-Windows.
- `applyTTSEnabled`/`applySTTProvider`/`blind_toggle` do `loadConfig` → mutate →
  `saveConfig` with no locking (last-writer-wins under concurrent voice commands).
- `ui/pebble.html` loads Google Fonts from the CDN — self-host for an
  offline-capable, no-external-origin webview.

### 5.7 Explicitly out of scope (repo-owner decisions)
- Brain-wide unauthenticated API / `0.0.0.0` bind posture with auth off by default
  (brain territory, not this branch).
- `sidecar/include/EventToken.h` — keep it (portable mingw cross-compile shim
  added by the original author; not machine-specific).
- The `docs/AMBIENT_UX_*.md` files committed under "MD File Plan (To be removed)"
  (`7c2bb97`) — flagged by the original author for deletion before merge. **This
  file too.**

---

## 6. Quick map of the shared-runtime architecture (the target)

```
pebble_core.go        constants + default copy (shared policy)
pebble_runtime.go     pebbleCore (state) + advanceFrame (physics/pointing)
                      + runPebbleLoop + pebblePlatform interface
                      + the shared SetState/SetText/PointAt/Set* mutators
pebble_overlay_windows.go   embeds pebbleCore; implements pebblePlatform (GDI)   [migrated]
pebble_overlay_linux.go     embeds pebbleCore; implements pebblePlatform (GTK)   [migrated]
pebble_overlay_darwin.go    still native loop; roadmap in comments               [TODO 5.1]

sub_pebble_core.go    layout + palette + formatting
sub_pebble_runtime.go subPebbleEntry + runSubPebbleOverlay + subPebbleEaseToSlot
                      + subPebblePlatform interface
sub_pebble_overlay_windows.go  implements subPebblePlatform (GDI)                 [migrated]
sub_pebble_overlay_other.go    no-op stub for !windows                            [TODO 5.2]

region_select.go      min-drag + rect normalization + RegionSelectionService
region_select_windows.go  full GDI overlay                                       [done]
region_select_other.go    no-op stub for !windows                                [TODO 5.2]

panels.go / panels_runtime.go / panels_<os>.go   the REFERENCE pattern (all platforms)
```

When resuming: start with **5.1 (macOS pebble migration)** — it's mechanical
given the Linux precedent and unblocks macOS parity; then **5.2** (the net-new
sub_pebble + region_select native renderers) is the bulk of the remaining work.
