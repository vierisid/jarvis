//go:build darwin

package main

// C→Go bridge for the macOS hotkey monitor (separate file per the cgo
// //export-vs-C-definitions rule). Called from the NSEvent global monitor block.

import "C"

//export goHotkeyFire
func goHotkeyFire(id C.ulonglong) {
	// Same dispatcher as linux, and for the same defect (#587): this used to
	// load the callback out of a sync.Map and launch `go fn()`, so a press
	// could start a callback after stop() had returned.
	//
	// It matters more here than it looks. The monitor block runs on the main
	// run loop while stop() runs on an RPC goroutine, so a block invocation
	// already in flight can reach this after removeMonitor: has been called.
	// Deregistering before removing the monitor (see startHotkeyListener)
	// already made that a no-op for the C side; this makes it a no-op for the
	// goroutine the block would otherwise have spawned.
	hotkeyDispatcher.dispatch(uint64(id))
}
