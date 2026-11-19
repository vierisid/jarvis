//go:build !darwin

package main

// panelLoopReady says whether a panel's window can be made now. Only macOS has
// to wait (panels_darwin.go): Windows runs a loop per window, and Linux makes
// its windows on the shared loop's own thread and waits for it there.
func panelLoopReady() bool { return true }
