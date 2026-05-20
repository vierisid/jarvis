package main

// Sub-pebble overlays — one per backgrounded sub-agent, docked in a
// vertical column on the right edge of the primary monitor.
//
// Inspired by Clicky's "the cursor companion splits and the sub-agent
// version flies to the right rail" pattern. Each sub-pebble is its own
// always-on-top layered window rendered natively (same Win32 / GDI+
// pipeline as the main pebble in pebble_overlay_windows.go), with:
//
//   - A stable color from a small palette (round-robin assigned by the
//     daemon so multiple sub-agents are visually distinct)
//   - A state-driven visual (running pulses faster, completed sits solid,
//     failed turns vermilion)
//   - A vertical slot index so multiple sub-pebbles stack from the top
//
// Click-to-inspect bubble + voice "close X" intent are Phase B.

// SubPebbleColor is the small palette of accent tints. The daemon assigns
// one per sub-agent so visually-distinguishable simultaneous tasks are
// possible without writing names on the rail.
type SubPebbleColor string

const (
	SubPebbleAmber     SubPebbleColor = "amber"
	SubPebbleSage      SubPebbleColor = "sage"
	SubPebbleViolet    SubPebbleColor = "violet"
	SubPebbleVermilion SubPebbleColor = "vermilion"
	SubPebbleMustard   SubPebbleColor = "mustard"
	SubPebbleTeal      SubPebbleColor = "teal"
)

// SubPebbleSpec configures a sub-pebble at spawn time. ID must be unique
// per active sub-pebble — the daemon uses the taskManager task id.
type SubPebbleSpec struct {
	ID    string         `json:"id"`
	Color SubPebbleColor `json:"color"`
	Slot  int            `json:"slot"`  // 0 = topmost; spacing handled in the implementation
	Label string         `json:"label"` // future bubble label (Phase B)
	State PebbleState    `json:"state"` // initial — usually PebbleWorking
}

// SubPebbleService is the platform-agnostic API. Multi-instance: callers
// spawn one per concurrent sub-agent and address them by ID afterwards.
type SubPebbleService interface {
	// Spawn creates a new sub-pebble overlay. Calling with an existing ID
	// is a no-op (returns nil) so daemon retries don't duplicate windows.
	Spawn(spec SubPebbleSpec) error

	// SetState transitions an existing sub-pebble to a new visual state.
	// Returns an error if the ID isn't currently spawned.
	SetState(id string, state PebbleState) error

	// SetColor recolors a sub-pebble. Used to swap to vermilion when a
	// task fails since the spawn color is otherwise stable across the
	// agent's lifetime.
	SetColor(id string, color SubPebbleColor) error

	// SetLabel updates the cached label for the sub-pebble.
	SetLabel(id string, label string) error

	// SetExpanded toggles the click-to-inspect bubble. Daemon supplies
	// the agent name, task line, result preview, and elapsed seconds so
	// the sidecar can render them without re-querying.
	SetExpanded(id string, expanded bool, agent, task, result string, elapsedS int) error

	// Close destroys a single sub-pebble overlay. Idempotent.
	Close(id string) error

	// CloseAll destroys every active sub-pebble. Called on sidecar
	// shutdown so we don't leak overlay windows.
	CloseAll() error

	// OnClick registers a callback invoked when the user clicks a
	// sub-pebble disc. The callback receives the clicked sub-pebble's
	// id. Threading: runs on a fresh goroutine — receivers should not
	// block.
	OnClick(callback func(id string))

	// OnOpenFull registers a callback invoked when the user clicks the
	// "open full" button inside the expanded bubble. The daemon spawns a
	// dedicated native window with the full task result.
	OnOpenFull(callback func(id string))
}

// NewSubPebbleService returns the platform-specific implementation. Each
// pebble_overlay_<os>.go-style file provides the body so this compiles on
// every target.
//
// (Declared here so callers in main.go / client.go can construct one
// without per-platform imports.)
