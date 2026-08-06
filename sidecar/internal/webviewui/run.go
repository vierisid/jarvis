package webviewui

import (
	"log"
	"runtime"

	webview "github.com/webview/webview_go"
)

// RunWindow hosts a small local-HTML webview window, owning its creation,
// event loop (Run()), and teardown. The reveal-on-load hook is installed here
// (before build, per its contract); build registers bindings and sets the
// page before Run().
//
// Callers must own the process's UI loop: do not call this from the sidecar
// while the tray is running — on macOS the tray owns [NSApp run] and the
// sidecar uses its piggybacking darwin runner instead (local_webview_darwin.go).
// Standalone processes (the installer, the sidecar's pre-tray --setup mode)
// call this from the main goroutine.
func RunWindow(title string, width, height int, hint webview.Hint, build func(webview.WebView)) {
	runtime.LockOSThread()
	// Unlock on the way out: the sidecar's Windows --setup path returns here
	// and continues into normal startup, and leaving the main goroutine pinned
	// to one OS thread past the window's life is not intended.
	defer runtime.UnlockOSThread()
	wv := webview.New(false)
	if wv == nil {
		log.Printf("[ui] could not open %q (webview runtime missing?)", title)
		return
	}
	defer wv.Destroy()
	wv.SetTitle(title)
	wv.SetSize(width, height, hint)
	stop := RevealOnLoad(wv)
	// LIFO with the Destroy above: a window closed within the reveal timeout
	// must join the timeout goroutine BEFORE the engine is freed, or its
	// pending Dispatch lands on a dangling pointer.
	defer stop()
	build(wv)
	wv.Run()
}
