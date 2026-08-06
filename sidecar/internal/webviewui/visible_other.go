//go:build !windows && !darwin && !linux

package webviewui

import "unsafe"

// setWindowVisible is a no-op on platforms without a webview backend.
func setWindowVisible(handle unsafe.Pointer, _ bool) error {
	return nil
}
