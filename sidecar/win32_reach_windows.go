//go:build windows

package main

// What Windows says about a window before it is acted on: whether keys would
// arrive, which of a program's windows is meant, and whether it is the notch's
// own. The decisions are in desktop_reach.go; this file only asks Windows.

import (
	"syscall"
	"unsafe"
)

var (
	reachAdvapi32               = syscall.NewLazyDLL("advapi32.dll")
	procReachOpenProcessToken   = reachAdvapi32.NewProc("OpenProcessToken")
	procReachGetTokenInfo       = reachAdvapi32.NewProc("GetTokenInformation")
	procReachGetCurrentProcess  = kernel32.NewProc("GetCurrentProcess")
	procReachGetCurrentProcessI = kernel32.NewProc("GetCurrentProcessId")
)

// tokenElevated asks whether a process runs as administrator. known is false
// when it could not be asked, which is itself what Windows answers about most
// processes on the other side of that line.
func tokenElevated(process uintptr) (elevated, known bool) {
	const tokenQuery = 0x0008
	const tokenElevationClass = 20 // TokenElevation
	if process == 0 {
		return false, false
	}
	var token uintptr
	if ok, _, _ := procReachOpenProcessToken.Call(process, tokenQuery, uintptr(unsafe.Pointer(&token))); ok == 0 {
		return false, false
	}
	defer procNativeCloseHandle.Call(token)
	var elevation, size uint32
	if ok, _, _ := procReachGetTokenInfo.Call(token, tokenElevationClass,
		uintptr(unsafe.Pointer(&elevation)), unsafe.Sizeof(elevation), uintptr(unsafe.Pointer(&size))); ok == 0 {
		return false, false
	}
	return elevation != 0, true
}

// windowKeyReach says whether keys sent to hwnd's window would arrive.
func windowKeyReach(hwnd uintptr) keyReach {
	if hwnd == 0 {
		return keysArrive
	}
	pid := win32GetWindowPid(hwnd)
	if own, _, _ := procReachGetCurrentProcessI.Call(); pid != 0 && uint32(own) == pid {
		return keysArrive
	}
	self, _, _ := procReachGetCurrentProcess.Call()
	selfElevated, selfKnown := tokenElevated(self)

	const processQueryLimitedInformation = 0x1000
	targetElevated, targetKnown := false, false
	if pid != 0 {
		if h, _, _ := procOpenProcess.Call(processQueryLimitedInformation, 0, uintptr(pid)); h != 0 {
			targetElevated, targetKnown = tokenElevated(h)
			procNativeCloseHandle.Call(h)
		}
	}
	return keysReachWindow(selfElevated, selfKnown, targetElevated, targetKnown)
}

// ownOverlayWindow says whether hwnd is one of the notch's own two windows.
// They are above every other window and are both called "Jarvis": in a list
// of what is open they came first, twice, and were nothing the agent could
// use; under a click they are a cover no window can be brought in front of.
func ownOverlayWindow(hwnd uintptr) bool {
	w := notchWin.Load()
	if w == nil || hwnd == 0 {
		return false
	}
	return hwnd == w.hwnd || (w.backdrop != nil && hwnd == w.backdrop.hwnd)
}

// topWindowOfPid is the window of pid a person means (pickWindowOfPid), or 0
// when the program has no visible, titled window.
func topWindowOfPid(pid int) uintptr {
	wins := windowsForPid(pid)
	if len(wins) == 0 {
		return 0
	}
	list := make([]pidWindow, len(wins))
	for i, w := range wins {
		minimized, _, _ := procIsIconic.Call(w.Hwnd)
		list[i] = pidWindow{Hwnd: w.Hwnd, Minimized: minimized != 0}
	}
	return pickWindowOfPid(list, win32GetForegroundWindow())
}
