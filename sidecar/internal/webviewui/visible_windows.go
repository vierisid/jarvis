//go:build windows

package webviewui

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32VisibleDLL = windows.NewLazySystemDLL("user32.dll")
	procShowWindowUI = user32VisibleDLL.NewProc("ShowWindow")
)

// setWindowVisible shows/hides an HWND. SW_HIDE=0, SW_SHOW=5 — same semantics
// as the sidecar panels' platformSetWindowVisible.
func setWindowVisible(handle unsafe.Pointer, visible bool) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	cmd := uintptr(0) // SW_HIDE
	if visible {
		cmd = uintptr(5) // SW_SHOW
	}
	procShowWindowUI.Call(uintptr(handle), cmd)
	return nil
}
