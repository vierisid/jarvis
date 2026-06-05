//go:build darwin

package main

// C→Go bridge for the macOS hotkey monitor (separate file per the cgo
// //export-vs-C-definitions rule). Called from the NSEvent global monitor block.

import "C"

//export goHotkeyFire
func goHotkeyFire(id C.ulonglong) {
	if v, ok := hotkeyRegDarwin.Load(uint64(id)); ok {
		if fn, ok := v.(func()); ok && fn != nil {
			go fn()
		}
	}
}
