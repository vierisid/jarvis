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

// magicColorKey — magenta the page paints on body background. Win32 sees
// any pixel with this exact RGB and treats it as fully transparent. Since
// WebView2 doesn't expose a controller-level transparency API, this is the
// most reliable way to get see-through pebble windows on Windows.
// COLORREF format is 0x00BBGGRR. RGB(0xFE, 0x00, 0xFE) = magenta.
const magicColorKey = 0x00FE00FE

// HWND_TOPMOST is officially -1, encoded as the largest uintptr.
const hwndTopmost = ^uintptr(0)

// user32, procSetForegroundWindow, procShowWindow are already declared in
// uia_windows.go — reuse those. The procs below are panel-service specific.
var (
	procGetWindowLongW             = user32.NewProc("GetWindowLongW")
	procSetWindowLongW             = user32.NewProc("SetWindowLongW")
	procGetWindowLongPtrW          = user32.NewProc("GetWindowLongPtrW") // 64-bit
	procSetWindowLongPtrW          = user32.NewProc("SetWindowLongPtrW") // 64-bit
	procSetWindowPos               = user32.NewProc("SetWindowPos")
	procSetLayeredWindowAttributes = user32.NewProc("SetLayeredWindowAttributes")
	procGetCursorPos               = user32.NewProc("GetCursorPos")
	procSetWindowRgn               = user32.NewProc("SetWindowRgn")
	procGetSystemMetrics           = user32.NewProc("GetSystemMetrics")

	gdi32                  = syscall.NewLazyDLL("gdi32.dll")
	procCreateRectRgn      = gdi32.NewProc("CreateRectRgn")
	procCreateRoundRectRgn = gdi32.NewProc("CreateRoundRectRgn")
	procCombineRgn         = gdi32.NewProc("CombineRgn")
	procDeleteObject       = gdi32.NewProc("DeleteObject")
)

// Virtual screen metric indices — together describe the bounding rect of all
// connected monitors as a single coordinate space.
const (
	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCxVirtualScreen = 78
	smCyVirtualScreen = 79
)

// platformGetScreenSize returns the size of the virtual screen (the bounding
// box of all connected monitors) so a fullscreen panel covers every display.
func platformGetScreenSize() (w, h int) {
	cx, _, _ := procGetSystemMetrics.Call(uintptr(smCxVirtualScreen))
	cy, _, _ := procGetSystemMetrics.Call(uintptr(smCyVirtualScreen))
	return int(int32(cx)), int(int32(cy))
}

// platformGetVirtualScreenOrigin returns the top-left corner of the virtual
// screen — needed when secondary monitors extend left/up of the primary
// monitor (origin can be negative).
func platformGetVirtualScreenOrigin() (x, y int) {
	xv, _, _ := procGetSystemMetrics.Call(uintptr(smXVirtualScreen))
	yv, _, _ := procGetSystemMetrics.Call(uintptr(smYVirtualScreen))
	return int(int32(xv)), int(int32(yv))
}

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

	if spec.Transparent {
		// Don't call SetLayeredWindowAttributes when transparent — that
		// forces a Windows GDI compositing path that fights WebView2's
		// DirectComposition. Just leaving WS_EX_LAYERED set lets DComp
		// compose WebView2's alpha-blended content with the desktop.
		// The WEBVIEW2_DEFAULT_BACKGROUND_COLOR=0 env var (set in
		// panels_runtime.go before webview.New) makes WebView2's default
		// surface transparent; body { background: transparent } in CSS
		// then leaves only the explicitly-painted pebble + bubble pixels.
	} else if spec.ClickThrough {
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

func platformSetClickThrough(handle unsafe.Pointer, clickThrough bool) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	hwnd := uintptr(handle)
	exStyle := getWindowLong(hwnd, gwlExStyle)
	if clickThrough {
		exStyle |= wsExLayered | wsExTransparent
	} else {
		exStyle &^= wsExTransparent
		exStyle |= wsExLayered // keep layered for transparency compositing
	}
	setWindowLong(hwnd, gwlExStyle, exStyle)
	return nil
}

// platformReassertTopmost forces the window back to the top of the topmost
// z-band without moving or resizing it. Useful for fullscreen overlays that
// other always-on-top apps (taskbar, virtual keyboards, etc.) might bury.
func platformReassertTopmost(handle unsafe.Pointer) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	const swpNoMove = 0x0002
	procSetWindowPos.Call(
		uintptr(handle),
		hwndTopmost,
		0, 0, 0, 0,
		swpNoMove|swpNoSize|swpNoActivate,
	)
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

// POINT mirrors Win32 POINT — two LONGs (32-bit signed).
type w32Point struct {
	X int32
	Y int32
}

func platformGetCursorPos() (int, int, error) {
	var p w32Point
	r, _, err := procGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
	if r == 0 {
		return 0, 0, fmt.Errorf("GetCursorPos failed: %v", err)
	}
	return int(p.X), int(p.Y), nil
}

// platformSetInteractiveRegions takes ownership of newly-created HRGN handles
// and passes them to SetWindowRgn (which assumes ownership of the final
// combined region). Pixels outside the union are non-rendered AND
// click-through. Empty rects collapse to a 0×0 region (fully invisible).
func platformSetInteractiveRegions(handle unsafe.Pointer, rects []PanelRect) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	const RGN_OR = 2
	// Start with an empty region; OR each rect/round-rect into it.
	combined, _, _ := procCreateRectRgn.Call(0, 0, 0, 0)
	for _, r := range rects {
		var rgn uintptr
		if r.Radius > 0 {
			rgn, _, _ = procCreateRoundRectRgn.Call(
				uintptr(int32(r.X)),
				uintptr(int32(r.Y)),
				uintptr(int32(r.X+r.W)),
				uintptr(int32(r.Y+r.H)),
				uintptr(int32(r.Radius*2)),
				uintptr(int32(r.Radius*2)),
			)
		} else {
			rgn, _, _ = procCreateRectRgn.Call(
				uintptr(int32(r.X)),
				uintptr(int32(r.Y)),
				uintptr(int32(r.X+r.W)),
				uintptr(int32(r.Y+r.H)),
			)
		}
		if rgn != 0 {
			procCombineRgn.Call(combined, combined, rgn, RGN_OR)
			procDeleteObject.Call(rgn)
		}
	}
	// SetWindowRgn(hwnd, hRgn, bRedraw=TRUE) — Windows takes ownership of hRgn.
	procSetWindowRgn.Call(uintptr(handle), combined, 1)
	return nil
}

func platformMoveWindow(handle unsafe.Pointer, x, y int) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	// Re-assert HWND_TOPMOST on every frame so the window stays above
	// other apps even when they activate. SWP_NOZORDER would preserve
	// the current order, but topmost is sometimes demoted by Windows
	// when other windows take focus — passing HWND_TOPMOST here forces
	// the window back to the top of the topmost group every move.
	procSetWindowPos.Call(
		uintptr(handle),
		hwndTopmost,
		uintptr(int32(x)), uintptr(int32(y)),
		0, 0,
		swpNoSize|swpNoActivate,
	)
	return nil
}
