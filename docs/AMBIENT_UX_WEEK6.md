# Ambient UX — Week 6: Awareness Eye + Privacy Toggle

**Branch:** `refractor/UI_UX_phase2`
**Status:** ✅ feature-complete (all four pieces in one slice)

---

## TL;DR

Closes the "you can't tell when JARVIS is watching" trust gap. The pebble now shows a small eye glyph that pulses vermilion every time the awareness pipeline takes a screen capture. Long-press the pebble disc to hard-pause awareness (persists across restarts). Voice "what's on my screen?" gets an inline answer in the bubble. When JARVIS is remotely controlling the cursor (agent-driven `desktop_click`), the disc grows a vermilion double-ring halo so the motion reads as deliberate.

---

## Ticket log

| # | Ticket | Status |
|---|---|---|
| **T1 — Eye glyph** | | |
| T1.1 | `eyeActive` atomic bool on main pebble; `pebble.set_eye(active)` RPC | ✅ done |
| T1.2 | `drawEyeGlyph` in `pebble_draw_windows.go` — 8 px oval lens + 1.4 px iris, vermilion when active, pulses 70–100% alpha on a 1.2 s cycle | ✅ done |
| T1.3 | Daemon listens for `screen_capture` events → dispatches `pebble.set_eye(true)` with 800 ms debounce; bursts keep glyph lit continuously | ✅ done |
| **T2 — Long-press blind toggle** | | |
| T2.1 | Drop `WS_EX_TRANSPARENT` from main pebble window so it can catch clicks | ✅ done |
| T2.2 | `WM_NCHITTEST` returns `HTCLIENT` only inside 18 px hit radius of disc anchor (everything else passes through) | ✅ done |
| T2.3 | `WM_LBUTTONDOWN`/`UP` timestamp click — < 500 ms = short-click summon (same as Ctrl+Space), ≥ 500 ms = long-press | ✅ done |
| T2.4 | Long-press fires `OnBlindToggle` callback → emits `pebble.blind_toggle` SidecarEvent | ✅ done |
| T2.5 | `pebble.set_blinded(blinded)` RPC; `blinded` atomic on pebble entry | ✅ done |
| T2.6 | Daemon `pebble.blind_toggle` handler — flips `awareness.enabled` in config (persists), calls `awarenessService.toggle()` in place, dispatches `pebble.set_blinded`, speaks confirmation through queued TTS | ✅ done |
| T2.7 | `drawEyeGlyph` extended — when blinded, paints muted ink-3 eye with diagonal strike-through line | ✅ done |
| T2.8 | Initial blinded state pushed on sidecar connect so visual matches `awareness.enabled` across daemon restarts | ✅ done |
| T2.9 | `pebble.blind_toggle` added to sidecar manager event allowlist | ✅ done |
| T2-fix | **Cursor-on-disc freeze bug** — paint loop now re-verifies `cursorOnDisc` each frame from live cursor position; original logic relied on `WM_NCHITTEST` to clear, but the OS stops sending hit-test messages once the cursor exits the window | ✅ done |
| **T3 — "What's on my screen?" inline Q&A** | | |
| T3.1 | Extended T9's `NEEDS_SCREENSHOT` regex to match: "what's on my screen", "what am I looking at", "what do you see", "describe my screen", "read my screen", "what's this", "what's happening here" | ✅ done |
| T3.2 | Existing T9 auto-screenshot + `streamMessageWithImage` path delivers answer to the bubble — no new daemon code, no panel spawned | ✅ done |
| **T4 — Controlling halo** | | |
| T4.1 | `drawControllingHalo` — double-ring vermilion halo at radii 11.5 and 14 around disc when `pointing` is active. Pulses 30–60% alpha so disc remains the focal point. | ✅ done |
| T4.2 | Wired into paint pipeline before `drawEyeGlyph` so glyph sits above halo | ✅ done |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Daemon (Bun)                                                    │
│  • screen_capture event → debounced pebble.set_eye(true)        │
│  • pebble.blind_toggle event → flip awareness.enabled +         │
│    toggle awarenessService + dispatch set_blinded + speak ack   │
│  • Initial set_blinded pushed on sidecar reconnect              │
│  • NEEDS_SCREENSHOT regex extended for screen Q&A               │
└──────────────────────┬──────────────────────────────────────────┘
                       │ pebble.set_eye / set_blinded RPC
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ Sidecar (Win32)                                                 │
│  • eyeActive, blinded atomic flags on pebble entry              │
│  • WM_NCHITTEST gates disc area; cursor-on-disc freeze          │
│  • WM_LBUTTONDOWN/UP timestamps for long-press detection        │
│  • OnBlindToggle → pebble.blind_toggle SidecarEvent             │
│  • drawEyeGlyph + drawControllingHalo paint helpers             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Out-of-scope follow-ups

| Item | Why deferred |
|---|---|
| Full screen-spanning connector line for mouse control | Current halo is enough for the trust signal; full connector would need a new ephemeral overlay window infrastructure (~200 LOC) |
| macOS / Linux ports of eye glyph + long-press | Tracking with the other Phase A/B port deferrals (W7+) |
| "Show me the last screenshot you took" voice intent | Hooks neatly into existing awareness data; not blocking ship |

---

## Lessons learned

1. **`WM_NCHITTEST` only fires while the cursor is inside the window** — clearing state via `cursorOnDisc.Store(false)` from inside the WndProc means the state goes stale the moment the cursor leaves the window entirely. Paint-loop re-verification is the right fix for any "is the cursor here right now" flag.

2. **Long-press as the dismiss gesture** — feels natural and prevents accidental privacy-off (a short tap = summon, easy to undo). Similar to mobile long-press patterns. ~500 ms threshold tested as the sweet spot — < 400 ms gets confused with double-clicks, > 600 ms feels laggy.

3. **Hard pause > soft pause** — explicitly stopping the awareness service (vs just suppressing visible signal) is the right trust model. Reversing requires a deliberate action, matching how users think about "off" buttons.

4. **Extending an existing regex beats adding a new intent** — for "what's on my screen", reusing the T9 `NEEDS_SCREENSHOT` path meant zero new daemon logic. The image attaches automatically, streams through the same `streamMessageWithImage` pipeline.

5. **State persistence on reconnect** is critical for the trust loop. After a daemon restart, the user shouldn't have to re-blind awareness — the eye should match `awareness.enabled` automatically.
