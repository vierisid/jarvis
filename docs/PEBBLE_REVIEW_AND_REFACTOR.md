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
`panels` "shared runtime + thin per-OS adapter" pattern. A second workstream —
**decoupling sidecar versioning from the brain + a brain↔sidecar compatibility
contract** — was added later and is designed (not yet built) in **§7**.

> **✅ Former release blocker (see §8) — FIXED:** the ambient pebble feature made
> the sidecar a cgo program; CI used to build it with `CGO_ENABLED=0` and failed
> on every platform. The `build-sidecar` job is now a per-OS `CGO_ENABLED=1`
> matrix and a PR-time Go compile gate was added. Linux + Windows-cross verified
> locally; arm64-linux + darwin must still go green on the runners.

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

> **Update — this iteration also implemented §5.1–§5.4** (the native-parity
> bucket), compile-verified on Linux + Windows-cross; macOS is mirrored but
> COMPILE-UNVERIFIED here (no Cocoa SDK). What landed:
>
> - **§5.1 macOS pebble migration — DONE** (mirrors the Linux `ca241e9` shape):
>   `pebble_overlay_darwin.go` removed the NSTimer + C-side easing, added
>   `jarvisPebblePresent(x,y,state,tick,eye,blinded,answerOverflow,text)` on the
>   main queue (keeps the bottom-left Y-flip), `jarvisPebbleSpawn(void)`; the Go
>   adapter embeds `pebbleCore` + implements `pebblePlatform`. macOS `PointAt`
>   now works.
> - **§5.2 sub_pebble + region_select native renderers — DONE (first cut)**:
>   `sub_pebble_overlay_linux.go`/`_darwin.go` (+ `_bridge_*` for the click
>   `//export`) implement `subPebblePlatform` — the colored state disc + slot
>   easing + reflow + disc-click → OnClick. `region_select_linux.go`/`_darwin.go`
>   implement the full snapshot → drag → crop → PNG flow (using the shared
>   `normalizeRegionRect`/`regionDragTooSmall`). The `_other.go` stubs were
>   narrowed to `!windows && !linux && !darwin`. A single shared GTK main loop
>   (`gtk_main_linux.go`) now drives pebble + sub-pebble + region. **Residual:**
>   the sub-pebble expand *bubble* + "open full" button are not drawn on
>   Linux/macOS yet (SetExpanded records state; disc renders) — mirror the bubble
>   math in `sub_pebble_draw_windows.go`.
> - **§5.3 remaining glyphs — DONE**: the eye, blinded strike, and
>   answer-overflow button now render in both the Cairo (Linux) and Core Graphics
>   (macOS) pebble renderers; `jarvisPebblePresent` gained `eye/blinded/
>   answerOverflow` flags.
> - **§5.4 hotkeys — DONE (global hotkeys); input residual**: Linux X11
>   `XGrabKey` listener (`hotkeys_linux.go`) + macOS NSEvent global monitor
>   (`hotkeys_darwin.go`) replace the stubs and are wired into the pebble Spawn
>   (summon + palette). **Residual:** the pebble window is still click-through, so
>   the disc long-press (blind-toggle) and the answer-button click are not yet
>   routed on Linux/macOS — that needs the pebble window to catch input on the
>   disc + button regions (mirror the sub-pebble's input-shape + click bridge).
>
> The original detailed roadmaps below are kept as reference. Items still open:
> the sub-pebble bubble (§5.2 residual), the pebble disc-click/long-press input
> (§5.4 residual), and all macOS runtime verification.

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
pebble_overlay_linux.go     embeds pebbleCore; implements pebblePlatform (GTK)   [migrated; glyphs+hotkeys]
pebble_overlay_darwin.go    embeds pebbleCore; implements pebblePlatform (Cocoa) [migrated; glyphs+hotkeys; UNVERIFIED]

gtk_main_linux.go     single shared GTK main loop (pebble + sub_pebble + region)

sub_pebble_core.go    layout + palette + formatting
sub_pebble_runtime.go subPebbleEntry + runSubPebbleOverlay + subPebbleEaseToSlot
                      + subPebblePlatform interface
sub_pebble_overlay_windows.go  implements subPebblePlatform (GDI)                 [migrated]
sub_pebble_overlay_linux.go    implements subPebblePlatform (GTK/Cairo)           [disc done; bubble TODO]
sub_pebble_overlay_darwin.go   implements subPebblePlatform (Cocoa/CG)            [disc done; bubble TODO; UNVERIFIED]
sub_pebble_overlay_other.go    no-op stub for !windows && !linux && !darwin

region_select.go      min-drag + rect normalization + RegionSelectionService
region_select_windows.go  full GDI overlay                                       [done]
region_select_linux.go    full GTK/Cairo overlay + GdkPixbuf crop                 [done]
region_select_darwin.go   full Cocoa/CG overlay + CGImage crop                    [done; UNVERIFIED]
region_select_other.go    no-op stub for !windows && !linux && !darwin

hotkeys_windows.go    RegisterHotKey                                             [done]
hotkeys_linux.go      X11 XGrabKey listener                                      [done]
hotkeys_darwin.go     NSEvent global monitor                                     [done; UNVERIFIED]

panels.go / panels_runtime.go / panels_<os>.go   the REFERENCE pattern (all platforms)
```

When resuming the native parity work, the open items are: the sub-pebble expand
**bubble** + "open full" button on Linux/macOS (§5.2 residual), the pebble
**disc-click / long-press** input on Linux/macOS (§5.4 residual — needs the
pebble window to catch input on the disc + answer-button regions), and **macOS
runtime verification** of everything (must be checked on a Mac).

---

## 7. Sidecar version decoupling & brain↔sidecar compatibility (IMPLEMENTED)

> Separate workstream added to this iteration. **Implemented** per the design
> below (decisions made explicitly with the repo owner, recorded inline). The
> sub-sections are kept as the rationale of record; what landed:
>
> - **Go:** `sidecar/VERSION` (seeded `1.0.0`), `sidecar/version.go`
>   (`var sidecarVersion = "dev"`), Makefile `-X main.sidecarVersion` from VERSION,
>   `--version` flag, `Version` on `SidecarRegistration` (sent in `client.go`),
>   and `client.go` handling of the brain's `register_rejected` (stop reconnect)
>   / `register_ack` (suggested) control frames.
> - **TS:** `src/sidecar/compat.ts` (`SIDECAR_MIN_VERSION` / `SIDECAR_RECOMMENDED_VERSION`
>   floors + `classifySidecarVersion` + `compat.test.ts`), `version` threaded
>   through `types.ts` (registration, `ConnectedSidecar`, `SidecarRecord`,
>   `SidecarInfo`) + a `version` DB column (schema migration), and the
>   classify→hard-block(`4001`)/suggest/store logic in `manager.ts`'s register
>   branch + `toSidecarInfo`. Dashboard: version + "update available/dev" badge
>   in the v2 `SidecarTab`.
> - **CI:** see §8 — `build-sidecar` rewritten as the cgo matrix, the brain/
>   sidecar release flows decoupled (`sidecar-v*` tag + `classify` job), and PR
>   gates (Go compile/test + VERSION-bump) added to `test.yml`.
> - **README:** "Versioning & updates" subsection under Sidecar Setup.
>
> Seed values: `MIN == RECOMMENDED == 1.0.0` (nothing incompatible yet). Below is
> the original design text.

### 7.1 The problem

Today the sidecar version is **coupled to the brain version and carries no
signal**:
- `release.yml` triggers on `v*` tags and stamps the **brain tag version** onto
  the brain package, all **five** sidecar platform packages, *and* the
  `@usejarvis/sidecar` wrapper. The versions in `sidecar/npm/*/package.json`
  (`0.1.0`) are placeholders overwritten at publish. So publishing brain `v1.0.0`
  also publishes sidecars `1.0.0` even with zero sidecar code changes (and vice
  versa).
- The Go binary has **no embedded version** (release builds use
  `-ldflags "-s -w"`, nothing injected).
- The `register` handshake (`SidecarRegistration` in `sidecar/types.go` /
  `register` in `src/sidecar/types.ts`) sends hostname/os/platform/capabilities
  but **no version**. The brain (`src/sidecar/manager.ts`, the `register` branch
  ~line 532) does **no compatibility check**.
- The sidecar is **not** a brain dependency. It's installed independently on the
  user's machine via **two channels**: `bun install -g @usejarvis/sidecar`
  (npm wrapper → arch package) **or** a native binary from GitHub Releases.
  **Most users use the native binary; npm is the niche** (some Linux users +
  some macOS users who prefer npm over the native installer).

Goal: decouple the two release cadences, make the **sidecar's semver encode
brain-compatibility**, enforce it at runtime, and gate CI so a sidecar code
change without a version bump is blocked.

### 7.2 Decisions (agreed with repo owner)

1. **One sidecar version across all arches** (NOT per-arch). The Go source is
   shared and cross-compiled identically to every arch from one commit, so a
   single `sidecar/VERSION` governs all five platform packages + the wrapper. A
   platform-specific fix bumps the single version and republishes all arches
   (unchanged binaries for the rest — harmless). This keeps the npm wrapper
   mechanism unchanged (single exact-pin version), which dissolves most of the
   "how does each arch know about updates" worry.
2. **Hard-block on major incompatibility.** When a connecting sidecar is below
   the brain's MIN version, the brain **refuses/closes the connection** with a
   clear reason; the sidecar logs "update required" and does not operate. (Not a
   soft alarm — an incompatible sidecar must not run.)
3. **`MIN` and `RECOMMENDED` are brain-owned *floors*, not "the latest sidecar
   version"** (no live npm/GitHub query). The brain declares the *oldest* sidecar
   it is happy with; it never needs to know the newest. This is what keeps the
   releases decoupled without a chicken-and-egg (see §7.3) — a sidecar release
   never forces a brain release.
4. **Dedicated `sidecar-v*` release tag.** Pushing `sidecar-vX.Y.Z` publishes the
   sidecar packages (independent of the brain's `v*`); CI checks the tag matches
   `sidecar/VERSION`.

### 7.3 The compatibility model (how the semver maps to behavior)

Two distinct things — keep them separate (the owner's original framing conflated
them):

- **The sidecar's own semver** (`sidecar/VERSION`), bumped by sidecar-dev
  discipline whenever shipping sidecar code changes:
  - **patch** — internal/bugfix, fully back-compatible with brains it already
    worked with. Update optional.
  - **minor** — new sidecar capability; older sidecars still work but miss it.
  - **major** — breaking protocol/behavior change.
- **The brain's two thresholds** — **brain-owned floors** ("the oldest sidecar
  I'm happy with"), which are what actually get **enforced at runtime**. The
  brain bumps these **only when the brain itself changes** for a compat reason,
  *in the brain release it is already cutting* — it never tracks "the newest
  sidecar":
  - `SIDECAR_MIN_VERSION` — hard floor. Brain dev bumps this when the brain makes
    a change that genuinely breaks older sidecars (→ "major / update **required**").
  - `SIDECAR_RECOMMENDED_VERSION` — "suggest updating if below this." Brain dev
    bumps this when a brain change works-but-is-buggy with older sidecars
    (→ "minor / update **suggested**").

> **Why this avoids a chicken-and-egg with decoupled releases.** If RECOMMENDED
> meant "the latest sidecar version," then every sidecar release would force a
> brain release just to advertise it. By defining it as a *floor the brain owns*,
> a sidecar release (1.3.0) needs **no** brain change — a 1.3.0 sidecar is simply
> `>= RECOMMENDED` → "ok". The brain only bumps the floors when the **brain**
> changes for compat reasons, which is a brain release happening anyway. Net: the
> brain advertises **compat-relevant** updates only; **optional (patch) sidecar
> updates are intentionally NOT nagged about** by the brain (they're optional —
> users get them via `npm update` / GitHub Releases). The runtime handshake stays
> the universal signal for the updates that matter.

On `register`, the brain compares the reported sidecar version:

| Reported sidecar version | Result |
|---|---|
| `>= RECOMMENDED` | OK |
| `MIN <= v < RECOMMENDED` | accept + **"update suggested"** (dashboard badge + sidecar logs a notice) |
| `< MIN` | **hard-block** (close connection, "update required") |
| `"dev"` / unparseable (local dev build) | accept + dev notice, **never block** |

### 7.4 Implementation plan

**A. Sidecar versioning (Go side)**
- New file `sidecar/VERSION` (plain `X.Y.Z`) — the single source of truth.
- New `sidecar/version.go`: `var sidecarVersion = "dev"` (overridden at build).
- Build injects it: `-ldflags "-X main.sidecarVersion=$(cat VERSION)"` in
  `sidecar/Makefile` (local builds) and in the release workflow's
  `go build` step (currently `-ldflags "-s -w"` → add `-X`). Unset = `"dev"`.
- Add `Version string \`json:"version"\`` to `SidecarRegistration`
  (`sidecar/types.go`) and set it in the register send (`sidecar/client.go`).

**B. Brain compatibility (TS side)**
- New `src/sidecar/compat.ts`:
  - `export const SIDECAR_MIN_VERSION = "x.y.z";`
  - `export const SIDECAR_RECOMMENDED_VERSION = "x.y.z";`
  - `classifySidecarVersion(v: string): 'ok' | 'suggested' | 'blocked' | 'dev'`
    using a small semver compare (or the `semver` pkg if already available).
- Extend the `register` type (`src/sidecar/types.ts`) + `ConnectedSidecar` with
  `version`. In `manager.ts`'s `register` branch:
  - read `parsed.version` (default `"dev"`), classify it;
  - `blocked` → send a `register_rejected` control message
    `{ type: 'incompatible', reason, min: MIN, your_version }` then close the WS
    (do **not** `registerConnection`);
  - `suggested`/`ok`/`dev` → register as today, store `version` +
    `updateStatus` on the record so the dashboard + API expose it.
- Sidecar side (`client.go`): handle the `incompatible` close — log a loud
  "sidecar X is incompatible with this brain (needs >= MIN); update required"
  and **stop the reconnect loop** (or long-backoff) so it doesn't hammer; surface
  it to the user (stderr is enough; the user runs the sidecar in a terminal).
  For `suggested`, the brain can include an `update_suggested` field in the
  normal register-ack (add one if there isn't a register-ack yet) so the sidecar
  logs "an update is available (recommended >= RECOMMENDED)".
- Dashboard: the Settings sidecar list (already shows online/os/platform) gains a
  **version column + an "update available/required" badge** from the stored
  status. (`src/daemon/api-routes.ts` sidecar list + the v2 settings room.)

**C. GitHub Actions**
- **PR gate** — new job (in `test.yml` or a new `sidecar-version-check.yml`) on
  `pull_request`: `git diff --name-only origin/<base>...HEAD`; if any **shipping**
  sidecar path changed (`sidecar/**/*.go` excluding `*_test.go`, plus
  `sidecar/go.mod`, `sidecar/go.sum`, `sidecar/helpers/**`) **and**
  `sidecar/VERSION` did NOT change → **fail** with "bump sidecar/VERSION". Gray
  areas to decide when implementing: `sidecar/Makefile`, `sidecar/include/**`
  (cross-compile shim only — probably exclude), comment-only `.go` edits (the
  pragmatic rule is "touch shipping `.go` → bump at least patch").
- **Decouple release** (`release.yml`):
  - Add trigger `tags: ['sidecar-v*']`. A `sidecar-v*` push runs **only** the
    `build-sidecar` + `build-ocr-helper` + `publish-sidecar` jobs, versioned from
    `sidecar/VERSION` (assert `sidecar/VERSION == ${tag#sidecar-v}`), NOT from the
    brain tag. The `go build` step gains `-X main.sidecarVersion=$(cat VERSION)`.
  - The brain `v*` release **stops building/publishing the sidecar**: remove
    `publish-sidecar` (and the sidecar build/ocr jobs) from the brain chain;
    re-point `publish-docker`/`publish-brain` `needs:` accordingly. (Docker image
    bundling the sidecar, if any, should pull a pinned published sidecar version
    rather than building it in the brain release — verify the Dockerfile.)
  - `publish-sidecar`'s "Extract version from tag" / "Prepare platform packages"
    use `sidecar/VERSION` instead of `${RELEASE_TAG#v}`; everything else (the
    per-platform `npm version`, the wrapper `optionalDependencies` `sed`) stays.

**D. The npm wrapper (`@usejarvis/sidecar`) — mechanism unchanged**
- All five platform packages + the wrapper publish at the single `sidecar/VERSION`;
  the wrapper's `optionalDependencies` stay exact-pinned to that one version; npm
  installs only the os/cpu match (as today). No structural change.
- "How users learn about updates":
  - **Compat-relevant updates (suggested/required)** reach **everyone** —
    native-binary users (the majority) and npm users — via the **runtime
    handshake** (§7.3), on every connect. This is the universal signal.
  - **Optional (patch) updates** are deliberately **not** announced by the brain
    (they're optional). npm users get them through normal
    `npm update -g @usejarvis/sidecar` / reinstall; native users via GitHub
    Releases. (Optional nicety, not required: the wrapper's `bin/jarvis-sidecar`
    launcher could do a cached `npm view @usejarvis/sidecar version` and print a
    one-line "update available" — best-effort, must not block startup or fail
    offline.)

### 7.5 Initial values / first cut
- Seed `sidecar/VERSION` at the current effective sidecar version (e.g. `1.0.0`
  if cutting fresh, or whatever the last coupled release stamped).
- Set the brain's `SIDECAR_MIN_VERSION` = that same value (nothing is
  incompatible yet) and `SIDECAR_RECOMMENDED_VERSION` = the same. They diverge
  from each other only as real compat events happen.
- Update README install/versioning notes (the sidecar now versions independently;
  `bun install -g @usejarvis/sidecar` still works).

### 7.6 Files this will touch (checklist for the implementer)
- `sidecar/VERSION` (new), `sidecar/version.go` (new), `sidecar/Makefile`
  (ldflags), `sidecar/types.go` + `sidecar/client.go` (register version).
- `src/sidecar/compat.ts` (new), `src/sidecar/types.ts`, `src/sidecar/manager.ts`
  (classify + hard-block + store), `sidecar/client.go` (handle reject/ack),
  `src/daemon/api-routes.ts` + the v2 settings room (version + badge).
- `.github/workflows/release.yml` (decouple + `sidecar-v*` + ldflags),
  a PR-gate workflow, `README.md`.
- No change needed to `sidecar/npm/*/package.json` structure (versions are
  generated at publish; wrapper pins stay single-version).

---

## 8. The CI sidecar build (cgo) — FIXED

> Was a release blocker (the `build-sidecar` job cross-compiled with
> `CGO_ENABLED=0` and failed on every platform). **Now fixed**, together with §7:
>
> - `release.yml` `build-sidecar` rewritten as the §8.3 per-OS `CGO_ENABLED=1`
>   matrix: linux-x64 native (webkit/gtk + `.pc` symlinks), linux-arm64 on an
>   `ubuntu-24.04-arm` runner, win32-x64 mingw cross from Linux (+ `EventToken.h`
>   shim), darwin arm64/x64 on `macos-latest` (`-target`). Version ldflag added.
> - `test.yml` gained a `sidecar-build` job (linux native `go vet`/`build`/`test`
>   + windows mingw cross-build) so a cgo break is caught on PRs, not at release.
> - **Verified locally here:** linux/amd64 native build + `go test`, and the
>   windows/amd64 mingw cross-build. **Not verifiable here** (must pass on the
>   runners): linux-arm64, darwin arm64/x64. The original finding text follows.

### 8.1 The finding

The ambient pebble feature turned the sidecar into a **cgo** program, but the
release pipeline still cross-compiles it as if it were pure Go. Concretely:

- `release.yml`'s `build-sidecar` job runs, for all 5 platforms on a **single
  `ubuntu-latest`** runner:
  ```
  CGO_ENABLED: "0"
  GOOS=… GOARCH=… go build -ldflags "-s -w" -o jarvis-sidecar …
  ```
- With `CGO_ENABLED=0`, the **cgo** dependencies are excluded, and the build
  **fails on every platform**:
  ```
  github.com/webview/webview_go: build constraints exclude all Go files
  ```
  (Reproduced locally for `linux/amd64`, `windows/amd64`, `darwin/arm64` — all
  fail identically.)
- **Nothing in CI catches this.** `test.yml` only builds the Swift `ocr-helper`
  (on a Mac); the `Dockerfile` does not build the sidecar. So the broken build is
  invisible until a release tag is pushed, at which point `build-sidecar` fails.

Bottom line: **a release of this branch would fail.** The pebble work introduced
native UI (panels = webview; pebble/sub_pebble = GTK/Cairo on Linux, Cocoa on
macOS, WebView2 on Windows) which requires `CGO_ENABLED=1` + per-OS toolchains
and libraries — none of which the current pipeline provides.

### 8.2 The cgo dependency surface (`sidecar/go.mod`)

- `github.com/webview/webview_go` — **cgo**, panels. Needs the system webview:
  **WebView2** (Windows), **WebKitGTK 4.1** (Linux), **WKWebView** (macOS).
- `github.com/gen2brain/malgo` — **cgo** (miniaudio), pebble audio. `dlopen`s the
  OS audio backend at runtime, so **no audio dev headers are needed at build
  time** (a plain cgo C compiler suffices — confirmed: the local Linux build
  worked with only the webkit/gtk deps).
- `github.com/hajimehoshi/go-mp3`, `golang.org/x/image` — pure Go, no cgo.
- The pebble overlays themselves add direct cgo: `pebble_overlay_linux.go`
  (`#cgo pkg-config: gtk+-3.0`), `pebble_overlay_darwin.go`
  (`#cgo … -framework Cocoa …`). `*_windows.go` overlays use `syscall` (no cgo),
  but they share the package with webview, so the whole package is cgo on Windows
  too.

### 8.3 Required build matrix (replace the single CGO=0 cross-compile)

Each platform must build with `CGO_ENABLED=1` on a runner/toolchain that can see
its native UI SDK. Add the §7 version ldflag everywhere:
`-ldflags "-s -w -X main.sidecarVersion=$(cat sidecar/VERSION)"`.

| npm pkg | GOOS/GOARCH | Runner | Toolchain + libs | Notes |
|---|---|---|---|---|
| `linux-x64` | linux/amd64 | `ubuntu-latest` (native) | `libwebkit2gtk-4.1-dev libgtk-3-dev pkg-config build-essential` + symlink `webkit2gtk-4.0.pc`→`-4.1.pc` (and `javascriptcoregtk-4.0.pc`→`-4.1.pc`) | This is exactly what made the local Linux build succeed; sufficient (malgo needs no dev headers). |
| `linux-arm64` | linux/arm64 | an **arm64 Linux runner** (`ubuntu-…-arm`) native, OR amd64 + aarch64 cross-toolchain + multiarch webkit/gtk libs | same libs (arm64) | Native arm64 runner is far simpler than cross-compiling cgo + multiarch apt. |
| `win32-x64` | windows/amd64 | `ubuntu-latest` **cross-compile** (preferred) **or** a `windows-latest` runner | mingw-w64: `CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++` + `CGO_CXXFLAGS=-I$PWD/include CGO_CFLAGS=-I$PWD/include` (the `EventToken.h` shim) | This is the proven `verify-windows.sh` recipe; no Windows runner needed. WebView2 headers are bundled in webview_go; the shim covers the one missing SDK header. |
| `darwin-arm64` | darwin/arm64 | `macos-latest` (native) | Xcode CLT (Cocoa/WKWebView SDK + clang) — already present on the runner | The `ocr-helper` job already runs on `macos-latest`; reuse a Mac runner. |
| `darwin-x64` | darwin/amd64 | `macos-latest` (cross on the Mac) | `CGO_ENABLED=1 GOOS=darwin GOARCH=amd64 CC="clang -target x86_64-apple-macos11"` (or set `-mmacosx-version-min`) | The ocr-helper job already cross-builds both arches on a Mac via `-target`, so the runner supports it. **Cross-compiling darwin cgo from Linux (osxcross) is painful — use a Mac runner.** |

Practical structuring options:
- Keep the matrix but split runners per `os` (matrix `include` with a `runner`
  field + an install step gated on the OS). The two darwin arches can share one
  `macos-latest` job that builds both via `-target`.
- Or: a Linux job (builds linux-amd64 native + win32-x64 via mingw + optionally
  linux-arm64 cross), a separate arm64-linux job, and a macOS job (both darwin
  arches). Either is fine; the constraint is "right SDK on the right runner".

### 8.4 Add a Go build to PR CI (so this never regresses silently)

`test.yml` should gain a **sidecar compile check** so a cgo/build break is caught
on PRs, not at release. Minimum: a Linux job that installs the webkit/gtk deps
and runs `go build ./...` + `go test ./...` in `sidecar/` (native, `CGO_ENABLED=1`).
Optionally add the Windows mingw cross-build (cheap, same runner) and a macOS
`go build` job. (Note: the repo's local pre-commit hook does **not** run Go at
all — see §1 — so CI is the only automated guard.)

### 8.5 How this integrates with §7

§7.4.C already rewrites `build-sidecar` for the decoupled `sidecar-v*` release and
the version ldflag. Fold §8 into that same rewrite: when you restructure
`build-sidecar`, do it as the §8.3 per-OS cgo matrix (not a tweak of the existing
`CGO_ENABLED=0` job). The PR-version-gate (§7.4.C) and the PR-compile-check
(§8.4) can live in the same workflow.

### 8.6 Verifiable here vs not
- Linux native build + Windows mingw cross-build: **verifiable in this dev
  environment** (the toolchains are installed; `verify-windows.sh` proves the
  Windows path).
- linux-arm64 and both darwin arches: **not verifiable here** — must be checked on
  the actual runners (a Mac for darwin; an arm64 runner or QEMU for linux-arm64).
