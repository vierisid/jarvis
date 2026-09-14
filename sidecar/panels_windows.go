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

// WM_SETICON assigns a window its title-bar (small) / Alt-Tab + taskbar (big)
// icon. WebView2 windows don't inherit the .exe icon on their own, so framed
// panels (the dashboard) show WebView2's default until we set it explicitly.
const (
	wmSetIcon = 0x0080
	iconSmall = 0
	iconBig   = 1
)

// setPanelBrandIcon stamps the Brand Book III drop mark (the same resource the
// .exe and tray load, ID trayIconBrandID) onto a framed panel window so its
// title bar and taskbar entry read as usejarvis rather than WebView2's stock
// icon. hInstance/LoadIconW are reused from the tray + pebble overlay decls.
func setPanelBrandIcon(hwnd uintptr) {
	hInstance, _, _ := procGetModuleHandleW.Call(0)
	hIcon, _, _ := procLoadIconW.Call(hInstance, uintptr(trayIconBrandID))
	if hIcon == 0 {
		return
	}
	procSendMessageW.Call(hwnd, wmSetIcon, iconBig, hIcon)
	procSendMessageW.Call(hwnd, wmSetIcon, iconSmall, hIcon)
}

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
	procSendMessageW               = user32.NewProc("SendMessageW")

	gdi32                  = syscall.NewLazyDLL("gdi32.dll")
	procCreateRectRgn      = gdi32.NewProc("CreateRectRgn")
	procCreateRoundRectRgn = gdi32.NewProc("CreateRoundRectRgn")
	procCombineRgn         = gdi32.NewProc("CombineRgn")
	procDeleteObject       = gdi32.NewProc("DeleteObject")

	// W3-T4 — Win11 chrome polish. DWM provides the system backdrop
	// (Mica), rounded corners, and immersive dark mode title bar.
	// Failing calls (older Windows) are silently ignored — they return
	// HRESULT codes we don't act on, just log.
	dwmapi                    = syscall.NewLazyDLL("dwmapi.dll")
	procDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
)

// DWM attribute identifiers used by the chrome polish below.
//
// DWMWA_USE_IMMERSIVE_DARK_MODE (20) — BOOL: dark title bar.
// DWMWA_WINDOW_CORNER_PREFERENCE (33) — DWORD: corner radius enum.
//
//	0 = default (let DWM decide), 1 = no round, 2 = round (large), 3 = small round.
//
// DWMWA_SYSTEMBACKDROP_TYPE (38) — DWORD: backdrop material.
//
//	1 = none, 2 = Mica, 3 = acrylic, 4 = tabbed Mica.
//
// All three require Win11 22H2 (build 22621) or newer; older builds
// return DWMRC_E_INVALID_ARG (0x80070057) which we ignore.
const (
	dwmWaUseImmersiveDarkMode   = 20
	dwmWaWindowCornerPreference = 33
	dwmWaSystemBackdropType     = 38

	dwmwcpRoundLarge = 2
	dwmsbtMainWindow = 2
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

	// W3-T4 — Win11 chrome polish for regular Room panels. Skip
	// frameless / transparent / click-through / always-on-top panels
	// (those are overlays where Mica + rounded corners would conflict
	// with custom rendering). Calls silently fail on older Windows.
	if !spec.Frameless && !spec.Transparent && !spec.ClickThrough && !spec.AlwaysOnTop {
		applyWin11ChromePolish(hwnd)
		// Framed panels (the dashboard) show a real title bar + taskbar entry,
		// so give them the brand drop icon instead of WebView2's default.
		setPanelBrandIcon(hwnd)
	}

	return nil
}

// applyWin11ChromePolish enables Mica backdrop, rounded corners, and the
// dark-mode title bar on a panel HWND. All three DwmSetWindowAttribute
// calls return HRESULTs we don't branch on — older Windows builds just
// return DWMRC_E_INVALID_ARG and leave the window with classic chrome,
// which is the desired fallback.
func applyWin11ChromePolish(hwnd uintptr) {
	// Dark title bar — follows the spawned page's general visual
	// language better than a stark white classic title bar.
	darkMode := int32(1)
	procDwmSetWindowAttribute.Call(
		hwnd,
		uintptr(dwmWaUseImmersiveDarkMode),
		uintptr(unsafe.Pointer(&darkMode)),
		unsafe.Sizeof(darkMode),
	)

	// Large rounded corners — Win11's default for shell windows. The
	// "large" radius matches Settings, File Explorer, etc.
	corner := int32(dwmwcpRoundLarge)
	procDwmSetWindowAttribute.Call(
		hwnd,
		uintptr(dwmWaWindowCornerPreference),
		uintptr(unsafe.Pointer(&corner)),
		unsafe.Sizeof(corner),
	)

	// Mica backdrop — gives the title bar + non-client area the
	// translucent material look. Content stays opaque because we
	// haven't reconfigured WebView2 transparency; the polish is most
	// visible in the title bar and around the rounded corners, which
	// is already a noticeable Win11-native upgrade over flat chrome.
	backdrop := int32(dwmsbtMainWindow)
	procDwmSetWindowAttribute.Call(
		hwnd,
		uintptr(dwmWaSystemBackdropType),
		uintptr(unsafe.Pointer(&backdrop)),
		unsafe.Sizeof(backdrop),
	)
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

// HWND_NOTOPMOST is officially -2.
const hwndNoTopmost = ^uintptr(1)

// FlashWindowEx flags: flash the taskbar button until the window comes to the
// foreground.
const (
	flashwTray      = 0x00000002
	flashwTimerNoFG = 0x0000000C
)

// flashWInfo mirrors Win32 FLASHWINFO.
type flashWInfo struct {
	cbSize    uint32
	hwnd      uintptr
	dwFlags   uint32
	uCount    uint32
	dwTimeout uint32
}

var procFlashWindowEx = user32.NewProc("FlashWindowEx")

// platformFocusWindow brings a panel forward. Most panels open with nobody
// clicking anything: the first-run dashboard when the sidecar connects, the
// "open dashboard at startup" window at login, rooms the brain opens. Windows
// only lets the process that received the user's last input take the
// foreground, so SetForegroundWindow alone is refused there and the window used
// to open BEHIND whatever the user was in, with no sign it had opened at all.
//
// So the window is first raised above every normal window without activating
// it, which Windows does allow (a round trip through the topmost band leaves it
// at the top of the normal band). Then the foreground is requested, which
// Windows grants when the user just interacted with Jarvis (its hotkey, the
// tray), and when the window still is not in the foreground the taskbar button
// flashes until the user switches to it; keyboard focus stays where the user
// left it. Topmost panels (the palette, overlays) are already above normal
// windows and keep their band. The raise, and only the raise, is skipped while
// a fullscreen app covers the panel's monitor or presentation mode is on.
func platformFocusWindow(handle unsafe.Pointer) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	hwnd := uintptr(handle)
	const swShow, swRestore = 5, 9
	if iconic, _, _ := procIsIconic.Call(hwnd); iconic != 0 {
		procShowWindow.Call(hwnd, swRestore)
	} else {
		procShowWindow.Call(hwnd, swShow)
	}
	if getWindowLong(hwnd, gwlExStyle)&wsExTopmost == 0 && !fullscreenAppCovers(hwnd) {
		procSetWindowPos.Call(hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
		procSetWindowPos.Call(hwnd, hwndNoTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
	}
	procSetForegroundWindow.Call(hwnd)
	// Judged by the outcome rather than SetForegroundWindow's return value,
	// which can report success when Windows only flashed the button.
	if fg, _, _ := procGetForegroundWindow.Call(); fg != hwnd {
		flashTaskbarButton(hwnd)
	}
	return nil
}

func flashTaskbarButton(hwnd uintptr) {
	fi := flashWInfo{hwnd: hwnd, dwFlags: flashwTray | flashwTimerNoFG}
	fi.cbSize = uint32(unsafe.Sizeof(fi))
	procFlashWindowEx.Call(uintptr(unsafe.Pointer(&fi)))
}

var (
	procSHQueryUserNotificationState = syscall.NewLazyDLL("shell32.dll").NewProc("SHQueryUserNotificationState")
	procPanelMonitorFromWindow       = user32.NewProc("MonitorFromWindow")
	procPanelIsZoomed                = user32.NewProc("IsZoomed")
)

// QUERY_USER_NOTIFICATION_STATE values that mean the user should not have
// windows popped over what they are doing.
const (
	qunsBusy                 = 2 // the shell considers a fullscreen app to be running
	qunsRunningD3DFullScreen = 3 // a Direct3D fullscreen app (games)
	qunsPresentationMode     = 4 // presentation settings are on
)

const monitorDefaultToNearest = 2

// panelMonitorInfo mirrors Win32 MONITORINFO.
type panelMonitorInfo struct {
	cbSize    uint32
	rcMonitor w32Rect
	rcWork    w32Rect
	dwFlags   uint32
}

// fullscreenAppCovers reports whether raising hwnd would pop it over a
// fullscreen app or a presentation. The shell's busy states alone are too
// broad (they can come from a fullscreen video on another monitor), so they
// count only when the foreground window is on the panel's monitor, covers that
// whole monitor, and is not just a maximized window. A maximized window can
// cover its monitor too, with an auto-hidden taskbar, but it is in the
// maximized state and keeps its caption; fullscreen browsers, players and
// games drop the caption or are not maximized. Presentation mode counts
// everywhere. Errors read as "no", so the panel is raised as usual.
func fullscreenAppCovers(hwnd uintptr) bool {
	var state int32
	if hr, _, _ := procSHQueryUserNotificationState.Call(uintptr(unsafe.Pointer(&state))); hr != 0 {
		return false
	}
	switch state {
	case qunsPresentationMode:
		return true
	case qunsBusy, qunsRunningD3DFullScreen:
		// Only when a fullscreen window really covers the panel's monitor; below.
	default:
		return false
	}
	fg, _, _ := procGetForegroundWindow.Call()
	if fg == 0 || fg == hwnd {
		return false
	}
	monitor, _, _ := procPanelMonitorFromWindow.Call(fg, monitorDefaultToNearest)
	panelMonitor, _, _ := procPanelMonitorFromWindow.Call(hwnd, monitorDefaultToNearest)
	if monitor == 0 || monitor != panelMonitor {
		return false
	}
	mi := panelMonitorInfo{}
	mi.cbSize = uint32(unsafe.Sizeof(mi))
	if ok, _, _ := procGetMonitorInfoW.Call(monitor, uintptr(unsafe.Pointer(&mi))); ok == 0 {
		return false
	}
	var r w32Rect
	if ok, _, _ := procGetWindowRect.Call(fg, uintptr(unsafe.Pointer(&r))); ok == 0 {
		return false
	}
	m := mi.rcMonitor
	if r.Left > m.Left || r.Top > m.Top || r.Right < m.Right || r.Bottom < m.Bottom {
		return false
	}
	zoomed, _, _ := procPanelIsZoomed.Call(fg)
	hasCaption := getWindowLong(fg, gwlStyle)&wsCaption == wsCaption
	return zoomed == 0 || !hasCaption
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

// w32Rect mirrors Win32 RECT — four LONGs (left, top, right, bottom).
type w32Rect struct {
	Left   int32
	Top    int32
	Right  int32
	Bottom int32
}

var procGetWindowRect = user32.NewProc("GetWindowRect")

// platformGetWindowRect returns the panel's current screen-space bounds
// (x, y, w, h). Used by the bounds-tracking poll so the daemon can
// persist where the user dragged/resized a panel last.
func platformGetWindowRect(handle unsafe.Pointer) (int, int, int, int, error) {
	if handle == nil {
		return 0, 0, 0, 0, fmt.Errorf("nil HWND")
	}
	var r w32Rect
	ret, _, err := procGetWindowRect.Call(uintptr(handle), uintptr(unsafe.Pointer(&r)))
	if ret == 0 {
		return 0, 0, 0, 0, fmt.Errorf("GetWindowRect failed: %v", err)
	}
	return int(r.Left), int(r.Top), int(r.Right - r.Left), int(r.Bottom - r.Top), nil
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

// swpNoZOrder preserves the window's current z-order — opposite of
// platformMoveWindow's HWND_TOPMOST reassertion. Used by initial-spawn
// positioning where the daemon hands the sidecar a saved (x, y) and we
// want the panel to land there without becoming always-on-top.
const swpNoZOrder = 0x0004

// platformMoveWindowKeepZOrder repositions without altering z-order.
// Used by the W3-T3 saved-bounds restore so a regular Room panel
// doesn't sneak above other windows just because it was repositioned.
func platformMoveWindowKeepZOrder(handle unsafe.Pointer, x, y int) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	procSetWindowPos.Call(
		uintptr(handle),
		0,
		uintptr(int32(x)), uintptr(int32(y)),
		0, 0,
		swpNoSize|swpNoActivate|swpNoZOrder,
	)
	return nil
}

// Win32 ShowWindow nCmdShow values for T18b voice window-state commands.
const (
	swShowNormal    = 1 // SW_SHOWNORMAL — restore from minimized/maximized
	swShowMaximized = 3 // SW_SHOWMAXIMIZED
	swMinimize      = 6 // SW_MINIMIZE — to taskbar without activating
	swRestore       = 9 // SW_RESTORE — restore + activate
)

var procShowWindowPanel = user32.NewProc("ShowWindow")
var procPostMessageW = user32.NewProc("PostMessageW")

const wmClose = 0x0010

// platformDestroyWindow forces an HWND to close even when the webview's
// own message loop didn't pick up Terminate() promptly. Posts WM_CLOSE
// to the window's queue — the webview's WndProc handles it the same way
// the user clicking the X would, which actually destroys the HWND and
// makes wv.Run() return so the deferred reg.delete fires.
func platformDestroyWindow(handle unsafe.Pointer) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	procPostMessageW.Call(uintptr(handle), wmClose, 0, 0)
	return nil
}

var procIsWindow = user32.NewProc("IsWindow")

// platformWindowAlive reports whether the HWND still exists (false once the
// window has been destroyed, e.g. the user clicked the X).
func platformWindowAlive(handle unsafe.Pointer) bool {
	if handle == nil {
		return false
	}
	r, _, _ := procIsWindow.Call(uintptr(handle))
	return r != 0
}

// registerPanelCloseWatch is macOS-only (NSWindowWillCloseNotification); Windows
// uses the platformWindowAlive (IsWindow) polling close watcher instead.
func registerPanelCloseWatch(_ unsafe.Pointer, _ *panelImpl) {}

// platformSetWindowVisible shows/hides a panel HWND. Used to keep a panel
// hidden while its page loads, then reveal it fully-rendered. SW_HIDE=0,
// SW_SHOW=5.
func platformSetWindowVisible(handle unsafe.Pointer, visible bool) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	cmd := uintptr(0) // SW_HIDE
	if visible {
		cmd = uintptr(5) // SW_SHOW
	}
	procShowWindowPanel.Call(uintptr(handle), cmd)
	return nil
}

// platformSetWindowState transitions a panel HWND between normal,
// minimized, and maximized states using ShowWindow.
func platformSetWindowState(handle unsafe.Pointer, state PanelWindowState) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	var cmd int32
	switch state {
	case PanelWindowMinimized:
		cmd = swMinimize
	case PanelWindowMaximized:
		cmd = swShowMaximized
	case PanelWindowNormal:
		cmd = swRestore
	default:
		return fmt.Errorf("unknown window state: %q", state)
	}
	procShowWindowPanel.Call(uintptr(handle), uintptr(cmd))
	return nil
}
