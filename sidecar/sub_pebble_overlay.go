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

	// SetLabel updates the cached label for the sub-pebble. Used now for
	// debug logging; Phase B's click-to-inspect bubble will read it.
	SetLabel(id string, label string) error

	// Close destroys a single sub-pebble overlay. Idempotent.
	Close(id string) error

	// CloseAll destroys every active sub-pebble. Called on sidecar
	// shutdown so we don't leak overlay windows.
	CloseAll() error
}

// NewSubPebbleService returns the platform-specific implementation. Each
// pebble_overlay_<os>.go-style file provides the body so this compiles on
// every target.
//
// (Declared here so callers in main.go / client.go can construct one
// without per-platform imports.)
