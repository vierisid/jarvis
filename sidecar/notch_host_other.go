//go:build !windows && !darwin

package main

import (
	"fmt"
	"log"
	"unsafe"
)

// The notch's window is built for Windows and macOS first. Elsewhere the panel
// still opens, as an ordinary always-on-top panel at the top of the screen,
// without the shape, the focus rules or the fullscreen rule.

func platformNotchSetUp(handle unsafe.Pointer, done <-chan struct{}) {
	if handle == nil {
		return
	}
	screenW, _ := platformGetScreenSize()
	if err := platformMoveWindowKeepZOrder(handle, notchTopCentre(screenW, notchWindowW), 0); err != nil {
		log.Printf("[notch] placing the window: %v", err)
	}
}

func platformNotchReveal(handle unsafe.Pointer) {
	_ = platformSetWindowVisible(handle, true)
}

func platformNotchWindowSize(handle unsafe.Pointer) (int, int) {
	return notchWindowW, notchWindowH
}

func platformNotchSetOutline(handle unsafe.Pointer, outline []notchPoint) error {
	return fmt.Errorf("the notch's shape is not built for this system yet")
}

func platformNotchFocus(handle unsafe.Pointer, take bool) bool {
	if take {
		return platformFocusWindow(handle) == nil
	}
	return false
}
