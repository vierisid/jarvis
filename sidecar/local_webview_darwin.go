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
// (SetHtml/Navigate); it runs on the main thread. It may return a cleanup
// (nil if none) that runs after the window closes — the join point for any
// goroutine a binding spawned. On macOS the engine is leaked, not freed (see
// below), so a late Dispatch is not a use-after-free; the join still bounds
// the goroutine's lifetime to the window's.
func runLocalWebview(title string, width, height int, hint webview.Hint, build func(webview.WebView) (cleanup func())) {
	runtime.LockOSThread()
	wv := webview.New(false)
	if wv == nil {
		log.Printf("[ui] could not open %q (webview runtime missing?)", title)
		return
	}

	closed := make(chan struct{})
	var stopReveal func()
	var cleanup func()
	uiSync(wv, func() { // synchronous: stopReveal is assigned before watchWindowClose can fire
		wv.SetTitle(title)
		wv.SetSize(width, height, hint)
		stopReveal = revealWebviewOnLoad(wv)
		cleanup = build(wv)
		watchWindowClose(wv.Window(), func() {
			// Stopping HERE (main thread), not after <-closed: AppKit releases
			// the window on close, and a reveal closure already queued on the
			// main queue would otherwise run against the freed handle before
			// our goroutine even wakes. Main-queue ordering makes the stop
			// flag visible to any closure that drains after this callback.
			stopReveal()
			close(closed)
		})
	})

	<-closed
	if cleanup != nil {
		cleanup()
	}
	// Intentionally do NOT wv.Destroy() here. Under the tray's shared loop the
	// window closes via AppKit, but webview's own on_window_will_close ->
	// dispatch(on_window_destroyed) callback still references the engine.
	// Destroying now frees the engine out from under it -> use-after-free
	// crash. We leak the engine instead (these windows open rarely; the reveal
	// timer, the other dangling reference this leak used to cover, is joined
	// above). TODO: cancellable teardown to reclaim.
}
