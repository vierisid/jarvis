//go:build windows

package main

// WebView2 runtime presence check — moved to internal/webview2 (Ensure) so
// the installer's wizard shares the same prompt-and-wait behavior; this shim
// keeps the sidecar's call site unchanged. messageBox stays here because
// alert_windows.go uses it independently of WebView2.

import (
	"syscall"
	"unsafe"

	"github.com/jarvis/sidecar/internal/webview2"
)

var procMessageBoxW = pebbleUser32.NewProc("MessageBoxW")

// ensureWebView2Runtime returns true if the WebView2 runtime is present (now
// or after the user installs it). See internal/webview2 for the full
// prompt → bootstrap → wait behavior.
func ensureWebView2Runtime() bool {
	return webview2.Ensure()
}

func messageBox(text, caption string, flags uint) int {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(caption)
	r, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), uintptr(flags))
	return int(r)
}
