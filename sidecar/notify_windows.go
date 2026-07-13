//go:build windows

package main

// Windows notifications — tray balloon (Shell_NotifyIcon NIF_INFO) reusing the
// existing tray icon. A balloon has no action buttons, so a click always opens
// the app to review (the click-only-in-app rule holds for every kind); inline
// Approve/Deny via a real WinRT toast is a separate increment. All trayNID
// access stays on the tray thread — showNotification stores the pending
// notification and posts a message the tray message-loop picks up.

import (
	"sync"
	"syscall"
	"unsafe"
)

const (
	trayMsgShowBalloon  = 0x0400 + 3 // WM_APP+3: client goroutine → tray thread
	ninBalloonUserClick = 0x0405     // user clicked the balloon body
	trayNifInfo         = 0x00000010 // NIF_INFO — this NIM_MODIFY carries a balloon
	trayNiifUser        = 0x00000004 // NIIF_USER — show our brand icon in the balloon
)

var (
	pendingNotifyMu sync.Mutex
	pendingNotify   Notification
)

func init() {
	showNotification = func(n Notification) {
		pendingNotifyMu.Lock()
		pendingNotify = n
		pendingNotifyMu.Unlock()
		if h := trayHwnd.Load(); h != 0 {
			procPostMessageW.Call(h, trayMsgShowBalloon, 0, 0)
		}
	}
}

// showBalloonNow raises the tray balloon for the pending notification. Tray
// thread only (owns trayNID). Uses a local copy so the persistent trayNID keeps
// its steady-state flags — a lingering NIF_INFO would re-fire the balloon on the
// next icon swap.
func showBalloonNow() {
	pendingNotifyMu.Lock()
	n := pendingNotify
	pendingNotifyMu.Unlock()
	if n.Title == "" && n.Body == "" {
		return
	}

	nid := trayNID // struct copy; SzInfo/SzInfoTitle start zeroed (never set on trayNID)
	nid.UFlags = trayNID.UFlags | trayNifInfo
	nid.DwInfoFlags = trayNiifUser

	body := n.Body
	if n.Meta != "" {
		body += " · " + n.Meta
	}
	body = truncateRunes(body, 200) // SzInfo is 256 wchars; leave headroom for the null

	if title, err := syscall.UTF16FromString(n.Title); err == nil {
		copy(nid.SzInfoTitle[:len(nid.SzInfoTitle)-1], title)
	}
	if info, err := syscall.UTF16FromString(body); err == nil {
		copy(nid.SzInfo[:len(nid.SzInfo)-1], info)
	}
	procShellNotifyIconW.Call(trayNimModify, uintptr(unsafe.Pointer(&nid)))
}

// onBalloonClick — a buttonless balloon click is never an approve; it always
// opens the app to review (the click-only-in-app rule). Inline Approve/Deny
// buttons are a separate WinRT-toast increment.
func onBalloonClick() {
	pendingNotifyMu.Lock()
	n := pendingNotify
	pendingNotifyMu.Unlock()
	if trayOpenChat != nil {
		go trayOpenChat()
	}
	notifyEmitAction(n.ID, n.Kind, "review")
}

// truncateRunes caps s to at most max runes (so a multi-byte tail isn't split).
func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}
