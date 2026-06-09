//go:build windows

package main

// platformShowAlert pops a modal native message box. Safe to call from any
// goroutine — MessageBoxW runs its own modal loop.
func platformShowAlert(title, message string) {
	const (
		mbOK            = 0x00000000 // MB_OK
		mbIconWarning   = 0x00000030 // MB_ICONWARNING
		mbSetForeground = 0x00010000 // MB_SETFOREGROUND
		mbTopmost       = 0x00040000 // MB_TOPMOST
	)
	messageBox(message, title, mbOK|mbIconWarning|mbSetForeground|mbTopmost)
}
