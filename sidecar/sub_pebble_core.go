package main

// Cross-platform sub-pebble policy: rail layout geometry, the accent colour
// palette, and small formatting helpers. These are product/UX decisions with
// no platform dependency, kept here (not in sub_pebble_*_windows.go) so a
// future macOS/Linux port renders an identical rail instead of re-deriving
// values that would silently drift. Platform files own only the actual window
// and drawing primitives.

import "fmt"

const (
	// subPebbleRightMargin is the distance from the disc's centre to the right
	// edge of the primary monitor. Tightens "this lives on the rail" without
	// clipping the disc against the bezel.
	subPebbleRightMargin = 22

	// subPebbleTopMargin / subPebbleSlotSpacing decide the vertical layout.
	// Slot 0 sits subPebbleTopMargin px from the top; subsequent slots step
	// down by subPebbleSlotSpacing.
	subPebbleTopMargin   = 96
	subPebbleSlotSpacing = 42

	// Bubble dimensions/offsets — the paper card shown to the LEFT of the disc
	// when a sub-pebble is expanded. Height is dynamic (compact vs tall); see
	// bubbleHeightForEntry. Width is generous enough to read a sentence-length
	// task; the tall variant fits a 3-line result clamp.
	subPebbleBubbleW        = 304 // grew 230→304 (founder: "still very small to see")
	subPebbleBubbleHCompact = 124
	subPebbleBubbleHTall    = 236
	subPebbleBubbleOffset   = 14 // gap between disc edge and bubble's right edge
	subPebbleBubbleAnchorY  = 24 // top of bubble relative to the disc's y axis
	subPebbleBubbleInnerPad = 16 // px from the bubble's outer edge to the text rect

	// "open full" button inside the bubble (spawns a native window with the
	// full task result), anchored to the bubble's bottom-right.
	subPebbleButtonW      = 112
	subPebbleButtonH      = 26
	subPebbleButtonInsetR = 12 // gap from bubble right edge to button right edge
	subPebbleButtonInsetB = 10 // gap from bubble bottom to button bottom
)

// subPebbleRGB returns the (R,G,B) accent for a palette colour. Each is
// hand-picked to look right against the paper-toned disc + ink border. This is
// the canonical palette; platform renderers consume it rather than redefining
// their own.
func subPebbleRGB(c SubPebbleColor) (r, g, b uint8) {
	switch c {
	case SubPebbleSage:
		return 0x4A, 0x7C, 0x3F
	case SubPebbleViolet:
		return 0x6E, 0x53, 0x9C
	case SubPebbleVermilion:
		return 0xE6, 0x3B, 0x2E
	case SubPebbleMustard:
		return 0xB7, 0x8A, 0x1E
	case SubPebbleTeal:
		return 0x2E, 0x7A, 0x82
	case SubPebbleAmber:
		fallthrough
	default:
		return 0xE5, 0xA9, 0x1E
	}
}

// formatSubPebbleElapsed renders the bubble's elapsed-seconds counter: "42s"
// under a minute, "3m07s" beyond.
func formatSubPebbleElapsed(s int) string {
	if s < 60 {
		return fmt.Sprintf("%ds", s)
	}
	return fmt.Sprintf("%dm%02ds", s/60, s%60)
}
