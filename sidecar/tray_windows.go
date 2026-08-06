//go:build windows

package main

// Windows system-tray icon.
//
// A hidden helper window receives the tray callback message; right-clicking the
// tray icon pops up a menu with a single "Close" entry that stops the sidecar.
// The icon + its message loop live on a dedicated OS-locked goroutine; the
// client keeps running on the main goroutine. When the client stops (menu Close
// or a signal) the icon is removed.
//
// Reuses the Win32 proc handles + window-class struct declared in
// pebble_overlay_windows.go / panels_windows.go (same package).

import (
	"context"
	"fmt"
	"log"
	"runtime"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

// shell32 (for Shell_NotifyIconW) + the menu/icon procs not already declared
// elsewhere in the package.
var (
	trayShell32          = syscall.NewLazyDLL("shell32.dll")
	procShellNotifyIconW = trayShell32.NewProc("Shell_NotifyIconW")
	procLoadIconW        = pebbleUser32.NewProc("LoadIconW")
	procCreatePopupMenu  = pebbleUser32.NewProc("CreatePopupMenu")
	procAppendMenuW      = pebbleUser32.NewProc("AppendMenuW")
	procTrackPopupMenu   = pebbleUser32.NewProc("TrackPopupMenu")
	procDestroyMenu      = pebbleUser32.NewProc("DestroyMenu")
)

const (
	trayCallbackMsg  = 0x0400 + 1 // WM_APP-ish (WM_USER+1) tray callback
	trayMsgSetState  = 0x0400 + 2 // WM_APP+2: poll goroutine -> tray thread, swap icon (wParam=state)
	trayMsgRefresh   = 0x0400 + 4 // WM_APP+4: tray.status changed -> tray thread, re-render icon (+3 is the balloon)
	trayWmRButtonUp  = 0x0205
	trayWmContextMnu = 0x007B
	trayWmClose      = 0x0010
	trayWmDestroy    = 0x0002

	trayNimAdd     = 0x00000000
	trayNimModify  = 0x00000001
	trayNimDelete  = 0x00000002
	trayNifMessage = 0x00000001
	trayNifIcon    = 0x00000002
	trayNifTip     = 0x00000004

	trayMfString     = 0x00000000
	trayMfGrayed     = 0x00000001
	trayMfDisabled   = 0x00000002
	trayMfChecked    = 0x00000008
	trayMfSeparator  = 0x00000800
	trayTpmRightBtn  = 0x0002
	trayTpmReturnCmd = 0x0100

	trayMenuCloseID    = 1
	trayMenuChatID     = 2
	trayMenuSettingsID = 3
	trayMenuLogsID     = 4
	trayMenuWaitingID  = 5
	trayMenuPauseID    = 6
	trayMenuMuteID     = 7
	trayMenuAccountID  = 8
	// Brand icon resources compiled into rsrc_windows_amd64.syso from jarvis.rc.
	// ID 2 is also the .exe / taskbar application icon (lowest-numbered group
	// icon). ID 3 is the vermilion drop shown when the connection drops.
	trayIconBrandID = 2 // light drop on dark tile — normal state + app icon
	trayIconErrorID = 3 // vermilion drop on dark tile — connection-error state
)

// NOTIFYICONDATAW (current/Vista+ layout).
type trayNotifyIconData struct {
	CbSize            uint32
	HWnd              uintptr
	UID               uint32
	UFlags            uint32
	UCallbackMessage  uint32
	HIcon             uintptr
	SzTip             [128]uint16
	DwState           uint32
	DwStateMask       uint32
	SzInfo            [256]uint16
	UVersionOrTimeout uint32
	SzInfoTitle       [64]uint16
	DwInfoFlags       uint32
	GuidItem          [16]byte
	HBalloonIcon      uintptr
}

type trayMsg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      pblPoint
	Extra   uint32
}

var (
	trayHwnd         atomic.Uintptr
	trayOnClose      func()
	trayConnState    func() int32 // brain-connection state (connConnecting/connConnected/connError)
	trayOpenChat     func()
	trayOpenAccount  func()
	trayOpenSettings func()
	trayOpenLogs     func()
	trayEmit         func(eventType string, payload map[string]any) // tray → brain (pause/mute)
	trayNID          trayNotifyIconData
)

// runWithTray (Windows): tray on its own goroutine, client on the main goroutine.
func runWithTray(ctx context.Context, cancel context.CancelFunc, client *SidecarClient) {
	trayOnClose = func() {
		client.Stop()
		cancel()
	}
	client.SetShutdown(trayOnClose)
	trayConnState = client.ConnState
	trayOpenChat = client.OpenChat
	trayOpenAccount = client.OpenAccount
	trayOpenSettings = client.OpenSettings
	trayOpenLogs = client.OpenLogViewer
	trayEmit = func(et string, p map[string]any) {
		_ = client.sendEvent(context.Background(), SidecarEvent{
			EventType: et,
			Timestamp: time.Now().UnixMilli(),
			Priority:  "normal",
			Payload:   p,
		}, nil)
	}
	// Pebble-state changes (tray.status pushes) re-render the icon so the tray
	// mirrors the pebble like the macOS status item. The render must happen on
	// the tray thread (it owns trayNID), so just post it over.
	trayRefresh = func() {
		if h := trayHwnd.Load(); h != 0 {
			procPostMessageW.Call(h, trayMsgRefresh, 0, 0)
		}
	}

	// Poll the connection state; when it changes, ask the tray thread (which owns
	// the icon) to swap the notification-area icon to reflect connected / error.
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		last := int32(-1)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				cur := client.ConnState()
				if cur == last {
					continue
				}
				last = cur
				if h := trayHwnd.Load(); h != 0 {
					procPostMessageW.Call(h, trayMsgSetState, uintptr(cur), 0)
				}
			}
		}
	}()

	ready := make(chan struct{})
	trayDone := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(trayDone)
		ok := createTrayIcon()
		close(ready)
		if !ok {
			return
		}
		runTrayMessageLoop()
	}()
	<-ready

	client.Start(ctx) // blocks until client.Stop() (menu Close or signal)

	// Tear the icon down: ask the tray window to remove the icon + end its loop,
	// then wait for the tray thread to actually finish so the process doesn't
	// exit (leaving a stale ghost icon) before Shell_NotifyIcon(NIM_DELETE) runs.
	// Bounded so a wedged message loop can't hang shutdown.
	if h := trayHwnd.Load(); h != 0 {
		procPostMessageW.Call(h, trayWmClose, 0, 0)
		select {
		case <-trayDone:
		case <-time.After(2 * time.Second):
		}
	}
}

// createTrayIcon registers the hidden helper window and adds the tray icon.
// Returns false on failure (the sidecar still runs, just without a tray icon).
func createTrayIcon() bool {
	className, _ := syscall.UTF16PtrFromString("JarvisSidecarTray")
	hInstance, _, _ := procGetModuleHandleW.Call(0)

	wc := pblWndClassEx{
		Size:      uint32(unsafe.Sizeof(pblWndClassEx{})),
		WndProc:   syscall.NewCallback(trayWndProc),
		Instance:  hInstance,
		ClassName: className,
	}
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	// Hidden helper window (never shown) — needed so the tray icon has an owner
	// to deliver callbacks to and so TrackPopupMenu has a foreground window.
	hwnd, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(className)),
		0, // not WS_VISIBLE
		0, 0, 0, 0,
		0, 0, hInstance, 0,
	)
	if hwnd == 0 {
		log.Printf("[tray] CreateWindowExW failed")
		return false
	}
	trayHwnd.Store(hwnd)

	hIcon, _, _ := procLoadIconW.Call(hInstance, uintptr(trayIconBrandID))

	trayNID = trayNotifyIconData{}
	trayNID.CbSize = uint32(unsafe.Sizeof(trayNID))
	trayNID.HWnd = hwnd
	trayNID.UID = 1
	trayNID.UFlags = trayNifMessage | trayNifIcon | trayNifTip
	trayNID.UCallbackMessage = trayCallbackMsg
	trayNID.HIcon = hIcon
	tip, _ := syscall.UTF16FromString("JARVIS Sidecar")
	copy(trayNID.SzTip[:], tip)

	r, _, _ := procShellNotifyIconW.Call(trayNimAdd, uintptr(unsafe.Pointer(&trayNID)))
	if r == 0 {
		log.Printf("[tray] Shell_NotifyIcon(NIM_ADD) failed")
		procDestroyWindow.Call(hwnd)
		trayHwnd.Store(0)
		return false
	}
	log.Printf("[tray] tray icon added")
	return true
}

func runTrayMessageLoop() {
	var msg trayMsg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(r) <= 0 { // 0 = WM_QUIT, -1 = error
			return
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}
}

// Tray-thread-only icon state: the last connection state seen (so the render
// can prioritise the error icon) and the previous dynamically synthesized
// HICON (destroyed on swap — LoadIconW handles are shared and must NOT be).
var (
	trayLastConnState int32
	trayDynIcon       uintptr
)

// traySetIconForState records the connection state and re-renders. Tray thread
// only (invoked via the trayMsgSetState message posted by the poll goroutine).
func traySetIconForState(state int32) {
	trayLastConnState = state
	trayRenderIcon()
}

// trayRenderIcon rebuilds the notification-area icon from connection state +
// pebble state (tray.status): connection-error wins, then a synthesized
// brand-icon-with-state-dot, then the plain brand icon. Tray thread only.
func trayRenderIcon() {
	hInstance, _, _ := procGetModuleHandleW.Call(0)
	var hIcon, dyn uintptr
	if trayLastConnState == connError {
		hIcon, _, _ = procLoadIconW.Call(hInstance, uintptr(trayIconErrorID))
	} else if code := trayStateCode(getTrayStatus().State); code != 0 {
		dyn = traySynthesizeStateIcon(code)
		hIcon = dyn
	}
	if hIcon == 0 {
		hIcon, _, _ = procLoadIconW.Call(hInstance, uintptr(trayIconBrandID))
		dyn = 0
	}
	if hIcon == 0 {
		return
	}
	trayNID.HIcon = hIcon
	procShellNotifyIconW.Call(trayNimModify, uintptr(unsafe.Pointer(&trayNID)))
	if trayDynIcon != 0 {
		procDestroyIcon.Call(trayDynIcon) // the shell has its own copy after NIM_MODIFY
	}
	trayDynIcon = dyn
}

func trayWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case trayCallbackMsg:
		// The low word of lParam is the originating mouse message.
		ev := uint32(lParam) & 0xFFFF
		if ev == trayWmRButtonUp || ev == trayWmContextMnu {
			showTrayMenu(hwnd)
		} else if ev == ninBalloonUserClick {
			onBalloonClick()
		}
		return 0

	case trayMsgSetState:
		traySetIconForState(int32(wParam))
		return 0

	case trayMsgRefresh:
		trayRenderIcon()
		return 0

	case trayMsgShowBalloon:
		showBalloonNow()
		return 0

	case trayWmCopyData:
		// Tagged external messages. A quit request (installer/updater about to
		// replace the binary) takes the same path as the tray menu's Close so
		// the client tears down cleanly (mic released, websocket closed);
		// anything else is a notification-button click forwarded from the
		// launched instance.
		if cds := (*copyDataStruct)(unsafe.Pointer(lParam)); cds != nil && cds.dwData == quitCopyDataMagic {
			if trayOnClose != nil {
				go trayOnClose()
			}
			return 1
		}
		onNotifyCopyData(lParam)
		return 1

	case trayWmClose:
		procShellNotifyIconW.Call(trayNimDelete, uintptr(unsafe.Pointer(&trayNID)))
		procDestroyWindow.Call(hwnd)
		trayHwnd.Store(0)
		return 0

	case trayWmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
	return r
}

// showTrayMenu pops up the right-click context menu ("Close") at the cursor.
func showTrayMenu(hwnd uintptr) {
	hMenu, _, _ := procCreatePopupMenu.Call()
	if hMenu == 0 {
		return
	}
	defer procDestroyMenu.Call(hMenu)

	// Live data (pushed by the brain via tray.status) + local connection state.
	// Rebuilt each open so it always reflects the current situation.
	ts := getTrayStatus()
	online := trayConnState != nil && trayConnState() == connConnected

	// Header — Jarvis + current state (disabled info line).
	header := "Jarvis"
	if ts.State != "" && ts.State != "idle" {
		header = "Jarvis · " + ts.State
	}
	appendTrayDisabled(hMenu, header)
	procAppendMenuW.Call(hMenu, trayMfSeparator, 0, 0)

	// Waiting on you — pending approvals; opens the dashboard (Authority).
	if ts.Waiting > 0 {
		appendTrayItem(hMenu, fmt.Sprintf("Waiting on you (%d)", ts.Waiting), trayMenuWaitingID)
		procAppendMenuW.Call(hMenu, trayMfSeparator, 0, 0)
	}

	// Controls — the two toggles worth a click (checkable).
	appendTrayCheck(hMenu, "Pause Jarvis", trayMenuPauseID, ts.Paused)
	appendTrayCheck(hMenu, "Mute microphone", trayMenuMuteID, ts.Muted)
	procAppendMenuW.Call(hMenu, trayMfSeparator, 0, 0)

	// Recent activity (disabled info lines).
	if len(ts.Recent) > 0 {
		appendTrayDisabled(hMenu, "Recent")
		for i, r := range ts.Recent {
			if i >= 3 {
				break
			}
			appendTrayDisabled(hMenu, "   "+r)
		}
		procAppendMenuW.Call(hMenu, trayMfSeparator, 0, 0)
	}

	// Into the app. (No accelerator labels: a tray menu has no focused window
	// for a menu accelerator to fire against, and Ctrl+J/Ctrl+Q are common
	// combos we won't hijack globally. A deliberate global "open dashboard"
	// hotkey would be a separate opt-in, on an uncommon combo.)
	appendTrayItem(hMenu, "Open dashboard", trayMenuChatID)
	appendTrayItem(hMenu, "Account", trayMenuAccountID)
	appendTrayItem(hMenu, "Settings", trayMenuSettingsID)
	appendTrayItem(hMenu, "Logs", trayMenuLogsID)
	procAppendMenuW.Call(hMenu, trayMfSeparator, 0, 0)

	appendTrayItem(hMenu, "Quit Jarvis", trayMenuCloseID)

	// Footer — brain / sidecar / port health (disabled info line).
	appendTrayDisabled(hMenu, trayFooterText(online, ts))

	var pt pblPoint
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	// SetForegroundWindow + the trailing WM_NULL post are the documented Win32
	// tray-menu workaround (MS KB135788): without them the menu fails to dismiss
	// on the first click outside it.
	procSetForegroundWindow.Call(hwnd)

	cmd, _, _ := procTrackPopupMenu.Call(
		hMenu,
		trayTpmRightBtn|trayTpmReturnCmd,
		uintptr(pt.X), uintptr(pt.Y),
		0, hwnd, 0,
	)
	procPostMessageW.Call(hwnd, 0 /* WM_NULL */, 0, 0)

	switch cmd {
	case trayMenuCloseID:
		if trayOnClose != nil {
			go trayOnClose()
		}
	case trayMenuChatID:
		if trayOpenChat != nil {
			go trayOpenChat()
		}
	case trayMenuAccountID:
		if trayOpenAccount != nil {
			go trayOpenAccount()
		}
	case trayMenuSettingsID:
		if trayOpenSettings != nil {
			go trayOpenSettings()
		}
	case trayMenuLogsID:
		if trayOpenLogs != nil {
			go trayOpenLogs()
		}
	case trayMenuWaitingID:
		if trayOpenChat != nil {
			go trayOpenChat() // into the dashboard to review the pending approval
		}
	case trayMenuPauseID:
		ts := getTrayStatus()
		ts.Paused = !ts.Paused
		setTrayStatus(ts)
		// WS write off the tray thread (a stalled brain must not freeze the
		// message pump), serialized so rapid toggles apply in click order.
		paused := ts.Paused
		trayCtlAsync(func() {
			if trayEmit != nil {
				trayEmit("tray.set_pause", map[string]any{"paused": paused})
			}
		})
	case trayMenuMuteID:
		ts := getTrayStatus()
		ts.Muted = !ts.Muted
		setTrayStatus(ts)
		// Mic gating tears down audio devices (blocking I/O) and the emit is a
		// WS write — off the tray thread, serialized so a rapid double-toggle
		// can't interleave and desync the mic from the menu.
		muted := ts.Muted
		trayCtlAsync(func() {
			trayApplyMute(muted) // gate the mic locally (sidecar owns mic control)
			if trayEmit != nil {
				trayEmit("tray.set_mute", map[string]any{"muted": muted})
			}
		})
	}
}

// appendTrayItem adds a normal clickable menu item with the given command id.
func appendTrayItem(hMenu uintptr, label string, id uintptr) {
	l, _ := syscall.UTF16PtrFromString(label)
	procAppendMenuW.Call(hMenu, trayMfString, id, uintptr(unsafe.Pointer(l)))
}

// appendTrayDisabled adds a greyed, unclickable info line (header / recent / footer).
func appendTrayDisabled(hMenu uintptr, label string) {
	l, _ := syscall.UTF16PtrFromString(label)
	procAppendMenuW.Call(hMenu, trayMfString|trayMfGrayed|trayMfDisabled, 0, uintptr(unsafe.Pointer(l)))
}

// appendTrayCheck adds a checkable toggle item (Pause / Mute).
func appendTrayCheck(hMenu uintptr, label string, id uintptr, checked bool) {
	l, _ := syscall.UTF16PtrFromString(label)
	flags := uintptr(trayMfString)
	if checked {
		flags |= trayMfChecked
	}
	procAppendMenuW.Call(hMenu, flags, id, uintptr(unsafe.Pointer(l)))
}

// trayFooterText builds the "brain online · sidecar 2/2 · :3142" health line.
func trayFooterText(online bool, ts TrayStatus) string {
	s := "brain offline"
	if online {
		s = "brain online"
	}
	if ts.Sidecars != "" {
		s += " · sidecar " + ts.Sidecars
	}
	if ts.Port > 0 {
		s += fmt.Sprintf(" · :%d", ts.Port)
	}
	return s
}
