package main

import (
	"errors"
	"fmt"
	"sync"

	"github.com/google/uuid"
)

// PanelID uniquely identifies a spawned native panel window.
type PanelID string

// PanelBounds describes window geometry. Use -1 for X or Y to mean
// "spawn near the user's cursor"; use 0 for W or H to mean "use default".
type PanelBounds struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// PanelRect is a single interactive (and visible) region within a panel
// window, expressed in window-relative pixels. Optional Radius creates a
// rounded rectangle (or a circle when Radius >= W/2 = H/2).
//
// Pixels outside the union of all PanelRects are made fully click-through
// AND non-rendered by the platform (Win32 SetWindowRgn / GTK input/visible
// shape regions), so the rest of the OS window is effectively absent.
type PanelRect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	W      int `json:"w"`
	H      int `json:"h"`
	Radius int `json:"radius,omitempty"`
}

// PanelSpec is the full specification for a panel window. It is sent from
// the daemon to the sidecar via the panel.spawn RPC.
type PanelSpec struct {
	ID            PanelID     `json:"id"`
	URL           string      `json:"url"`
	Title         string      `json:"title"`
	Bounds        PanelBounds `json:"bounds"`
	Frameless     bool        `json:"frameless"`
	AlwaysOnTop   bool        `json:"always_on_top"`
	ClickThrough  bool        `json:"click_through"`
	Transparent   bool        `json:"transparent"`
	Resizable     bool        `json:"resizable"`
	MultiInstance bool        `json:"multi_instance"`
	// FollowCursor turns on the sidecar-side cursor-tracking goroutine
	// that polls platformGetCursorPos() at ~60fps and moves the window
	// to (cursor + offset). The page can pause tracking via the
	// panel.set_follow RPC when it wants the window to stay put (e.g.
	// while the bubble is open).
	FollowCursor bool `json:"follow_cursor"`
	// CursorOffsetX/Y is the pixel offset applied to (cursor.x, cursor.y)
	// when computing the window's top-left position. Defaults to (24, 28)
	// when both are zero — keeps the cursor above-left of the pebble so
	// it never sits on top of the visible pixels.
	CursorOffsetX int `json:"cursor_offset_x"`
	CursorOffsetY int `json:"cursor_offset_y"`
	// SummonHotkey, if non-empty, registers a global OS hotkey that
	// toggles cursor-follow on this panel and dispatches a JS callback
	// in the page (`window.__pebble_summon` / `window.__pebble_dismiss`)
	// to set the visual state. Format: "ctrl+space", "alt+j", etc.
	// Currently only "ctrl+space" is supported (Win11). Returns an error
	// silently logged on platforms where global hotkeys aren't wired yet
	// (macOS / Linux); the panel still spawns and follows cursor.
	SummonHotkey string `json:"summon_hotkey"`
	// Fullscreen sizes the window to the primary monitor and disables
	// window movement (the Clicky pattern). The page is responsible for
	// rendering the pebble at the cursor's screen position via CSS
	// transform; the sidecar feeds cursor positions to the page via
	// __pebble_set_cursor invoked through wv.Eval at ~60fps.
	Fullscreen bool `json:"fullscreen"`
}

// PanelService manages the lifecycle of native panel windows.
//
// Implementations are platform-specific (panels_windows.go, panels_darwin.go,
// panels_linux.go) and share the in-memory registry maintained here.
type PanelService interface {
	Spawn(spec PanelSpec) (PanelID, error)
	Close(id PanelID) error
	Focus(id PanelID) error
	List() []PanelID
	// SetFollow toggles the cursor-tracking goroutine for a panel that was
	// spawned with FollowCursor=true. The page calls this to pause tracking
	// when the bubble opens (so the window stops jittering while the user
	// reaches for buttons) and resumes when the bubble dismisses.
	SetFollow(id PanelID, follow bool) error
	// SetInteractiveRegions defines the visible + clickable shape of the
	// panel window. Anything outside the union of rects becomes
	// non-rendered AND click-through to the desktop. Page calls this on
	// every layout change so the OS window matches the rendered UI.
	// Note: kept for cross-platform parity (Linux uses it for click-through)
	// but Windows skips it in favour of dynamic WS_EX_TRANSPARENT toggling
	// since SetWindowRgn crops the layered+transparent window's contents.
	SetInteractiveRegions(id PanelID, rects []PanelRect) error
	// SetClickThrough toggles whole-window click-through (Win32
	// WS_EX_TRANSPARENT). When true, every click passes through to the
	// desktop including over the visible UI; when false, the window grabs
	// all clicks in its bounds. Page calls this on state transitions:
	// idle = true (cursor passes through), listening = false (bubble
	// buttons clickable).
	SetClickThrough(id PanelID, clickThrough bool) error
	// SetWindowState transitions a panel to one of three OS-level states:
	// "normal" (restored), "minimized" (taskbar), "maximized" (fullscreen-
	// like). Used by T18b voice commands ("expand", "minimize", "restore").
	SetWindowState(id PanelID, state PanelWindowState) error
	// OnBoundsChanged registers a callback fired whenever a spawned panel's
	// screen-space bounds change (user drag, resize, or maximize). The
	// callback runs from a poll goroutine — receivers should not block on
	// network or disk I/O directly; dispatch onto a separate goroutine if
	// they need to. Bounds are reported in OS pixel coordinates as
	// (x, y, w, h). Only called once per change; identical consecutive
	// readings are deduped inside the poll.
	OnBoundsChanged(cb func(id PanelID, x, y, w, h int))
	// OnClosed registers a callback fired once when a spawned panel's window
	// goes away — whether the user closed it or Close() was called. Lets the
	// daemon untrack panels so its inventory doesn't accumulate stale entries.
	// Runs from the panel's goroutine after its event loop exits; receivers
	// should not block.
	OnClosed(cb func(id PanelID))
	Stop()
}

// PanelWindowState mirrors the three OS-level window states a panel can
// take. Maps to ShowWindow on Win32, miniaturize/zoom on Cocoa, and
// gtk_window_iconify/maximize on GTK.
type PanelWindowState string

const (
	PanelWindowNormal    PanelWindowState = "normal"
	PanelWindowMinimized PanelWindowState = "minimized"
	PanelWindowMaximized PanelWindowState = "maximized"
)

// panelRegistry is the cross-platform bookkeeping layer. Platform impls embed
// this and add a platform-specific window handle per entry.
type panelRegistry struct {
	mu      sync.Mutex
	entries map[PanelID]*panelEntry
}

type panelEntry struct {
	spec PanelSpec
	// platform-specific handle is attached by the platform impl
	handle any
}

func newPanelRegistry() *panelRegistry {
	return &panelRegistry{entries: make(map[PanelID]*panelEntry)}
}

func (r *panelRegistry) put(id PanelID, e *panelEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries[id] = e
}

func (r *panelRegistry) get(id PanelID) (*panelEntry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.entries[id]
	return e, ok
}

func (r *panelRegistry) delete(id PanelID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.entries, id)
}

func (r *panelRegistry) ids() []PanelID {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]PanelID, 0, len(r.entries))
	for id := range r.entries {
		out = append(out, id)
	}
	return out
}

// validateSpec rejects specs that would obviously fail at the platform layer.
func validateSpec(spec PanelSpec) error {
	if spec.URL == "" {
		return errors.New("panel spec missing required field: url")
	}
	return nil
}

// resolveSpec assigns an ID if the spec has none.
func resolveSpec(spec PanelSpec) PanelSpec {
	if spec.ID == "" {
		spec.ID = PanelID(uuid.NewString())
	}
	return spec
}

// ErrPanelUnknown is returned by Close/Focus when the id is not registered.
var ErrPanelUnknown = errors.New("panel not found")

// ErrPanelExists is returned by Spawn when a non-multi-instance panel with
// the same id is already open. Callers should Focus(id) instead.
var ErrPanelExists = errors.New("panel already exists")

// formatPanelError adds context to platform errors for clearer RPC responses.
func formatPanelError(op string, id PanelID, err error) error {
	if id == "" {
		return fmt.Errorf("panel.%s: %w", op, err)
	}
	return fmt.Errorf("panel.%s[%s]: %w", op, id, err)
}
