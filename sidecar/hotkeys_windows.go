//go:build windows

package main

import (
	"log"
	"runtime"
	"syscall"
	"unsafe"
)

// Win32 hotkey modifiers + virtual-key codes.
const (
	modAlt     = 0x0001
	modControl = 0x0002
	modShift   = 0x0004
	modWin     = 0x0008
	modNoRepeat = 0x4000
)

const (
	vkSpace = 0x20
	vkK     = 0x4B
)

// Win32 message identifiers.
const (
	wmHotkey = 0x0312
	wmQuit   = 0x0012
)

// Win32 message struct layout.
type w32Msg struct {
	HWND    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      w32Point
	Extra   uint32 // some win versions; pad
}

var (
	procRegisterHotKey   = user32.NewProc("RegisterHotKey")
	procUnregisterHotKey = user32.NewProc("UnregisterHotKey")
	procGetMessageW      = user32.NewProc("GetMessageW")
	procPostThreadMsg    = user32.NewProc("PostThreadMessageW")
	procGetCurrentThread = syscall.NewLazyDLL("kernel32.dll").NewProc("GetCurrentThreadId")
)

// startHotkeyListener registers a single global hotkey on a dedicated OS
// thread and runs a Win32 message loop, invoking onFire on every press.
// Returns a stop function that unregisters the hotkey and breaks the loop.
//
// keyspec is parsed by parseHotkey; only "ctrl+space" is supported in W2-T2.
// Mac/Linux will plug in here when their hotkey backends land.
func startHotkeyListener(keyspec string, onFire func()) (stop func(), err error) {
	mods, vk, err := parseHotkey(keyspec)
	if err != nil {
		return nil, err
	}

	threadIDCh := make(chan uint32, 1)
	stopCh := make(chan struct{})

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		tid, _, _ := procGetCurrentThread.Call()
		threadIDCh <- uint32(tid)

		const hotkeyID = 1
		r, _, e := procRegisterHotKey.Call(0, hotkeyID, uintptr(mods|modNoRepeat), uintptr(vk))
		if r == 0 {
			log.Printf("[hotkeys] RegisterHotKey(%s) failed: %v", keyspec, e)
			return
		}
		defer procUnregisterHotKey.Call(0, hotkeyID)
		log.Printf("[hotkeys] registered %s (mods=0x%x, vk=0x%x)", keyspec, mods, vk)

		for {
			select {
			case <-stopCh:
				return
			default:
			}

			var msg w32Msg
			r, _, _ := procGetMessageW.Call(
				uintptr(unsafe.Pointer(&msg)),
				0, 0, 0,
			)
			if r == 0 || r == ^uintptr(0) {
				return
			}
			if msg.Message == wmHotkey && msg.WParam == hotkeyID {
				log.Printf("[hotkeys] WM_HOTKEY received for %s — firing", keyspec)
				go onFire()
			}
		}
	}()

	tid := <-threadIDCh

	stop = func() {
		close(stopCh)
		// Unblock GetMessage by posting WM_QUIT to the listener thread.
		procPostThreadMsg.Call(uintptr(tid), wmQuit, 0, 0)
	}
	return stop, nil
}

// parseHotkey converts a string like "ctrl+space" or "alt+j" into Win32
// modifier flags and a virtual-key code. Only the keys we actually use are
// supported in W2-T2 (extending here is trivial).
func parseHotkey(spec string) (mods, vk uint32, err error) {
	switch spec {
	case "ctrl+space", "Ctrl+Space", "CTRL+SPACE":
		return modControl, vkSpace, nil
	case "ctrl+k", "Ctrl+K", "CTRL+K":
		return modControl, vkK, nil
	}
	return 0, 0, &hotkeyParseError{spec: spec}
}

type hotkeyParseError struct{ spec string }

func (e *hotkeyParseError) Error() string {
	return "unsupported hotkey: " + e.spec
}
