//go:build linux

package main

// C→Go bridges for the Linux region overlay. Separate file because a cgo file
// using //export must not also define C functions (region_select_linux.go has
// the C definitions). These run on the GTK main thread (the C event handlers
// invoke them), so the active selection's finish/cancel may call the C crop/
// close helpers directly.

import "C"

//export goRegionFinish
func goRegionFinish(x0, y0, x1, y1 C.int) {
	if s := activeRegionLinux.Load(); s != nil {
		s.finish(int(x0), int(y0), int(x1), int(y1))
	}
}

//export goRegionCancel
func goRegionCancel() {
	if s := activeRegionLinux.Load(); s != nil {
		s.cancel()
	}
}
