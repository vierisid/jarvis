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

	// Close hides + destroys the overlay. Idempotent.
	Close() error
}

// NewPebbleService returns the platform-specific implementation. Defined in
// pebble_overlay_<os>.go.
//
// (declared here so callers in main.go / client.go can construct one without
// per-platform imports; each platform file provides the body.)
