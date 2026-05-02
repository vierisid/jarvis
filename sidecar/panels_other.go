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
