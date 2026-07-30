//go:build !darwin

package main

import (
	"log"
	"runtime"

	webview "github.com/webview/webview_go"
)

// runLocalWebview hosts a small local-HTML webview window (settings, logs) on
// platforms where each window owns its own goroutine and event loop
// (Windows/Linux). This goroutine creates, configures, runs, and tears the
// window down. The reveal-on-load hook is installed here (before build, per
// its contract); build registers bindings and sets the page before Run().
func runLocalWebview(title string, width, height int, hint webview.Hint, build func(webview.WebView)) {
	runtime.LockOSThread()
	wv := webview.New(false)
	if wv == nil {
		log.Printf("[ui] could not open %q (webview runtime missing?)", title)
		return
	}
	defer wv.Destroy()
	wv.SetTitle(title)
	wv.SetSize(width, height, hint)
	stop := revealWebviewOnLoad(wv)
	// LIFO with the Destroy above: a window closed within the reveal timeout
	// must join the timeout goroutine BEFORE the engine is freed, or its
	// pending Dispatch lands on a dangling pointer.
	defer stop()
	build(wv)
	wv.Run()
}
