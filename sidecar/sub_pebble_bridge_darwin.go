//go:build darwin

package main

// C→Go bridge for the macOS sub-pebble overlay (separate file per the cgo
// //export-vs-C-definitions rule). Called from JarvisSubView.mouseDown on the
// main thread; Go does the disc hit-test with the shared geometry.

import "C"

//export goSubPebbleClick
func goSubPebbleClick(handle C.ulonglong, x, y C.int) {
	v, ok := subPebbleByHandleDarwin.Load(uintptr(handle))
	if !ok {
		return
	}
	entry := v.(*subPebbleEntry)
	dx := int(x) - subPebbleDarwinAnchor
	dy := int(y) - subPebbleDarwinAnchor
	if dx*dx+dy*dy > subPebbleDarwinHitRadius*subPebbleDarwinHitRadius {
		return
	}
	if cbAny := subPebbleClickCallbackDarwin.Load(); cbAny != nil {
		if cb, ok := cbAny.(func(string)); ok && cb != nil {
			go cb(entry.id)
		}
	}
}
