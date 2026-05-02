//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

// Win32 GetWindowLong / SetWindowLong indices.
const (
	gwlExStyle = -20
	gwlStyle   = -16
)

// Win32 extended window styles.
const (
	wsExLayered     = 0x00080000
	wsExTransparent = 0x00000020
	wsExTopmost     = 0x00000008
	wsExNoActivate  = 0x08000000
	wsExToolWindow  = 0x00000080
)

// Win32 standard window styles.
const (
	wsOverlappedWindow = 0x00CF0000
	wsPopup            = 0x80000000
	wsCaption          = 0x00C00000
	wsThickFrame       = 0x00040000
	wsSysMenu          = 0x00080000
)

// SetWindowPos flags.
const (
	swpNoMove       = 0x0002
	swpNoSize       = 0x0001
	swpNoActivate   = 0x0010
	swpShowWindow   = 0x0040
	swpFrameChanged = 0x0020
)

// SetLayeredWindowAttributes flags.
const (
	lwaColorKey = 0x00000001
	lwaAlpha    = 0x00000002
)

// HWND_TOPMOST is officially -1, encoded as the largest uintptr.
const hwndTopmost = ^uintptr(0)

var (
	user32 = syscall.NewLazyDLL("user32.dll")

	procGetWindowLongW             = user32.NewProc("GetWindowLongW")
	procSetWindowLongW             = user32.NewProc("SetWindowLongW")
	procGetWindowLongPtrW          = user32.NewProc("GetWindowLongPtrW") // 64-bit
	procSetWindowLongPtrW          = user32.NewProc("SetWindowLongPtrW") // 64-bit
	procSetWindowPos               = user32.NewProc("SetWindowPos")
	procSetLayeredWindowAttributes = user32.NewProc("SetLayeredWindowAttributes")
	procSetForegroundWindow        = user32.NewProc("SetForegroundWindow")
	procShowWindow                 = user32.NewProc("ShowWindow")
)

func getWindowLong(hwnd uintptr, idx int32) uintptr {
	if proc := procGetWindowLongPtrW; proc.Find() == nil {
		v, _, _ := proc.Call(hwnd, uintptr(idx))
		return v
	}
	v, _, _ := procGetWindowLongW.Call(hwnd, uintptr(idx))
	return v
}

func setWindowLong(hwnd uintptr, idx int32, val uintptr) {
	if proc := procSetWindowLongPtrW; proc.Find() == nil {
		proc.Call(hwnd, uintptr(idx), val)
		return
	}
	procSetWindowLongW.Call(hwnd, uintptr(idx), val)
}

// applyPlatformFlags applies frameless, transparent, click-through and
// always-on-top flags to a HWND on Windows. Called once after the WebView2
// window has been created.
func applyPlatformFlags(handle unsafe.Pointer, spec PanelSpec) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	hwnd := uintptr(handle)

	exStyle := getWindowLong(hwnd, gwlExStyle)
	if spec.AlwaysOnTop {
		exStyle |= wsExTopmost
		exStyle |= wsExNoActivate
		exStyle |= wsExToolWindow // hide from Alt-Tab
	}
	if spec.ClickThrough {
		exStyle |= wsExLayered | wsExTransparent
	}
	if spec.Transparent {
		exStyle |= wsExLayered
	}
	setWindowLong(hwnd, gwlExStyle, exStyle)

	if spec.Transparent || spec.ClickThrough {
		// LWA_ALPHA with 255 = fully opaque window content; transparent
		// regions in the page (background: transparent on body) compose with
		// whatever is behind on the desktop.
		procSetLayeredWindowAttributes.Call(hwnd, 0, 255, lwaAlpha)
	}

	if spec.Frameless {
		style := getWindowLong(hwnd, gwlStyle)
		style &^= wsOverlappedWindow
		style &^= wsCaption | wsThickFrame | wsSysMenu
		style |= wsPopup
		setWindowLong(hwnd, gwlStyle, style)
	}

	if spec.AlwaysOnTop {
		procSetWindowPos.Call(hwnd,
			hwndTopmost,
			0, 0, 0, 0,
			swpNoMove|swpNoSize|swpNoActivate|swpShowWindow|swpFrameChanged,
		)
	}

	return nil
}

func platformFocusWindow(handle unsafe.Pointer) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	hwnd := uintptr(handle)
	const swShow = 5
	procShowWindow.Call(hwnd, swShow)
	procSetForegroundWindow.Call(hwnd)
	return nil
}
