//go:build darwin

package main

// C→Go bridge for the macOS tray (separate file per the cgo //export-vs-C-
// definitions rule). Called on the main thread when the "Close" menu item fires.

import "C"

//export goTrayClose
func goTrayClose() {
	// Runs on the Cocoa main thread; do the shutdown (client.Stop closes the WS +
	// services) off-thread so we don't block the run loop. Cancelling the context
	// makes the ctx-watcher quit NSApp.
	if trayOnCloseDarwin != nil {
		go trayOnCloseDarwin()
	}
}
