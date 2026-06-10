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
	trayMfSeparator  = 0x00000800
	trayTpmRightBtn  = 0x0002
	trayTpmReturnCmd = 0x0100

	trayMenuCloseID    = 1
	trayMenuChatID     = 2
	trayMenuSettingsID = 3
	trayMenuLogsID     = 4
	trayIDIApp         = 32512 // IDI_APPLICATION (stock icon placeholder; brand later)
	trayIDIError       = 32515 // IDI_WARNING (connection-error placeholder; brand later)
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
	trayOpenSettings func()
	trayOpenLogs     func()
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
	trayOpenSettings = client.OpenSettings
	trayOpenLogs = client.OpenLogViewer

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

	hIcon, _, _ := procLoadIconW.Call(0, uintptr(trayIDIApp))

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

// traySetIconForState swaps the notification-area icon to reflect the current
// connection state. Must run on the tray thread (it owns trayNID), so it's
// invoked via the trayMsgSetState window message posted by the poll goroutine.
func traySetIconForState(state int32) {
	id := uintptr(trayIDIApp)
	if state == connError {
		id = uintptr(trayIDIError) // connection-error placeholder; brand later
	}
	hIcon, _, _ := procLoadIconW.Call(0, id)
	if hIcon == 0 {
		return
	}
	trayNID.HIcon = hIcon
	procShellNotifyIconW.Call(trayNimModify, uintptr(unsafe.Pointer(&trayNID)))
}

func trayWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case trayCallbackMsg:
		// The low word of lParam is the originating mouse message.
		ev := uint32(lParam) & 0xFFFF
		if ev == trayWmRButtonUp || ev == trayWmContextMnu {
			showTrayMenu(hwnd)
		}
		return 0

	case trayMsgSetState:
		traySetIconForState(int32(wParam))
		return 0

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

	// Connection status — disabled (unclickable) info line, rebuilt each open so
	// it always reflects the current state.
	status := "Disconnected"
	if trayConnState != nil {
		switch trayConnState() {
		case connConnected:
			status = "Connected"
		case connError:
			status = "Connection error"
		}
	}
	statusLabel, _ := syscall.UTF16PtrFromString(status)
	procAppendMenuW.Call(hMenu, trayMfString|trayMfGrayed|trayMfDisabled, 0, uintptr(unsafe.Pointer(statusLabel)))
	procAppendMenuW.Call(hMenu, trayMfSeparator, 0, 0)

	appendTrayItem(hMenu, "Jarvis", trayMenuChatID)
	appendTrayItem(hMenu, "Settings", trayMenuSettingsID)
	appendTrayItem(hMenu, "Logs", trayMenuLogsID)
	procAppendMenuW.Call(hMenu, trayMfSeparator, 0, 0)

	appendTrayItem(hMenu, "Close", trayMenuCloseID)

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
	case trayMenuSettingsID:
		if trayOpenSettings != nil {
			go trayOpenSettings()
		}
	case trayMenuLogsID:
		if trayOpenLogs != nil {
			go trayOpenLogs()
		}
	}
}

// appendTrayItem adds a normal clickable menu item with the given command id.
func appendTrayItem(hMenu uintptr, label string, id uintptr) {
	l, _ := syscall.UTF16PtrFromString(label)
	procAppendMenuW.Call(hMenu, trayMfString, id, uintptr(unsafe.Pointer(l)))
}
