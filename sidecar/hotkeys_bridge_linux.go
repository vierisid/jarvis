//go:build linux

package main

// C→Go bridge for the X11 hotkey listener (separate file per the cgo
// //export-vs-C-definitions rule). Called from the hotkey's poll() loop on a
// KeyPress.

import "C"

//export goHotkeyFire
func goHotkeyFire(id C.ulonglong) {
	// Once stop() has invalidated the registration this is a guaranteed no-op,
	// which is the whole point of routing through the dispatcher (#587). The old
	// code loaded the callback out of a sync.Map and launched `go fn()` with
	// nothing tying that goroutine to the hotkey's lifetime, so a press could
	// start a callback after stop() had returned and the caller had begun
	// tearing down whatever it touches.
	//
	// dispatch does the claiming inside the goroutine it starts, deliberately;
	// see its comment for why doing it on this thread instead would give the
	// window straight back.
	hotkeyDispatcher.dispatch(uint64(id))
}
