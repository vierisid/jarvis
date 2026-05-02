//go:build !windows && !linux && !darwin

package main

import (
	"fmt"
	"unsafe"
)

func applyPlatformFlags(handle unsafe.Pointer, spec PanelSpec) error {
	return fmt.Errorf("panel service not supported on this platform")
}

func platformFocusWindow(handle unsafe.Pointer) error {
	return fmt.Errorf("panel service not supported on this platform")
}

func platformGetCursorPos() (int, int, error) {
	return 0, 0, fmt.Errorf("cursor follow not supported on this platform")
}

func platformMoveWindow(handle unsafe.Pointer, x, y int) error {
	return fmt.Errorf("window move not supported on this platform")
}
