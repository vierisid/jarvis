package main

// Pebble overlay — native per-platform rendered floating cursor companion.
//
// Architecture (replaces the abandoned webview-based pebble):
//   - One layered/transparent native window per OS
//   - Rendered with native drawing primitives (GDI+ on Windows, Core Graphics
//     on macOS, Cairo on Linux) — no browser, no webview, no transparency hacks
//   - Cursor polled at 60fps; window position SetWindowPos'd with eased
//     physics matching the mock
//   - State machine drives the visible glyph (idle dot / listening waveform /
//     thinking dots / speaking bars / working amber-pulse)
//
// The implementation lives in pebble_overlay_<os>.go behind build tags. This
// file is the cross-platform interface + state types only.

// PebbleState mirrors the React state machine used in the design mock.
type PebbleState string

const (
	PebbleIdle      PebbleState = "idle"
	PebbleListening PebbleState = "listening"
	PebbleThinking  PebbleState = "thinking"
	PebbleSpeaking  PebbleState = "speaking"
	PebbleWorking   PebbleState = "working"
	PebbleAsking    PebbleState = "asking" // amber — waiting on your approval/authority
	PebbleDone      PebbleState = "done"   // green flash — job landed
	PebbleMuted     PebbleState = "muted"  // mic muted — quiet, no chroma
)

// PebbleSpec configures the overlay at spawn time.
type PebbleSpec struct {
	// CursorOffsetX/Y is the pixel offset from the OS cursor at which the
	// pebble's centre is rendered. (14, 16) keeps the cursor outside the
	// pebble's visible disc with a comfortable companion distance.
	CursorOffsetX int `json:"cursor_offset_x"`
	CursorOffsetY int `json:"cursor_offset_y"`

	// SummonHotkey, if non-empty, registers a global hotkey that toggles
	// listening/idle and shows/hides the bubble. Default "ctrl+space".
	SummonHotkey string `json:"summon_hotkey"`

	// PaletteHotkey, if non-empty, registers a second global hotkey that
	// fires the OnPalette callback. Used by the Cmd+K / Ctrl+K palette to
	// open a fuzzy room picker at the cursor. Default "ctrl+k".
	PaletteHotkey string `json:"palette_hotkey"`
}

// PebbleService is the platform-agnostic API for the native pebble overlay.
// One pebble exists per sidecar at most; callers spawn it once and update
// state via SetState.
type PebbleService interface {
	// Spawn creates and shows the pebble overlay. Idempotent — calling
	// while already spawned is a no-op (returns nil).
	Spawn(spec PebbleSpec) error

	// SetState transitions the pebble to a new visual state. Triggers a
	// repaint on the next frame. Calling while not spawned returns an error.
	SetState(state PebbleState) error

	// SetText updates the body line shown in the bubble (listening hint,
	// speaking transcript). Empty string falls back to the default per-state
	// copy. Safe to call before Spawn — value is just stashed until paint.
	SetText(text string) error

	// PointAt animates the pebble to a fixed virtual-screen position
	// for `durationMs` milliseconds, showing `label` in the bubble. After
	// the duration expires the previous state + text are restored and
	// the pebble resumes cursor-follow. Used by T8's `[POINT:x,y:label]`
	// LLM tags — Clicky-style "click here" UX.
	PointAt(x, y int, label string, durationMs int) error

	// SetEye toggles the eye glyph that visualises awareness/OCR firing.
	// Daemon turns it on when sidecar emits a screen_capture event,
	// clears it after a short timeout. Safe before Spawn.
	SetEye(active bool) error

	// SetAnswerOverflow tells the pebble that the current speaking response
	// is too long to fully fit in the bubble. The sidecar paints an
	// "open full ↗" button; on click it emits pebble.open_answer with
	// `answerID` so the daemon can spawn a markdown panel. Empty string
	// clears the button. Safe before Spawn.
	SetAnswerOverflow(answerID string) error

	// SetBlinded marks awareness as hard-paused. The pebble dims and
	// shows a struck-through eye. Persists across SetState. Safe before
	// Spawn (value just stashed).
	SetBlinded(blinded bool) error

	// SetEthereal configures ethereal mode: when enabled, the pebble fades out
	// after staying idle for idleSeconds and pops back in (a faster animation
	// than the fade-out) the moment it next becomes active. Live-updatable from
	// settings and safe to call before Spawn (the values are just stored).
	SetEthereal(enabled bool, idleSeconds int)

	// Close hides + destroys the overlay. Idempotent.
	Close() error

	// OnSummon registers a callback fired each time the user triggers the
	// summon hotkey (Ctrl+Space). The callback runs on whatever goroutine
	// the hotkey listener uses; receivers should not block.
	//
	// The pebble itself does NOT change state on summon — it leaves that
	// to the brain. The callback is the sidecar's signal to the daemon
	// ("user wants attention"); the daemon then drives state transitions
	// via SetState (listening → thinking → speaking → idle, or whatever
	// the voice/LLM lifecycle dictates).
	OnSummon(callback func())

	// OnPalette registers a callback fired when the user triggers the
	// palette hotkey (Ctrl+K). Same threading and non-blocking contract as
	// OnSummon. The callback drives the daemon's palette open/close flow.
	OnPalette(callback func())

	// OnBlindToggle (W6-T2) registers a callback fired when the user
	// long-presses the pebble disc. The daemon flips awareness.enabled
	// in config and dispatches pebble.set_blinded.
	OnBlindToggle(callback func())

	// OnAnswerOpen registers a callback fired when the user clicks the
	// "open full ↗" button on the speaking bubble. The callback receives
	// the answer id that SetAnswerOverflow was called with. Threading:
	// runs on a fresh goroutine.
	OnAnswerOpen(callback func(answerID string))
}

// NewPebbleService returns the platform-specific implementation. Defined in
// pebble_overlay_<os>.go.
//
// (declared here so callers in main.go / client.go can construct one without
// per-platform imports; each platform file provides the body.)
