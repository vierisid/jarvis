//go:build windows

package main

// Windows half of the single-instance guard (single_instance.go).
//
// The lock is a named mutex in the session-local namespace, so each signed-in
// user gets their own sidecar. Only the mutex's EXISTENCE is used, never its
// ownership: a Win32 mutex is owned by a thread, and Go can retire an OS thread
// under us (a goroutine that ends while LockOSThread'd takes its thread along),
// which would abandon an owned mutex and let a second instance in. An open
// handle has no such tie, and it is never closed: process exit releases it.
//
// The hand-off rides the tray window's WM_COPYDATA hook, the same channel the
// notification forwarder and the installer's quit request use.

import (
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	singleInstanceMutexName = `Local\Jarvis.Sidecar`
	showCopyDataMagic       = 0x4A565348 // 'JVSH' - a second launch asks the running instance to show itself
	pingCopyDataMagic       = 0x4A565047 // 'JVPG' - a second launch only checks the running instance is there
	smtoAbortIfHung         = 0x0002
	// handOffTimeoutMS bounds the hand-off. A plain SendMessage to a hung
	// instance would block this launch forever.
	handOffTimeoutMS = 2000
)

var (
	procSendMessageTimeoutW      = user32.NewProc("SendMessageTimeoutW")
	procAllowSetForegroundWindow = user32.NewProc("AllowSetForegroundWindow")
)

type windowsInstanceLock struct {
	name   string
	handle windows.Handle
}

func newInstanceLock() instanceLock {
	return &windowsInstanceLock{name: singleInstanceMutexName}
}

func (l *windowsInstanceLock) tryAcquire() (bool, error) {
	name, err := windows.UTF16PtrFromString(l.name)
	if err != nil {
		return false, err
	}
	h, err := windows.CreateMutex(nil, false, name)
	switch err {
	case nil:
		l.handle = h
		return false, nil
	case windows.ERROR_ALREADY_EXISTS:
		// x/sys reports this as an error but still hands back a valid handle to
		// the existing mutex, which must not leak into this process or the
		// mutex outlives its real holder.
		windows.CloseHandle(h)
		return true, nil
	case windows.ERROR_ACCESS_DENIED:
		// The mutex exists but was created by a process we can't open it from:
		// an instance started with "Run as administrator", seen from a normal
		// launch such as autostart. It is held all the same.
		return true, nil
	}
	return false, err
}

func (l *windowsInstanceLock) handOff(show bool) bool {
	cls, err := windows.UTF16PtrFromString("JarvisSidecarTray")
	if err != nil {
		return false
	}
	hwnd, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(cls)), 0)
	if hwnd == 0 {
		return false
	}
	magic := uintptr(pingCopyDataMagic)
	if show {
		magic = showCopyDataMagic
		// Windows only lets the foreground process pass focus on, and that is
		// us: the user just launched this process. Without this the dashboard
		// the running instance brings up would flash in the taskbar instead.
		var pid uint32
		procGetWindowThreadProcId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if pid != 0 {
			procAllowSetForegroundWindow.Call(uintptr(pid))
		}
	}
	// A sidecar from before this guard answers any tagged WM_COPYDATA with 1,
	// so it counts as reached either way.
	payload := []byte("launch\x00")
	cds := copyDataStruct{
		dwData: magic,
		cbData: uint32(len(payload)),
		lpData: uintptr(unsafe.Pointer(&payload[0])),
	}
	var result uintptr
	r, _, _ := procSendMessageTimeoutW.Call(hwnd, trayWmCopyData, 0, uintptr(unsafe.Pointer(&cds)),
		smtoAbortIfHung, handOffTimeoutMS, uintptr(unsafe.Pointer(&result)))
	runtime.KeepAlive(payload) // lpData is a bare uintptr - keep the buffer live across the syscall
	runtime.KeepAlive(cds)
	return r != 0 && result == 1
}
