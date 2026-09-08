//go:build windows

package main

import (
	"fmt"
	"log"
	"runtime"
	"syscall"
	"unsafe"
)

// Win32 hotkey modifiers + virtual-key codes.
const (
	modAlt      = 0x0001
	modControl  = 0x0002
	modShift    = 0x0004
	modWin      = 0x0008
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

// ERROR_HOTKEY_ALREADY_REGISTERED — another process (an IME, a launcher, a
// window manager) owns this combination, so ours will never fire.
const errHotkeyAlreadyRegistered = syscall.Errno(1409)

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
// A registration that FAILS comes back as an error. It used to be logged from
// inside the goroutine while this function still returned (stop, nil), so every
// caller went on to announce the hotkey as registered -- the sidecar log said
// "summon hotkey 'ctrl+space' registered" for a key that did nothing, which is
// the worst possible thing for it to say when someone is trying to work out why
// their hotkey is dead. Ctrl+Space in particular is contended on Windows (IMEs
// and other launchers take it), and RegisterHotKey refuses a combination that
// another process already holds.
//
// keyspec is parsed by parseHotkey; only "ctrl+space" is supported in W2-T2.
// Mac/Linux will plug in here when their hotkey backends land.
func startHotkeyListener(keyspec string, onFire func()) (stop func(), err error) {
	mods, vk, err := parseHotkey(keyspec)
	if err != nil {
		return nil, err
	}

	// The thread id is only useful once the hotkey is actually registered (it
	// exists to unblock GetMessage in stop()), so it rides along with the
	// verdict rather than being published ahead of it.
	type registration struct {
		tid uint32
		err error
	}
	regCh := make(chan registration, 1)
	stopCh := make(chan struct{})

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		tid, _, _ := procGetCurrentThread.Call()

		const hotkeyID = 1
		r, _, e := procRegisterHotKey.Call(0, hotkeyID, uintptr(mods|modNoRepeat), uintptr(vk))
		if r == 0 {
			regCh <- registration{err: registerHotKeyError(keyspec, e)}
			return
		}
		defer procUnregisterHotKey.Call(0, hotkeyID)
		regCh <- registration{tid: uint32(tid)}
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
			// GetMessage returns a 32-bit BOOL, and -1 is its error return. The
			// upper half of the register is not part of that value, so compare
			// as int32: `r == ^uintptr(0)` only ever matched a sign-extended
			// -1, and on the error path that never matches the loop would spin
			// on a failing call forever.
			if r == 0 || int32(r) == -1 {
				return
			}
			if msg.Message == wmHotkey && msg.WParam == hotkeyID {
				log.Printf("[hotkeys] WM_HOTKEY received for %s — firing", keyspec)
				go onFire()
			}
		}
	}()

	reg := <-regCh
	if reg.err != nil {
		return nil, reg.err
	}

	tid := reg.tid
	stop = func() {
		close(stopCh)
		// Unblock GetMessage by posting WM_QUIT to the listener thread.
		procPostThreadMsg.Call(uintptr(tid), wmQuit, 0, 0)
	}
	return stop, nil
}

// registerHotKeyError turns RegisterHotKey's failure into something a user can
// act on. The common case by far is another process already owning the
// combination, and "the operation completed successfully" -- which is what a
// zero errno formats as -- is not an error message.
func registerHotKeyError(keyspec string, e error) error {
	errno, ok := e.(syscall.Errno)
	switch {
	case ok && errno == errHotkeyAlreadyRegistered:
		return fmt.Errorf("RegisterHotKey(%s): already registered by another application", keyspec)
	case ok && errno == 0:
		return fmt.Errorf("RegisterHotKey(%s): refused with no error code", keyspec)
	}
	return fmt.Errorf("RegisterHotKey(%s): %w", keyspec, e)
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
