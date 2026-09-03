//go:build windows

package winchrome

import (
	"log"
	"syscall"
	"unsafe"

	webview "github.com/webview/webview_go"
)

// GetWindowLong / SetWindowLong indices.
const gwlStyle = -16
const gwlExStyle = -20

// SetWindowPos flags.
const (
	swpNoSize       = 0x0001
	swpNoMove       = 0x0002
	swpNoZOrder     = 0x0004
	swpNoActivate   = 0x0010
	swpFrameChanged = 0x0020
)

// Messages and hit-test codes used by the caption drag / close path.
const (
	wmNCLButtonDown = 0x00A1
	wmNCRButtonUp   = 0x00A5
	wmClose         = 0x0010
	htCaption       = 2
)

// ShowWindow commands.
const (
	swMaximize = 3
	swMinimize = 6
	swRestore  = 9
)

// DWMWA_WINDOW_CORNER_PREFERENCE (33) with DWMWCP_ROUND (2). Windows 11 21H2
// (build 22000) and newer; older builds return E_INVALIDARG for the unknown
// attribute and keep square corners, which is the fallback we want.
const (
	dwmWaWindowCornerPreference = 33
	dwmwcpRound                 = 2
)

var (
	user32                       = syscall.NewLazyDLL("user32.dll")
	procGetWindowLongW           = user32.NewProc("GetWindowLongW")
	procSetWindowLongW           = user32.NewProc("SetWindowLongW")
	procGetWindowLongPtrW        = user32.NewProc("GetWindowLongPtrW") // 64-bit only
	procSetWindowLongPtrW        = user32.NewProc("SetWindowLongPtrW") // 64-bit only
	procSetWindowPos             = user32.NewProc("SetWindowPos")
	procGetClientRect            = user32.NewProc("GetClientRect")
	procAdjustWindowRectEx       = user32.NewProc("AdjustWindowRectEx")
	procAdjustWindowRectExForDpi = user32.NewProc("AdjustWindowRectExForDpi") // Win10 1607+
	procGetDpiForWindow          = user32.NewProc("GetDpiForWindow")          // Win10 1607+
	procReleaseCapture           = user32.NewProc("ReleaseCapture")
	procSendMessageW             = user32.NewProc("SendMessageW")
	procPostMessageW             = user32.NewProc("PostMessageW")
	procShowWindow               = user32.NewProc("ShowWindow")
	procIsZoomed                 = user32.NewProc("IsZoomed")
	procGetCursorPos             = user32.NewProc("GetCursorPos")
	procGetDoubleClickTime       = user32.NewProc("GetDoubleClickTime")

	dwmapi                    = syscall.NewLazyDLL("dwmapi.dll")
	procDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
)

// rect mirrors Win32 RECT (four LONGs).
type rect struct {
	Left, Top, Right, Bottom int32
}

// point mirrors Win32 POINT (two LONGs).
type point struct {
	X, Y int32
}

// Install removes the native title bar from w's window and binds the calls the
// page needs to replace it. Reports whether custom chrome is live; on false the
// window keeps its native decoration and the page keeps its native title bar.
//
// Call it from the window HOST — not from a build/setup callback, which both
// hosts run after the reveal hook is already installed — AFTER SetTitle and
// SetSize (the size is re-derived from the new frame here) and BEFORE the
// reveal hook and the first SetHtml/Navigate: the window is still hidden at
// that point, so the native bar is never composited, and the injected marker
// script only applies to documents loaded after Init.
//
// Only ever give custom chrome to a window showing LOCAL html. These bindings
// move, minimise, maximise and close the window; exposing them to a remote
// document hands that page control of the window.
//
// Custom chrome implies a resizable window: it does not add WS_THICKFRAME, so
// pairing it with SetSize(..., HintFixed) leaves a page whose maximize button
// the OS will refuse.
//
// The caption is SYNCED PER DOCUMENT, not stripped once. Reloading a document
// that was loaded with SetHtml lands on about:blank, and a captionless window
// with no page to draw a strip is one the user cannot move or close. So every
// document reports whether our strip is in it (initJS) and syncCaption puts
// the native caption back when it is not. Install still does the first strip
// itself, before anything is loaded, so the native bar is never composited.
//
// It also turns WebView2's browser accelerator keys off, so the reload never
// happens in the first place. That switch is a FAMILY switch, and the cost is
// accepted deliberately: Ctrl+F, Alt+←/→, Ctrl+P and keyboard zoom
// (Ctrl +/−/0) go with it. These are small fixed-purpose task windows rather
// than documents, Windows display scaling still applies and the windows size
// themselves at their own DPI, and the one page anyone would search — the log
// viewer — has its own search box. Ctrl+A/C/V/X are untouched.
//
// The default context menu — whose Reload is the other way to land on a blank
// document — is left ALONE on purpose. Turning it off is cheaper than the
// engine-level fix and would close that route, but it also takes away
// right-click→Paste in the token form's textarea and right-click→Copy on a log
// line, which people use. The caption sync already covers the route, and
// leaving it reachable is what keeps that recovery path exercised instead of
// rotting.
func Install(w webview.WebView) bool {
	if w == nil {
		return false
	}
	handle := w.Window()
	if handle == nil {
		return false
	}
	hwnd := uintptr(handle)
	// Controls first: a captionless window whose buttons failed to bind can
	// only be moved or closed through the taskbar, so a failed Bind must leave
	// the native title bar in place rather than take it away.
	if !bindControls(w, hwnd) {
		return false
	}
	if !stripCaption(hwnd) {
		log.Printf("[chrome] could not remove the native title bar; keeping it")
		return false
	}
	roundCorners(hwnd)
	// Success path only. A window whose caption could not be removed is an
	// ordinary framed window that was never at risk, and taking F5, Ctrl+F and
	// keyboard zoom away from it would be a regression bought for nothing.
	//
	// After the strip and before Init/SetHtml: WebView2 applies a settings
	// change from the next navigation onward, and Install's contract already
	// puts it ahead of the first SetHtml.
	disableBrowserAccelerators(w)
	// Init last, after every Bind: the sync script gives up if its binding is
	// not there, and this ordering means it never has to.
	w.Init(initJS(doubleClickTime()))
	return true
}

// stripCaption swaps the window over to the captionless style and restores the
// client size the caller asked for.
//
// The size step matters: the caption's height becomes client area the moment
// WS_CAPTION goes, so a window sized before the strip would grow its page by
// the bar height. We read the client rect first, then re-derive the window rect
// the new style needs for exactly that client size. The same SetWindowPos is
// also what makes Windows recompute the frame (SWP_FRAMECHANGED) and what
// delivers the WM_SIZE that moves the WebView2 child onto the new client area.
func stripCaption(hwnd uintptr) bool {
	style := getWindowLong(hwnd, gwlStyle)
	if style == 0 {
		// GetWindowLong failed. Ambiguous in principle — WS_OVERLAPPED is 0,
		// so a style-less window reads the same — but webview always creates
		// WS_OVERLAPPEDWINDOW, and treating the ambiguous case as failure only
		// ever costs us the native title bar staying put.
		return false
	}
	var client rect
	if ok, _, _ := procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&client))); ok == 0 {
		return false
	}

	newStyle := uintptr(captionlessStyle(uint32(style)))
	setWindowLong(hwnd, gwlStyle, newStyle)

	want := rect{Right: client.Right, Bottom: client.Bottom}
	adjustWindowRect(hwnd, &want, newStyle, getWindowLong(hwnd, gwlExStyle))
	procSetWindowPos.Call(
		hwnd, 0,
		0, 0,
		uintptr(want.Right-want.Left), uintptr(want.Bottom-want.Top),
		swpNoMove|swpNoZOrder|swpNoActivate|swpFrameChanged,
	)
	return true
}

// syncCaption makes the window's caption match the document that just loaded:
// present when the page draws no strip of its own, gone when it does.
//
// Unlike stripCaption this does NOT re-derive the size, and must not. That
// dance exists to honour the size the CALLER asked for, once, at Install time;
// running it on every document would accumulate the DPI fallback's few pixels
// of error across each strip→restore→strip cycle, and would fight the OS over
// a maximized window's rect. SWP_NOSIZE|SWP_NOMOVE keeps the window rect
// exactly where it is and lets the client area gain or lose the caption's
// height — which is the right answer for a document that is either empty or
// about to lay itself out anyway.
func syncCaption(hwnd uintptr, custom bool) {
	style := getWindowLong(hwnd, gwlStyle)
	if style == 0 {
		// GetWindowLong failed; same ambiguity (and same conservative
		// reading) as stripCaption.
		return
	}
	want := uintptr(captionedStyle(uint32(style)))
	if custom {
		want = uintptr(captionlessStyle(uint32(style)))
	}
	if want == style {
		// The steady state: every normal document of a chromed window lands
		// here, so the whole mechanism costs one binding round trip and one
		// GetWindowLong per page.
		return
	}
	setWindowLong(hwnd, gwlStyle, want)
	procSetWindowPos.Call(
		hwnd, 0,
		0, 0, 0, 0,
		swpNoMove|swpNoSize|swpNoZOrder|swpNoActivate|swpFrameChanged,
	)
	// Only on a real transition, and say which way: this is what turns "the
	// settings window went weird" into something diagnosable from a log.
	if custom {
		log.Printf("[chrome] document draws its own title bar; caption removed")
		return
	}
	log.Printf("[chrome] document has no title bar of its own (a reload lands on about:blank); native caption restored")
}

// adjustWindowRect grows a client rect into the window rect that style needs,
// at the window's own DPI where the OS can tell us (Win10 1607+). The
// DPI-blind AdjustWindowRectEx is the fallback: it uses the system DPI, so on
// a per-monitor-DPI setup it can be off by a few pixels of border — visible
// as a slightly wrong window size, never as broken chrome.
func adjustWindowRect(hwnd uintptr, r *rect, style, exStyle uintptr) {
	if procGetDpiForWindow.Find() == nil && procAdjustWindowRectExForDpi.Find() == nil {
		if dpi, _, _ := procGetDpiForWindow.Call(hwnd); dpi != 0 {
			// On a scratch copy: the API does not promise to leave the rect
			// untouched when it fails, and inflating an already-inflated rect
			// with the fallback would size the window tens of pixels too big.
			try := *r
			ok, _, _ := procAdjustWindowRectExForDpi.Call(
				uintptr(unsafe.Pointer(&try)), style, 0, exStyle, dpi,
			)
			if ok != 0 {
				*r = try
				return
			}
		}
	}
	procAdjustWindowRectEx.Call(uintptr(unsafe.Pointer(r)), style, 0, exStyle)
}

// roundCorners asks DWM for Win11's rounded corners explicitly. Captionless
// windows still get them by default, but a window whose style we rewrote after
// creation is exactly the case where being explicit costs one ignored call.
func roundCorners(hwnd uintptr) {
	corner := int32(dwmwcpRound)
	procDwmSetWindowAttribute.Call(
		hwnd,
		uintptr(dwmWaWindowCornerPreference),
		uintptr(unsafe.Pointer(&corner)),
		unsafe.Sizeof(corner),
	)
}

// bindControls installs the page's window controls and reports whether all of
// them are live.
//
// Every one of them runs on the webview's UI thread (that is where bindings are
// dispatched), which is the thread that owns the window — so ReleaseCapture,
// the modal move loop entered by WM_NCLBUTTONDOWN, and ShowWindow all target
// the right thread without a Dispatch hop.
func bindControls(w webview.WebView, hwnd uintptr) bool {
	ok := true
	bind := func(name string, fn any) {
		if err := w.Bind(name, fn); err != nil {
			log.Printf("[chrome] Bind(%s) failed: %v", name, err)
			ok = false
		}
	}
	// Caption drag. The mouse is over the WebView2 child, which holds capture
	// and would keep every subsequent move to itself; releasing it and telling
	// the frame the press landed on its caption hands the gesture to Windows,
	// which then gives us the real thing: snap to edges, snap-back off a
	// maximised window, and multi-monitor drag. SendMessage (not Post) on
	// purpose — the modal move loop must start inside the user gesture.
	// It returns when the drag ends, so the page must not await this.
	bind("__jarvis_chrome_drag", func() {
		procReleaseCapture.Call()
		procSendMessageW.Call(hwnd, wmNCLButtonDown, htCaption, 0)
	})

	bind("__jarvis_chrome_minimize", func() {
		procShowWindow.Call(hwnd, swMinimize)
	})

	// Reports the state the window is in AFTER the toggle so the page can
	// swap its maximise/restore glyph without a second round trip.
	bind("__jarvis_chrome_toggle_maximize", func() bool {
		if isZoomed(hwnd) {
			procShowWindow.Call(hwnd, swRestore)
			return false
		}
		procShowWindow.Call(hwnd, swMaximize)
		return true
	})

	bind("__jarvis_chrome_is_maximized", func() bool { return isZoomed(hwnd) })

	// Post, never Send: WM_CLOSE tears the window (and the engine) down, and
	// this binding is running inside that engine's dispatch. Queuing the
	// message lets the call return first.
	bind("__jarvis_chrome_close", func() {
		procPostMessageW.Call(hwnd, wmClose, 0, 0)
	})

	// The caption sync (see initJS). Deliberately inside the same `ok`
	// accumulator as the window controls: a window whose recovery net could
	// not be installed must keep its native title bar rather than have it
	// taken away with nothing able to give it back.
	bind("__jarvis_chrome_sync", func(custom bool) { syncCaption(hwnd, custom) })

	// Right-click on the caption. DefWindowProc turns WM_NCRBUTTONUP/HTCAPTION
	// into the system menu, so the menu, its item states and its commands are
	// all the OS's — we only say where. The position comes from GetCursorPos
	// rather than the page: the click just happened, and screen pixels from Go
	// need no CSS-pixel-to-DPI conversion. Modal like the drag, and on the same
	// thread, for the same reason.
	bind("__jarvis_chrome_sysmenu", func() {
		var pt point
		if ok, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt))); ok == 0 {
			return
		}
		// MAKELPARAM: low word x, high word y, both truncated to 16 bits --
		// which is what GET_X_LPARAM sign-extends back on a negative
		// (left-of-primary) monitor.
		lparam := uintptr(uint32(uint16(pt.X)) | uint32(uint16(pt.Y))<<16)
		procSendMessageW.Call(hwnd, wmNCRButtonUp, htCaption, lparam)
	})

	return ok
}

// doubleClickTime is the user's configured double-click speed in ms (0 if the
// call fails, which initJS reads as "use the default").
func doubleClickTime() uint32 {
	ms, _, _ := procGetDoubleClickTime.Call()
	return uint32(ms)
}

func isZoomed(hwnd uintptr) bool {
	z, _, _ := procIsZoomed.Call(hwnd)
	return z != 0
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
