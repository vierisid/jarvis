//go:build darwin

package main

import "fmt"

// startHotkeyListener — macOS implementation deferred to a follow-up ticket
// (needs NSEvent addGlobalMonitorForEvents wired through cgo with a callback
// shim back to Go). For now it returns an error so the panel runtime falls
// back gracefully when a hotkey is requested on macOS.
func startHotkeyListener(keyspec string, onFire func()) (func(), error) {
	return nil, fmt.Errorf("global hotkeys not yet implemented on macOS (W2 follow-up)")
}
