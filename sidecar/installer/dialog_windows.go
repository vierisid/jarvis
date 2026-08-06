//go:build windows

package main

// Native dialogs. The installer is built -H windowsgui (no console), so an
// uninstall launched from Settings → Apps has nowhere to print and no stdin to
// read: every user-facing question and the final result must be a MessageBox.

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32Dialog    = windows.NewLazySystemDLL("user32.dll")
	procMessageBoxW = user32Dialog.NewProc("MessageBoxW")
)

const (
	mbOK           = 0x00000000
	mbYesNo        = 0x00000004
	mbIconQuestion = 0x00000020
	mbIconInfo     = 0x00000040
	mbIconWarning  = 0x00000030
	mbDefButton2   = 0x00000100
	idYes          = 6
)

func messageBox(title, text string, flags uint) int {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(title)
	r, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), uintptr(flags))
	return int(r)
}

// confirm asks a yes/no question, defaulting to No.
func confirm(title, text string) bool {
	return messageBox(title, text, mbYesNo|mbIconQuestion|mbDefButton2) == idYes
}

// notify reports a terminal outcome.
func notify(title, text string, failed bool) {
	icon := uint(mbIconInfo)
	if failed {
		icon = mbIconWarning
	}
	messageBox(title, text, mbOK|icon)
}
