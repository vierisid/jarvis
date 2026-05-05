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
