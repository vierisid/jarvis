//go:build linux

package main

// C→Go bridge for the X11 hotkey listener (separate file per the cgo
// //export-vs-C-definitions rule). Called from the hotkey's poll() loop on a
// KeyPress.

import "C"

//export goHotkeyFire
func goHotkeyFire(id C.ulonglong) {
	// The claim happens HERE, synchronously on the listener thread, rather than
	// inside the dispatched goroutine (#587). Two reasons: a burst of queued
	// KeyPresses does not spawn a goroutine per press only for each to discover
	// it was already stopped, and the in-flight count is correct by the time
	// this returns, so a stop() racing this press reads the truth instead of a
	// value that is about to change.
	//
	// Once stop() has invalidated the registration this is a guaranteed no-op,
	// which is the whole point. The old code loaded the callback out of a
	// sync.Map and launched `go fn()` with nothing tying that goroutine to the
	// hotkey's lifetime, so a press could start a callback after stop() had
	// returned and the caller had begun tearing down whatever it touches.
	hotkeyDispatcher.dispatch(uint64(id))
}
