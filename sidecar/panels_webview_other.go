//go:build !linux

package main

import (
	"unsafe"

	webview "github.com/webview/webview_go"
)

// newPanelWebview creates a panel's webview on the calling goroutine. Windows
// runs one loop per panel thread, and on macOS the vendored engine marshals the
// window's creation onto the main thread itself. Linux creates it on the shared
// GTK loop instead (panels_linux.go).
func newPanelWebview(debug bool) webview.WebView { return webview.New(debug) }

// runOnSharedUIThread lets a platform take over uiSync's marshalling. Only Linux
// does (panels_linux.go); returning false keeps uiSync's own behavior here.
func runOnSharedUIThread(func()) bool { return false }

// withPanelWindow runs fn with the panel's native window handle. Linux resolves
// the handle on its GTK loop's thread (panels_linux.go); here the handle is read
// directly, as it always was.
func withPanelWindow(wv webview.WebView, fn func(handle unsafe.Pointer) error) error {
	return fn(wv.Window())
}

// withFollowedWindow runs fn for the cursor-follow goroutine with the handle it
// captured at spawn. That goroutine can outlive the engine on Windows (Destroy
// runs as the panel tears down), so it must not call wv.Window() there.
func withFollowedWindow(_ webview.WebView, handle unsafe.Pointer, fn func(handle unsafe.Pointer) error) error {
	return fn(handle)
}

// allowSharedUILoop and sharedUILoopRunning only matter for Linux's shared GTK
// loop (gtk_main_linux.go).
func allowSharedUILoop() {}

func sharedUILoopRunning() bool { return false }
