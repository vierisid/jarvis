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

func platformGetWindowRect(handle unsafe.Pointer) (int, int, int, int, error) {
	return 0, 0, 0, 0, fmt.Errorf("window rect not supported on this platform")
}

func platformMoveWindowKeepZOrder(handle unsafe.Pointer, x, y int) error {
	return fmt.Errorf("window move not supported on this platform")
}

func platformSetInteractiveRegions(handle unsafe.Pointer, rects []PanelRect) error {
	return fmt.Errorf("region shaping not supported on this platform")
}

func platformSetClickThrough(handle unsafe.Pointer, clickThrough bool) error {
	return fmt.Errorf("click-through not supported on this platform")
}

func platformGetScreenSize() (int, int) {
	return 1920, 1080
}

func platformGetVirtualScreenOrigin() (int, int) {
	return 0, 0
}

func platformReassertTopmost(handle unsafe.Pointer) error {
	return nil
}

func platformSetWindowState(handle unsafe.Pointer, state PanelWindowState) error {
	return fmt.Errorf("set window state not supported on this platform")
}

func platformSetWindowVisible(handle unsafe.Pointer, _ bool) error {
	return nil
}

func platformWindowAlive(handle unsafe.Pointer) bool { return handle != nil }

// registerPanelCloseWatch is macOS-only (NSWindowWillCloseNotification).
func registerPanelCloseWatch(_ unsafe.Pointer, _ *panelImpl) {}

func platformDestroyWindow(handle unsafe.Pointer) error {
	return fmt.Errorf("destroy window not supported on this platform")
}
