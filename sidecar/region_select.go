package main

// Cross-platform region selection — drag-select a screen rectangle and
// return the captured pixels as PNG. Used by T19's "help with this"
// flow: the sidecar overlays a translucent fullscreen window, the user
// drags a rect, the sidecar BitBlts the selected pixels and emits a
// `region.captured` event with the PNG bytes.
//
// Platform implementations live in region_select_<os>.go behind build
// tags. Public interface is identical across platforms; non-Windows
// platforms ship stubs for now (T19b will port macOS / Linux).

// RegionSelectionService starts a single drag-select interaction. The
// callbacks fire exactly once: either onCapture with a PNG buffer (the
// user picked a rect and released the mouse) or onCancel (the user
// pressed Esc, right-clicked, or moved out of any drag without
// selecting a non-trivial rect).
type RegionSelectionService interface {
	// Start spawns the overlay and begins listening. Returns once the
	// overlay is displayed; the actual selection completes asynchronously
	// and fires one of the two callbacks. Returns an error if a
	// selection is already in progress or the overlay can't be created.
	Start(onCapture func(png []byte, width, height int), onCancel func()) error
}

// regionMinDragPx is the smallest drag (px, per axis) treated as a real
// selection. Anything smaller is an accidental click and cancels the capture.
// Shared across platforms so the "too small to mean it" feel stays identical.
const regionMinDragPx = 6

// normalizeRegionRect orders two drag corners into a top-left origin plus
// width/height. Pure geometry shared by every platform's drag handler.
func normalizeRegionRect(x0, y0, x1, y1 int) (x, y, w, h int) {
	if x1 < x0 {
		x0, x1 = x1, x0
	}
	if y1 < y0 {
		y0, y1 = y1, y0
	}
	return x0, y0, x1 - x0, y1 - y0
}

// regionDragTooSmall reports whether a drag of (w,h) is below the minimum and
// should be treated as a cancel rather than a capture.
func regionDragTooSmall(w, h int) bool {
	return w < regionMinDragPx || h < regionMinDragPx
}
