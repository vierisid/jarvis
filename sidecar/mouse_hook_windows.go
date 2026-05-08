//go:build windows

// mouse_hook_windows.go — Low-level mouse hook for global mouse-button
// shortcuts that aren't reachable via Win32's RegisterHotKey (which only
// covers keyboard chords).
//
// Used by W4 to register Ctrl+Middle-click as a one-handed palette
// trigger so the user can fire the palette without lifting either hand
// from the mouse.

package main

import (
	"log"
	"runtime"
	"sync/atomic"
	"syscall"
	"unsafe"
)

var _ = syscall.GetLastError // keep syscall import live across build configurations

// Win32 constants for the low-level mouse hook (WH_MOUSE_LL).
const (
	whMouseLL      = 14
	wmMButtonDown  = 0x0207
	vkControl      = 0x11
	asyncKeyHeldHi = 0x8000 // GetAsyncKeyState high bit set ≡ key currently down
)

// MSLLHOOKSTRUCT — payload Windows passes to the WH_MOUSE_LL callback.
// Layout per the Win32 SDK; only Pt is meaningful for our use-case but
// the full struct is required so unsafe.Pointer arithmetic lines up.
type msllHookStruct struct {
	Pt          w32Point
	MouseData   uint32
	Flags       uint32
	Time        uint32
	DwExtraInfo uintptr
}

var (
	procSetWindowsHookExW   = user32.NewProc("SetWindowsHookExW")
	procUnhookWindowsHookEx = user32.NewProc("UnhookWindowsHookEx")
	procCallNextHookEx      = user32.NewProc("CallNextHookEx")
	procGetAsyncKeyState    = user32.NewProc("GetAsyncKeyState")
	// procGetModuleHandleW is declared in pebble_overlay_windows.go.
)

// startMouseHookCtrlMButton installs a global low-level mouse hook on a
// dedicated OS thread. Whenever the user presses Ctrl+Middle-Mouse-Button
// anywhere in the OS, onFire is invoked asynchronously and the click is
// swallowed (so apps that bind plain MMB don't see a phantom press).
// Other mouse activity flows through untouched.
//
// Returns a stop function that removes the hook and tears down the
// listener thread. Safe to call multiple times across the sidecar's
// lifetime — each call returns its own independent hook + stopper.
func startMouseHookCtrlMButton(onFire func()) (stop func(), err error) {
	// Buffer 16 events — way more than realistic click rates. A non-
	// blocking send keeps the hook callback fast even if the consumer
	// goroutine is briefly behind.
	fireCh := make(chan struct{}, 16)
	stopCh := make(chan struct{})

	// Dispatch goroutine — owns the user callback so the hook proc
	// itself stays cheap (Windows is waiting on its return value to
	// decide whether to deliver the click to the next hook in chain
	// + the foreground window). Also owns logging — log.Printf is a
	// mutex-locked I/O call and we don't want to hold it inside the
	// Win32 hook proc (which runs on a Windows native thread for
	// every mouse event in the system).
	go func() {
		for {
			select {
			case <-stopCh:
				return
			case <-fireCh:
				log.Printf("[mouse-hook] Ctrl+MMB detected — firing palette callback")
				if onFire != nil {
					onFire()
				}
			}
		}
	}()

	// Hook callback — runs in the hook thread's context. Must return
	// quickly. We check Ctrl state via GetAsyncKeyState (cheap), and
	// either swallow the event (return 1) or pass it through via
	// CallNextHookEx.
	var swallowed atomic.Int64
	hookProc := syscall.NewCallback(func(nCode int32, wParam uintptr, lParam uintptr) uintptr {
		if nCode >= 0 && wParam == wmMButtonDown {
			ks, _, _ := procGetAsyncKeyState.Call(uintptr(vkControl))
			// Low-order bit can be set if pressed since last call;
			// high-order bit ≡ "currently down". We only want
			// "currently down".
			if ks&asyncKeyHeldHi != 0 {
				swallowed.Add(1)
				select {
				case fireCh <- struct{}{}:
				default:
					// channel full — drop this fire so we
					// never block Windows in the hook.
				}
				// Returning 1 swallows the click so the next
				// hook + foreground window don't see Ctrl+MMB.
				// Plain MMB still works because we only
				// short-circuit when Ctrl is held.
				return 1
			}
		}
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	})

	hookHandleCh := make(chan uintptr, 1)
	tidCh := make(chan uint32, 1)

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		tid, _, _ := procGetCurrentThread.Call()
		tidCh <- uint32(tid)

		hMod, _, _ := procGetModuleHandleW.Call(0)
		hHook, _, e := procSetWindowsHookExW.Call(
			uintptr(whMouseLL),
			hookProc,
			hMod,
			0,
		)
		if hHook == 0 {
			log.Printf("[mouse-hook] SetWindowsHookExW failed: %v", e)
			hookHandleCh <- 0
			return
		}
		hookHandleCh <- hHook
		log.Printf("[mouse-hook] installed WH_MOUSE_LL (handle=0x%x)", hHook)

		// Pump messages so Windows can deliver the hook callbacks on
		// this thread. The hook also serves as the loop's wake-up so
		// GetMessageW can be used directly. WM_QUIT (posted by stop)
		// breaks the loop.
		for {
			var msg w32Msg
			r, _, _ := procGetMessageW.Call(
				uintptr(unsafe.Pointer(&msg)),
				0, 0, 0,
			)
			if r == 0 || r == ^uintptr(0) {
				break
			}
		}

		procUnhookWindowsHookEx.Call(hHook)
		log.Printf("[mouse-hook] uninstalled (swallowed %d Ctrl+MMB events)", swallowed.Load())
	}()

	hHook := <-hookHandleCh
	tid := <-tidCh
	if hHook == 0 {
		return nil, syscall.GetLastError()
	}

	stop = func() {
		close(stopCh)
		procPostThreadMsg.Call(uintptr(tid), wmQuit, 0, 0)
	}
	return stop, nil
}
