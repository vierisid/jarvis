# Ambient UX — Week 2 Tickets

**Goal:** Turn the W1 "fixed widget" pebble into a true ambient companion — small floating pebble that follows the cursor across the entire screen, summonable via a global hotkey from any app, with clicks passing through transparent areas while bubble buttons remain interactive.

**Branch:** `refractor/UI_UX_phase2`
**Estimated effort:** 5 working days
**Definition of done:** see end of doc

---

## Progress

| # | Ticket | Status |
|---|---|---|
| T1 | Native cursor follow + window-move (cross-platform) | ⚠️ obsoleted — see "Pivot to native rendering" below |
| T2 | OS-level global hotkey for summon (Ctrl+Space) | ✅ done — Windows wired (RegisterHotKey + WM_HOTKEY loop); pattern reusable for native pebble |
| T3 | Region-based click-through (interactive zones only) | ⚠️ obsoleted — replaced by per-pixel alpha via UpdateLayeredWindow in native rendering |
| T4 | WebView2 transparent background (Win11) | ❌ closed — WebView2 transparency unattainable through webview_go on this build |
| T5 | Wire daemon → pebble state via WebSocket | ✅ done — `pebble.summon` SidecarEvent emitted on hotkey, daemon orchestrates state via `pebble.set_state` RPC. Demo cycle (listening 0s → thinking 2s → speaking 4s → idle 7s) so all 4 active state renderers are exercised. Re-pressing the hotkey mid-cycle dismisses to idle. Real voice/LLM events replace the timer logic in W2-T14. |
| T6 | Fork webview_go for transparency support | ❌ reverted — `put_DefaultBackgroundColor` doesn't take effect even with the fork |
| T7 | Clicky-style fullscreen pebble architecture | ❌ reverted — depended on T6 transparency that doesn't work |
| T8 | Element pointing via [POINT:x,y:label] tags | ✅ done — Clicky-style "click here" UX. **Sidecar (Windows)**: `pebbleServiceWindows.PointAt(x, y, label, durationMs)` sets atomic override target + bubble label, snapshots pre-point state for restoration. `paint()` checks `pointing` flag and uses `(pointX, pointY)` as the eased target instead of cursor + offset; on duration expiry, restores prior state. New `pebble.point_at` RPC. macOS / Linux ship stubs (T8b ports). **Daemon**: streaming text path strips closed `[POINT:x,y:label]` tags before the bubble + TTS see them, dispatches `pebble.point_at` per tag with a 3.5 s stagger so multiple points "walk" the user through a sequence. Partial tags straddling chunk boundaries are held back via a tagBuffer + lookback regex so we never leak fragments. Tag instructions appended to the LLM's pebble system prompt with an example. End result: ask "where do I click to publish?" and the pebble flies to the publish button with a "publish" label. |
| T8-fix | Foreground-app awareness + interrogative-tab bug | ✅ done — two fixes after T8 testing. **(1) Wrong tab match**: "Show me where the editor tab is in workflows" was triggering `switch_tab` with `tab="where_the_editor"` because the in-panel regex matched "show me" as an imperative verb. Now interrogative phrasings (`where|how|when|which|why|what … tab|view|section`) are explicitly rejected and fall through to the LLM with pointer guidance. **(2) Foreground-app context**: when the user says "where do I click for X?" without naming an app, JARVIS had no idea what app they were looking at (Chrome / VSCode / CapCut / etc.). Daemon now queries the sidecar's `list_windows` (which already returns `is_foreground`) before each pebble cycle and injects the foreground window's title + process name into the LLM siteContext, with explicit instructions to reason from that app's typical UI when the user is ambiguous. Best-effort with an 800 ms timeout so a slow window-enum call never blocks the response. |
| T9 | Auto-screenshot for spatial queries (LLM sees the actual screen) | ✅ done — the LLM was guessing coordinates from app conventions; now it sees the actual pixels. Daemon detects spatial intent (`where|show me|point|guide me|highlight|locate|how do I open/find/access/click/...`) and, in parallel with the panel-context build, dispatches the existing `capture_screen` RPC to grab the user's full virtual screen as PNG via Win32 BitBlt. The PNG arrives as `result._binary.data` (already wired from the existing awareness pipeline). When present, the daemon routes the cycle through `streamMessageWithImage` so the LLM gets the screenshot as the first content block; the system prompt explicitly instructs it to ground every `[POINT:x,y:label]` estimate in the attached image rather than remembered conventions. 2 s timeout — best-effort, falls back to text-only if capture fails. Skipped for non-spatial questions to save the latency. This is the structural accuracy fix; coordinates should now line up with actual buttons rather than nearby. |
| **T10** | **Native pebble overlay — Windows (GDI+ + UpdateLayeredWindow)** | ✅ done — riso idle (shadow + hairline border + breathing dot), all 4 active state renderers (listening/thinking/speaking/working pills with animated glyphs), Ctrl+Space hotkey toggle, eased cursor follow with offset, true transparency, always-on-top, multi-monitor cursor tracking. |
| **T14** | **Native bubble rendering (paper card below pebble during listening/speaking)** | ✅ done — window grew to 360×220, pebble pinned at anchor (40, 28), riso bubble drops below in listening (paper) and speaking (dark) variants, hard 4×4 offset shadow + hairline border, only renders in those two states |
| **T15** | **Bubble text rendering (Win32 GDI DrawText)** | ✅ done — JetBrains Mono "JARVIS" eyebrow + Inter Tight body line, antialiased, state-aware (vermilion eyebrow / ink body on listening; paper text on speaking dark card). DrawText writes RGB into the alpha=255 bubble fill so pre-multiplied ARGB stays correct for UpdateLayeredWindow. |
| **T16** | **Wake word detection + "Hey JARVIS" summon** | ✅ done — chose the **STT-driven** path over native ONNX wake-word. Sidecar's new `WakeListenerService` (pebble_wake.go) runs continuous mic capture, segments via VAD (reuses `pcmRMSint16`), and emits one `audio.wake_segment` event per phrase. Daemon transcribes via the existing STT provider, regex-searches for `\bjarvis\b` (matches "Jarvis", "Hey Jarvis", "I'm at home, Jarvis", etc.), and on a hit either (a) extracts the command after "jarvis" and runs the response cycle in one shot ("Jarvis play music" works without re-prompting), or (b) drops to listening state for 6 s when the wake word stands alone. Suppressed during active summon cycles (so the continuous wake stream doesn't fight the active turn) and pauses around session captures (releases the mic device). **Always on** alongside the pebble — no config flag, no file edits. No new native deps; supports "Jarvis anywhere in the utterance" naturally because the matching is text-side. Trade-off: ~300–800 ms STT round-trip latency vs. ONNX wake-word's ~50 ms — acceptable for "always-listening" UX, can be replaced by ONNX-native detection later if real-time hot-trigger feel becomes necessary (T16b). |
| **T17** | **Real voice loop (STT → LLM → TTS driving pebble state)** | ✅ done — pebble.summon → mic capture → STT → real `agentService.handleMessage` → speaking state with response broadcast for dashboard TTS → idle. Empty transcripts short-circuit back to idle. State transitions are event-driven, not timer-driven. |
| **T17b** | **Display LLM response text in speaking bubble** | ✅ done — `pebble.set_state` RPC accepts optional `text`; sidecar stores dynamic body line on Windows/macOS/Linux services; bubble renders the live response with word-wrap (Win32 `DT_WORDBREAK | DT_END_ELLIPSIS`, NSAttributedString `drawWithRect`, Pango `pango_layout_set_wrap`). Daemon passes the full LLM response on the speaking transition. Replaces the hardcoded "speaking…" placeholder. |
| **T17c** | **Auto-fit speaking bubble (height tracks text)** | ✅ done — bubble height now derives from measured wrapped-text height. Windows uses `DrawTextW` with `DT_CALCRECT` against the same memDC + body font that paints the text; macOS uses `boundingRectWithSize:options:attributes:`; Linux uses `pango_layout_get_pixel_size`. `bubbleY1 = bodyY0 + textH + bottomPad`, clamped to `[108, 200]` so single-line copy never looks pinched and long responses can't overflow the layered window. Card + last-line ellipsis track the auto-fitted bottom. Identical math + clamp values across all three platforms so visuals stay consistent. |
| **T17d** | **Typewriter reveal of LLM response** | ✅ done (superseded by T17e) — original implementation paced an artificial typewriter over the audio's estimated duration. Replaced in T17e with the LLM's own token cadence: the bubble grows naturally as tokens stream, no artificial pace needed. |
| **T17e** | **Streaming sentence-by-sentence TTS** | ✅ done — major architectural change to the voice cycle. Daemon switched from `agentService.handleMessage` (await full response) to `agentService.streamMessage` (async-iterable token stream). As tokens arrive: (a) bubble text updates live via `pebble.set_state`, (b) a sentence-boundary regex (`[.!?]+\s+`) extracts complete sentences, (c) each sentence is synthesized via the TTS provider in parallel and dispatched as a `pebble.play_audio` clip. Sidecar `AudioPlaybackService` refactored from one-clip-at-a-time to a queue model with a worker goroutine: clips play back-to-back seamlessly, generation counter invalidates queued jobs on Stop(). Daemon tracks estimated cumulative playback end so it knows when to flip to idle. Logs first-token latency and first-audio latency separately so the win is measurable. Expected: first audio in ~1–2 s instead of 4–7 s for a typical "How are you?"-style response. The wake-suppression hook (T16) still fires correctly because the queue worker's idle-timeout debouncer flips the playback-state flag only when the queue genuinely empties. |
| **T17f** | **Bubble text alpha-repair (transparent-text fix)** | ✅ done — Win32 GDI DrawText was writing glyph RGB into the 32-bit ARGB DIB but corrupting the alpha byte to 0, so the rendered text became transparent to the desktop background under the layered window. Made the listening text invisible on white desktops and the speaking text invisible on black ones. Added `repairBubbleTextAlpha(pixels, bubbleY1)` — runs after every `drawBubbleText` and clamps alpha to 255 across the bubble interior (insets larger than the corner radius so the rounded-corner transparent pixels aren't clobbered). RGB is preserved, so the glyph colour DrawText chose stays correct; trade-off is subpixel AA on glyph edges becomes hard-edged, which is invisible at the bubble's text size. |
| **T18** | **Spawn dashboard pages as native windows from pebble** | ✅ done — daemon's `tryHandlePanelIntent` matches `open|show|launch|bring up <room>` and `close|hide|dismiss|shut <room>` against an alias table covering all 12 rooms (settings, workflows, memory, tools, agents, authority, logs, calendar, goals, tasks, content, workspaces). On match, dispatches `panel.spawn` (or iterates `panel.list` + `panel.close` for closing) with per-room default bounds, then speaks a short confirmation through the queue-based TTS path. **Skips the LLM entirely** — saves the 2–7 s round-trip. Word-bounded alias matching avoids false positives; longest-match-first so "tool catalog" wins over "tools". Reuses existing `panel.spawn` infrastructure. |
| **T18-fix** | **Panel-mode route (no AppShell, no voice clash)** | ✅ done — first cut spawned `#/_room_<key>` which renders the full AppShell (Thread + Rail + Composer + voice handlers), so the dashboard's web wake-word started competing with the pebble's sidecar wake-word — two voices, double-trigger risk. Added a new `panel` route variant to `ui/src/v2/router.ts` (`#/_panel_<key>`); `AppShellV2` short-circuits this route to render JUST the `RoomBody` for the requested key — no AppShell, no Thread, no voice. Daemon's `dashboardURL` switched to `_panel_<key>`. Rebuilt the dashboard so the route ships in `ui/dist`. |
| **T18b** | **Window-management voice commands (expand, minimize, restore, close, focus)** | ✅ done — full pronoun-aware vocabulary that lets the user manage the most-recently-spawned panel without naming a room. New cross-platform `PanelService.SetWindowState(id, "normal"\|"minimized"\|"maximized")` (Win32 `ShowWindow`, Cocoa `miniaturize/zoom`, GTK `iconify/maximize`) plus matching `panel.set_window_state` RPC. Intent parser covers: **expand / maximize / fullscreen / make it bigger / enlarge / blow it up** → maximized; **minimize / hide it / put it away / send it to the taskbar** → minimized; **restore / shrink / make it smaller / un-maximize / normalize** → normal; **close it / dismiss / shut it / kill it / get rid of it** → close; **focus / bring it back / where did it go / surface it / raise it** → focus. Each command speaks a short confirmation through the queued TTS path and skips the LLM entirely. |
| **T18b-fix** | **Force OS close + per-window targeting** | ✅ done — two follow-ups on T18b. **(1) Close didn't close**: `wv.Terminate()` on Windows returns the webview's message loop but doesn't destroy the HWND, so the user kept seeing a window the daemon thought was closed. Added `platformDestroyWindow(handle)` — Win32 posts `WM_CLOSE` to the HWND, Cocoa calls `[NSWindow close]`, GTK calls `gtk_widget_destroy` — called before `wv.Terminate()` so the deferred `reg.delete` cleanup still fires. **(2) Multi-window targeting**: previously `lastPanelBySidecar` only remembered the last spawn, so "expand the workflows window" with two panels open always acted on the last one regardless of room. Replaced with a per-sidecar panel list; verb parser now captures an optional `(?:the\s+)?<room>(?:\s+window\|panel)?` tail; `findPanel` resolves the hint via the alias table back-to-front so the most-recent matching panel wins. Pronoun "it / that / the window" still falls back to the latest entry. |
| **T19** | **Region selection ("help with this" + drag-select screen area)** | ✅ done — full multi-modal voice flow. **Sidecar (Windows)**: new `RegionSelectionService` (`region_select_windows.go`) snapshots the entire virtual screen via Win32 BitBlt before showing an overlay (so the final crop doesn't include our own selection rect), spawns a fullscreen layered topmost window covering all monitors, paints a translucent dim layer with a hairline-outlined cutout that follows the drag, captures cropped PNG on mouseup, fires `region.captured` SidecarEvent with the bytes inline. Esc / right-click / tiny drags trigger `region.cancelled`. Stubs for darwin/linux/other (T19b ports). New RPC `region.start_selection`; wake listener pauses for the duration so mic doesn't grab the user's grunting during selection. **Daemon**: voice intent matches `(help|look|explain|what'?s?|what is|describe|tell me about|analy[sz]e) … (this|that|here|the screen|the area|the region)`. On match: pebble → working, dispatches `region.start_selection`, stores the original transcript. On `region.captured` event: agent's new `streamMessageWithImage(text, base64, mediaType, channel, siteContext)` builds a multi-modal user message (image + text content blocks), routes through the regular streaming response cycle (typewriter + queued sentence TTS). **Agent**: extended `addMessage` and `orchestrator.streamMessage` to accept `string \| ContentBlock[]`. End result: "Hey Jarvis, what is this?" → fullscreen dim → drag a rectangle → release → JARVIS responds based on what's in the captured area. |
| **T19-fix** | **Cross-provider vision support** | ✅ done — initial T19 only worked on Anthropic because OpenAI / NVIDIA / Groq providers were stripping every image content block to the literal text `'[image]'` before the API call. Patched all three providers' `convertMessages` to translate user-message image blocks into the OpenAI-compatible `image_url` content-parts shape with `data:<mime>;base64,<bytes>` data URLs. Ollama already supported images natively. Now T19 works on every provider that has a vision-capable model (gpt-4o, claude-sonnet, llama-3.2-vision, llava, etc.). Re-entry guard added so the post-capture `runResponseCycle` doesn't re-trigger the region-intent matcher; original-summon `pendingSummons.has` check removed since by the time the intent runs, the slot is already (correctly) claimed. |
| **T20** | **Voice command routing — settings mutation (TTS / STT)** | ✅ done — settings-mutation fast path in `tryHandleSettingsIntent`. **TTS on/off**: phrases like "turn off TTS", "disable text-to-speech", "turn off the speech in the settings" patch `jarvisConfig.tts.enabled`, persist via `saveConfig`, rebuild `pebbleTTS` (and the dashboard `wsService` provider) in place — no daemon restart needed. **STT provider switch**: "switch transcription to groq", "use openai for STT", "use local for listening" — same pattern; refuses gracefully when the target provider has no API key configured. Runs BEFORE the panel intent so "turn off TTS in settings" doesn't accidentally open the settings panel. |
| **T20b** | **Panel awareness in LLM context** | ✅ done — fixed the "Hey Jarvis I have no idea what you're talking about" gap when the user references an open panel ("switch to the editor tab in workflows", "go to memory in vault"). Daemon now builds a panel-inventory `siteContext` string from `panelsBySidecar` and passes it to `agentService.streamMessage` as a third arg. The LLM gets the list of currently-open windows (title, room_key, id, "most recent" flag) plus instructions on what each panel contains and what voice actions exist. With it, "the workflows" / "the editor tab" / "this window" / "that panel" all resolve to a specific open native window, so JARVIS can answer naturally instead of asking which app the user means. Empty when no panels open — saves the prompt tokens. |
| **T20c** | **Voice-driven in-panel actions (switch tab, navigate inside a panel)** | ✅ done — completes voice-driven dashboard navigation. **Dashboard side**: new `PanelRoomActionBridge` (in `AppShellV2`) opens a WebSocket to the daemon's `/ws` endpoint when in panel mode and forwards every `room_action` notification into the panel's `RoomActionBus`. Auto-reconnects with a 1.5 s backoff after daemon restart. **Daemon side**: new `tryHandleInPanelAction` matches "switch to <X> tab", "go to <X>", "click on <X>", "open the <X> view/section/page", with optional trailing room hint ("…in workflows"). Resolves the target panel via `findPanel`, normalizes common tab synonyms (editor → editor, edit → editor, history → logs, agent builder → agent_builder, etc.), and dispatches `wsService.broadcastRoomAction` with `{room, action: 'switch_tab', args: {tab}}`. Existing `useRoomActions` handlers in workflows / goals / settings / authority pick it up automatically — no per-room dashboard changes needed. Speaks short confirmation; rejects gracefully when no panel is open or the named room isn't visible. Now "switch to the editor tab", "go to logs", "show me general settings" all work end-to-end without LLM round-trip. Same registry pattern accommodates non-tab actions (search / set_filter / select / run / pause) the rooms already register; future verb additions extend `tryHandleInPanelAction` without touching the dashboard. |
| **T21** | **Sidecar mic capture (cross-platform via malgo)** | ✅ milestone done — `pebble_audio.go` captures PCM s16 16 kHz mono via miniaudio (WASAPI/CoreAudio/ALSA). On Ctrl+Space, sidecar captures 5s and saves a WAV to OS temp dir, logs the path. Cross-compiles to Windows clean (19 MB .exe). |
| **T22** | **Stream sidecar audio to daemon (WebSocket binary frames)** | ✅ done — sidecar emits `audio.session_start` + `audio.session_end` SidecarEvents; the latter carries full PCM as inline base64 binary. Daemon's `AudioSessionRegistry` (src/daemon/audio-sessions.ts) buffers + decodes, fires `onComplete(session)` with `{pcm: Buffer, durationMs, sampleRate, channels, format}` ready for STT. |
| **T23** | **Run STT on captured audio + drive real LLM with transcript** | ✅ done — daemon constructs an STT provider from `jarvisConfig.stt` (same provider config the dashboard uses), wraps PCM as WAV, transcribes via Whisper/Groq/Local/Sarvam, feeds the real transcript to `agentService.handleMessage`. Voice cycle is now event-driven (audio session completion drives state transitions instead of fixed timers). Empty transcripts return to idle without bothering the LLM. |
| **T24** | **Sidecar audio playback (TTS streaming back from daemon)** | ✅ done — daemon synthesizes the LLM response via the existing `jarvisConfig.tts` provider (edge-tts / ElevenLabs / Sarvam) and dispatches `pebble.play_audio` to the sidecar with the encoded bytes (base64 + MIME hint). Sidecar's `AudioPlaybackService` (pebble_playback.go) sniffs format (MP3 magic / RIFF), decodes via `go-mp3` or inline WAV parser, and plays through the default output device via malgo. Daemon estimates clip duration via MP3-frame-header bitrate parsing so the speaking state stays up until playback finishes. **Interrupt support:** new `pebble.stop_audio` RPC + `AudioPlaybackService.Stop()` flips an atomic flag that the data callback observes; pressing the summon hotkey mid-playback cuts audio within ~10 ms (the daemon's dismiss path now fires the stop RPC alongside the visual idle transition). Dashboard heartbeat broadcast retained as fallback. |
| **T25** | **End-of-speech detection (replace fixed listening duration)** | ✅ done — energy-based VAD in `pebbleCaptureWithVAD` (sidecar) replaces the fixed 5 s window. Per-chunk RMS computed in the malgo callback via the new `SetChunkListener` hook; coordinator polls every 50 ms and stops when (a) >1.1 s of silence has elapsed since the last detected speech, (b) no speech detected within the first 4 s (pre-speech cap), or (c) the 15 s hard cap fires. Logs the stop reason + peak RMS for tuning. RMS threshold defaults to 500 (above typical desktop-mic noise floor); tunable via `VADOpts`. Short utterances stop instantly; long sentences extend up to the hard cap. |

## Recommended order

Voice loop is feature-complete and streaming end-to-end. Voice-triggered navigation now works ("Jarvis open settings"). Remaining W2 work + multi-week roadmap below.

### Remaining W2

W2 ambient-UX is feature-complete. Action narration ✅, voice control ✅, screen awareness ✅, panel management ✅. Moving forward picks from the multi-week plan and deferred items.

**Skipped / deferred:**
- **T8c** — Multi-step user-guided workflows (JARVIS-points-then-watches-user-click). Inverse of T26. Big lift, lower priority than W3+.
- **T8b** — port element pointing to macOS / Linux pebble overlays (override-target plumbing is Windows-only).
- **T19b** — port region selection to macOS / Linux.
- **T20d** — broaden the voice-intent registry to non-tab room actions: search, set_filter, select / run / pause by name. Plus task creation, agent launch, workflow trigger, calendar events.

### Recently shipped

| Task | Status |
|---|---|
| **T26 — Action narration via pebble (v1: working state + label)** | ✅ done — when the LLM emits a tool call for a visible action, the daemon intercepts the `tool_call` event, generates a human label, and flips the pebble to the new `working` state with the label as bubble text. **Tools narrated**: all `desktop_*` actions (click / type / press_keys / launch_app / focus_window), all `browser_*` actions (click / type / navigate / scroll / evaluate / upload_file), `run_command`, `write_file`, `set_clipboard`, `create_document`, `delegate_task`, `manage_workflow`, `manage_goals`, `manage_agents`. Read-only tools (snapshots, list_*, find_element, read_file, etc.) deliberately skipped. Re-designed `drawWorking` visual: wider 24×8 paper pill with amber-tinted hairline border and a sweeping amber bar that travels left↔right with a fading 3-dot trail — distinct from listening (waveform) and thinking (bouncing dots), reads as "I'm doing something autonomously" at a glance. |
| **T26b — Pebble fly-to-target for desktop clicks** | ✅ done — `desktop_click` calls now fly the pebble to the actual element BEFORE the click fires. Daemon imports a new read-only accessor `getCachedElementBounds(id)` from `desktop.ts`, looks up the cached UIA bounds, computes the centre, dispatches `pebble.point_at(cx, cy, label, 2500ms)`. Tool execution lands ~50–300 ms later, well within the 2.5 s pebble hold. Falls back gracefully to label-only narration when the element isn't in cache. |
| **T26c — Pebble fly-to-target for browser clicks** | ✅ done — same idea for web apps. When the LLM emits `browser_click({element_id})` or `browser_type({element_id})`, daemon dispatches a one-shot `browser_evaluate` through the sidecar with a tiny script that resolves the element_id (same `document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick], [tabindex]')` indexing the sidecar uses internally) → reads `getBoundingClientRect()` → adds `window.screenX/Y` to convert viewport coords to absolute screen pixels. Center of the resulting box becomes the pebble target. Robust JSON-shape probing (the eval result wrapping varies between sidecars). 1.5 s timeout — best-effort, falls back to label-only narration on any failure. So a Gmail "compose email to alice" workflow now visibly walks the user through Compose → To → Subject → Body → Send: pebble glides to each rendered field/button as the LLM clicks/types it via CDP DOM events (no OS cursor takeover). |
| **W4 — Cmd+K / Ctrl+K palette** | ✅ done — cursor-anchored fuzzy room picker spawned by a sidecar-native global hotkey. Sidecar registers `Ctrl+K` as a second global hotkey alongside `Ctrl+Space` (extended `parseHotkey` and added an independent listener slot in `pebble_overlay_windows.go`). On fire, the sidecar reads cursor pos and emits a `pebble.palette` event; daemon spawns a 460×440 always-on-top panel at the cursor offset (`#/_palette` route) — second press toggles it closed. The dashboard's `_palette` route reuses the existing `CommandPalette` component (with scrim collapsed via `.jarvis-v2-palette-mode` so the panel itself acts as the modal). Picks POST to two new daemon routes (`/api/palette/pick` and `/api/palette/close`) that forward through a small palette-controller singleton; the controller's `pick` reuses the same `panel.spawn` + `trackPanel` path that voice "open workflows" uses, so picked rooms show up in the same panel inventory the LLM sees. Esc/click-pick auto-closes. Linux + macOS paths stubbed (palette hotkey is Windows-only for now, gated on the existing X11 / NSEvent hotkey-port tickets). Post-merge: also added a global low-level `Ctrl+Middle-click` mouse hook (`WH_MOUSE_LL` in `mouse_hook_windows.go`) so the palette can be triggered one-handed from the mouse — plain MMB still passes through. Toggle semantics on the hotkey were dropped after observing webview_go segfaults under rapid panel close/spawn cycles — now Ctrl+K-while-open just focuses the existing palette; closing flows only through user actions (Esc / click / pick) plus a 350 ms cooldown before respawn. |
| **W3 — Window state persistence + Win11 chrome polish** | ✅ done — every spawned Room panel now remembers its size and position across restarts. Sidecar polls each panel's window rect at 1 Hz (`platformGetWindowRect` in `panels_windows.go`, stubbed on darwin/linux) and emits a `panel.bounds_changed` event on drag/resize; daemon maps panel id → room key against the existing `panelsBySidecar` inventory and saves to `~/.jarvis/window-state.json` (debounced 400 ms, schema `{ version: 1, rooms: { workflows: {x,y,w,h}, … } }`). On next spawn (`panel.spawn` from voice or palette pick), the daemon looks up saved bounds via `boundsForRoom(key, w, h)` and passes them as the panel's initial position; the sidecar now honours explicit (≥0,≥0) bounds.x/y via a new `platformMoveWindowKeepZOrder` that uses `SWP_NOZORDER` instead of `HWND_TOPMOST` so restored Rooms don't accidentally become always-on-top. Win11 chrome polish via `DwmSetWindowAttribute`: dark immersive title bar, large rounded corners, Mica `DWMSBT_MAINWINDOW` backdrop — silently ignored on Win10/older. Polish is skipped for frameless/transparent/always-on-top overlays (palette, pebble overlay). Sidecar manager event allowlist extended with `panel.bounds_changed` so the new events actually reach `onEvent` listeners (same gotcha that bit `pebble.palette` initially). |
| **T20-fix-1 — Auto-route desktop tools to sidecar** | ✅ done — desktop tools defaulted to `executeLocal` (legacy C# desktop-bridge) when no `target` was passed, and the LLM almost never passed one. Added `autoTargetForCapability(cap)` in `sidecar-route.ts` and a `resolveDesktopTarget(explicit?)` helper in `desktop.ts`; all 9 `desktop_*` tools now auto-route to a connected sidecar advertising the `desktop` capability. Same auto-route extended to `capture_screen`, `get_clipboard`/`set_clipboard`, `get_system_info`, `run_command`, `read_file`/`write_file`/`list_directory`, and all 7 `browser_*` tools. So when the Go sidecar is connected, every "touch the user's machine" tool lands on it transparently. |
| **T20-fix-2 — UIA Invoke first** | ✅ done — `actionClick` in `uia_actions_windows.go` was preferring `win32Click` (SetCursorPos + mouse_event, which steals the user's actual cursor) over the COM-level `patternInvoke` (cursor-free). Flipped the priority: try Invoke first, fall back to win32Click only when the widget doesn't support it. Now `desktop_click` keeps the user's cursor where they put it for every UIA-aware widget (most native Windows controls). |

### Beyond W2 (from `AMBIENT_UX_PLAN.md` master plan)

5. **W3** — ✅ done (see "Recently shipped" above).
6. **W4** — ✅ done (see "Recently shipped" above). `⌘B` background-agent spawn and `⌘V` voice-reply-on-room shortcuts deferred until W5 ships the agent strip + reply-target plumbing.
7. **W5** — Background agent strip: bottom-right floating window showing all running agents (status dots, progress bars, elapsed time). Agent spawn from voice ("in the background…"), thread bubble, or palette. OS notification on completion.
8. **W6** — Awareness eye + privacy toggle: pebble eye glyph activates when OCR/awareness fires; long-press pebble = instant blind toggle; "what's on my screen" answered inline; mouse-control visualization with connector line.
9. **W7** — Polish + dogfood: animation tuning (state transitions, spring), DPI scaling, dual-monitor edge cases, state persistence across restarts, coexistence flag with old dashboard.
10. **W8** — Bugfix + cut: dogfood for a week, fix worst issues, cut from `refractor/UI_UX_phase2` into demo + PR.

### Latency / quality follow-ups (not blocking)

- **T16b** — ONNX-native wake-word detection (deferred): bundle onnxruntime per platform, run openwakeword pipeline against continuous mic capture. Wake STT round-trip → ~50 ms vs the current 300–800 ms STT path.
- **STT swap to Groq** — user-config in `~/.jarvis/config.yaml`. ~5–10× speedup on STT round-trip.

## Latency improvements log (T16/T17 follow-ups)

| Optimization | Saved | Status |
|---|---|---|
| Slim system prompt for `pebble` channel | ~200–500 ms (LLM first token) | ✅ |
| Wake silence cutoff 900→500→350 ms | ~550 ms (wake → listening) | ✅ |
| Wake suppression during TTS playback | self-trigger fix | ✅ |
| Streaming sentence-by-sentence TTS | first audio in ~1–2 s vs 4–7 s | ✅ |
| **Switch STT to Groq Whisper** | ~2–3 s (wake + command STT) | ⏳ user-config: edit `~/.jarvis/config.yaml` `stt.provider: groq` |
| ONNX-native wake-word (T16b) | wake STT round-trip → ~50 ms | ⏳ deferred — would require bundling onnxruntime native lib |

## Known limitations (v1 scope-cuts to revisit)

- **T16b**: ONNX-native wake-word detection. Lower latency than STT-based; would require bundling the onnxruntime native lib per platform. Current STT path is acceptable but adds ~300–800 ms.

## T16 patch (post-merge fixes)

- **Wake follow-up capture**: when wake fires with no trailing command ("Jarvis"… [pause]), the daemon now dispatches `pebble.start_listening` to the sidecar instead of timing out. The sidecar runs the same VAD-driven session capture as Ctrl+Space, and the resulting `audio.session_end` flows through the existing `audioSessions.onComplete` handler. So "Jarvis play music" works in one shot AND "Jarvis ... [pause] ... play music" also works.
- **Latency**: WakeListener silence cutoff dropped from 900 ms → 500 ms; coordinator poll from 50 ms → 30 ms. Wake match → "listening" visual now lands in roughly half the time.

## Sidecar-native voice loop (T21–T25)

Confirmed direction: **the sidecar owns audio**. Mic capture and speaker playback happen in the sidecar binary so the pebble works on any computer with no dashboard open. API keys stay where they are (daemon-side provider configs); the sidecar streams raw PCM to the daemon, the daemon runs STT/LLM/TTS via its existing providers, and the daemon streams TTS audio back to the sidecar for playback.

Pipeline:
```
[Sidecar mic capture]                 ← T21 (malgo cross-platform)
        ↓ PCM chunks via WS binary frames
[Daemon audio session buffer]         ← T22
        ↓ on end-of-speech
[Daemon STT (existing provider)]      ← T23 — replaces stub prompt
        ↓ transcript
[Daemon LLM (existing agentService)]
        ↓ response text
[Daemon TTS (existing provider)]
        ↓ audio bytes via WS binary frames
[Sidecar speaker playback]            ← T24
```

End-of-speech detection (T25) replaces the fixed listening duration with VAD-driven cutoff so the pebble's `listening` state matches actual user speech.

This is a multi-ticket build — current iteration starts with T21 (mic capture only).

## Functional vision (post-W2 native rendering)

Confirmed direction: **the pebble is the sidecar's user surface — everything you can do in the dashboard can be done from the pebble**. The dashboard remains for setup + power-user views, but the pebble + ambient flow is the daily-driver UX.

The full surface, in priority order:

1. **Cross-platform parity** (T11 macOS, T12 Linux) — *current focus*. Native rendering ports of the Windows pipeline.
2. **Real brain integration** (T16 wake word, T17 voice loop, T18 panel spawn, T20 voice command routing) — pebble responds to "Hey JARVIS", actually speaks, opens dashboard rooms as native windows on demand, creates tasks / launches agents / queries vault from voice.
3. **Multi-monitor support** (T9 + general) — secondary monitor cursor follow, multi-monitor element pointing, virtual screen geometry.
4. **Element pointing** (T8) — Clicky's `[POINT:x,y:label]` UX. Claude says "click here" → pebble flies to the button on screen, displays a label. Multi-step flows: pebble walks the user through a sequence of UI actions.
5. **Region selection** (T19) — drag-select a screen rectangle, ask "help with this", LLM gets the cropped image as context.

The screen-awareness piece (sidecar already captures screen via OCR/awareness) feeds into all of these — pebble can know what app/window is in focus, suggest workflows, point at relevant UI. That's existing infra; the pebble integration is the new piece.
| **T11** | **Native pebble overlay — macOS (NSWindow + Core Graphics)** | ✅ code-complete — `pebble_overlay_darwin.go`: borderless transparent NSWindow at `NSScreenSaverWindowLevel`, `ignoresMouseEvents=YES`, joins all spaces, custom `JarvisPebbleView` with `drawRect:` rendering all 5 states + bubble + text via Core Graphics + NSAttributedString. 60fps NSTimer drives cursor poll + redraw on the main thread. Visual verification needs an actual Mac box (cross-compiling Darwin from WSL requires osxcross). |
| **T12** | **Native pebble overlay — Linux (GTK + Cairo)** | ✅ code-complete — `pebble_overlay_linux.go`: GTK_WINDOW_POPUP with RGBA visual + decorated=false + keep_above + skip_taskbar + DOCK type hint, custom GtkDrawingArea draws all 5 states + bubble + text via Cairo + Pango. 60fps `g_timeout_add` drives cursor poll + redraw on the GLib main loop. Empty input shape gives global click-through. |
| **T13** | **Pebble service RPC + daemon integration** | ✅ done — `pebble.spawn / close / set_state` RPC handlers, `CapPebble` capability, daemon dispatches `pebble.spawn` on connect under `JARVIS_AMBIENT_UI=1` |

## Pivot to native rendering (2026-05-04)

After exhausting WebView2 transparency through:
1. `WEBVIEW2_DEFAULT_BACKGROUND_COLOR` env var (process init)
2. `ICoreWebView2Controller2.put_DefaultBackgroundColor` from spawn goroutine
3. Same call dispatched onto WebView2 UI thread before `Run()`
4. Same call from a page-side Bind triggered after first mount + with `WS_EX_LAYERED` set on the parent HWND

…none gave a transparent surface. Combined with `webview_go` not allowing pre-creation of the layered HWND (WebView2 caches its compositor state at controller creation, so setting `WS_EX_LAYERED` later is too late), we determined the WebView2 path is fundamentally blocked.

**The fix: render the pebble natively per platform**, the way every transparent overlay on Windows is built (Discord overlay, OBS, NVIDIA overlays):

| Platform | Tech | Files |
|---|---|---|
| Windows | `CreateWindowEx(WS_EX_LAYERED|WS_EX_TRANSPARENT|WS_EX_TOPMOST)` + `UpdateLayeredWindow` + GDI+ | `pebble_overlay_windows.go` (new) |
| macOS | `NSWindow(backgroundColor=.clear, ignoresMouseEvents=true, level=.screenSaver)` + Core Graphics | `pebble_overlay_darwin.go` (new) |
| Linux X11 | `GtkWindow` with RGBA visual + `keep_above` + `decorated=false` + Cairo | `pebble_overlay_linux.go` (new) |

The riso aesthetic (paper-toned rounded pill, hairline border, hard offset shadow, mono uppercase labels, accent waveform) is reproduced in native drawing primitives. No browser involved for the pebble. The dashboard (and future dashboard panels — workflows, vault, settings, etc.) keeps using webview since transparency isn't needed there.

**Cross-platform answer:** yes, but each OS has its own rendering file (same pattern as `panels_windows.go`, etc.). Public Go interface is identical.

**Sidecar-hosted answer:** yes — native pebble lives in the sidecar binary as new platform-tagged files. The "host on server, sidecar on PC" topology stays exactly the same.

## What's been reverted (2026-05-04)

To get a clean foundation:
- `sidecar/transparency_windows.cpp`, `transparency_windows.go`, `transparency_other.go` — deleted (no longer needed without WebView2 transparency)
- `sidecar/internal/webview_go/` (vendored fork) — deleted; `replace` directive in `go.mod` removed; back on upstream webview_go
- The `__sidecar_set_transparent` and `__sidecar_get_cursor` Bind handlers — removed from `panels_runtime.go`
- The webview-pebble `panel.spawn` in `src/daemon/index.ts` — replaced with a no-op log line (env var still recognized; just doesn't spawn anything until native pebble lands)
- `Pebble.tsx`'s native-mode useEffect — short-circuited to a no-op (browser dev mode still works for design reference)
- The `Fullscreen`, `FollowCursor`, `CursorOffsetX/Y`, `SummonHotkey` fields on `PanelSpec` — kept (still useful for general dashboard panel spawning if we wire those features for non-pebble panels later)

## What stays

- The whole `panel.*` RPC surface (`spawn / close / focus / list / set_follow / set_clickthrough / set_interactive_regions`) — useful for spawning ordinary opaque dashboard panels (workflows, vault, etc.)
- `panel_handlers_test.go` tests — all still pass
- The mockups in `docs/mockups/ambient-ux/` — design references for the native rendering work
- The `Ctrl+Space` hotkey infrastructure — pattern reusable when native pebble needs summon
- `Pebble.tsx` browser dev mode — open `pebble.html` in a browser to see the visual design we're targeting

## Native pebble (W2-T10/11/12/13) plan summary

### W2-T10 — Windows (~1–2 days)

`sidecar/pebble_overlay_windows.go` — new file with:
- Goroutine with `runtime.LockOSThread` (Win32 layered windows are thread-affine)
- Win32 window class registration + `CreateWindowEx` with `WS_POPUP | WS_VISIBLE` and `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`
- 60fps timer that:
  - Polls `GetCursorPos`
  - Eases the rendered position toward `(cursor + offset)`
  - Renders the pebble shape via GDI+ to a 32-bit ARGB DIB
  - Calls `UpdateLayeredWindow` with that DIB → true per-pixel alpha
- State machine: idle / listening / thinking / speaking / working — each with its own glyph rendering
- Bubble: separate layered window or expanded same window when `state ∈ {listening, speaking}`
- Click-through default; `WS_EX_TRANSPARENT` toggled off when bubble is open

### W2-T13 — RPC + daemon

New `PebbleService` interface:
```go
type PebbleService interface {
    Spawn(spec PebbleSpec) error
    Close() error
    SetState(state PebbleState) error
}
```
RPC handlers `pebble.spawn / pebble.close / pebble.set_state`. `CapPebble` capability. Daemon hook (behind `JARVIS_AMBIENT_UI=1`) dispatches `pebble.spawn` on connect, `pebble.close` on shutdown.

### W2-T11 — macOS (~1 day, after T10)

Mirror with `NSWindow` subclass + `NSView` doing CG drawing. NSWindow already supports true transparency natively.

### W2-T12 — Linux (~1 day, after T10)

Mirror with GtkWindow + RGBA visual + cairo draw signal.

## Definition of done (revised W2)

- [ ] Native pebble appears on Windows with true per-pixel alpha (no white box, no edges)
- [ ] Pebble follows cursor smoothly with eased physics
- [ ] Always on top of every other window
- [ ] Click-through everywhere except the bubble (when shown)
- [ ] Riso aesthetic reproduced in native rendering (paper-tone, vermilion accent, hairline border, hard offset shadow)
- [ ] State machine transitions: idle / listening / thinking / speaking / working
- [ ] Ctrl+Space summon (toggle listening state)
- [ ] Multi-monitor: pebble follows cursor across displays
- [ ] No regressions to dashboard or existing `panel.*` RPC for general panel spawning
- [ ] macOS and Linux ports completed

T2/T3 unblock once T1 lands. T4/T5 can run parallel after T1.

---

## What W1 left behind

W1 demo: small frameless always-on-top window at fixed position (100, 100), 420×160 px. Pebble follows cursor *inside* the window. Clicks inside grab focus. No transparency. No global hotkey.

W2 closes those four gaps in priority order.

---

## T1 — Native cursor follow + window-move

**Files:**
- `sidecar/panels.go` — add `FollowCursor bool` to `PanelSpec`
- `sidecar/panels_runtime.go` — spawn cursor-tracking goroutine when FollowCursor=true; new RPC handler glue
- `sidecar/panels_windows.go` / `_darwin.go` / `_linux.go` / `_other.go` — add `platformGetCursorPos() (x, y int)` and `platformMoveWindow(handle unsafe.Pointer, x, y int)`
- `sidecar/panel_handlers.go` — new RPC `panel.set_follow(id, bool)`
- `src/daemon/index.ts` — pass `follow_cursor: true`, shrink bounds to ~80×80 idle

### Platform implementations

**Windows:**
```go
func platformGetCursorPos() (int, int) {
    var p struct{ X, Y int32 }
    procGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
    return int(p.X), int(p.Y)
}
func platformMoveWindow(handle unsafe.Pointer, x, y int) {
    procSetWindowPos.Call(uintptr(handle), 0, uintptr(x), uintptr(y), 0, 0,
        swpNoSize|swpNoActivate|swpShowWindow)
}
```

**macOS:** `[NSEvent mouseLocation]` (returns flipped screen coords) + `[NSWindow setFrameTopLeftPoint:]`.

**Linux X11:** `XQueryPointer(display, root, ...)` + `gtk_window_move(w, x, y)`.

### Tracking goroutine

```go
go func() {
    ticker := time.NewTicker(16 * time.Millisecond) // ~60fps
    defer ticker.Stop()
    for {
        select {
        case <-impl.followStop:
            return
        case <-ticker.C:
            if !impl.following.Load() { continue }
            x, y := platformGetCursorPos()
            platformMoveWindow(impl.wv.Window(), x+24, y+28) // offset
        }
    }
}()
```

Use atomic bool for `following` so the page can pause it via `panel.set_follow(id, false)` when the bubble opens (so the window stops jittering while the user reaches for buttons).

### Daemon spawn args (T1 final)

```ts
bounds: { x: 0, y: 0, w: 80, h: 80 },  // tiny — just the pebble area
frameless: true,
transparent: false,                     // T4 fixes this
always_on_top: true,
click_through: false,                    // T3 fixes this with regions
follow_cursor: true,                     // NEW
```

**Acceptance:** Move your mouse anywhere on screen — the 80×80 paper-coloured pebble window trails behind. Click on it: bubble appears. Click "Speak it" on the bubble — the click registers (because the small window grabs clicks within its bounds, and you're hovering over that bound).

---

## T2 — OS-level global hotkey for summon

**Files:**
- `sidecar/hotkeys.go` (new) — cross-platform interface
- `sidecar/hotkeys_windows.go` — `RegisterHotKey` + message-loop pump
- `sidecar/hotkeys_darwin.go` — `[NSEvent addGlobalMonitorForEvents:NSEventMaskKeyDown handler:^...]`
- `sidecar/hotkeys_linux.go` — `XGrabKey` on root window with `XKeysymToKeycode`
- `sidecar/main.go` — start hotkey service on init (under CapWindows or new `CapHotkeys`)
- `sidecar/handlers.go` / new RPC `panel.set_state(id, state)` — daemon-driven state changes
- `src/daemon/index.ts` — new SidecarEvent listener for `pebble.summon`; on fire, dispatch `panel.set_state(pebble, 'listening')`
- `src/sidecar/types.ts` — add `'pebble.summon'` event type

### Hotkey config

```yaml
# ~/.jarvis-sidecar/config.yaml
hotkeys:
  pebble_summon: "ctrl+space"  # platform translates
```

**Acceptance:** Focus any other app (browser, vscode, terminal). Press Ctrl+Space. Pebble enters listening state and shows the bubble at cursor position.

---

## T3 — Region-based click-through

**Files:**
- `sidecar/panel_handlers.go` — new RPC `panel.set_interactive_regions(id, rects)`
- `sidecar/panels_windows.go` — `SetWindowRgn(hwnd, CreateRectRgn(...))` combining all rects
- `sidecar/panels_darwin.go` — custom NSView subclass overriding `mouseDownCanMoveWindow` + `hitTest:` per rect
- `sidecar/panels_linux.go` — `gdk_window_input_shape_combine_region` with cairo region built from rects
- `ui/src/ambient/Pebble.tsx` — call `panel.set_interactive_regions` on every layout change (idle = pebble bounds; bubble open = pebble + bubble bounds)

### Bridge from page → sidecar

The pebble page already has a WS to the daemon. Add a thin RPC helper:
```ts
// page calls
sidecarRpc('panel.set_interactive_regions', {
  id: 'pebble',
  rects: [{x: 0, y: 0, w: 22, h: 22}, ...]  // pebble + maybe bubble
});
```
Daemon forwards to sidecar via existing dispatchRPC.

**Acceptance:** With T3 active, clicking on the desktop near the pebble (but not on it) lands on whatever's underneath. Clicking the pebble or bubble buttons works. The window's "shape" is just the visible UI.

---

## T4 — WebView2 transparent background (Win11)

The hardest of the four. webview_go doesn't expose `ICoreWebView2Controller2.put_DefaultBackgroundColor`, so WebView2 paints its content area opaque white regardless of `body { background: transparent }`.

**Three viable paths:**

1. **Custom COM cgo binding (cleanest, most work):** call `webView->QueryInterface(IID_ICoreWebView2Controller2)` from inside our panel runtime. Need Windows IID GUIDs and COM marshalling code in `panels_windows.go`.
2. **Fork webview_go (medium work):** add a `SetBackgroundColor(r, g, b, a)` method upstream or in a fork; pin the fork in `go.mod`.
3. **LWA_COLORKEY fallback (quickest, hacky):** make body bg a unique magenta `#FF00FE`; window uses `SetLayeredWindowAttributes(hwnd, RGB(0xFF,0x00,0xFE), 0, LWA_COLORKEY)` so that exact colour is treated as transparent. Pebble + bubble keep their paper colours and render correctly.

Recommend (3) for W2 to ship fast; (1) or (2) as a follow-up.

**Acceptance:** Pebble window content is see-through to the desktop except where the pebble + bubble are drawn.

---

## T5 — Wire daemon → pebble state via WebSocket

**Files:**
- `src/daemon/ws-service.ts` — new broadcast method `broadcastPebbleState(state)`
- `src/daemon/index.ts` — call it on wake-word fire / LLM lifecycle hooks
- `ui/src/ambient/main.tsx` — open WS connection to `ws://localhost:3142/ws` on mount
- `ui/src/ambient/Pebble.tsx` — subscribe to `pebble.state` messages

**Acceptance:** From the daemon REPL or a test endpoint, push `{type: 'pebble.state', state: 'listening'}` → pebble enters listening state without any user action. Wake-word and LLM hooks can now drive the UI.

---

## Definition of Done (Week 2)

- [ ] Pebble window follows cursor across the whole screen at 60fps with no perceptible lag (< 30ms).
- [ ] `Ctrl+Space` summons listening from any focused app.
- [ ] Clicks land on whatever is behind the pebble window except where the pebble or bubble is drawn.
- [ ] Pebble window has a transparent background (or LWA_COLORKEY equivalent) so only the riso surfaces are visible.
- [ ] Daemon can drive pebble state changes via WS push.
- [ ] No regression to W1 features (build, tests, daemon spawn, riso aesthetic).

---

## Open architectural questions

1. **Windowed-mode fallback.** What happens on systems where transparent + always-on-top + click-through don't compose cleanly (some Linux compositors, Win10)? Fall back to a fixed-position floating widget like W1, or hide the pebble entirely?
2. **Multi-monitor.** Does the pebble follow the cursor across monitor boundaries? `GetCursorPos` returns virtual-screen coords on Windows; need to verify the move call works across displays.
3. **Fullscreen apps.** Does the pebble appear over fullscreen video / games? On Windows, `WS_EX_TOPMOST` typically loses to exclusive-fullscreen apps. Acceptable for W2 — note as known limitation.
4. **Wayland.** XGrabKey only works on X11. Wayland needs `xdg-shell` global shortcuts protocol or per-compositor hacks. Defer Wayland support past W2.

---

## What W2 explicitly does NOT do

Pushed to W3:
- LLM streaming into the bubble
- TTS streaming for speaking state
- Wake-word integration (the hook from T5 makes this trivial in W3)
- Cmd+K palette in the native window (W4 in original plan)
- Spawning panels other than the pebble (workflows, vault, etc. — W4)
