//go:build linux

package main

// C→Go bridge for the X11 hotkey listener (separate file per the cgo
// //export-vs-C-definitions rule). Called from the hotkey's select() loop on a
// KeyPress.

import "C"

//export goHotkeyFire
func goHotkeyFire(id C.ulonglong) {
	if v, ok := hotkeyReg.Load(uint64(id)); ok {
		if fn, ok := v.(func()); ok && fn != nil {
			go fn()
		}
	}
}
