//go:build linux

package main

import "fmt"

// startHotkeyListener — Linux implementation deferred. X11 needs XGrabKey on
// the root window plus a separate event loop in a dedicated display
// connection; Wayland needs the xdg-shell global shortcuts protocol or a
// per-compositor hack. Both are bigger than a single ticket allows; tracking
// as a W2 follow-up.
func startHotkeyListener(keyspec string, onFire func()) (func(), error) {
	return nil, fmt.Errorf("global hotkeys not yet implemented on Linux (W2 follow-up)")
}
