//go:build windows

package main

import (
	"fmt"
	"log"
	"runtime"
	"syscall"
	"unsafe"
)

// MOD_NOREPEAT: one WM_HOTKEY per press, not one per auto-repeat tick. The
// other MOD_* flags and the virtual-key table live in hotkeys_keyspec.go, which
// carries no build tag so the key names are covered by a test on any OS.
const modNoRepeat = 0x4000

// Win32 message identifiers.
const (
	wmHotkey = 0x0312
	wmQuit   = 0x0012
)

// ERROR_HOTKEY_ALREADY_REGISTERED — some other hot key already owns this
// combination, so ours will never fire. Usually another app (an IME, a
// launcher, a window manager), but not always ours to blame elsewhere: a
// previous sidecar instance that has not finished exiting still holds its
// hotkeys, which is exactly the window relaunch.go waits out.
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
// and other launchers take it), and RegisterHotKey refuses any combination that
// another hot key already holds -- including one held by a previous instance of
// this sidecar that has not finished exiting.
//
// keyspec is parsed by parseHotkey, which takes the same grammar as the macOS
// and Linux backends.
func startHotkeyListener(keyspec string, onFire func()) (stop func(), err error) {
	mods, vk, err := parseHotkey(keyspec)
	if err != nil {
		return nil, err
	}
	// Registered before the listener thread starts, so the message loop can
	// dispatch through it from its first iteration. hotkeyID below is the Win32
	// id (always 1, scoped to this thread); dispatchID is ours.
	dispatchID := hotkeyDispatcher.register(onFire)

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
		log.Printf("[hotkeys] registered %q (mods=0x%x, vk=0x%x)", keyspec, mods, vk)

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
			if r == 0 {
				return // WM_QUIT: stop() asked for it
			}
			// GetMessage returns a 32-bit BOOL, and -1 is its error return. The
			// upper half of the register is not part of that value, so compare
			// as int32: `r == ^uintptr(0)` only ever matched a sign-extended
			// -1, and on the error path that never matches the loop would spin
			// on a failing call forever.
			//
			// Said out loud, because this is the listener going deaf for the
			// rest of the process's life. A silent return here would put us
			// straight back to the thing this file exists to stop: a hotkey
			// that does nothing and a log with no trace of why.
			if int32(r) == -1 {
				log.Printf("[hotkeys] GetMessage failed for %q; listener stopping (hotkey is now dead)", keyspec)
				return
			}
			if msg.Message == wmHotkey && msg.WParam == hotkeyID {
				log.Printf("[hotkeys] WM_HOTKEY received for %q -- firing", keyspec)
				// Through the shared registry, not `go onFire()` (#587). The
				// issue names linux and darwin, but this is the identical
				// defect: stop() closes stopCh and posts WM_QUIT without
				// waiting, so a WM_HOTKEY already dequeued here could launch a
				// callback after stop() had returned and the caller had begun
				// tearing down what it touches. Leaving one backend with the
				// defect while fixing the class is worse than fixing all
				// three, and the Linux and Windows halves of this file are
				// deliberately kept aligned.
				hotkeyDispatcher.dispatch(dispatchID)
			}
		}
	}()

	reg := <-regCh
	if reg.err != nil {
		hotkeyDispatcher.invalidate(dispatchID)
		return nil, reg.err
	}

	tid := reg.tid
	stop = func() {
		// Invalidate FIRST, before the loop is asked to quit: a WM_HOTKEY the
		// loop has already dequeued would otherwise still start a callback
		// after this function returns (#587). See hotkeys_dispatch.go for why
		// this invalidates rather than waiting.
		if inFlight := hotkeyDispatcher.invalidate(dispatchID); inFlight > 0 {
			log.Printf("[hotkeys] %q: stopped while %d callback(s) were still running; they will finish, so anything this hotkey drives must tolerate that",
				keyspec, inFlight)
		}
		close(stopCh)
		// Unblock GetMessage by posting WM_QUIT to the listener thread.
		procPostThreadMsg.Call(uintptr(tid), wmQuit, 0, 0)
	}
	return stop, nil
}

// registerHotKeyError turns RegisterHotKey's failure into something a user can
// act on. The common case by far is the combination already being taken, and
// "the operation completed successfully" -- which is what a zero errno formats
// as -- is not an error message.
//
// Deliberately does NOT name a culprit: the holder can be another app or a
// previous instance of this sidecar, and we cannot tell which from here.
func registerHotKeyError(keyspec string, e error) error {
	errno, ok := e.(syscall.Errno)
	switch {
	case ok && errno == errHotkeyAlreadyRegistered:
		return fmt.Errorf("RegisterHotKey(%s): already held by another hot key (another app, or a sidecar that has not exited)", keyspec)
	case ok && errno == 0:
		return fmt.Errorf("RegisterHotKey(%s): refused with no error code", keyspec)
	case e == nil:
		return fmt.Errorf("RegisterHotKey(%s): refused", keyspec)
	}
	return fmt.Errorf("RegisterHotKey(%s): %w", keyspec, e)
}
