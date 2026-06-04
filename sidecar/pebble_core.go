package main

// Cross-platform pebble policy: cursor-follow easing, interaction timings, and
// the default per-state bubble copy. These are product/UX decisions with no
// platform dependency.
//
// The Windows renderer consumes these symbols directly. The macOS (Cocoa) and
// Linux (GTK) renderers embed the same values inside their draw code — cgo C
// can't reference a Go constant, so those literals must be kept in sync with
// the canonical definitions here. Centralising them gives one source of truth
// (the values had already drifted across the three platform files) and lets a
// future Go-level port reuse them verbatim.

const (
	// pebbleFollowFactor is the per-frame cursor-follow easing — the "lagging
	// companion" feel. pebblePointFollowFactor is the snappier ease used while
	// the pebble flies to a fixed [POINT:..] target so it spends more of the
	// hold window parked at the target rather than animating.
	pebbleFollowFactor      = 0.18
	pebblePointFollowFactor = 0.42

	// pebbleLongPressMs is the disc press duration that flips awareness (the
	// blind toggle); a shorter press is a summon click.
	pebbleLongPressMs = 500
	// pebbleDiscHitRadius is the clickable disc radius (px from disc centre).
	pebbleDiscHitRadius = 18

	// pebbleAnchorX/Y is where the disc centre is drawn within the overlay
	// window; the window is positioned so this anchor lands at (cursor +
	// offset). Shared because it's identical across renderers (the window
	// SIZE differs per platform, but the anchor does not).
	pebbleAnchorX = 40
	pebbleAnchorY = 28
)

// defaultPebbleBodyText is the placeholder bubble copy for a state when no
// dynamic text (live transcript / response) has been set. This is the
// canonical copy — the Cocoa/GTK renderers hardcode the same strings and must
// match.
func defaultPebbleBodyText(state PebbleState) string {
	switch state {
	case PebbleListening:
		return "listening — go ahead."
	case PebbleSpeaking:
		return "speaking…"
	default:
		return ""
	}
}
