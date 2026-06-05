# Pebble Feature — Complete Manual Test Guide

> **⚠️ DELETE THIS FILE BEFORE MERGE.** This is a throwaway QA checklist for the
> in-progress ambient "pebble" sidecar work on `fix/pebble-sidecar-auth-binary`.
> It is not product documentation. Companion to
> `docs/PEBBLE_REVIEW_AND_REFACTOR.md` (the design/hand-off doc) — read §5/§7/§8
> there for context on what was built and what is intentionally unfinished.

---

## 0. How to use this guide

- Work top to bottom. Each test has **steps** and an **expected result**; tick
  the box when the expected result is observed.
- **Platform tags** on each test: **[W]** Windows, **[L]** Linux (X11),
  **[M]** macOS. Run the tests tagged for the platform you are on.
- Tests marked **⚠ EXPECTED GAP** exercise something that is deliberately not
  finished this iteration. Confirm the documented behaviour (usually "no crash,
  graceful no-op") — do **not** file these as bugs. The full list is in §11.
- Anything that is **not** an expected gap and fails the expected result is a
  real bug: capture OS + a screen recording + the sidecar terminal logs.
- The sidecar logs to its **terminal** (stderr). Keep it visible the whole time;
  most events print a line (`[pebble] …`, `[sub-pebble] …`, `[region] …`,
  `[wake] …`).

### Verification status going in (what the dev environment could prove)

| Area | Linux | Windows | macOS |
|---|---|---|---|
| Compiles (cgo) | ✅ verified | ✅ verified (mingw cross) | ❌ **unverified — never compiled** |
| Runtime behaviour | ❓ needs this guide | ❓ needs this guide | ❓ needs this guide |

> macOS code is mirrored from Linux but was **never compiled** (no Cocoa SDK in
> the dev box). On a Mac, **expect to fix compile errors first** (see §1.3)
> before any runtime test passes.

---

## 1. Build & install the sidecar

The sidecar is a **cgo** program (webview + GTK/Cocoa/WebView2 + audio). It
canNOT be built with `CGO_ENABLED=0`. Build per platform.

### 1.1 Linux [L]

```bash
# Deps (Debian/Ubuntu shown; Arch: pacman -S webkit2gtk-4.1 gtk3 libx11)
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libx11-dev \
  pkg-config build-essential
# webview_go pins the pkg-config name webkit2gtk-4.0; alias the 4.1 .pc files
for d in /usr/lib/*/pkgconfig; do
  sudo ln -sf "$d/webkit2gtk-4.1.pc" "$d/webkit2gtk-4.0.pc" 2>/dev/null || true
  sudo ln -sf "$d/javascriptcoregtk-4.1.pc" "$d/javascriptcoregtk-4.0.pc" 2>/dev/null || true
done

cd sidecar
CGO_ENABLED=1 go build -ldflags "-X main.sidecarVersion=$(cat VERSION)" -o jarvis-sidecar .
./jarvis-sidecar --version    # must print 1.0.0
```

- [ ] **1.1.a [L]** Build succeeds, `--version` prints `1.0.0`.
- [ ] **1.1.b [L]** Run on an **X11** session (or XWayland). On pure Wayland the
      overlays + global hotkeys won't work (documented gap §11). Check your
      session: `echo $XDG_SESSION_TYPE`.

### 1.2 Windows [W]

Cross-compiled from Linux/WSL with mingw (the proven recipe), or built natively.

```bash
# From the repo on WSL/Linux:
cd sidecar
CGO_ENABLED=1 GOOS=windows CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++ \
  CGO_CFLAGS=-I$(pwd)/include CGO_CXXFLAGS=-I$(pwd)/include \
  go build -ldflags "-X main.sidecarVersion=$(cat VERSION)" -o jarvis-sidecar.exe .
```

- [ ] **1.2.a [W]** `jarvis-sidecar.exe --version` prints `1.0.0`.
- [ ] **1.2.b [W]** Requires the **WebView2 runtime** installed (panels). If
      panels fail to spawn, install the Evergreen WebView2 runtime.

### 1.3 macOS [M] — expect to fix compile errors first

```bash
cd sidecar
CGO_ENABLED=1 go build -ldflags "-X main.sidecarVersion=$(cat VERSION)" -o jarvis-sidecar .
./jarvis-sidecar --version
make build-ocr-helper     # builds the Vision OCR helper (needs Xcode CLT)
```

- [ ] **1.3.a [M]** `go build` succeeds. **If it does not**, the macOS cgo
      (`pebble_overlay_darwin.go`, `sub_pebble_overlay_darwin.go`,
      `region_select_darwin.go`, `hotkeys_darwin.go`) needs fixes — these files
      were written but never compiled. Fix and note every change.
- [ ] **1.3.b [M]** Grant permissions before testing:
      **System Settings → Privacy & Security →**
      - **Accessibility** (global hotkeys won't fire without it)
      - **Screen Recording** (region capture returns black/empty without it)
- [ ] **1.3.c [M]** `--version` prints `1.0.0`.

---

## 2. Brain setup & enrollment

- [ ] **2.a** Start the brain: `bun run dev` (or your usual run). Open the
      dashboard (default `http://localhost:3142`).
- [ ] **2.b** **Settings → Sidecar → Enroll**, name it (e.g. "test-box"), copy
      the `jarvis-sidecar --token <jwt>` command.
- [ ] **2.c** Run that command on the test machine. The sidecar terminal prints
      `Identified as <host> (<os>/<arch>) v1.0.0` and `Connected`.
- [ ] **2.d** Back in **Settings → Sidecar**, the sidecar shows **online** with
      **`v1.0.0`** next to the os/platform (the new version column).
- [ ] **2.e** In Settings, enable the capabilities under test: at least
      **pebble**, **sub_pebble**, **windows** (panels), **awareness**,
      **screenshot**. Save; the sidecar logs `Config reloaded`.
- [ ] **2.f** The pebble overlay appears near the cursor shortly after the
      `pebble` capability is enabled and the sidecar (re)connects.

---

## 3. Pebble — the cursor companion

The pebble is one overlay per machine that follows the cursor. States map to:
`0 idle · 1 listening · 2 thinking · 3 speaking · 4 working`.

### 3.1 Motion & spawn

- [ ] **3.1.a [W][L][M]** **Cursor follow.** Move the cursor around. The pebble
      trails it with smooth eased motion (a lagging companion), settling ~`(40,28)`
      offset from the cursor. No stutter, no teleport.
- [ ] **3.1.b [W][L][M]** **No corner flash on spawn.** Disable then re-enable
      the `pebble` capability (or restart the sidecar). When it reappears it
      should materialise **at the cursor**, not flash from screen `(0,0)` first.
- [ ] **3.1.c [W][L][M]** **Disc-hover freeze.** Move the cursor slowly onto the
      pebble's disc. While the cursor is over the disc, the pebble stops chasing
      (so you can click it). Move away — it resumes following.

### 3.2 States (idle / listening / thinking / speaking / working)

Drive these through the real flow: **summon** the pebble (Ctrl+Space or click,
see §3.4) and speak; the brain walks it through listening → thinking → speaking.

- [ ] **3.2.a [W][L][M]** **Idle** — paper disc, hairline border, a slow
      "breathing" centre dot.
- [ ] **3.2.b [W][L][M]** **Listening** — wider pill with 4 animated waveform
      bars + a bubble reading "listening — go ahead." (accent/vermilion border).
- [ ] **3.2.c [W][L][M]** **Thinking** — small pill with 3 bouncing dots.
- [ ] **3.2.d [W][L][M]** **Speaking** — dark pill + bars; the bubble shows the
      live transcript (dark card, paper text). Bubble height auto-fits the text.
- [ ] **3.2.e [W][L][M]** **Working** — pill with a pulsing amber dot (e.g. while
      a background task runs).
- [ ] **3.2.f [W][L][M]** Bubble text wraps and the card grows for long replies,
      capped (does not overflow the window); short replies = compact card.

### 3.3 PointAt ("click here" gesture)

The LLM can emit `[POINT:x,y:label]` tags to fly the pebble to a screen point.

- [ ] **3.3.a [W][L][M]** Ask JARVIS something that makes it point at a UI
      element (or trigger a flow known to emit a POINT tag). The pebble **flies to
      the target point** (snappier than cursor-follow), shows the label in the
      bubble, then after the duration **restores the prior state + text** and
      resumes cursor-follow.
- [ ] **3.3.b [W][L][M]** Multiple sequential POINT tags hop between targets and
      finally restore the **original** state (not an intermediate one).
- [ ] **3.3.c [W][L]** This previously did nothing off-Windows — confirm it now
      works on Linux. (**[M]** also expected to work after 1.3.)

### 3.4 Summon + palette hotkeys (§5.4)

Defaults: **summon = Ctrl+Space**, **palette = Ctrl+K**.

- [ ] **3.4.a [W]** Press **Ctrl+Space** anywhere. Sidecar logs
      `[pebble] … summon`, an `audio.session_start` fires, the pebble flips to
      listening, mic capture begins.
- [ ] **3.4.b [L]** Same on Linux (X11). Sidecar logs
      `summon hotkey "ctrl+space" registered` at spawn, and pressing it fires the
      summon. If it logs `not registered`, another app already grabbed the combo
      (try a different binding) — note it.
- [ ] **3.4.c [M]** Same on macOS. Requires **Accessibility** permission
      (§1.3.b); without it the listener installs but never fires.
- [ ] **3.4.d [W][L][M]** Press **Ctrl+K**. Sidecar logs `pebble.palette` with
      cursor coords; the brain opens the room-palette panel at the cursor.
- [ ] **3.4.e [W][L][M]** **Close/respawn** stops the hotkeys cleanly (disable
      `pebble` capability; no leftover grab, no crash; re-enable re-registers).

### 3.5 Eye glyph, blinded, answer overflow (§5.3)

- [ ] **3.5.a [W][L][M]** **Eye (awareness firing).** With `awareness` enabled,
      let a screen capture / OCR cycle fire. A small **eye glyph** (lens + iris)
      appears above-right of the disc and the iris **pulses** briefly, then clears.
- [ ] **3.5.b [W]** **Blinded.** Long-press (≥0.5s) the disc → blind toggle. The
      eye turns **muted with a diagonal strike-through** (awareness paused).
- [ ] **3.5.c [L][M]** **Blinded rendering** — confirm the struck-through eye
      *renders* when blinded. **NOTE:** the long-press that *triggers* blind on
      Linux/macOS is an **⚠ EXPECTED GAP** (§11). To see the rendering, trigger
      blind from the brain/dashboard if available, or via the awareness toggle.
- [ ] **3.5.d [W][L][M]** **Answer overflow button.** Ask a question with a long
      answer that won't fully fit the bubble. An **"open full ↗"** button renders
      at the bubble's bottom-right.
- [ ] **3.5.e [W]** Click "open full ↗" → sidecar logs `pebble.open_answer`; the
      brain opens a panel with the full answer.
- [ ] **3.5.f [L][M]** The button **renders**, but **clicking it is an ⚠ EXPECTED
      GAP** (§11 — pebble window is click-through on Linux/macOS). Confirm it
      draws correctly; do not expect the click to work yet.

---

## 4. Sub-pebble rail (background-task indicators)

One small coloured disc per background agent task, docked on the **right edge**,
stacked vertically. Colours: amber, sage, violet, vermilion, mustard, teal.

- [ ] **4.a [W][L][M]** Kick off a background/delegated task. A coloured
      sub-pebble **flies out from the cursor** to its slot on the right rail.
      Sidecar logs `[sub-pebble] spawned id=… color=… slot=…`.
- [ ] **4.b [W][L][M]** Start several tasks. Sub-pebbles **stack** top-down with
      even spacing; each has a distinct colour.
- [ ] **4.c [W][L][M]** **Active pulse.** A running sub-pebble's centre dot
      pulses (faster than the main pebble's idle breath); idle ones sit dim.
- [ ] **4.d [W][L][M]** **Fail recolor.** When a task fails, its disc turns
      **vermilion** (SetColor) without moving.
- [ ] **4.e [W][L][M]** **Reflow on close.** Finish/close a sub-pebble that is
      **not** the bottom one. The ones below **slide up** one slot to fill the gap
      (eased, over ~10 frames). Sidecar logs `[sub-pebble] closed id=…`.
- [ ] **4.f [W][L][M]** **Click a disc.** Sidecar logs `sub_pebble.clicked id=…`;
      the brain reacts (e.g. toggles the expand bubble on Windows / opens detail).
- [ ] **4.g [W]** **Expand bubble.** Clicking opens a paper card to the left with
      the agent name, task line, elapsed counter, and an "open full" button.
- [ ] **4.h [L][M]** **Expand bubble is an ⚠ EXPECTED GAP** (§11). The disc
      renders + click fires the event, but the **card is not drawn** on
      Linux/macOS yet. Confirm the disc + click work; the bubble not appearing is
      expected.
- [ ] **4.i [W][L][M]** **Multi-monitor.** With 2+ displays, a sub-pebble anchors
      to the right edge of the monitor it spawned on (**[L][M]** first cut may use
      the primary/main monitor — note actual behaviour).
- [ ] **4.j [W][L][M]** **Shutdown.** Stop the sidecar (Ctrl+C). All sub-pebble
      windows disappear; no orphaned overlay windows remain.

---

## 5. Region select ("help with this")

A drag-select screen-capture overlay. Trigger it via the brain flow that calls
`region.start_selection` (e.g. the "help with this" voice/chord intent).

- [ ] **5.a [W][L][M]** Trigger region select. The whole screen **dims**; the
      cursor becomes a **crosshair**.
- [ ] **5.b [W][L][M]** Drag a rectangle. The selection area **clears** (live
      screen shows through) with a **vermilion outline**; it updates live as you
      drag.
- [ ] **5.c [W][L][M]** Release. The overlay closes; sidecar logs
      `[region] captured WxH, N PNG bytes`; a `region.captured` event reaches the
      brain and the captured image is used (handed to the LLM).
- [ ] **5.d [W][L][M]** **Cancel paths:** press **Esc**, or **right-click**, or
      do a **tiny drag (<6px)** → overlay closes, `region.cancelled` fires, the
      pebble returns to idle (no stranded "working" state).
- [ ] **5.e [W][L][M]** The captured PNG contains the **pre-overlay** pixels
      (NOT the dim layer or the outline) — open the saved/used image and confirm
      it's clean.
- [ ] **5.f [M]** Needs **Screen Recording** permission (§1.3.b) or the capture is
      black. Retina: confirm the crop is the right region at backing-scale
      resolution.

---

## 6. Panels (native webview windows) — security-sensitive

- [ ] **6.a [W][L][M]** A flow that opens a panel (e.g. open-full answer, a
      dashboard room panel) spawns a **frameless native webview** showing the
      brain page.
- [ ] **6.b [W][L][M]** **JWT auth.** The panel loads authenticated content
      (answers / task detail) over the sidecar's enrollment identity — no 401,
      even with a dashboard token configured.
- [ ] **6.c [W][L][M]** **URL pinning (S2).** The panel only ever navigates to
      pages whose host matches the JWT `brain` claim. (Dev check: a `panel.spawn`
      with a foreign host is rejected by `sanitizePanelURL`; sidecar logs the
      rejection.)
- [ ] **6.d [W][L][M]** **Bounds persistence.** Move/resize a panel; sidecar logs
      `panel.bounds_changed`. Close + reopen the same room → it restores position.
- [ ] **6.e [W][L][M]** **Close tracking (H2).** Close a panel via its window
      chrome. Sidecar emits `panel.closed`; the brain untracks it (no phantom
      panels accumulate — verify the brain's panel inventory shrinks).

---

## 7. Audio / voice loop

- [ ] **7.a [W][L][M]** **Wake word.** With the pebble active, say "**jarvis**".
      Sidecar logs `[wake] …`; an `audio.wake_segment` reaches the brain; the
      pebble transitions to listening.
- [ ] **7.b [W][L][M]** **Summon capture.** Ctrl+Space → speak a command →
      silence. Sidecar streams PCM (`audio.session_end`, "streamed session …").
      The brain transcribes and responds; TTS plays back.
- [ ] **7.c [W][L][M]** **TTS self-wake guard.** While JARVIS is speaking through
      the speakers, the wake word does **not** self-trigger.
- [ ] **7.d [W][L][M]** **Large audio via binary ref.** A long capture (≥256KB
      PCM) is sent as a **separate binary WS frame** (sidecar logs
      `Sending audio.session_end via binary ref (… bytes, ref=…)`), not inline
      base64. The brain still processes it normally.
- [ ] **7.e [W][L][M]** **Privacy.** Confirm full transcripts are **not** printed
      verbatim in the brain logs (redacted).

---

## 8. Sidecar version decoupling & compatibility (§7)

This is the new versioning workstream. Floors ship at `MIN = RECOMMENDED = 1.0.0`.

### 8.1 Handshake — happy path

- [ ] **8.1.a [W][L][M]** A `1.0.0` sidecar connects normally; dashboard shows
      `v1.0.0`, no "update" badge.
- [ ] **8.1.b** **Dev build never blocks.** Build **without** the ldflag
      (`go build .`), so `--version` prints `dev`. Connect it. The brain accepts
      it; dashboard shows a **"dev build"** note; it is never blocked.

### 8.2 Compatibility classifier (drive with temporary floor edits)

To exercise the non-trivial branches, temporarily edit
`src/sidecar/compat.ts` and restart the brain (revert after).

- [ ] **8.2.a Blocked (update required).** Set `SIDECAR_MIN_VERSION = '2.0.0'`.
      Restart brain. Connect the `1.0.0` sidecar. **Expected:** brain refuses —
      logs `Rejecting sidecar … version 1.0.0 < required 2.0.0`; the WS closes
      (code 4001); the **sidecar** prints the loud `INCOMPATIBLE … update
      required` banner and **stops reconnecting** (no hammering). Revert.
- [ ] **8.2.b Suggested (update available).** Set `SIDECAR_RECOMMENDED_VERSION =
      '2.0.0'` (leave MIN at `1.0.0`). Restart brain. Connect the `1.0.0`
      sidecar. **Expected:** it connects; sidecar logs `An update is available
      (recommends >= 2.0.0…)`; dashboard sidecar row shows **"update available"**
      (warn colour). Revert.
- [ ] **8.2.c Unit cover.** `cd <repo> && bun test src/sidecar/compat.test.ts`
      passes (parse, compare, classify incl. prerelease).

### 8.3 Reconnect behaviour

- [ ] **8.3.a** After a **blocked** rejection (8.2.a), confirm the sidecar does
      **not** retry in a tight loop — it logs "Not reconnecting" and idles/exits.
- [ ] **8.3.b** A normal disconnect (kill the brain, restart it) still
      reconnects with backoff as before (regression check).

---

## 9. CI / release plumbing (§7C + §8) — repo-level, no device needed

Run these as a reviewer on the branch / a draft PR.

- [ ] **9.a Go PR gate.** Open a draft PR. The `Tests` workflow runs a
      **`sidecar-build`** job (Linux native cgo `go vet`/`build`/`test` +
      Windows mingw cross-build). It must pass.
- [ ] **9.b Version-bump gate.** In a scratch PR, edit a shipping file
      (`sidecar/client.go`) **without** bumping `sidecar/VERSION` →
      `sidecar-version-gate` **fails** with "bump sidecar/VERSION". Then bump
      `sidecar/VERSION` → it **passes**. Editing only `*_test.go` or
      `sidecar/include/**` does **not** require a bump.
- [ ] **9.c Sidecar release (dry run).** Actions → **Release** → Run workflow
      with `dry_run = true`, `tag = sidecar-v1.0.0-test.1`. The `classify` job
      tags it **sidecar**; only `build-sidecar` (5-arch cgo matrix) +
      `build-ocr-helper` + `publish-sidecar` (+ sidecar GH release) run; brain
      jobs are **skipped**. `publish-sidecar` asserts the tag == `sidecar/VERSION`.
- [ ] **9.d Brain release (dry run).** Run with `tag = v9.9.9-test.1`. Only
      `build-docker` / `publish-brain` / `publish-docker` / `github-release` /
      `discord-notify` run; **no sidecar jobs**. Docker image does not bundle the
      sidecar.
- [ ] **9.e Version mismatch fails.** Dry-run a sidecar release with a tag that
      does **not** match `sidecar/VERSION` (e.g. `sidecar-v9.9.9`) →
      `publish-sidecar` fails at "Resolve + verify sidecar version".
- [ ] **9.f Build matrix is cgo.** Confirm `build-sidecar` uses
      `CGO_ENABLED=1` per-OS (linux native, linux-arm64 runner, windows mingw,
      darwin on `macos-latest`) — not the old single `CGO_ENABLED=0` job.

---

## 10. Cross-platform regression sweep (§5.0)

Quick "did the shared-runtime migration regress anything" pass — run the core
loop end to end on **each** platform you can:

- [ ] **10.a [W]** Windows: 3.1 + 3.2 + 3.4 + 4 + 5 all behave as before the
      refactor (Windows was the reference; it must not have regressed).
- [ ] **10.b [L]** Linux: full pebble loop (follow, states, PointAt, hotkeys,
      glyphs), sub-pebble rail, region select.
- [ ] **10.c [M]** macOS: same, after the 1.3 compile-fix pass. Pay special
      attention to **on-screen position** (the bottom-left ↔ top-left Y-flip is
      the single most likely thing to be wrong on macOS — if the pebble is
      mirrored vertically or offset, that's the flip in `jarvisPebblePresent`).

---

## 11. Known gaps / expected "failures" — DO NOT file these

These are intentionally unfinished this iteration (see
`PEBBLE_REVIEW_AND_REFACTOR.md` §5.2/§5.4). Confirm the **graceful** behaviour;
they are not bugs.

1. **[L][M] Pebble disc input** — the pebble window is click-through on
   Linux/macOS, so **disc long-press (blind toggle)** and **answer "open full"
   click** do nothing. Glyphs still *render*; global hotkeys still work.
2. **[L][M] Sub-pebble expand bubble** — the click fires `sub_pebble.clicked`
   but the **detail card + "open full" button are not drawn**. Disc + click work.
3. **[L] Wayland** — overlays and X11 global hotkeys require an **X11/XWayland**
   session. On native Wayland the pebble may not show / hotkeys won't grab.
4. **[M] Permissions** — without **Accessibility** (hotkeys) and **Screen
   Recording** (region capture) grants, those silently no-op.
5. **[M] Everything is compile-unverified** — a clean `go build` on a Mac is the
   first milestone; expect to fix cgo before runtime testing.
6. **[L][M] Multi-monitor sub-pebble anchor** — first cut may anchor to the
   primary/main monitor rather than the spawn monitor.

---

## 12. Sign-off

| Platform | Built | Pebble | Sub-pebble | Region | Panels | Audio | Version (§8) | Tester / date |
|---|---|---|---|---|---|---|---|---|
| Windows  | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |
| Linux/X11| ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |
| macOS    | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |

CI gates (§9): ☐ Go build gate · ☐ version-bump gate · ☐ sidecar release dry-run
· ☐ brain release dry-run.

> When all three platforms are signed off and the residuals in §11 are either
> closed or accepted, delete this file and `PEBBLE_REVIEW_AND_REFACTOR.md` before
> merge.
