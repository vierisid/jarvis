//go:build darwin

package main

import (
	"log"
	"runtime"

	webview "github.com/webview/webview_go"
)

// runLocalWebview hosts a small local-HTML webview window (settings, logs) on
// macOS, where one process-wide [NSApp run] loop — owned by the tray — services
// every window. The webview is created on this goroutine (webview_go dispatches
// the actual NSWindow creation to the main thread), but EVERY window/webview
// mutation runs on the main thread via uiSync, and we never call wv.Run(): that
// would nest [NSApp run] on a background goroutine and abort with
// "NSWindow geometry should only be modified on the main thread!". We block
// until the window closes, then destroy it on the main thread.
//
// build receives the webview and should register bindings and set the page
// (SetHtml/Navigate); it runs on the main thread.
func runLocalWebview(title string, width, height int, hint webview.Hint, build func(webview.WebView)) {
	runtime.LockOSThread()
	wv := webview.New(false)
	if wv == nil {
		log.Printf("[ui] could not open %q (webview runtime missing?)", title)
		return
	}

	closed := make(chan struct{})
	uiSync(wv, func() {
		wv.SetTitle(title)
		wv.SetSize(width, height, hint)
		build(wv)
		watchWindowClose(wv.Window(), func() { close(closed) })
	})

	<-closed
	// Intentionally do NOT wv.Destroy() here. Under the tray's shared loop the
	// window closes via AppKit, but pending callbacks still reference the engine
	// — webview's own on_window_will_close -> dispatch(on_window_destroyed) and
	// revealWebviewOnLoad's reveal-timeout goroutine. Destroying now frees the
	// engine out from under them -> use-after-free crash. We leak the engine
	// instead (these windows open rarely). TODO: cancellable teardown to reclaim.
}
