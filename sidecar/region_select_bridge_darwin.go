//go:build darwin

package main

// C→Go bridge for the macOS region overlay (separate file per the cgo
// //export-vs-C-definitions rule). Called from the Cocoa event handlers on the
// main thread, so finish/cancel may call the C crop/close helpers directly.

import "C"

//export goRegionFinish
func goRegionFinish(x0, y0, x1, y1 C.int) {
	if s := activeRegionDarwin.Load(); s != nil {
		s.finish(int(x0), int(y0), int(x1), int(y1))
	}
}

//export goRegionCancel
func goRegionCancel() {
	if s := activeRegionDarwin.Load(); s != nil {
		s.cancel()
	}
}
