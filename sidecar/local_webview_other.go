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
// window down. build registers bindings and sets the page before Run().
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
	build(wv)
	wv.Run()
}
