//go:build !darwin

package main

import (
	"log"
	"runtime"

	webview "github.com/webview/webview_go"

	"github.com/jarvis/sidecar/internal/winchrome"
)

// runLocalWebview hosts a small local-HTML webview window (settings, logs) on
// platforms where each window owns its own goroutine and event loop
// (Windows/Linux). This goroutine creates, configures, runs, and tears the
// window down. The reveal-on-load hook is installed here (before build, per
// its contract); build registers bindings and sets the page before Run(), and
// may return a cleanup (nil if none) that runs after the loop exits but
// BEFORE the engine is freed — the join point for any goroutine a binding
// spawned, so a pending Dispatch can never land on a dangling pointer.
//
// titleBar chooses between the system title bar and one the page draws itself
// (winchrome; custom is Windows-only and degrades to native elsewhere). Ask
// for winchrome.CustomTitleBar only for a window showing LOCAL html: it binds
// window controls, which a remote document must never reach.
func runLocalWebview(title string, width, height int, hint webview.Hint, titleBar winchrome.TitleBar, build func(webview.WebView) (cleanup func())) {
	runtime.LockOSThread()
	wv := webview.New(false)
	if wv == nil {
		log.Printf("[ui] could not open %q (webview runtime missing?)", title)
		return
	}
	defer wv.Destroy()
	wv.SetTitle(title)
	wv.SetSize(width, height, hint)
	if titleBar == winchrome.CustomTitleBar {
		// Before the reveal hook and before build's SetHtml/Navigate: the
		// window is still hidden, so the native bar is never composited, and
		// the marker script Install injects only reaches documents loaded
		// after it.
		winchrome.Install(wv)
	}
	stop := revealWebviewOnLoad(wv)
	// LIFO with the Destroy above: a window closed within the reveal timeout
	// must join the timeout goroutine BEFORE the engine is freed, or its
	// pending Dispatch lands on a dangling pointer.
	defer stop()
	if cleanup := build(wv); cleanup != nil {
		// LIFO again: binding goroutines join first, then the reveal timer,
		// then the engine is freed.
		defer cleanup()
	}
	wv.Run()
}
