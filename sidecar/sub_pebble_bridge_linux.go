//go:build linux

package main

// C→Go bridges for the Linux sub-pebble overlay. Kept in its own file because a
// cgo file containing //export must not also define C functions in its preamble
// (sub_pebble_overlay_linux.go has the C definitions).

import "C"

// goSubPebbleClick is called from the GTK button-press handler with the clicked
// window's handle and window-local coordinates. The disc hit-test uses the same
// geometry the renderer drew with, then fires the OnClick callback with the
// sub-pebble's id.
//
//export goSubPebbleClick
func goSubPebbleClick(handle C.ulonglong, x, y C.int) {
	v, ok := subPebbleByHandleLinux.Load(uintptr(handle))
	if !ok {
		return
	}
	entry := v.(*subPebbleEntry)
	dx := int(x) - subPebbleLinuxAnchor
	dy := int(y) - subPebbleLinuxAnchor
	if dx*dx+dy*dy > subPebbleLinuxHitRadius*subPebbleLinuxHitRadius {
		return // outside the disc — ignore
	}
	if cbAny := subPebbleClickCallbackLinux.Load(); cbAny != nil {
		if cb, ok := cbAny.(func(string)); ok && cb != nil {
			go cb(entry.id)
		}
	}
}

// goSubSetMonitorRight is called from the create idle once the overlay's display
// is resolved, so the rail anchors to the right edge of the spawn monitor.
//
//export goSubSetMonitorRight
func goSubSetMonitorRight(handle C.ulonglong, right C.int) {
	if v, ok := subPebbleByHandleLinux.Load(uintptr(handle)); ok {
		v.(*subPebbleEntry).monitorRight.Store(int32(right))
	}
}

// subPebbleLinuxHitRadius is the disc click radius (slightly larger than the
// 9px visible disc so users don't have to land dead-on). Matches the Windows
// hitRadiusPx feel.
const subPebbleLinuxHitRadius = 16
